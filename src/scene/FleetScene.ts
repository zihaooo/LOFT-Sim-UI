import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import Stats from "stats.js";
import { Pane } from "tweakpane";
import type { AirRoute, BuildingFootprint, RoadPath, SceneBounds, SceneData, ScenePoint, TreePoint, UavState } from "../types";
import { createFleet, getUavRoutePosition } from "../simulation/fleet";

type FleetSceneOptions = {
  host: HTMLDivElement;
  panel: HTMLDivElement;
  labelLayer: HTMLDivElement;
  stats: HTMLDivElement;
  sceneData: SceneData;
  uavGeometry?: THREE.BufferGeometry | null;
};

type CameraMode = "Free" | "Follow selected UAV";

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

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const HIDDEN_UAV_SCALE = new THREE.Vector3(0, 0, 0);
const LABEL_LIMIT = 140;
const ROUTE_LINE_RADIUS = 0.3;
const ROUTE_CONE_RADIUS = 1.2;
const ROUTE_CONE_HEIGHT = 3.2;
const ROAD_RENDER_Y = 0.1;
const CAMERA_MIN_Y = 0;
const DRONE_MODEL_CANDIDATES = ["/asset/model/drone.gltf"];
const DRONE_MODEL_SPAN_METERS = 22;

export async function loadDroneGeometry(): Promise<THREE.BufferGeometry | null> {
  const modelPath = await findExistingDroneModelPath();
  if (!modelPath) {
    return null;
  }

  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(modelPath);
    return createDroneModelGeometry(gltf.scene);
  } catch (error) {
    console.warn(`Failed to load drone model from ${modelPath}; falling back to cone.`, error);
    return null;
  }
}

export class FleetScene {
  private readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly sceneData: SceneData;
  private readonly routeById: Map<string, AirRoute>;
  private readonly fleet: UavState[];
  private readonly fleetById: Map<string, UavState>;
  private readonly customUavGeometry: THREE.BufferGeometry | null;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly performanceStats = new Stats();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(52, 1, 1, 20_000);
  private readonly controls: OrbitControls;
  private readonly pane: Pane;
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly keys = new Set<string>();
  private readonly uavMesh: THREE.InstancedMesh;
  private readonly routeGroup = new THREE.Group();
  private readonly envelopeGroup = new THREE.Group();
  private readonly roadGroup = new THREE.Group();
  private readonly treeGroup = new THREE.Group();
  private readonly buildingGroup = new THREE.Group();
  private readonly labelNodes = new Map<string, HTMLDivElement>();
  private readonly routeLabelNodes: Array<{ element: HTMLDivElement; position: THREE.Vector3 }> = [];
  private readonly simulationClockValue: HTMLDivElement;
  private readonly cameraPositionValue: HTMLDivElement;
  private readonly cameraLookAtValue: HTMLDivElement;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly initialCameraPosition = new THREE.Vector3();
  private readonly initialTarget = new THREE.Vector3(0,1,);

  private animationFrame = 0;
  private elapsedSeconds = 0;
  private selectedInstanceId = 0;
  private selectedPosition = new THREE.Vector3();
  private selectedTangent = new THREE.Vector3(1, 0, 0);
  private previousCameraMode: CameraMode = "Free";
  private previousSelectedUavId = "";
  private lastFollowPosition = new THREE.Vector3();
  private activeUavCount = 0;
  private readonly params: ControlState;

  /** Wires DOM hosts, builds the fleet from scene data, and configures renderer, controls, UI, and scene. */
  constructor(options: FleetSceneOptions) {
    this.host = options.host;
    this.panel = options.panel;
    this.labelLayer = options.labelLayer;
    this.stats = options.stats;
    this.sceneData = options.sceneData;
    this.routeById = new Map(this.sceneData.routes.map((route) => [route.id, route]));
    this.fleet = createFleet(this.sceneData.routes, this.sceneData.flows);
    this.fleetById = new Map(this.fleet.map((uav) => [uav.id, uav]));
    this.customUavGeometry = options.uavGeometry ?? null;

    this.params = {
      running: true,
      speed: 1,
      selectedUavId: this.fleet[0]?.id ?? "",
      cameraMode: "Free",
      routesVisible: true,
      envelopesVisible: true,
      buildingsVisible: true,
      roadsVisible: true,
      treesVisible: true,
      uavLabelsVisible: false,
    };

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 4_500;
    this.controls.minDistance = 45;
    this.controls.screenSpacePanning = false;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    this.uavMesh = this.createUavMesh();
    this.pane = new Pane({ container: this.panel, title: "Simulation Controls" });
    const readouts = this.createReadoutPanels();
    this.simulationClockValue = readouts.simulationClockValue;
    this.cameraPositionValue = readouts.cameraPositionValue;
    this.cameraLookAtValue = readouts.cameraLookAtValue;

    this.buildScene();
    this.createStatsPanel();
    this.createControls();
    this.createLabels();
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
    this.scene.background = new THREE.Color("#dce7ef");
    this.scene.fog = new THREE.Fog("#dce7ef", 1_500, 7_500);

    this.setInitialCameraFrame();

    this.addLighting();
    this.addSky();
    this.addGround();
    this.addRoads(this.sceneData.roads);
    this.addTrees(this.sceneData.trees);
    this.addBuildings(this.sceneData.buildings);
    this.addRoutes(this.sceneData.routes);
    this.addFlightEnvelopes(this.sceneData.routes);

    this.scene.add(this.roadGroup, this.treeGroup, this.routeGroup, this.envelopeGroup, this.buildingGroup, this.uavMesh);
  }

  /** Adds hemisphere fill plus a shadow-casting directional sun sized for the scene's footprint. */
  private addLighting(): void {
    const hemisphere = new THREE.HemisphereLight("#f2f8ff", "#879281", 2.6);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight("#ffffff", 2.4);
    sun.position.set(-900, 1_400, 700);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -2_500;
    sun.shadow.camera.right = 2_500;
    sun.shadow.camera.top = 2_500;
    sun.shadow.camera.bottom = -2_500;
    this.scene.add(sun);
  }

  /** Adds a large back-side sphere as the sky dome; fog disabled so it stays a constant background color. */
  private addSky(): void {
    const geometry = new THREE.SphereGeometry(8_000, 32, 16);
    const material = new THREE.MeshBasicMaterial({
      color: "#c8dced",
      side: THREE.BackSide,
      fog: false,
    });
    this.scene.add(new THREE.Mesh(geometry, material));
  }

  /** Adds the ground plane and a translucent grid helper for spatial reference. */
  private addGround(): void {
    const bounds = this.sceneData.mapBounds;
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;
    const geometry = new THREE.PlaneGeometry(bounds.width, bounds.depth, 24, 24);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: "#d9ddcf",
      roughness: 0.9,
      metalness: 0,
    });
    const ground = new THREE.Mesh(geometry, material);
    ground.position.set(centerX, 0, centerZ);
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.scene.add(createBoundedGrid(bounds));
  }

  /** Extrudes each footprint and merges into a single mesh — one draw call instead of thousands. */
  private addBuildings(buildings: BuildingFootprint[]): void {
    const geometries: THREE.BufferGeometry[] = [];

    buildings.forEach((building) => {
      const geometry = createBuildingGeometry(building);
      if (geometry) {
        geometries.push(geometry);
      }
    });

    if (geometries.length === 0) {
      return;
    }

    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());

    if (!merged) {
      return;
    }

    const material = new THREE.MeshStandardMaterial({
      color: "#aeb9bc",
      roughness: 0.72,
      metalness: 0.04,
    });
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.buildingGroup.add(mesh);
  }

  /** Builds road ribbons by extruding each segment to its width into a single vertex-colored mesh. */
  private addRoads(roads: RoadPath[]): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const colorByValue = new Map<string, THREE.Color>();
    let vertexIndex = 0;

    roads.forEach((road) => {
      const color = getCachedColor(colorByValue, road.color);
      const halfWidth = road.width / 2;

      for (let index = 1; index < road.points.length; index += 1) {
        const start = road.points[index - 1];
        const end = road.points[index];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);

        if (length < 0.01) {
          continue;
        }

        const offsetX = (-dz / length) * halfWidth;
        const offsetZ = (dx / length) * halfWidth;
        const y = Math.max(start.y, end.y) + ROAD_RENDER_Y;
        const quad = clipHorizontalPolygonToBounds(
          [
            { x: start.x + offsetX, y, z: start.z + offsetZ },
            { x: end.x + offsetX, y, z: end.z + offsetZ },
            { x: end.x - offsetX, y, z: end.z - offsetZ },
            { x: start.x - offsetX, y, z: start.z - offsetZ },
          ],
          this.sceneData.mapBounds,
        );

        if (quad.length < 3) {
          continue;
        }

        quad.forEach((point) => {
          positions.push(point.x, point.y, point.z);
        });

        for (let colorIndex = 0; colorIndex < quad.length; colorIndex += 1) {
          colors.push(color.r, color.g, color.b);
        }

        for (let triangleIndex = 1; triangleIndex < quad.length - 1; triangleIndex += 1) {
          indices.push(vertexIndex, vertexIndex + triangleIndex, vertexIndex + triangleIndex + 1);
        }
        vertexIndex += quad.length;
      }
    });

    if (positions.length === 0) {
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    this.roadGroup.add(mesh);
  }

  /** Renders trees as two InstancedMeshes (trunk + canopy) with per-instance color jitter for variety. */
  private addTrees(trees: TreePoint[]): void {
    if (trees.length === 0) {
      return;
    }

    const trunkGeometry = new THREE.CylinderGeometry(0.55, 0.7, 1, 5);
    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: "#6f563a",
      roughness: 0.86,
      metalness: 0,
    });
    const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);

    const canopyGeometry = new THREE.IcosahedronGeometry(1, 1);
    const canopyMaterial = new THREE.MeshStandardMaterial({
      color: "#537c4f",
      roughness: 0.94,
      metalness: 0,
    });
    const canopyMesh = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, trees.length);
    const matrix = new THREE.Matrix4();
    const identity = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();

    trees.forEach((tree, index) => {
      const baseY = tree.position.y;
      const trunkHeight = Math.max(tree.height * 0.42, 2.4);
      const trunkRadius = Math.max(tree.radius * 0.14, 0.22);
      const canopyHeight = Math.max(tree.height - trunkHeight, tree.radius * 1.6);

      position.set(tree.position.x, baseY + trunkHeight / 2, tree.position.z);
      scale.set(trunkRadius, trunkHeight, trunkRadius);
      matrix.compose(position, identity, scale);
      trunkMesh.setMatrixAt(index, matrix);

      position.set(tree.position.x, baseY + trunkHeight + canopyHeight / 2, tree.position.z);
      scale.set(tree.radius, canopyHeight / 2, tree.radius);
      matrix.compose(position, identity, scale);
      canopyMesh.setMatrixAt(index, matrix);
      canopyMesh.setColorAt(index, color.setHSL(0.29 + (index % 7) * 0.008, 0.28, 0.34 + (index % 3) * 0.03));
    });

    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    canopyMesh.castShadow = true;
    canopyMesh.receiveShadow = true;
    if (canopyMesh.instanceColor) {
      canopyMesh.instanceColor.needsUpdate = true;
    }
    this.treeGroup.add(trunkMesh, canopyMesh);
  }

  /** Draws each air route as a tube centerline plus periodic direction-of-travel cones. */
  private addRoutes(routes: AirRoute[]): void {
    routes.forEach((route) => {
      const points = route.points.map(toVector3);
      const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0);
      const geometry = new THREE.TubeGeometry(curve, Math.max(route.points.length * 16, 48), ROUTE_LINE_RADIUS, 8, false);
      const material = new THREE.MeshBasicMaterial({
        color: route.color,
      });
      const centerline = new THREE.Mesh(geometry, material);
      this.routeGroup.add(centerline);

      for (let index = 2; index < points.length; index += 3) {
        const start = points[index - 1];
        const end = points[index];
        const direction = end.clone().sub(start).normalize();
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(ROUTE_CONE_RADIUS, ROUTE_CONE_HEIGHT, 8),
          new THREE.MeshBasicMaterial({ color: route.color }),
        );
        cone.position.copy(end).sub(direction.clone().multiplyScalar(ROUTE_CONE_HEIGHT / 2 + ROUTE_LINE_RADIUS));
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        this.routeGroup.add(cone);
      }
    });
  }

  /** Draws a translucent tube around each route to visualize its safety envelope radius. */
  private addFlightEnvelopes(routes: AirRoute[]): void {
    routes.forEach((route) => {
      const geometry = createPolylineTubeGeometry(route.points.map(toVector3), route.envelopeRadius, 18);
      if (!geometry) {
        return;
      }

      const material = new THREE.MeshStandardMaterial({
        color: route.color,
        transparent: true,
        opacity: 0.16,
        roughness: 0.45,
        metalness: 0,
        depthWrite: false,
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      this.envelopeGroup.add(mesh);
    });
  }

  /** Builds the single InstancedMesh used to draw the entire fleet — one draw call for all UAVs. */
  private createUavMesh(): THREE.InstancedMesh {
    const geometry = this.customUavGeometry ?? createFallbackUavGeometry();
    const material = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.38,
      metalness: 0.15,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(this.fleet.length, 1));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    return mesh;
  }

  /** Wires Tweakpane bindings for play/speed/selection/visibility toggles and the reset button. */
  private createControls(): void {
    this.pane.addBinding(this.params, "running", { label: "Play" });
    this.pane.addBinding(this.params, "speed", {
      label: "Speed",
      options: {
        "0.5x": 0.5,
        "1x": 1,
        "2x": 2,
        "5x": 5,
      },
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
        Free: "Free",
        Follow: "Follow selected UAV",
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
      this.params.cameraMode = "Free";
      this.camera.position.copy(this.initialCameraPosition);
      this.controls.target.copy(this.initialTarget);
      this.pane.refresh();
    });
  }

  /** Creates DOM-based overlay labels for routes and the first LABEL_LIMIT UAVs (HTML over WebGL). */
  private createLabels(): void {
    this.sceneData.routes.forEach((route) => {
      const position = toVector3(route.points[Math.floor(route.points.length / 2)] ?? { x: 0, y: 0, z: 0 });
      position.y += route.envelopeRadius;

      const label = document.createElement("div");
      label.className = "route-label";
      label.textContent = `Route ${route.id}`;
      label.style.borderColor = route.color;
      label.style.color = route.color;
      this.labelLayer.appendChild(label);
      this.routeLabelNodes.push({ element: label, position });
    });

    this.fleet.slice(0, LABEL_LIMIT).forEach((uav) => {
      const label = document.createElement("div");
      label.className = "uav-label";
      label.textContent = uav.id;
      this.labelLayer.appendChild(label);
      this.labelNodes.set(uav.id, label);
    });
  }

  /** Per-frame loop: advances sim time, updates fleet/camera/labels, then renders. Bound as arrow for rAF. */
  private animate = (): void => {
    this.animationFrame = window.requestAnimationFrame(this.animate);
    this.performanceStats.begin();
    const delta = Math.min(this.clock.getDelta(), 0.08);

    if (this.params.running) {
      this.elapsedSeconds += delta;
    }

    this.applyKeyboardNavigation(delta);
    this.updateFleetInstances();
    this.updateCameraMode(delta);
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
    const selectedColor = new THREE.Color("#ff2f2f");
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
  private updateCameraMode(delta: number): void {
    const followEnabled = this.params.cameraMode === "Follow selected UAV" && Boolean(this.params.selectedUavId);
    const justEnteredFollow = followEnabled && this.previousCameraMode !== "Follow selected UAV";
    const selectionChanged = this.params.selectedUavId !== this.previousSelectedUavId;
    this.controls.enabled = true;

    if (!followEnabled) {
      this.previousCameraMode = this.params.cameraMode;
      this.previousSelectedUavId = this.params.selectedUavId;
      return;
    }

    if (justEnteredFollow || selectionChanged) {
      const behind = this.selectedTangent.clone().multiplyScalar(-95);
      this.camera.position.copy(this.selectedPosition).add(behind).add(new THREE.Vector3(0, 58, 0));
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
    this.labelLayer.classList.toggle("label-layer--uav-visible", this.params.uavLabelsVisible);

    this.routeLabelNodes.forEach(({ element, position }) => {
      const screenPoint = toScreenPosition(position, this.camera, this.host);
      element.style.transform = `translate3d(${screenPoint.x}px, ${screenPoint.y}px, 0)`;
      element.hidden = !this.params.routesVisible && !this.params.envelopesVisible;
    });

    this.fleet.slice(0, LABEL_LIMIT).forEach((uav) => {
      const label = this.labelNodes.get(uav.id);
      const route = this.routeById.get(uav.routeId);
      if (!label || !route) {
        return;
      }

      const sampled = getUavRoutePosition(uav, route, this.elapsedSeconds, this.params.speed);
      label.hidden = !sampled.active;
      if (!sampled.active) {
        return;
      }

      const screenPoint = toScreenPosition(toVector3(sampled.position), this.camera, this.host);
      label.style.transform = `translate(${screenPoint.x}px, ${screenPoint.y}px)`;
      label.classList.toggle("uav-label--selected", uav.id === this.params.selectedUavId);
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
    if (this.params.cameraMode !== "Free" || this.keys.size === 0) {
      return;
    }

    const direction = new THREE.Vector3();
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    if (this.keys.has("w") || this.keys.has("arrowup")) direction.add(forward);
    if (this.keys.has("s") || this.keys.has("arrowdown")) direction.sub(forward);
    if (this.keys.has("d") || this.keys.has("arrowright")) direction.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) direction.sub(right);

    if (direction.lengthSq() === 0) {
      return;
    }

    direction.normalize().multiplyScalar(360 * delta);
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
    this.initialCameraPosition.set(centerX-1, 3000, centerZ);

    this.camera.position.copy(this.initialCameraPosition);
    this.controls.target.copy(this.initialTarget);
  }

  /** Mounts the stats.js FPS panel as an absolutely-positioned overlay on the scene host. */
  private createStatsPanel(): void {
    this.performanceStats.showPanel(0);
    this.performanceStats.dom.classList.add("stats-panel");
    Object.assign(this.performanceStats.dom.style, {
      position: "absolute",
      top: "24px",
      left: "24px",
      zIndex: "2",
    });
    this.host.parentElement?.appendChild(this.performanceStats.dom);
  }

  /** Builds the sim-clock and camera-debug DOM panels in the side panel and returns their value nodes. */
  private createReadoutPanels(): {
    simulationClockValue: HTMLDivElement;
    cameraPositionValue: HTMLDivElement;
    cameraLookAtValue: HTMLDivElement;
  } {
    const simulationPanel = document.createElement("section");
    simulationPanel.className = "control-readout";
    simulationPanel.innerHTML = `
      <div class="control-readout__title">Simulation Clock</div>
      <div class="control-readout__value" data-readout="simulation-clock">00:00:00.0</div>
    `;

    const debugPanel = document.createElement("section");
    debugPanel.className = "control-readout control-readout--debug";
    debugPanel.innerHTML = `
      <div class="control-readout__title">Camera Debug</div>
      <div class="control-readout__row">
        <span>Position</span>
        <code data-readout="camera-position">x 0.0 · y 0.0 · z 0.0</code>
      </div>
      <div class="control-readout__row">
        <span>Lookat</span>
        <code data-readout="camera-lookat">x 0.0 · y 0.0 · z 0.0</code>
      </div>
    `;

    this.panel.append(simulationPanel, debugPanel);

    return {
      simulationClockValue: requireReadout(simulationPanel, "simulation-clock"),
      cameraPositionValue: requireReadout(debugPanel, "camera-position"),
      cameraLookAtValue: requireReadout(debugPanel, "camera-lookat"),
    };
  }

  /** Refreshes the sim-clock and camera-debug readouts each frame from current state. */
  private updateReadoutPanels(): void {
    this.simulationClockValue.textContent = formatSimulationTime(this.elapsedSeconds);
    this.cameraPositionValue.textContent = formatVector(this.camera.position);
    this.cameraLookAtValue.textContent = formatVector(this.controls.target);
  }
}

async function findExistingDroneModelPath(): Promise<string | null> {
  for (const path of DRONE_MODEL_CANDIDATES) {
    if (await assetExists(path)) {
      return path;
    }
  }

  return null;
}

async function assetExists(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { method: "HEAD", cache: "no-store" });
    const contentType = response.headers.get("content-type") ?? "";
    return response.ok && !contentType.includes("text/html");
  } catch {
    return false;
  }
}

function createDroneModelGeometry(root: THREE.Object3D): THREE.BufferGeometry | null {
  const geometries: THREE.BufferGeometry[] = [];
  root.updateWorldMatrix(true, true);

  root.traverse((object) => {
    if (!isMeshWithGeometry(object)) {
      return;
    }

    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    geometries.push(geometry);
  });

  if (geometries.length === 0) {
    return null;
  }

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());

  if (!merged) {
    return null;
  }

  normalizeDroneGeometry(merged);
  return merged;
}

function isMeshWithGeometry(object: THREE.Object3D): object is THREE.Mesh {
  const candidate = object as THREE.Mesh;
  return candidate.isMesh === true && Boolean(candidate.geometry);
}

function normalizeDroneGeometry(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) {
    return;
  }

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const footprint = Math.max(size.x, size.z, 0.0001);
  const scale = DRONE_MODEL_SPAN_METERS / footprint;

  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(scale, scale, scale);
  geometry.rotateY(Math.PI);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

function createFallbackUavGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(7, 22, 8);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function createPolylineTubeGeometry(
  rawPoints: THREE.Vector3[],
  radius: number,
  radialSegments: number,
): THREE.BufferGeometry | null {
  const points = removeDuplicateVectorPoints(rawPoints);
  if (points.length < 2) {
    return null;
  }

  const tangents = points.map((point, index) => getPolylineTangent(points, point, index));
  const positions: number[] = [];
  const indices: number[] = [];
  const rotation = new THREE.Quaternion();
  let normal = chooseTubeNormal(tangents[0]);
  let binormal = new THREE.Vector3().crossVectors(tangents[0], normal).normalize();

  points.forEach((point, pointIndex) => {
    const tangent = tangents[pointIndex];

    if (pointIndex > 0) {
      rotation.setFromUnitVectors(tangents[pointIndex - 1], tangent);
      normal.applyQuaternion(rotation);
      normal.addScaledVector(tangent, -normal.dot(tangent));
      if (normal.lengthSq() < 0.000001) {
        normal = chooseTubeNormal(tangent);
      } else {
        normal.normalize();
      }
      binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    }

    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const angle = (segmentIndex / radialSegments) * Math.PI * 2;
      const radialOffset = normal.clone().multiplyScalar(Math.cos(angle) * radius);
      radialOffset.addScaledVector(binormal, Math.sin(angle) * radius);
      positions.push(point.x + radialOffset.x, point.y + radialOffset.y, point.z + radialOffset.z);
    }
  });

  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
    const currentRing = pointIndex * radialSegments;
    const nextRing = (pointIndex + 1) * radialSegments;

    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const nextSegmentIndex = (segmentIndex + 1) % radialSegments;
      const a = currentRing + segmentIndex;
      const b = currentRing + nextSegmentIndex;
      const c = nextRing + segmentIndex;
      const d = nextRing + nextSegmentIndex;

      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function removeDuplicateVectorPoints(points: THREE.Vector3[]): THREE.Vector3[] {
  const filtered: THREE.Vector3[] = [];

  points.forEach((point) => {
    if (!filtered.length || filtered[filtered.length - 1].distanceToSquared(point) > 0.000001) {
      filtered.push(point);
    }
  });

  return filtered;
}

function getPolylineTangent(points: THREE.Vector3[], point: THREE.Vector3, index: number): THREE.Vector3 {
  if (index === 0) {
    return points[1].clone().sub(point).normalize();
  }

  if (index === points.length - 1) {
    return point.clone().sub(points[index - 1]).normalize();
  }

  const incoming = point.clone().sub(points[index - 1]).normalize();
  const outgoing = points[index + 1].clone().sub(point).normalize();
  const tangent = incoming.add(outgoing);

  if (tangent.lengthSq() < 0.000001) {
    return points[index + 1].clone().sub(points[index - 1]).normalize();
  }

  return tangent.normalize();
}

function chooseTubeNormal(tangent: THREE.Vector3): THREE.Vector3 {
  const reference = Math.abs(tangent.dot(WORLD_UP)) > 0.94 ? new THREE.Vector3(1, 0, 0) : WORLD_UP;
  return new THREE.Vector3().crossVectors(reference, tangent).normalize();
}

function setUavYawQuaternion(quaternion: THREE.Quaternion, tangent: THREE.Vector3): void {
  const horizontalLength = Math.hypot(tangent.x, tangent.z);
  if (horizontalLength < 0.000001) {
    quaternion.identity();
    return;
  }

  quaternion.setFromAxisAngle(WORLD_UP, Math.atan2(tangent.x, tangent.z));
}

/** Extrudes a 2D footprint into a 3D building geometry; returns null when the footprint has no points. */
function createBuildingGeometry(building: BuildingFootprint): THREE.BufferGeometry | null {
  const shape = new THREE.Shape();
  const [first, ...rest] = building.points;

  if (!first) {
    return null;
  }

  shape.moveTo(first.x, -first.z);
  rest.forEach((point) => {
    shape.lineTo(point.x, -point.z);
  });
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: building.height,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function createBoundedGrid(bounds: SceneBounds): THREE.LineSegments {
  const positions: number[] = [];
  const spacing = chooseGridSpacing(Math.max(bounds.width, bounds.depth));
  const y = 0.04;
  const firstX = Math.ceil(bounds.min.x / spacing) * spacing;
  const firstZ = Math.ceil(bounds.min.z / spacing) * spacing;

  for (let x = firstX; x <= bounds.max.x + 0.001; x += spacing) {
    positions.push(x, y, bounds.min.z, x, y, bounds.max.z);
  }

  for (let z = firstZ; z <= bounds.max.z + 0.001; z += spacing) {
    positions.push(bounds.min.x, y, z, bounds.max.x, y, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: "#9da79b",
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}

function chooseGridSpacing(size: number): number {
  if (size > 6_000) return 200;
  if (size > 3_000) return 100;
  if (size > 1_500) return 50;
  return 25;
}

function clipHorizontalPolygonToBounds(polygon: ScenePoint[], bounds: SceneBounds): ScenePoint[] {
  return clipPolygonEdge(
    clipPolygonEdge(
      clipPolygonEdge(
        clipPolygonEdge(polygon, (point) => point.x >= bounds.min.x, (a, b) => intersectAtX(a, b, bounds.min.x)),
        (point) => point.x <= bounds.max.x,
        (a, b) => intersectAtX(a, b, bounds.max.x),
      ),
      (point) => point.z >= bounds.min.z,
      (a, b) => intersectAtZ(a, b, bounds.min.z),
    ),
    (point) => point.z <= bounds.max.z,
    (a, b) => intersectAtZ(a, b, bounds.max.z),
  );
}

function clipPolygonEdge(
  polygon: ScenePoint[],
  isInside: (point: ScenePoint) => boolean,
  intersect: (a: ScenePoint, b: ScenePoint) => ScenePoint,
): ScenePoint[] {
  if (polygon.length === 0) {
    return [];
  }

  const output: ScenePoint[] = [];
  let previous = polygon[polygon.length - 1];
  let previousInside = isInside(previous);

  polygon.forEach((current) => {
    const currentInside = isInside(current);

    if (currentInside !== previousInside) {
      output.push(intersect(previous, current));
    }
    if (currentInside) {
      output.push(current);
    }

    previous = current;
    previousInside = currentInside;
  });

  return output;
}

function intersectAtX(a: ScenePoint, b: ScenePoint, x: number): ScenePoint {
  const denominator = b.x - a.x;
  const t = Math.abs(denominator) < 0.000001 ? 0 : (x - a.x) / denominator;
  return interpolatePoint(a, b, t);
}

function intersectAtZ(a: ScenePoint, b: ScenePoint, z: number): ScenePoint {
  const denominator = b.z - a.z;
  const t = Math.abs(denominator) < 0.000001 ? 0 : (z - a.z) / denominator;
  return interpolatePoint(a, b, t);
}

function interpolatePoint(a: ScenePoint, b: ScenePoint, t: number): ScenePoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Memoizes THREE.Color instances by hex string to avoid per-segment allocations during road meshing. */
function getCachedColor(cache: Map<string, THREE.Color>, value: string): THREE.Color {
  const cached = cache.get(value);
  if (cached) {
    return cached;
  }

  const color = new THREE.Color(value);
  cache.set(value, color);
  return color;
}

/** Adapts a plain ScenePoint into a THREE.Vector3 for math/geometry use. */
function toVector3(point: ScenePoint): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

/** Projects a world-space position to host-pixel coordinates, lifted +16m so labels float above their anchor. */
function toScreenPosition(position: THREE.Vector3, camera: THREE.Camera, host: HTMLElement): { x: number; y: number } {
  const projected = position.clone();
  projected.y += 16;
  projected.project(camera);

  return {
    x: Math.round(((projected.x + 1) / 2) * host.clientWidth),
    y: Math.round(((-projected.y + 1) / 2) * host.clientHeight),
  };
}

/** Formats elapsed seconds as HH:MM:SS.t for the simulation clock readout. */
function formatSimulationTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)}.${tenths}`;
}

/** Pretty-prints a Vector3 as `x ## · y ## · z ##` for the camera debug readouts. */
function formatVector(vector: THREE.Vector3): string {
  return `x ${vector.x.toFixed(1)} · y ${vector.y.toFixed(1)} · z ${vector.z.toFixed(1)}`;
}

/** Left-pads an integer to 2 digits with a leading zero for clock formatting. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Looks up a `[data-readout="…"]` value node in a panel and throws if it's missing. */
function requireReadout(root: HTMLElement, name: string): HTMLDivElement {
  const element = root.querySelector<HTMLDivElement>(`[data-readout="${name}"]`);
  if (!element) {
    throw new Error(`Missing readout: ${name}`);
  }

  return element;
}
