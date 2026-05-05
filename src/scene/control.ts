import { Pane } from "tweakpane";
import { CAMERA_MODES, SIMULATION_SPEED_LEVELS } from "../constant";

export type CameraMode = (typeof CAMERA_MODES)[keyof typeof CAMERA_MODES];

export type SimulationControlState = {
  running: boolean;
  speedLevelIndex: number;
  selectedUavId: string;
  cameraMode: CameraMode;
  routesVisible: boolean;
  envelopesVisible: boolean;
  buildingsVisible: boolean;
  roadsVisible: boolean;
  treesVisible: boolean;
  uavLabelsVisible: boolean;
};

export type LayerVisibilityState = Pick<
  SimulationControlState,
  "routesVisible" | "envelopesVisible" | "buildingsVisible" | "roadsVisible" | "treesVisible"
>;

type SimulationControlsOptions = {
  container: HTMLElement;
  state: SimulationControlState;
  formatSpeed: (speedLevelIndex: number) => string;
  normalizeSpeedLevelIndex: (speedLevelIndex: number) => number;
  onLayerVisibilityChange: (visibility: LayerVisibilityState) => void;
  onResetSimulation: () => void;
};

/** Creates the default mutable control state shared by Tweakpane bindings and FleetScene. */
export function createDefaultControlState(): SimulationControlState {
  return {
    running: true,
    speedLevelIndex: 0,
    selectedUavId: "",
    cameraMode: CAMERA_MODES.FREE,
    routesVisible: true,
    envelopesVisible: true,
    buildingsVisible: true,
    roadsVisible: true,
    treesVisible: true,
    uavLabelsVisible: true,
  };
}

/** Mounts Tweakpane controls and delegates all scene mutations back to FleetScene through callbacks. */
export function createSimulationControls(options: SimulationControlsOptions): Pane {
  const pane = new Pane({ container: options.container, title: "Simulation Controls" });
  const { state } = options;

  pane.addBinding(state, "running", { label: "Play" });
  pane.addBinding(state, "speedLevelIndex", {
    label: "Speed",
    min: 0,
    max: SIMULATION_SPEED_LEVELS.length - 1,
    step: 1,
    format: (value: number) => options.formatSpeed(value),
  }).on("change", () => {
    state.speedLevelIndex = options.normalizeSpeedLevelIndex(state.speedLevelIndex);
    pane.refresh();
  });

  pane.addBinding(state, "cameraMode", {
    label: "Camera",
    options: {
      Free: CAMERA_MODES.FREE,
      Follow: CAMERA_MODES.FOLLOW_SELECTED_UAV,
    },
  });

  pane.addBinding(state, "routesVisible", { label: "Routes" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  pane.addBinding(state, "envelopesVisible", { label: "Envelopes" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  pane.addBinding(state, "buildingsVisible", { label: "Buildings" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  pane.addBinding(state, "roadsVisible", { label: "Roads" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  pane.addBinding(state, "treesVisible", { label: "Trees" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  pane.addBinding(state, "uavLabelsVisible", { label: "Labels" });
  pane.addButton({ title: "Reset simulation" }).on("click", () => {
    options.onResetSimulation();
    pane.refresh();
  });

  return pane;
}
