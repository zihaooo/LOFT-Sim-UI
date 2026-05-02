import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import Stats from "stats.js";
import { Pane } from "tweakpane";
import type { AirRoute, SceneData, UavState } from "../types";
import { createFleet, getUavRoutePosition } from "../simulation/fleet";
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
  HIDDEN_UAV_SCALE,
  INITIAL_CAMERA_HEIGHT_METERS,
  INITIAL_CAMERA_X_OFFSET_METERS,
  MAX_DEVICE_PIXEL_RATIO,
  ORBIT_DAMPING_FACTOR,
  ORBIT_MAX_DISTANCE_METERS,
  ORBIT_MIN_DISTANCE_METERS,
  ORBIT_MOUSE_BUTTONS,
  SCENE_BACKGROUND_COLOR,
  SCENE_FOG_FAR_METERS,
  SCENE_FOG_NEAR_METERS,
  SELECTED_UAV_COLOR,
  SIMULATION_SPEED_OPTIONS,
  WORLD_UP,
} from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { setUavYawQuaternion } from "../geometry/drone";
import { createUavMesh } from "../layer/drone";
import { createLightingGroup, createSkyDome } from "../layer/environment";
import { createBuildingGroup, createGroundGroup, createRoadGroup, createTreeGroup } from "../layer/map";
import { createFlightEnvelopeGroup, createRouteGroup } from "../layer/route";
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
};

type CameraMode = (typeof CAMERA_MODES)[keyof typeof CAMERA_MODES];

type ControlState = {
  running: boolean;
  speed: number;
  selectedUavId: string;
  cameraMode: CameraMode;
  routesVisible: boolean;
  envelopesVisible: boolean;
  buildingsVisible: boolean;
  roadsVisible: boolean;
  treesVisible: boolean;
  uavLabelsVisible: boolean;
};

export class FleetScene {
  private readonly host: HTMLDivElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly sceneData: SceneData;
  private readonly routeById: Map<string, AirRoute>;
  private readonly fleet: UavState[];
  private readonly fleetById: Map<string, UavState>;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly performanceStats = new Stats();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR_METERS, CAMERA_FAR_METERS);
  private readonly controls: OrbitControls;
  private readonly pane: Pane;
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly keys = new Set<string>();
  private readonly uavMesh: THREE.InstancedMesh;
  private readonly routeGroup: THREE.Group;
  private readonly envelopeGroup: THREE.Group;
  private readonly roadGroup: THREE.Group;
  private readonly treeGroup: THREE.Group;
  private readonly buildingGroup: THREE.Group;
  private readonly labelNodes: Map<string, HTMLDivElement>;
  private readonly routeLabelNodes: RouteLabelNode[];
  private readonly simulationClockValue: HTMLDivElement;
  private readonly cameraPositionValue: HTMLDivElement;
  private readonly cameraLookAtValue: HTMLDivElement;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly initialCameraPosition = new THREE.Vector3();
  private readonly initialTarget = new THREE.Vector3();

  private animationFrame = 0;
  private elapsedSeconds = 0;
  private selectedInstanceId = 0;
  private selectedPosition = new THREE.Vector3();
  private selectedTangent = new THREE.Vector3(1, 0, 0);
  private previousCameraMode: CameraMode = CAMERA_MODES.FREE;
  private previousSelectedUavId = "";
  private lastFollowPosition = new THREE.Vector3();
  private activeUavCount = 0;
  private readonly params: ControlState;

  /** Wires DOM hosts, builds the fleet from scene data, and configures renderer, controls, UI, and scene. */
  constructor(options: FleetSceneOptions) {
    this.host = options.host;
    this.labelLayer = options.labelLayer;
    this.stats = options.stats;
    this.sceneData = options.sceneData;
    this.routeById = new Map(this.sceneData.routes.map((route) => [route.id, route]));
    this.fleet = createFleet(this.sceneData.routes, this.sceneData.flows);
    this.fleetById = new Map(this.fleet.map((uav) => [uav.id, uav]));

    this.params = {
      running: true,
      speed: 1,
      selectedUavId: this.fleet[0]?.id ?? "",
      cameraMode: CAMERA_MODES.FREE,
      routesVisible: true,
      envelopesVisible: true,
      buildingsVisible: true,
      roadsVisible: true,
      treesVisible: true,
      uavLabelsVisible: false,
    };

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
    this.uavMesh = createUavMesh(this.fleet.length, options.uavGeometry ?? null);
    this.pane = new Pane({ container: options.panel, title: "Simulation Controls" });
    const readouts = createReadoutPanels(options.panel);
    this.simulationClockValue = readouts.simulationClockValue;
    this.cameraPositionValue = readouts.cameraPositionValue;
    this.cameraLookAtValue = readouts.cameraLookAtValue;
    this.routeLabelNodes = createRouteLabels(this.sceneData.routes, this.labelLayer);
    this.labelNodes = createUavLabels(this.fleet, this.labelLayer);

    this.buildScene();
    mountStatsPanel(this.host, this.performanceStats);
    this.createControls();
    this.resize();
  }

  /** Registers window/canvas event listeners and kicks off the render loop. */
  start(): void {
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("contextmenu", this.handleContextMenu);
    this.clock.start();
    this.animate();
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

  /** Wires Tweakpane bindings for play/speed/selection/visibility toggles and the reset button. */
  private createControls(): void {
    this.pane.addBinding(this.params, "running", { label: "Play" });
    this.pane.addBinding(this.params, "speed", {
      label: "Speed",
      options: SIMULATION_SPEED_OPTIONS,
    });

    this.pane
      .addBinding(this.params, "selectedUavId", {
        label: "UAV",
        options: Object.fromEntries(this.fleet.map((uav) => [uav.id, uav.id])),
      })
      .on("change", () => {
        this.selectedInstanceId = Math.max(
          0,
          this.fleet.findIndex((uav) => uav.id === this.params.selectedUavId),
        );
      });

    this.pane.addBinding(this.params, "cameraMode", {
      label: "Camera",
      options: {
        Free: CAMERA_MODES.FREE,
        Follow: CAMERA_MODES.FOLLOW_SELECTED_UAV,
      },
    });

    this.pane.addBinding(this.params, "routesVisible", { label: "Routes" }).on("change", () => {
      this.routeGroup.visible = this.params.routesVisible;
    });
    this.pane.addBinding(this.params, "envelopesVisible", { label: "Envelopes" }).on("change", () => {
      this.envelopeGroup.visible = this.params.envelopesVisible;
    });
    this.pane.addBinding(this.params, "buildingsVisible", { label: "Buildings" }).on("change", () => {
      this.buildingGroup.visible = this.params.buildingsVisible;
    });
    this.pane.addBinding(this.params, "roadsVisible", { label: "Roads" }).on("change", () => {
      this.roadGroup.visible = this.params.roadsVisible;
    });
    this.pane.addBinding(this.params, "treesVisible", { label: "Trees" }).on("change", () => {
      this.treeGroup.visible = this.params.treesVisible;
    });
    this.pane.addBinding(this.params, "uavLabelsVisible", { label: "Labels" });
    this.pane.addButton({ title: "Reset simulation" }).on("click", () => {
      this.elapsedSeconds = 0;
      this.params.cameraMode = CAMERA_MODES.FREE;
      this.camera.position.copy(this.initialCameraPosition);
      this.controls.target.copy(this.initialTarget);
      this.pane.refresh();
    });
  }

  /** Per-frame loop: advances sim time, updates fleet/camera/labels, then renders. Bound as arrow for rAF. */
  private animate = (): void => {
    this.animationFrame = window.requestAnimationFrame(this.animate);
    this.performanceStats.begin();
    const delta = Math.min(this.clock.getDelta(), FRAME_DELTA_MAX_SECONDS);

    if (this.params.running) {
      this.elapsedSeconds += delta;
    }

    this.applyKeyboardNavigation(delta);
    this.updateFleetInstances();
    this.updateCameraMode();
    this.controls.update();
    this.constrainCameraAboveHorizon();
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
    this.updateStats();
    this.updateReadoutPanels();
    this.performanceStats.end();
  };

  /** Re-samples each UAV's position/orientation and writes its instance matrix and tint color. */
  private updateFleetInstances(): void {
    const routeColor = new THREE.Color();
    const selectedColor = new THREE.Color(SELECTED_UAV_COLOR);
    this.activeUavCount = 0;

    this.fleet.forEach((uav, index) => {
      const route = this.routeById.get(uav.routeId);
      if (!route) {
        return;
      }

      const sampled = getUavRoutePosition(uav, route, this.elapsedSeconds, this.params.speed);
      const position = toVector3(sampled.position);
      const tangent = toVector3(sampled.tangent).normalize();

      if (!sampled.active) {
        this.matrix.compose(position, this.quaternion.identity(), HIDDEN_UAV_SCALE);
        this.uavMesh.setMatrixAt(index, this.matrix);

        if (uav.id === this.params.selectedUavId) {
          this.selectedPosition.copy(position);
          this.selectedTangent.copy(tangent);
        }
        return;
      }

      this.activeUavCount += 1;
      setUavYawQuaternion(this.quaternion, tangent);
      this.matrix.compose(position, this.quaternion, this.scale);
      this.uavMesh.setMatrixAt(index, this.matrix);
      this.uavMesh.setColorAt(index, index === this.selectedInstanceId ? selectedColor : routeColor.set(route.color));

      if (uav.id === this.params.selectedUavId) {
        this.selectedPosition.copy(position);
        this.selectedTangent.copy(tangent);
      }
    });

    this.uavMesh.instanceMatrix.needsUpdate = true;
    if (this.uavMesh.instanceColor) {
      this.uavMesh.instanceColor.needsUpdate = true;
    }
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
      fleet: this.fleet,
      routeById: this.routeById,
      camera: this.camera,
      host: this.host,
      elapsedSeconds: this.elapsedSeconds,
      speed: this.params.speed,
      selectedUavId: this.params.selectedUavId,
      routesVisible: this.params.routesVisible,
      envelopesVisible: this.params.envelopesVisible,
      uavLabelsVisible: this.params.uavLabelsVisible,
    });
  }

  /** Refreshes the HUD stats line with run state, fleet/route/scene counts, and selected-UAV info. */
  private updateStats(): void {
    const selectedUav = this.fleetById.get(this.params.selectedUavId);
    const selectedRoute = selectedUav ? this.routeById.get(selectedUav.routeId) : undefined;
    const mode = this.params.running ? "Playing" : "Paused";
    const selectedText = selectedUav && selectedRoute
      ? `${selectedUav.id} · ${selectedUav.type} · ${selectedRoute.from} to ${selectedRoute.to}`
      : "No UAV selected";

    this.stats.textContent = `${mode} · ${this.params.speed}x · ${this.activeUavCount.toLocaleString()} active / ${this.fleet.length.toLocaleString()} scheduled UAVs · ${this.sceneData.routes.length} routes · ${this.sceneData.buildings.length.toLocaleString()} buildings · ${this.sceneData.roads.length.toLocaleString()} roads · ${this.sceneData.trees.length.toLocaleString()} trees · ${selectedText}`;
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
    if (instanceId === undefined || !this.fleet[instanceId]) {
      return;
    }

    this.selectedInstanceId = instanceId;
    this.params.selectedUavId = this.fleet[instanceId].id;
    this.pane.refresh();
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

  /** Keeps the camera aspect ratio and renderer size in sync with the host element on resize. */
  private resize = (): void => {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

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

  /** Refreshes the sim-clock and camera-debug readouts each frame from current state. */
  private updateReadoutPanels(): void {
    this.simulationClockValue.textContent = formatSimulationTime(this.elapsedSeconds);
    this.cameraPositionValue.textContent = formatVector(this.camera.position);
    this.cameraLookAtValue.textContent = formatVector(this.controls.target);
  }
}
