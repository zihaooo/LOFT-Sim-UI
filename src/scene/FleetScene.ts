import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import Stats from "stats.js";
import type { Pane } from "tweakpane";
import type { AirRoute, SceneData, UavSchedule, UavState } from "../types";
import { createFleet, getUavRoutePosition } from "../animation/fleet";
import {
  CAMERA_FAR_METERS,
  CAMERA_FOV_DEGREES,
  CAMERA_MIN_Y,
  CAMERA_MODES,
  CAMERA_NEAR_METERS,
  FOLLOW_CAMERA_DISTANCE_METERS,
  FOLLOW_CAMERA_HEIGHT_METERS,
  FRAME_DELTA_MAX_SECONDS,
  FREE_CAMERA_PAN_METERS_PER_SECOND,
  INITIAL_CAMERA_HEIGHT_METERS,
  INITIAL_CAMERA_X_OFFSET_METERS,
  MAX_DEVICE_PIXEL_RATIO,
  ORBIT_DAMPING_FACTOR,
  ORBIT_MAX_DISTANCE_METERS,
  ORBIT_MIN_DISTANCE_METERS,
  ORBIT_MOUSE_BUTTONS,
  ROUTE_COLORS,
  SCENE_BACKGROUND_COLOR,
  SCENE_FOG_FAR_METERS,
  SCENE_FOG_NEAR_METERS,
  SELECTED_UAV_COLOR,
  SIMULATION_SPEED_LEVELS,
  TELEMETRY_UAV_MESH_CAPACITY,
  WORLD_UP,
} from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { setUavYawQuaternion } from "../geometry/drone";
import { createUavMesh } from "../layer/drone";
import { TelemetryClient } from "../telemetry/client";
import type { TelemetryDroneState, TelemetrySnapshot } from "../telemetry/protocol";
import { createLightingGroup, createSkyDome } from "../layer/environment";
import { createBuildingGroup, createGroundGroup, createRoadGroup, createTreeGroup } from "../layer/map";
import { createFlightEnvelopeGroup, createRouteGroup } from "../layer/route";
import {
  createDefaultControlState,
  createSimulationControls,
  type CameraMode,
  type ConfigFileSelection,
  type DemoPreset,
  type LayerVisibilityState,
  type SimulationControlState,
} from "./control";
import { createRouteLabels, createUavLabels, updateLabels, type RouteLabelNode } from "./labels";
import { createReadoutPanels, formatSimulationTime, formatVector, mountStatsPanel } from "./readouts";

export { loadDroneGeometry } from "../geometry/drone";

type FleetSceneOptions = {
  host: HTMLDivElement;
  panel: HTMLDivElement;
  labelLayer: HTMLDivElement;
  stats: HTMLDivElement;
  sceneData: SceneData;
  uavGeometry?: THREE.BufferGeometry | null;
  onReloadScene: (files: ConfigFileSelection) => Promise<void>;
  onLoadDemoPreset: (preset: DemoPreset | null) => Promise<void>;
  activeDemoPreset?: DemoPreset | null;
  telemetryUrl?: string;
};

export class FleetScene {
  private readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly sceneData: SceneData;
  private readonly onReloadScene: (files: ConfigFileSelection) => Promise<void>;
  private readonly onLoadDemoPreset: (preset: DemoPreset | null) => Promise<void>;
  private readonly routeById: Map<string, AirRoute>;
  private readonly fleet: UavSchedule[];
  private readonly fleetById: Map<string, UavSchedule>;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly performanceStats = new Stats();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR_METERS, CAMERA_FAR_METERS);
  private readonly controls: OrbitControls;
  private readonly controlPane: Pane;
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly keys = new Set<string>();
  private readonly telemetryClient: TelemetryClient | null;
  private readonly uavMesh: THREE.InstancedMesh;
  private readonly routeGroup: THREE.Group;
  private readonly envelopeGroup: THREE.Group;
  private readonly roadGroup: THREE.Group;
  private readonly treeGroup: THREE.Group;
  private readonly buildingGroup: THREE.Group;
  private readonly labelNodes: Map<string, HTMLDivElement>;
  private readonly routeLabelNodes: RouteLabelNode[];
  private readonly pendingUavIndices: number[];
  private readonly activeUavIndices: number[] = [];
  private readonly uavStateById = new Map<string, UavState>();
  private readonly renderSlotToFleetIndex: number[] = [];
  private readonly renderSlotToTelemetryHandle: number[] = [];
  private readonly simulationClockValue: HTMLElement;
  private readonly sceneRoutesValue: HTMLElement;
  private readonly sceneBuildingsValue: HTMLElement;
  private readonly sceneRoadsValue: HTMLElement;
  private readonly sceneTreesValue: HTMLElement;
  private readonly cameraPositionValue: HTMLElement;
  private readonly cameraLookAtValue: HTMLElement;
  private readonly telemetryConnectionValue: HTMLElement;
  private readonly telemetryFrequencyValue: HTMLElement;
  private readonly telemetrySequenceValue: HTMLElement;
  private readonly telemetryAgeValue: HTMLElement;
  private readonly telemetryParseValue: HTMLElement;
  private readonly telemetrySkippedValue: HTMLElement;
  private readonly telemetryErrorValue: HTMLElement;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly selectedColor = new THREE.Color(SELECTED_UAV_COLOR);
  private readonly telemetryRouteColor = new THREE.Color();
  private readonly telemetryPosition = new THREE.Vector3();
  private readonly telemetryTangent = new THREE.Vector3(1, 0, 0);
  private readonly initialCameraPosition = new THREE.Vector3();
  private readonly initialTarget = new THREE.Vector3();

  private elapsedSeconds = 0;
  private selectedInstanceId = -1;
  private selectedTelemetryHandle = -1;
  private selectedPosition = new THREE.Vector3();
  private selectedTangent = new THREE.Vector3(1, 0, 0);
  private previousCameraMode: CameraMode = CAMERA_MODES.FREE;
  private previousSelectedUavId = "";
  private lastFollowPosition = new THREE.Vector3();
  private activeUavCount = 0;
  private nextPendingUavIndex = 0;
  private animationFrame = 0;
  private started = false;
  private disposed = false;
  private readonly params: SimulationControlState;

  /** Wires DOM hosts, builds the fleet from scene data, and configures renderer, controls, UI, and scene. */
  constructor(options: FleetSceneOptions) {
    this.host = options.host;
    this.panel = options.panel;
    this.labelLayer = options.labelLayer;
    this.stats = options.stats;
    this.sceneData = options.sceneData;
    this.onReloadScene = options.onReloadScene;
    this.onLoadDemoPreset = options.onLoadDemoPreset;
    this.routeById = new Map(this.sceneData.routes.map((route) => [route.id, route]));
    this.fleet = createFleet(this.sceneData.routes, this.sceneData.flows);
    this.fleetById = new Map(this.fleet.map((uav) => [uav.id, uav]));
    this.telemetryClient = options.telemetryUrl
      ? new TelemetryClient({ url: options.telemetryUrl, frontendOrigin: this.sceneData.origin })
      : null;
    this.pendingUavIndices = this.fleet
      .map((_, index) => index)
      .sort((a, b) => this.fleet[a].departureTimeSeconds - this.fleet[b].departureTimeSeconds);

    this.params = createDefaultControlState(options.activeDemoPreset ?? null);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO));
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = ORBIT_DAMPING_FACTOR;
    this.controls.maxDistance = ORBIT_MAX_DISTANCE_METERS;
    this.controls.minDistance = ORBIT_MIN_DISTANCE_METERS;
    this.controls.screenSpacePanning = false;
    this.controls.mouseButtons = ORBIT_MOUSE_BUTTONS;

    this.roadGroup = createRoadGroup(this.sceneData.roads, this.sceneData.mapBounds);
    this.treeGroup = createTreeGroup(this.sceneData.trees);
    this.buildingGroup = createBuildingGroup(this.sceneData.buildings);
    this.routeGroup = createRouteGroup(this.sceneData.routes);
    this.envelopeGroup = createFlightEnvelopeGroup(this.sceneData.routes);
    this.uavMesh = createUavMesh(Math.max(this.fleet.length, TELEMETRY_UAV_MESH_CAPACITY), options.uavGeometry ?? null);
    this.uavMesh.count = 0;
    this.uavMesh.frustumCulled = false; // All drones are in a single InstancedMesh frustumCulled is not necessary right now.
    this.initializeStaticUavBoundingSphere();
    this.controlPane = this.createControlPane(options.panel);
    const readouts = createReadoutPanels(options.panel);
    this.simulationClockValue = readouts.simulationClockValue;
    this.sceneRoutesValue = readouts.sceneRoutesValue;
    this.sceneBuildingsValue = readouts.sceneBuildingsValue;
    this.sceneRoadsValue = readouts.sceneRoadsValue;
    this.sceneTreesValue = readouts.sceneTreesValue;
    this.cameraPositionValue = readouts.cameraPositionValue;
    this.cameraLookAtValue = readouts.cameraLookAtValue;
    this.telemetryConnectionValue = readouts.telemetryConnectionValue;
    this.telemetryFrequencyValue = readouts.telemetryFrequencyValue;
    this.telemetrySequenceValue = readouts.telemetrySequenceValue;
    this.telemetryAgeValue = readouts.telemetryAgeValue;
    this.telemetryParseValue = readouts.telemetryParseValue;
    this.telemetrySkippedValue = readouts.telemetrySkippedValue;
    this.telemetryErrorValue = readouts.telemetryErrorValue;
    this.routeLabelNodes = createRouteLabels(this.sceneData.routes, this.labelLayer);
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
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("contextmenu", this.handleContextMenu);
    this.telemetryClient?.start();
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
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("contextmenu", this.handleContextMenu);
    this.telemetryClient?.stop();
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

    this.setInitialCameraFrame();

    this.scene.add(
      createLightingGroup(),
      createSkyDome(),
      createGroundGroup(this.sceneData.mapBounds),
      this.roadGroup,
      this.treeGroup,
      this.routeGroup,
      this.envelopeGroup,
      this.buildingGroup,
      this.uavMesh,
    );
  }

  /** Mounts the control panel while keeping scene mutations inside FleetScene. */
  private createControlPane(panel: HTMLElement): Pane {
    return createSimulationControls({
      container: panel,
      state: this.params,
      formatSpeed: (speedLevelIndex) => `${this.getSimulationSpeed(speedLevelIndex)}x`,
      normalizeSpeedLevelIndex: (speedLevelIndex) => this.toSpeedLevelIndex(speedLevelIndex),
      onRunningChange: (running) => this.telemetryClient?.setRunning(running),
      onLayerVisibilityChange: (visibility) => this.applyLayerVisibility(visibility),
      onResetSimulation: () => this.resetSimulation(),
      onReloadScene: this.onReloadScene,
      onLoadDemoPreset: this.onLoadDemoPreset,
    });
  }

  /** Applies visibility toggles from the control panel to the corresponding scene groups. */
  private applyLayerVisibility(visibility: LayerVisibilityState): void {
    this.routeGroup.visible = visibility.routesVisible;
    this.envelopeGroup.visible = visibility.envelopesVisible;
    this.buildingGroup.visible = visibility.buildingsVisible;
    this.roadGroup.visible = visibility.roadsVisible;
    this.treeGroup.visible = visibility.treesVisible;
  }

  /** Resets mutable simulation state while preserving loaded scene assets and control bindings. */
  private resetSimulation(): void {
    this.elapsedSeconds = 0;
    this.nextPendingUavIndex = 0;
    this.activeUavIndices.length = 0;
    this.uavStateById.clear();
    this.renderSlotToFleetIndex.length = 0;
    this.renderSlotToTelemetryHandle.length = 0;
    this.uavMesh.count = 0;
    this.clearSelectedUav();
    this.clearUavLabels();
    this.params.cameraMode = CAMERA_MODES.FREE;
    this.camera.position.copy(this.initialCameraPosition);
    this.controls.target.copy(this.initialTarget);
  }

  private clearSelectedUav(): void {
    this.selectedInstanceId = -1;
    this.selectedTelemetryHandle = -1;
    this.params.selectedUavId = "";
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

    this.applyKeyboardNavigation(delta);
    this.updateFleetInstances();
    this.updateCameraMode();
    this.controls.update();
    this.constrainCameraAboveHorizon();
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
    this.updateHudStats();
    this.updateReadoutPanels();
    this.performanceStats.end();
  };

  /** Promotes any pending UAVs whose departure time has been reached into the active set. */
  private activateDepartedUavs(): void {
    while (this.nextPendingUavIndex < this.pendingUavIndices.length) {
      const fleetIndex = this.pendingUavIndices[this.nextPendingUavIndex];
      const uav = this.fleet[fleetIndex];
      if (uav.departureTimeSeconds > this.elapsedSeconds) {
        break;
      }

      this.activeUavIndices.push(fleetIndex);
      this.nextPendingUavIndex += 1;
    }
  }

  /** O(1) removal from the active list by swapping the last entry into the freed slot. */
  private removeActiveUavAt(activeIndex: number): void {
    const lastIndex = this.activeUavIndices.pop();
    if (lastIndex !== undefined && activeIndex < this.activeUavIndices.length) {
      this.activeUavIndices[activeIndex] = lastIndex;
    }
  }

  /** Detaches every cached UAV label DOM node and clears the lookup map. */
  private clearUavLabels(): void {
    this.labelNodes.forEach((label) => {
      label.remove();
    });
    this.labelNodes.clear();
  }

  /** Updates each active UAV's position/orientation and writes its instance matrix and tint color. */
  private updateFleetInstances(): void {
    const telemetrySnapshot = this.telemetryClient?.latestSnapshot();
    if (telemetrySnapshot) {
      this.updateTelemetryInstances(telemetrySnapshot);
      return;
    }

    this.updateDemoInstances();
  }

  /** Renders the frontend-only demo fleet generated from local flow definitions. */
  private updateDemoInstances(): void {
    const routeColor = new THREE.Color();
    const selectedColor = new THREE.Color(SELECTED_UAV_COLOR);
    this.activateDepartedUavs();
    this.uavStateById.clear();
    this.activeUavCount = 0;
    this.renderSlotToTelemetryHandle.length = 0;

    for (let activeIndex = 0; activeIndex < this.activeUavIndices.length;) {
      const index = this.activeUavIndices[activeIndex];
      const uav = this.fleet[index];
      const route = this.routeById.get(uav.routeId);
      if (!route) {
        this.removeActiveUavAt(activeIndex);
        continue;
      }

      const uavState = getUavRoutePosition(uav, route, this.elapsedSeconds, 1);
      const position = toVector3(uavState.position);
      const tangent = toVector3(uavState.tangent).normalize();

      if (uavState.status === "destroyed") {
        if (uav.id === this.params.selectedUavId) {
          this.selectedPosition.copy(position);
          this.selectedTangent.copy(tangent);
        }
        this.removeActiveUavAt(activeIndex);
        continue;
      }

      if (uavState.status !== "active") {
        activeIndex += 1;
        continue;
      }

      const renderSlot = this.activeUavCount;
      this.activeUavCount += 1;
      this.renderSlotToFleetIndex[renderSlot] = index;
      this.uavStateById.set(uav.id, uavState);
      setUavYawQuaternion(this.quaternion, tangent);
      this.matrix.compose(position, this.quaternion, this.scale);
      this.uavMesh.setMatrixAt(renderSlot, this.matrix);
      this.uavMesh.setColorAt(renderSlot, index === this.selectedInstanceId ? selectedColor : routeColor.set(route.color));

      if (uav.id === this.params.selectedUavId) {
        this.selectedPosition.copy(position);
        this.selectedTangent.copy(tangent);
      }
      activeIndex += 1;
    }

    this.renderSlotToFleetIndex.length = this.activeUavCount;
    this.uavMesh.count = this.activeUavCount;
    if (this.activeUavCount === 0) {
      return;
    }

    this.uavMesh.instanceMatrix.addUpdateRange(0, this.activeUavCount * 16);
    this.uavMesh.instanceMatrix.needsUpdate = true;
    if (this.uavMesh.instanceColor) {
      this.uavMesh.instanceColor.addUpdateRange(0, this.activeUavCount * 3);
      this.uavMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Renders backend telemetry snapshots directly, without frontend interpolation. */
  private updateTelemetryInstances(snapshot: TelemetrySnapshot): void {
    const capacity = this.uavMesh.instanceMatrix.count;
    this.uavStateById.clear();
    this.renderSlotToFleetIndex.length = 0;
    this.activeUavCount = 0;

    for (const drone of snapshot.drones) {
      if (this.activeUavCount >= capacity) {
        break;
      }
      if (drone.stateCode === 0) {
        continue;
      }

      const renderSlot = this.activeUavCount;
      this.activeUavCount += 1;
      this.renderSlotToTelemetryHandle[renderSlot] = drone.handle;

      this.telemetryPosition.set(drone.position.x, drone.position.y, drone.position.z);
      this.telemetryTangent.set(drone.velocity.x, drone.velocity.y, drone.velocity.z);
      if (this.telemetryTangent.lengthSq() < 0.0001) {
        this.telemetryTangent.set(1, 0, 0);
      } else {
        this.telemetryTangent.normalize();
      }

      const droneId = this.getTelemetryDroneId(drone);
      const isSelected = drone.handle === this.selectedTelemetryHandle || droneId === this.params.selectedUavId;
      setUavYawQuaternion(this.quaternion, this.telemetryTangent);
      this.matrix.compose(this.telemetryPosition, this.quaternion, this.scale);
      this.uavMesh.setMatrixAt(renderSlot, this.matrix);
      this.uavMesh.setColorAt(renderSlot, isSelected ? this.selectedColor : this.getTelemetryRouteColor(drone));

      if (isSelected) {
        this.params.selectedUavId = droneId;
        this.selectedPosition.copy(this.telemetryPosition);
        this.selectedTangent.copy(this.telemetryTangent);
        this.uavStateById.set(droneId, {
          position: drone.position,
          tangent: {
            x: this.telemetryTangent.x,
            y: this.telemetryTangent.y,
            z: this.telemetryTangent.z,
          },
          distance: 0,
          progress: 0,
          status: "active",
        });
      }
    }

    this.renderSlotToTelemetryHandle.length = this.activeUavCount;
    this.uavMesh.count = this.activeUavCount;
    if (this.activeUavCount === 0) {
      return;
    }

    this.uavMesh.instanceMatrix.addUpdateRange(0, this.activeUavCount * 16);
    this.uavMesh.instanceMatrix.needsUpdate = true;
    if (this.uavMesh.instanceColor) {
      this.uavMesh.instanceColor.addUpdateRange(0, this.activeUavCount * 3);
      this.uavMesh.instanceColor.needsUpdate = true;
    }
  }

  private getTelemetryDroneId(drone: TelemetryDroneState): string {
    return this.telemetryClient?.getRegistry().dronesByHandle.get(drone.handle)?.id ?? `D${drone.handle}`;
  }

  private getTelemetryRouteColor(drone: TelemetryDroneState): THREE.Color {
    const routeId = this.telemetryClient?.getRegistry().routesByHandle.get(drone.routeHandle)?.id;
    const route = routeId ? this.routeById.get(routeId) : undefined;
    return this.telemetryRouteColor.set(route?.color ?? ROUTE_COLORS[drone.routeHandle % ROUTE_COLORS.length]);
  }

  /** Switches between Free orbit and Follow modes; in Follow, snaps behind/above the UAV on entry then trails it. */
  private updateCameraMode(): void {
    const followEnabled = this.params.cameraMode === CAMERA_MODES.FOLLOW_SELECTED_UAV && Boolean(this.params.selectedUavId);
    const justEnteredFollow = followEnabled && this.previousCameraMode !== CAMERA_MODES.FOLLOW_SELECTED_UAV;
    const selectionChanged = this.params.selectedUavId !== this.previousSelectedUavId;
    this.controls.enabled = true;

    if (!followEnabled) {
      this.previousCameraMode = this.params.cameraMode;
      this.previousSelectedUavId = this.params.selectedUavId;
      return;
    }

    if (justEnteredFollow || selectionChanged) {
      const behind = this.selectedTangent.clone().multiplyScalar(-FOLLOW_CAMERA_DISTANCE_METERS);
      this.camera.position.copy(this.selectedPosition).add(behind).add(new THREE.Vector3(0, FOLLOW_CAMERA_HEIGHT_METERS, 0));
      this.controls.target.copy(this.selectedPosition);
    } else {
      const movement = this.selectedPosition.clone().sub(this.lastFollowPosition);
      this.camera.position.add(movement);
      this.controls.target.add(movement);
    }

    this.lastFollowPosition.copy(this.selectedPosition);
    this.previousCameraMode = this.params.cameraMode;
    this.previousSelectedUavId = this.params.selectedUavId;
  }

  /** Projects 3D anchors to screen pixels and updates each route/UAV label's CSS transform. */
  private updateLabels(): void {
    updateLabels({
      labelLayer: this.labelLayer,
      routeLabelNodes: this.routeLabelNodes,
      uavLabelNodes: this.labelNodes,
      uavStateById: this.uavStateById,
      camera: this.camera,
      host: this.host,
      selectedUavId: this.params.selectedUavId,
      routesVisible: this.params.routesVisible,
      envelopesVisible: this.params.envelopesVisible,
      uavLabelsVisible: this.params.uavLabelsVisible,
    });
  }

  /** Refreshes the HUD with simulation-facing state, keeping transport metrics in the debug panel. */
  private updateHudStats(): void {
    const telemetrySnapshot = this.telemetryClient?.latestSnapshot();
    const status = this.params.running ? "Playing" : "Paused";
    const selectedText = telemetrySnapshot
      ? this.getTelemetrySelectedText(telemetrySnapshot)
      : this.getDemoSelectedText();
    const parts = [
      `Status: ${status}`,
      `UAVs: ${this.activeUavCount.toLocaleString()} active`,
      `Routes: ${this.sceneData.routes.length.toLocaleString()}`,
      `Selected: ${selectedText}`,
    ];

    if (!telemetrySnapshot) {
      parts.splice(
        1,
        1,
        `Speed: ${this.getSimulationSpeed()}x`,
        `UAVs: ${this.activeUavCount.toLocaleString()} active / ${this.fleet.length.toLocaleString()} scheduled`,
      );
    }

    this.stats.textContent = parts.join(" · ");
  }

  private getDemoSelectedText(): string {
    const selectedUav = this.fleetById.get(this.params.selectedUavId);
    if (!selectedUav) {
      return "none";
    }

    const selectedRoute = this.routeById.get(selectedUav.routeId);
    const routeText = selectedRoute ? this.formatRouteSummary(selectedRoute) : `Route ${selectedUav.routeId}`;
    return `${selectedUav.id} · ${selectedUav.type} · ${routeText}`;
  }

  private getTelemetrySelectedText(snapshot: TelemetrySnapshot): string {
    const selectedDrone = this.getSelectedTelemetryDrone(snapshot);
    if (!selectedDrone) {
      return "none";
    }

    const droneId = this.getTelemetryDroneId(selectedDrone);
    const droneType = this.telemetryClient?.getRegistry().dronesByHandle.get(selectedDrone.handle)?.vehicleType
      ?? `type ${selectedDrone.vehicleTypeCode}`;
    const route = this.getTelemetryRoute(selectedDrone);
    const routeId = this.getTelemetryRouteId(selectedDrone);
    const routeText = route ? this.formatRouteSummary(route) : `Route ${routeId ?? selectedDrone.routeHandle}`;

    return `${droneId} · ${droneType} · ${routeText}`;
  }

  private getSelectedTelemetryDrone(snapshot: TelemetrySnapshot): TelemetryDroneState | undefined {
    return snapshot.drones.find((drone) => (
      drone.handle === this.selectedTelemetryHandle
      || this.getTelemetryDroneId(drone) === this.params.selectedUavId
    ));
  }

  private getTelemetryRouteId(drone: TelemetryDroneState): string | undefined {
    return this.telemetryClient?.getRegistry().routesByHandle.get(drone.routeHandle)?.id;
  }

  private getTelemetryRoute(drone: TelemetryDroneState): AirRoute | undefined {
    const routeId = this.getTelemetryRouteId(drone);
    return routeId ? this.routeById.get(routeId) : undefined;
  }

  private formatRouteSummary(route: AirRoute): string {
    if (route.from && route.to) {
      return `${route.from} to ${route.to}`;
    }
    if (route.from) {
      return `${route.from} to unknown`;
    }
    if (route.to) {
      return `unknown to ${route.to}`;
    }
    return route.name || `Route ${route.id}`;
  }

  /** WASD/arrow keys pan the camera (and orbit target) along the ground plane while in Free mode. */
  private applyKeyboardNavigation(delta: number): void {
    if (this.params.cameraMode !== CAMERA_MODES.FREE || this.keys.size === 0) {
      return;
    }

    const direction = new THREE.Vector3();
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize();

    if (this.keys.has("w") || this.keys.has("arrowup")) direction.add(forward);
    if (this.keys.has("s") || this.keys.has("arrowdown")) direction.sub(forward);
    if (this.keys.has("d") || this.keys.has("arrowright")) direction.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) direction.sub(right);

    if (direction.lengthSq() === 0) {
      return;
    }

    direction.normalize().multiplyScalar(FREE_CAMERA_PAN_METERS_PER_SECOND * delta);
    this.camera.position.add(direction);
    this.controls.target.add(direction);
  }

  /** Clamps the camera's height to CAMERA_MIN_Y so it can't drop below the ground plane. */
  private constrainCameraAboveHorizon(): void {
    if (this.camera.position.y < CAMERA_MIN_Y) {
      this.camera.position.y = CAMERA_MIN_Y;
    }
  }

  /** Left-click selects the UAV under the cursor via raycasting against the InstancedMesh. */
  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const intersections = this.raycaster.intersectObject(this.uavMesh);
    const instanceId = intersections[0]?.instanceId;
    const telemetryHandle = instanceId === undefined ? undefined : this.renderSlotToTelemetryHandle[instanceId];
    if (telemetryHandle !== undefined) {
      const droneId = this.telemetryClient?.getRegistry().dronesByHandle.get(telemetryHandle)?.id ?? `D${telemetryHandle}`;
      if (telemetryHandle === this.selectedTelemetryHandle || droneId === this.params.selectedUavId) {
        this.clearSelectedUav();
        return;
      }

      this.selectedTelemetryHandle = telemetryHandle;
      this.selectedInstanceId = -1;
      this.params.selectedUavId = droneId;
      return;
    }

    const fleetIndex = instanceId === undefined ? undefined : this.renderSlotToFleetIndex[instanceId];
    if (fleetIndex === undefined || !this.fleet[fleetIndex]) {
      return;
    }

    const uavId = this.fleet[fleetIndex].id;
    if (fleetIndex === this.selectedInstanceId || uavId === this.params.selectedUavId) {
      this.clearSelectedUav();
      return;
    }

    this.selectedTelemetryHandle = -1;
    this.selectedInstanceId = fleetIndex;
    this.params.selectedUavId = uavId;
  };

  /** Suppresses the browser context menu so right-drag is free to rotate the orbit camera. */
  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  /** Tracks held keys (lowercased) for keyboard navigation in the animate loop. */
  private handleKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.key.toLowerCase());
  };

  /** Releases held-key state when a key is lifted. */
  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
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
  };

  /** Covers every possible UAV position so InstancedMesh raycasting does not depend on stale moving-instance bounds. */
  private initializeStaticUavBoundingSphere(): void {
    const bounds = this.sceneData.mapBounds;
    const uavMovementBounds = new THREE.Box3(
      toVector3(bounds.min),
      toVector3(bounds.max),
    );

    this.sceneData.routes.forEach((route) => {
      route.points.forEach((point) => {
        uavMovementBounds.expandByPoint(toVector3(point));
      });
    });

    const boundingSphere = new THREE.Sphere();
    uavMovementBounds.getBoundingSphere(boundingSphere);

    if (!this.uavMesh.geometry.boundingSphere) {
      this.uavMesh.geometry.computeBoundingSphere();
    }
    boundingSphere.radius += this.uavMesh.geometry.boundingSphere?.radius ?? 0;
    this.uavMesh.boundingSphere = boundingSphere;
  }

  /** Starts at the middle of the ground plane's south edge, looking at the ground center. */
  private setInitialCameraFrame(): void {
    const bounds = this.sceneData.mapBounds;
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;

    this.initialTarget.set(centerX, 0, centerZ);
    // this.initialCameraPosition.set(bounds.min.x, 700, centerZ);
    this.initialCameraPosition.set(centerX + INITIAL_CAMERA_X_OFFSET_METERS, INITIAL_CAMERA_HEIGHT_METERS, centerZ);

    this.camera.position.copy(this.initialCameraPosition);
    this.controls.target.copy(this.initialTarget);
  }

  /** Refreshes simulation, scene, camera, and telemetry debug readouts each frame. */
  private updateReadoutPanels(): void {
    const telemetrySnapshot = this.telemetryClient?.latestSnapshot();
    this.simulationClockValue.textContent = formatSimulationTime(
      telemetrySnapshot?.simTimeSeconds ?? this.elapsedSeconds,
    );
    this.sceneRoutesValue.textContent = this.sceneData.routes.length.toLocaleString();
    this.sceneBuildingsValue.textContent = this.sceneData.buildings.length.toLocaleString();
    this.sceneRoadsValue.textContent = this.sceneData.roads.length.toLocaleString();
    this.sceneTreesValue.textContent = this.sceneData.trees.length.toLocaleString();
    this.cameraPositionValue.textContent = formatVector(this.camera.position);
    this.cameraLookAtValue.textContent = formatVector(this.controls.target);

    const telemetryStats = this.telemetryClient?.getStats();
    this.telemetryConnectionValue.textContent = telemetryStats?.connectionState ?? "disabled";
    this.telemetryFrequencyValue.textContent = telemetrySnapshot && telemetryStats
      ? `${telemetryStats.snapshotHz.toFixed(1)} Hz`
      : "-";
    this.telemetrySequenceValue.textContent = telemetrySnapshot ? String(telemetrySnapshot.sequence) : "-";
    this.telemetryAgeValue.textContent = telemetrySnapshot
      ? `${Math.max(0, performance.now() - telemetrySnapshot.receivedAtMs).toFixed(0)} ms`
      : "-";
    this.telemetryParseValue.textContent = telemetrySnapshot && telemetryStats
      ? `${telemetryStats.lastParseTimeMs.toFixed(2)} ms`
      : "-";
    this.telemetrySkippedValue.textContent = telemetrySnapshot && telemetryStats
      ? telemetryStats.droppedSnapshotCount.toLocaleString()
      : "-";
    this.telemetryErrorValue.textContent = telemetryStats?.lastError || "-";
  }
}
