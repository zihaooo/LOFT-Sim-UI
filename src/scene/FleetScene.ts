import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import Stats from "stats.js";
import type { Pane } from "tweakpane";
import type { SceneBounds, SceneData } from "../types";
import {
  AIRSPACE_RENDER_ORDER,
  CAMERA_FAR_METERS,
  CAMERA_FOV_DEGREES,
  CAMERA_NEAR_METERS,
  DEFAULT_VEHICLE_TYPE_CODE,
  DRONE_MODEL_PATHS_BY_TYPE,
  FRAME_DELTA_MAX_SECONDS,
  GRID_SPACING_TICKS,
  GROUND_PADDING_METERS,
  MAX_DEVICE_PIXEL_RATIO,
  ORBIT_DAMPING_FACTOR,
  ORBIT_MAX_DISTANCE_METERS,
  ORBIT_MIN_DISTANCE_METERS,
  ORBIT_MOUSE_BUTTONS,
  SCENE_BACKGROUND_COLOR,
  SCENE_FOG_FAR_METERS,
  SCENE_FOG_NEAR_METERS,
  SIMULATION_SPEED_LEVELS,
  TELEMETRY_UAV_MESH_CAPACITY,
} from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { buildGridGeometry, initialGridSpacingIndex, padSceneBounds } from "../geometry/map";
import { createBlobShadowMesh, createUavMesh } from "../layer/drone";
import { TelemetryClient } from "../telemetry/client";
import { DemoFleetSource } from "../fleet/demoSource";
import { TelemetrySource } from "../fleet/telemetrySource";
import { UavInstanceWriter } from "../fleet/uavInstanceWriter";
import type { FleetFrame, FleetFrameContext, FleetSource } from "../fleet/source";
import type { UavModel } from "../geometry/drone";
import { createLightingGroup, createSkyDome } from "../layer/environment";
import { createBuildingGroup, createGrid, createGroundGroup, createRoadGroup, createTreeGroup } from "../layer/map";
import { createFlightEnvelopeGroup, createCorridorGroup, createRouteGroup, ROUTE_ENVELOPE_CHILD_NAME } from "../layer/airPath";
import { createVertiportGroup } from "../layer/vertiport";
import { createContingencySiteGroup } from "../layer/contingencySite";
import { createCnsSiteLayer, type CnsSiteLayer } from "../layer/cnsSite";
import { updateGroundIconBillboards } from "../layer/groundIcon";
import type { GroundIconTextures } from "../geometry/groundIcon";
import { CameraRig } from "./cameraRig";
import {
  createDefaultControlState,
  createSimulationControls,
  type ConfigFileSelection,
  type DemoPreset,
  type LayerVisibilityState,
  type SimulationControlState,
} from "./control";
import { createCorridorLabels, createUavLabels, updateLabels, type CorridorLabelNode } from "./labels";
import {
  createReadoutPanels,
  mountStatsPanel,
  updateReadoutPanels,
  writeStaticSceneReadouts,
  type ReadoutPanels,
} from "./readouts";
import { createHud, updateHud, type HudRefs } from "./hud";

export { loadUavModels, cloneUavModels } from "../geometry/drone";
export type { UavModel } from "../geometry/drone";
export { loadGroundIconTextures } from "../geometry/groundIcon";

type FleetSceneOptions = {
  host: HTMLDivElement;
  panel: HTMLDivElement;
  labelLayer: HTMLDivElement;
  stats: HTMLDivElement;
  sceneData: SceneData;
  uavModels?: Map<number, UavModel> | null;
  /** Preloaded icon textures, shared across scene rebuilds (never disposed — see loadGroundIconTextures). */
  groundIconTextures?: GroundIconTextures | null;
  onReloadScene: (files: ConfigFileSelection) => Promise<void>;
  onLoadDemoPreset: (preset: DemoPreset | null) => Promise<void>;
  activeDemoPreset?: DemoPreset | null;
  telemetryUrl?: string;
};

export class FleetScene {
  private readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly hud: HudRefs;
  private readonly sceneData: SceneData;
  private readonly onReloadScene: (files: ConfigFileSelection) => Promise<void>;
  private readonly onLoadDemoPreset: (preset: DemoPreset | null) => Promise<void>;
  /** Frontend-generated fleet; always present and used as the fallback when telemetry has no frame. */
  private readonly demoSource: DemoFleetSource;
  /** Backend telemetry source; present only when a telemetry URL was configured. */
  private readonly telemetrySource: TelemetrySource | null;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly performanceStats = new Stats();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR_METERS, CAMERA_FAR_METERS);
  private readonly controls: OrbitControls;
  private readonly controlPane: Pane;
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  /** Owns all camera behavior: initial framing, keyboard pan, follow mode, reset-view tween, ground clamp. */
  private readonly cameraRig: CameraRig;
  /** One InstancedMesh per vehicle type code (keys mirror DRONE_MODEL_PATHS_BY_TYPE). */
  private readonly uavMeshes: Map<number, THREE.InstancedMesh>;
  /** One shared decal per drone, drawing its altitude-faded ground shadow (drones don't cast into the shadow map). */
  private readonly blobShadowMesh: THREE.InstancedMesh;
  /**
   * Height of the surface that receives a blob shadow at (x, z). v1 is flat ground (0); swap for a building
   * height field (built once from sceneData.buildings) to land shadows on rooftops — see CONTEXT.md. With the
   * sun-angle projection, a correct height field must march along the ray, not just sample under the drone.
   */
  private readonly surfaceHeightAt = (_x: number, _z: number): number => 0;
  /** Writes drones into the per-type meshes each frame; shared by both fleet sources. */
  private readonly uavWriter: UavInstanceWriter;
  private readonly corridorGroup: THREE.Group;
  private readonly envelopeGroup: THREE.Group;
  private readonly routeGroup: THREE.Group;
  private readonly roadGroup: THREE.Group;
  private readonly treeGroup: THREE.Group;
  private readonly buildingGroup: THREE.Group;
  private readonly vertiportGroup: THREE.Group;
  private readonly contingencySiteGroup: THREE.Group;
  /** CNS site markers plus their coverage domes and extent rings; toggled as one unit. */
  private readonly cnsSiteLayer: CnsSiteLayer;
  /** Standalone reference-grid layer; its geometry is swapped in place when the "Grid Size" slider changes. */
  private readonly grid: THREE.LineSegments;
  /** Padded ground bounds shared by the ground plane and the grid; reused when rebuilding the grid geometry. */
  private readonly gridBounds: SceneBounds;
  private readonly labelNodes: Map<string, HTMLDivElement>;
  private readonly corridorLabelNodes: CorridorLabelNode[];
  /** Camera pose of the last corridor-label projection; unchanged pose + flags skip the DOM writes. */
  private readonly lastLabelCameraMatrix = new THREE.Matrix4();
  private lastCorridorLabelsHidden = false;
  /** Forces a corridor-label re-projection on the first frame and after a resize. */
  private corridorLabelsDirty = true;
  /** Value nodes of the debug readout panels; static rows are filled once, live rows every frame. */
  private readonly readouts: ReadoutPanels;
  /** Source that produced the most recent frame; the raycast selection is routed back to it. */
  private activeSource: FleetSource;
  private lastFrame: FleetFrame | null = null;
  private elapsedSeconds = 0;
  private animationFrame = 0;
  private started = false;
  private disposed = false;
  private readonly params: SimulationControlState;

  /** Wires DOM hosts, builds the fleet sources from scene data, and configures renderer, controls, UI, and scene. */
  constructor(options: FleetSceneOptions) {
    this.host = options.host;
    this.panel = options.panel;
    this.labelLayer = options.labelLayer;
    this.hud = createHud(options.stats);
    this.sceneData = options.sceneData;
    this.onReloadScene = options.onReloadScene;
    this.onLoadDemoPreset = options.onLoadDemoPreset;

    const routeById = new Map(this.sceneData.routes.map((route) => [route.id, route]));
    const corridorById = new Map(this.sceneData.corridors.map((corridor) => [corridor.id, corridor]));
    this.demoSource = new DemoFleetSource(this.sceneData.routes, this.sceneData.flows, routeById);
    this.telemetrySource = options.telemetryUrl ? new TelemetrySource(
          new TelemetryClient({ url: options.telemetryUrl, frontendOrigin: this.sceneData.origin }),
          routeById,
          corridorById,
        )
      : null;
    this.activeSource = this.demoSource;

    this.params = createDefaultControlState(options.activeDemoPreset ?? null);
    // Seed the grid spacing from the scene size before the control pane binds to it (no pane refresh needed).
    this.params.gridSpacingIndex = initialGridSpacingIndex(this.sceneData.sceneBounds);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    // Shader-error introspection stalls the pipeline once per program — each status query blocks until
    // that program finishes compiling and linking — so production skips it and keeps the driver's
    // background compile threads busy instead; dev keeps full shader diagnostics.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO));
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Clip the half-space below the ground (keeps y >= -0.1), hiding sub-surface geometry such as the
    // buried envelope ground-terminal stubs. The 0.1 m offset drops the cut just below y=0 so the ground
    // plane (y=0) and its coplanar grid stay safely on the kept side instead of straddling the clip
    // boundary and flickering. Global clipping needs no localClippingEnabled flag.
    this.renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.1)];
    // Per-material clipping is opt-in; the CNS site layer uses it to cut coverage rings at the
    // ground rectangle's edge (the domes make the same cut inside their shader instead).
    this.renderer.localClippingEnabled = true;
    this.host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = ORBIT_DAMPING_FACTOR;
    this.controls.maxDistance = ORBIT_MAX_DISTANCE_METERS;
    this.controls.minDistance = ORBIT_MIN_DISTANCE_METERS;
    this.controls.screenSpacePanning = false;
    this.controls.mouseButtons = ORBIT_MOUSE_BUTTONS;
    this.cameraRig = new CameraRig(this.camera, this.controls, this.sceneData.sceneBounds, this.params);

    this.roadGroup = createRoadGroup(this.sceneData.roads, this.sceneData.sceneBounds);
    this.treeGroup = createTreeGroup(this.sceneData.trees, this.sceneData.sceneBounds);
    this.buildingGroup = createBuildingGroup(this.sceneData.buildings, this.sceneData.sceneBounds);
    this.vertiportGroup = createVertiportGroup(
      this.sceneData.vertiports,
      options.groundIconTextures?.get("vertiport") ?? null,
    );
    this.contingencySiteGroup = createContingencySiteGroup(
      this.sceneData.contingencySites,
      options.groundIconTextures?.get("contSite") ?? null,
    );
    // The ground plane, grid, and CNS coverage clipping share this once-computed padded box.
    this.gridBounds = padSceneBounds(this.sceneData.sceneBounds, GROUND_PADDING_METERS);
    this.cnsSiteLayer = createCnsSiteLayer(this.sceneData.sites, options.groundIconTextures ?? null, this.gridBounds);
    this.corridorGroup = createCorridorGroup(this.sceneData.corridors);
    this.envelopeGroup = createFlightEnvelopeGroup(this.sceneData.corridors);
    this.routeGroup = createRouteGroup(this.sceneData.routes);
    this.routeGroup.visible = this.params.routesVisible;
    this.grid = createGrid(this.gridBounds, GRID_SPACING_TICKS[this.params.gridSpacingIndex]);
    // Groups default to visible, but not every control default is "on" — the CNS layer starts in
    // Coverage mode, which needs the intensity domes hidden — so apply the defaults once up front.
    this.applyLayerVisibility(this.params);
    this.uavMeshes = this.createUavMeshes(options.uavModels ?? null);
    // One blob slot per possible drone across every type, so no written drone can ever lack a shadow.
    let blobCapacity = 0;
    for (const mesh of this.uavMeshes.values()) {
      blobCapacity += mesh.instanceMatrix.count;
    }
    this.blobShadowMesh = createBlobShadowMesh(blobCapacity);
    this.uavWriter = new UavInstanceWriter(this.uavMeshes, DEFAULT_VEHICLE_TYPE_CODE, this.blobShadowMesh, this.surfaceHeightAt);
    this.initializeStaticUavBoundingSphere();
    this.controlPane = this.createControlPane(options.panel);
    this.readouts = createReadoutPanels(options.panel);
    writeStaticSceneReadouts(this.readouts, this.sceneData);
    this.corridorLabelNodes = createCorridorLabels(this.sceneData.corridors, this.labelLayer);
    this.labelNodes = createUavLabels();

    this.buildScene();
    mountStatsPanel(this.host, this.performanceStats);
    this.resize();
  }

  /** Registers window/canvas event listeners and kicks off the render loop. */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.cameraRig.handleKeyDown);
    window.addEventListener("keyup", this.cameraRig.handleKeyUp);
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("contextmenu", this.handleContextMenu);
    this.telemetrySource?.start();
    this.clock.start();
    this.animate();
  }

  /** Stops rendering, detaches DOM/event handlers, and releases GPU resources before scene recreation. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.animationFrame !== 0) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }

    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.cameraRig.handleKeyDown);
    window.removeEventListener("keyup", this.cameraRig.handleKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("contextmenu", this.handleContextMenu);
    this.telemetrySource?.stop();
    this.controls.dispose();
    this.controlPane.dispose();
    this.performanceStats.dom.remove();
    this.clearUavLabels();
    this.labelLayer.replaceChildren();
    this.panel.replaceChildren();
    this.disposeSceneResources();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** One-time scene assembly: background, fog, initial camera framing, and all geometry groups. */
  private buildScene(): void {
    this.scene.background = new THREE.Color(SCENE_BACKGROUND_COLOR);
    this.scene.fog = new THREE.Fog(SCENE_BACKGROUND_COLOR, SCENE_FOG_NEAR_METERS, SCENE_FOG_FAR_METERS);

    // The ground plane (and grid) extend past the scene bounds so the clipped map is not flush with the edge.
    this.scene.add(
      createLightingGroup(this.sceneData.sceneBounds),
      createSkyDome(),
      createGroundGroup(this.gridBounds),
      this.grid,
      this.roadGroup,
      this.treeGroup,
      this.vertiportGroup,
      this.contingencySiteGroup,
      this.cnsSiteLayer.root,
      this.corridorGroup,
      this.envelopeGroup,
      this.routeGroup,
      this.buildingGroup,
    );
    this.uavMeshes.forEach((mesh) => this.scene.add(mesh));
    this.scene.add(this.blobShadowMesh);

    this.layerAirspaceAboveGroundIcons();
  }

  /** Builds one InstancedMesh per vehicle type, using each type's loaded model (or a cone fallback). */
  private createUavMeshes(models: Map<number, UavModel> | null): Map<number, THREE.InstancedMesh> {
    const meshes = new Map<number, THREE.InstancedMesh>();
    for (const code of Object.keys(DRONE_MODEL_PATHS_BY_TYPE).map(Number)) {
      // The default type also carries the demo fleet, so size it for whichever roster is larger.
      const capacity = code === DEFAULT_VEHICLE_TYPE_CODE
        ? Math.max(this.demoSource.fleetSize, TELEMETRY_UAV_MESH_CAPACITY)
        : TELEMETRY_UAV_MESH_CAPACITY;
      const model = models?.get(code) ?? null;
      const mesh = createUavMesh(capacity, model?.geometry ?? null, model?.materials ?? null);
      mesh.count = 0;
      mesh.frustumCulled = false; // Drones span the scene; a static bounding sphere drives raycasting instead.
      meshes.set(code, mesh);
    }
    return meshes;
  }

  /** Resolves a raycast-hit InstancedMesh back to its vehicle type code, defaulting if it isn't a UAV mesh. */
  private typeCodeForMesh(object: THREE.Object3D): number {
    for (const [code, mesh] of this.uavMeshes) {
      if (mesh === object) {
        return code;
      }
    }
    return DEFAULT_VEHICLE_TYPE_CODE;
  }

  /**
   * Lifts the airspace layer (drones, corridors, routes, envelopes) above the ground icon markers
   * (vertiports and CNS sites) in render order. The markers draw with depthTest off so buildings can't
   * hide them; pushing the airspace meshes to a later renderOrder makes them draw after — and depth-test
   * against — the markers, so a drone or corridor in front of a marker still occludes it. Group nodes
   * don't inherit renderOrder, so this is applied per object. Map geometry stays at the default 0,
   * leaving it below the markers.
   */
  private layerAirspaceAboveGroundIcons(): void {
    this.uavMeshes.forEach((mesh) => {
      mesh.renderOrder = AIRSPACE_RENDER_ORDER;
    });
    [this.corridorGroup, this.envelopeGroup, this.routeGroup].forEach((group) => {
      group.traverse((object) => {
        object.renderOrder = AIRSPACE_RENDER_ORDER;
      });
    });
  }

  /** Mounts the control panel while keeping scene mutations inside FleetScene. */
  private createControlPane(panel: HTMLElement): Pane {
    return createSimulationControls({
      container: panel,
      state: this.params,
      availableLayers: {
        contingencySites: this.contingencySiteGroup.children.length > 0,
        cnsSites: this.cnsSiteLayer.iconGroups.length > 0,
        buildings: this.buildingGroup.children.length > 0,
        roads: this.roadGroup.children.length > 0,
        trees: this.treeGroup.children.length > 0,
      },
      formatSpeed: (speedLevelIndex) => `${this.getSimulationSpeed(speedLevelIndex)}x`,
      normalizeSpeedLevelIndex: (speedLevelIndex) => this.toSpeedLevelIndex(speedLevelIndex),
      onRunningChange: (running) => this.telemetrySource?.setRunning(running),
      onSpeedChange: (speedLevelIndex) => this.telemetrySource?.setSpeed(this.getSimulationSpeed(speedLevelIndex)),
      onLayerVisibilityChange: (visibility) => this.applyLayerVisibility(visibility),
      onResetView: () => this.cameraRig.resetView(),
      onResetSimulation: () => this.resetSimulation(),
      onReloadScene: this.onReloadScene,
      onLoadDemoPreset: this.onLoadDemoPreset,
      onShadowsToggle: (enabled) => this.applyShadowsEnabled(enabled),
      onGridSpacingChange: (spacingMeters) => this.setGridSpacing(spacingMeters),
    });
  }

  /** Enables or disables shadow rendering, recompiling materials so the change takes effect at runtime. */
  private applyShadowsEnabled(enabled: boolean): void {
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = true;
    // Drone shadows are a separate decal layer, not the shadow map, so the toggle must hide them explicitly
    // for "Shadows" to govern every shadow in the scene.
    this.blobShadowMesh.visible = enabled;
    // Whether a material samples the shadow map is baked into its compiled shader program, so existing
    // materials must be flagged for recompile; otherwise toggling shadowMap.enabled has no visible effect.
    this.scene.traverse((object) => {
      const material = (object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(material)) {
        material.forEach((entry) => (entry.needsUpdate = true));
      } else if (material) {
        material.needsUpdate = true;
      }
    });
  }

  /** Applies visibility toggles from the control panel to the corresponding scene groups. */
  private applyLayerVisibility(visibility: LayerVisibilityState): void {
    this.vertiportGroup.visible = visibility.vertiportsVisible;
    this.contingencySiteGroup.visible = visibility.contingencySitesVisible;
    // The CNS mode picks one dome treatment; markers and rings (directly on the root) serve both.
    this.cnsSiteLayer.root.visible = visibility.cnsSitesMode !== "off";
    this.cnsSiteLayer.intensityGroup.visible = visibility.cnsSitesMode === "intensity";
    this.cnsSiteLayer.coverageGroup.visible = visibility.cnsSitesMode === "coverage";
    this.corridorGroup.visible = visibility.corridorsVisible;
    // Corridor envelope follows its own toggle but hides while routes are shown (the two are exclusive).
    this.envelopeGroup.visible = visibility.envelopesVisible && !visibility.routesVisible;
    // The route group's overall visibility and per-route selection are driven per-frame in updateRouteVisibility.
    this.buildingGroup.visible = visibility.buildingsVisible;
    this.roadGroup.visible = visibility.roadsVisible;
    this.treeGroup.visible = visibility.treesVisible;
    this.grid.visible = visibility.gridVisible;
  }

  /** Rebuilds the grid's line geometry at a new spacing (meters), disposing the old geometry. */
  private setGridSpacing(spacingMeters: number): void {
    this.grid.geometry.dispose();
    this.grid.geometry = buildGridGeometry(this.gridBounds, spacingMeters);
  }

  /** Resets mutable simulation state while preserving loaded scene assets and control bindings. */
  private resetSimulation(): void {
    this.elapsedSeconds = 0;
    this.demoSource.reset();
    this.telemetrySource?.reset();
    this.activeSource = this.demoSource;
    this.lastFrame = null;
    this.uavMeshes.forEach((mesh) => {
      mesh.count = 0;
    });
    this.params.selectedUavId = "";
    this.clearUavLabels();
    this.cameraRig.resetToInitialFrame();
  }

  /** Returns the simulation-speed multiplier for the given speed-level slider index. */
  private getSimulationSpeed(speedLevelIndex = this.params.speedLevelIndex): number {
    return SIMULATION_SPEED_LEVELS[this.toSpeedLevelIndex(speedLevelIndex)] ?? SIMULATION_SPEED_LEVELS[0];
  }

  /** Rounds and clamps a raw slider value into a valid SIMULATION_SPEED_LEVELS index. */
  private toSpeedLevelIndex(speedLevelIndex: number): number {
    return Math.min(Math.max(Math.round(speedLevelIndex), 0), SIMULATION_SPEED_LEVELS.length - 1);
  }

  /** Per-frame loop: advances sim time, updates fleet/camera/labels, then renders. Bound as arrow for rAF. */
  private animate = (): void => {
    if (this.disposed) {
      return;
    }
    this.animationFrame = window.requestAnimationFrame(this.animate);
    this.performanceStats.begin();
    const delta = Math.min(this.clock.getDelta(), FRAME_DELTA_MAX_SECONDS);

    if (this.params.running) {
      this.elapsedSeconds += delta * this.getSimulationSpeed();
    }

    this.updateFleet();
    this.updateRouteVisibility();
    this.cameraRig.update(delta, this.lastFrame?.selection ?? null);
    updateGroundIconBillboards(this.vertiportGroup, this.camera);
    updateGroundIconBillboards(this.contingencySiteGroup, this.camera);
    for (const iconGroup of this.cnsSiteLayer.iconGroups) {
      updateGroundIconBillboards(iconGroup, this.camera);
    }
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
    this.updateHudStats();
    updateReadoutPanels(this.readouts, {
      simTimeSeconds: this.lastFrame?.simTimeSeconds ?? this.elapsedSeconds,
      cameraPosition: this.camera.position,
      cameraTarget: this.controls.target,
      telemetry: this.telemetrySource?.debugReadout() ?? null,
    });
    this.performanceStats.end();
  };

  /** Runs telemetry when it has a live frame, otherwise the demo fleet, and adopts the frame's selection state. */
  private updateFleet(): void {
    const ctx: FleetFrameContext = {
      writer: this.uavWriter,
      elapsedSeconds: this.elapsedSeconds,
      selectedUavId: this.params.selectedUavId,
    };
    const telemetryFrame = this.telemetrySource?.update(ctx) ?? null;
    const frame = telemetryFrame ?? this.demoSource.update(ctx);
    this.activeSource = telemetryFrame ? (this.telemetrySource as FleetSource) : this.demoSource;
    this.lastFrame = frame;
    this.params.selectedUavId = frame.selectedUavId;
  }

  /**
   * Shows only the selected UAV's route while the Route toggle is on: the group is hidden entirely
   * unless routes are enabled, and within it only the `route:<selectedRouteId>` subgroup stays visible.
   * Within the visible subgroup the centerline always shows while its envelope child follows the
   * Envelopes toggle — the corridor and route envelopes share that one switch, which is unambiguous
   * because the corridor and route layers are mutually exclusive. With nothing selected, no route is shown.
   */
  private updateRouteVisibility(): void {
    if (!this.params.routesVisible) {
      this.routeGroup.visible = false;
      return;
    }

    this.routeGroup.visible = true;
    const selectedRouteId = this.lastFrame?.selectedRouteId ?? null;
    const targetName = selectedRouteId === null ? null : `route:${selectedRouteId}`;
    for (const subgroup of this.routeGroup.children) {
      subgroup.visible = subgroup.name === targetName;
      const envelope = subgroup.getObjectByName(ROUTE_ENVELOPE_CHILD_NAME);
      if (envelope) {
        envelope.visible = this.params.envelopesVisible;
      }
    }
  }

  /** Detaches every cached UAV label DOM node and clears the lookup map. */
  private clearUavLabels(): void {
    this.labelNodes.forEach((label) => {
      label.remove();
    });
    this.labelNodes.clear();
  }

  /** Projects 3D anchors to screen pixels and updates each corridor/UAV label's CSS transform. */
  private updateLabels(): void {
    const corridorLabelsHidden =
      !this.params.uavLabelsVisible || (!this.params.corridorsVisible && !this.params.envelopesVisible);
    // Corridor anchors are static, so re-projecting them while the camera is idle is pure DOM-write waste,
    // and the per-label setStyle calls dominate this path. The camera matrix compared here is the same state
    // the projection consumes, so skipping equal frames is output-identical.
    const reprojectCorridorLabels =
      this.corridorLabelsDirty ||
      corridorLabelsHidden !== this.lastCorridorLabelsHidden ||
      !this.lastLabelCameraMatrix.equals(this.camera.matrixWorld);
    if (reprojectCorridorLabels) {
      this.corridorLabelsDirty = false;
      this.lastCorridorLabelsHidden = corridorLabelsHidden;
      this.lastLabelCameraMatrix.copy(this.camera.matrixWorld);
    }

    updateLabels({
      labelLayer: this.labelLayer,
      corridorLabelNodes: this.corridorLabelNodes,
      uavLabelNodes: this.labelNodes,
      selectedUavState: this.lastFrame?.selectedUavState ?? null,
      camera: this.camera,
      host: this.host,
      selectedUavId: this.params.selectedUavId,
      reprojectCorridorLabels,
      corridorLabelsHidden,
      uavLabelsVisible: this.params.uavLabelsVisible,
    });
  }

  /** Refreshes the HUD with simulation-facing state, keeping transport metrics in the debug panel. */
  private updateHudStats(): void {
    const frame = this.lastFrame;
    updateHud(this.hud, {
      running: this.params.running,
      speed: this.getSimulationSpeed(),
      activeCount: frame?.activeCount ?? 0,
      selectedSummary: frame?.selectedSummary ?? null,
    });
  }

  /**
   * Left-click toggles selection of the UAV under the cursor: raycast to an instance slot, ask the active
   * source for that slot's canonical id, then select it — or clear when it was already selected. This is
   * the single owner of the toggle/clear policy; sources only resolve slots to ids.
   */
  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const intersections = this.raycaster.intersectObjects(Array.from(this.uavMeshes.values()));
    const hit = intersections[0];
    const instanceId = hit?.instanceId;
    if (instanceId === undefined) {
      return;
    }

    const typeCode = this.typeCodeForMesh(hit.object);
    const hitUavId = this.activeSource.resolveId(typeCode, instanceId);
    if (hitUavId === null) {
      return;
    }
    this.params.selectedUavId = hitUavId === this.params.selectedUavId ? "" : hitUavId;
  };

  /** Suppresses the browser context menu so right-drag is free to rotate the orbit camera. */
  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  /** Disposes geometries and materials owned by the scene graph. */
  private disposeSceneResources(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();

    this.scene.traverse((object) => {
      const renderable = object as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };

      if (renderable.geometry) {
        geometries.add(renderable.geometry);
      }
      if (Array.isArray(renderable.material)) {
        renderable.material.forEach((material) => materials.add(material));
      } else if (renderable.material) {
        materials.add(renderable.material);
      }
    });

    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }

  /** Keeps the camera aspect ratio and renderer size in sync with the host element on resize. */
  private resize = (): void => {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    // Label projection depends on the viewport size, which the camera matrix can't detect.
    this.corridorLabelsDirty = true;
    // Fat centerlines (LineMaterial) need the viewport resolution to compute screen-space stroke width.
    const applyLineResolution = (object: THREE.Object3D): void => {
      const material = (object as Partial<{ material: { isLineMaterial?: boolean; resolution: THREE.Vector2 } }>).material;
      if (material?.isLineMaterial) {
        material.resolution.set(width, height);
      }
    };
    this.corridorGroup.traverse(applyLineResolution);
    this.routeGroup.traverse(applyLineResolution);
  };

  /** Covers every possible UAV position so InstancedMesh raycasting does not depend on stale moving-instance bounds. */
  private initializeStaticUavBoundingSphere(): void {
    const bounds = this.sceneData.sceneBounds;
    const uavMovementBounds = new THREE.Box3(
      toVector3(bounds.min),
      toVector3(bounds.max),
    );

    // sceneBounds is flat at y=0; expand by corridor points to give the sphere its vertical (altitude) extent.
    this.sceneData.corridors.forEach((corridor) => {
      corridor.points.forEach((point) => {
        uavMovementBounds.expandByPoint(toVector3(point));
      });
    });

    const movementSphere = new THREE.Sphere();
    uavMovementBounds.getBoundingSphere(movementSphere);

    this.uavMeshes.forEach((mesh) => {
      if (!mesh.geometry.boundingSphere) {
        mesh.geometry.computeBoundingSphere();
      }
      const sphere = movementSphere.clone();
      sphere.radius += mesh.geometry.boundingSphere?.radius ?? 0;
      mesh.boundingSphere = sphere;
    });
  }

}
