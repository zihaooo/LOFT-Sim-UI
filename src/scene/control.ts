import { Pane } from "tweakpane";
import * as TweakpaneFileImportPlugin from "tweakpane-plugin-file-import";
import { CAMERA_MODES, SIMULATION_SPEED_LEVELS } from "../constant";

export type CameraMode = (typeof CAMERA_MODES)[keyof typeof CAMERA_MODES];
export type DemoPreset = "twoCorridors" | "stressTest";

export type SimulationControlState = {
  running: boolean;
  speedLevelIndex: number;
  selectedUavId: string;
  demoTwoCorridors: boolean;
  demoStressTest: boolean;
  cameraMode: CameraMode;
  corridorsVisible: boolean;
  routesVisible: boolean;
  envelopesVisible: boolean;
  buildingsVisible: boolean;
  roadsVisible: boolean;
  treesVisible: boolean;
  uavLabelsVisible: boolean;
};

export type LayerVisibilityState = Pick<
  SimulationControlState,
  "corridorsVisible" | "routesVisible" | "envelopesVisible" | "buildingsVisible" | "roadsVisible" | "treesVisible"
>;

export type ConfigFileSelection = {
  mapFile: File | null;
  corridorFile: File | null;
  demandFile: File | null;
};

type ConfigFileInputValue = "" | File | null;

type ConfigControlState = {
  mapFile: ConfigFileInputValue;
  corridorFile: ConfigFileInputValue;
  demandFile: ConfigFileInputValue;
};

type SimulationControlsOptions = {
  container: HTMLElement;
  state: SimulationControlState;
  formatSpeed: (speedLevelIndex: number) => string;
  normalizeSpeedLevelIndex: (speedLevelIndex: number) => number;
  onRunningChange: (running: boolean) => void;
  onLayerVisibilityChange: (visibility: LayerVisibilityState) => void;
  onResetSimulation: () => void;
  onReloadScene: (files: ConfigFileSelection) => Promise<void>;
  onLoadDemoPreset: (preset: DemoPreset | null) => Promise<void>;
};

/** Creates the default mutable control state shared by Tweakpane bindings and FleetScene. */
export function createDefaultControlState(activeDemoPreset: DemoPreset | null = null): SimulationControlState {
  return {
    running: true,
    speedLevelIndex: 0,
    selectedUavId: "",
    demoTwoCorridors: activeDemoPreset === "twoCorridors",
    demoStressTest: activeDemoPreset === "stressTest",
    cameraMode: CAMERA_MODES.FREE,
    corridorsVisible: true,
    routesVisible: false,
    envelopesVisible: true,
    buildingsVisible: true,
    roadsVisible: true,
    treesVisible: true,
    uavLabelsVisible: false,
  };
}

/** Mounts Tweakpane controls and delegates all scene mutations back to FleetScene through callbacks. */
export function createSimulationControls(options: SimulationControlsOptions): Pane {
  const pane = new Pane({ container: options.container });
  pane.registerPlugin(TweakpaneFileImportPlugin);
  const { state } = options;
  const configState: ConfigControlState = {
    mapFile: "",
    corridorFile: "",
    demandFile: "",
  };

  const configFolder = pane.addFolder({ title: "Config Files", expanded: false });
  configFolder.addBinding(configState, "mapFile", {
    label: "Map",
    view: "file-input",
    lineCount: 1,
    filetypes: [".osm"],
    invalidFiletypeMessage: "Select an .osm file.",
  });
  configFolder.addBinding(configState, "corridorFile", {
    label: "Air corridor",
    view: "file-input",
    lineCount: 1,
    filetypes: [".osm"],
    invalidFiletypeMessage: "Select an .osm file.",
  });
  configFolder.addBinding(configState, "demandFile", {
    label: "Demand",
    view: "file-input",
    lineCount: 1,
    filetypes: [".json"],
    invalidFiletypeMessage: "Select a .json file.",
  });
  configFolder.addButton({ title: "Reload scene" }).on("click", () => {
    void options.onReloadScene({
      mapFile: toFile(configState.mapFile),
      corridorFile: toFile(configState.corridorFile),
      demandFile: toFile(configState.demandFile),
    });
  });

  const controlFolder = pane.addFolder({ title: "Controls", expanded: true });

  controlFolder.addBinding(state, "running", { label: "Play" }).on("change", () => {
    options.onRunningChange(state.running);
  });
  controlFolder.addBinding(state, "speedLevelIndex", {
    label: "Speed",
    min: 0,
    max: SIMULATION_SPEED_LEVELS.length - 1,
    step: 1,
    format: (value: number) => options.formatSpeed(value),
  }).on("change", () => {
    state.speedLevelIndex = options.normalizeSpeedLevelIndex(state.speedLevelIndex);
    pane.refresh();
  });

  controlFolder.addBinding(state, "cameraMode", {
    label: "Camera",
    options: {
      Free: CAMERA_MODES.FREE,
      Follow: CAMERA_MODES.FOLLOW_SELECTED_UAV,
    },
  });

  // Corridors and Routes are mutually exclusive: enabling one disables the other (both may be off).
  // The guard suppresses the re-entrant change event that pane.refresh() fires for the cleared toggle.
  let syncingCorridorRoute = false;
  controlFolder.addBinding(state, "corridorsVisible", { label: "Corridors" }).on("change", () => {
    if (syncingCorridorRoute) {
      return;
    }
    if (state.corridorsVisible && state.routesVisible) {
      syncingCorridorRoute = true;
      state.routesVisible = false;
      pane.refresh();
      syncingCorridorRoute = false;
    }
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "routesVisible", { label: "Routes" }).on("change", () => {
    if (syncingCorridorRoute) {
      return;
    }
    if (state.routesVisible && state.corridorsVisible) {
      syncingCorridorRoute = true;
      state.corridorsVisible = false;
      pane.refresh();
      syncingCorridorRoute = false;
    }
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "envelopesVisible", { label: "Envelopes" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "buildingsVisible", { label: "Buildings" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "roadsVisible", { label: "Roads" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "treesVisible", { label: "Trees" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "uavLabelsVisible", { label: "Labels" });
  controlFolder.addButton({ title: "Reset simulation" }).on("click", () => {
    options.onResetSimulation();
    pane.refresh();
  });

  let syncingDemoControls = false;
  const demoFolder = pane.addFolder({ title: "Demo", expanded: false });
  demoFolder.addBinding(state, "demoTwoCorridors", { label: "Two Corridors" }).on("change", () => {
    if (!state.demoTwoCorridors) {
      if (!syncingDemoControls && !state.demoStressTest) {
        void options.onLoadDemoPreset(null);
      }
      return;
    }

    syncingDemoControls = true;
    state.demoStressTest = false;
    pane.refresh();
    syncingDemoControls = false;
    void options.onLoadDemoPreset("twoCorridors");
  });
  demoFolder.addBinding(state, "demoStressTest", { label: "Stress Test" }).on("change", () => {
    if (!state.demoStressTest) {
      if (!syncingDemoControls && !state.demoTwoCorridors) {
        void options.onLoadDemoPreset(null);
      }
      return;
    }

    syncingDemoControls = true;
    state.demoTwoCorridors = false;
    pane.refresh();
    syncingDemoControls = false;
    void options.onLoadDemoPreset("stressTest");
  });

  return pane;
}

/** Normalizes the file-input plugin's initial empty string and delete state into a File-or-null value. */
function toFile(value: ConfigFileInputValue): File | null {
  return value instanceof File ? value : null;
}
