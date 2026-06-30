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
  vertiportsVisible: boolean;
  corridorsVisible: boolean;
  routesVisible: boolean;
  envelopesVisible: boolean;
  buildingsVisible: boolean;
  roadsVisible: boolean;
  treesVisible: boolean;
  uavLabelsVisible: boolean;
  shadowsEnabled: boolean;
};

export type LayerVisibilityState = Pick<
  SimulationControlState,
  "vertiportsVisible" | "corridorsVisible" | "routesVisible" | "envelopesVisible" | "buildingsVisible" | "roadsVisible" | "treesVisible"
>;

export type ConfigFileSelection = {
  mapFile: File | null;
  corridorFile: File | null;
  demandFile: File | null;
};

/** Which map-derived layers have rendered geometry; empty ones get their toggle disabled. */
type LayerAvailability = {
  buildings: boolean;
  roads: boolean;
  trees: boolean;
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
  availableLayers: LayerAvailability;
  formatSpeed: (speedLevelIndex: number) => string;
  normalizeSpeedLevelIndex: (speedLevelIndex: number) => number;
  onRunningChange: (running: boolean) => void;
  onSpeedChange: (speedLevelIndex: number) => void;
  onLayerVisibilityChange: (visibility: LayerVisibilityState) => void;
  onResetSimulation: () => void;
  onReloadScene: (files: ConfigFileSelection) => Promise<void>;
  onLoadDemoPreset: (preset: DemoPreset | null) => Promise<void>;
  onShadowsToggle: (enabled: boolean) => void;
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
    vertiportsVisible: true,
    corridorsVisible: true,
    routesVisible: false,
    envelopesVisible: true,
    buildingsVisible: true,
    roadsVisible: true,
    treesVisible: true,
    uavLabelsVisible: false,
    shadowsEnabled: true,
  };
}

/** Mounts Tweakpane controls and delegates all scene mutations back to FleetScene through callbacks. */
export function createSimulationControls(options: SimulationControlsOptions): Pane {
  const pane = new Pane({ container: options.container });
  pane.registerPlugin(TweakpaneFileImportPlugin);
  const { state } = options;


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
    options.onSpeedChange(state.speedLevelIndex);
  });

  controlFolder.addBinding(state, "cameraMode", {
    label: "Camera",
    options: {
      Free: CAMERA_MODES.FREE,
      Follow: CAMERA_MODES.FOLLOW_SELECTED_UAV,
    },
  });

  controlFolder.addBinding(state, "vertiportsVisible", { label: "Vertiports" }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });

  // Corridors and Routes are mutually exclusive: enabling one disables the other (both may be off).
  // Envelopes follow whichever of the two the user toggles: turning Corridors or Routes on shows
  // Envelopes, turning either off hides them. Toggling Envelopes directly leaves Corridors/Routes alone.
  // The guard suppresses re-entrant change events that pane.refresh() fires for toggles we set here.
  let syncingLayers = false;
  controlFolder.addBinding(state, "corridorsVisible", { label: "Corridors" }).on("change", () => {
    if (syncingLayers) {
      return;
    }
    syncingLayers = true;
    if (state.corridorsVisible && state.routesVisible) {
      state.routesVisible = false;
    }
    state.envelopesVisible = state.corridorsVisible;
    pane.refresh();
    syncingLayers = false;
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "routesVisible", { label: "Selected UVA's Route" }).on("change", () => {
    if (syncingLayers) {
      return;
    }
    syncingLayers = true;
    if (state.routesVisible && state.corridorsVisible) {
      state.corridorsVisible = false;
    }
    state.envelopesVisible = state.routesVisible;
    pane.refresh();
    syncingLayers = false;
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "envelopesVisible", { label: "Envelopes" }).on("change", () => {
    if (syncingLayers) {
      return;
    }
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "buildingsVisible", {
    label: "Buildings",
    disabled: !options.availableLayers.buildings,
  }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "roadsVisible", {
    label: "Roads",
    disabled: !options.availableLayers.roads,
  }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "treesVisible", {
    label: "Trees",
    disabled: !options.availableLayers.trees,
  }).on("change", () => {
    options.onLayerVisibilityChange(state);
  });
  controlFolder.addBinding(state, "uavLabelsVisible", { label: "Labels" });
  controlFolder.addBinding(state, "shadowsEnabled", { label: "Shadows" }).on("change", () => {
    options.onShadowsToggle(state.shadowsEnabled);
  });
  controlFolder.addButton({ title: "Reset simulation" }).on("click", () => {
    options.onResetSimulation();
    pane.refresh();
  });

  // Demo presets rely on bundled OSM/demand fixtures that ship only in dev builds,
  // so expose the Demo folder under `vite dev` only. Production is telemetry-backed,
  // and this branch is tree-shaken out of the production bundle.
  if (import.meta.env.DEV) {
    const configState: ConfigControlState = {
      mapFile: "",
      corridorFile: "",
      demandFile: "",
    };

    const configFolder = pane.addFolder({ title: "Config Files Override", expanded: false });
    configFolder.addBinding(configState, "mapFile", {
      label: "Base Map",
      view: "file-input",
      lineCount: 1,
      filetypes: [".osm"],
      invalidFiletypeMessage: "Select an .osm file.",
    });
    configFolder.addBinding(configState, "corridorFile", {
      label: "Air Network",
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
  }

  return pane;
}

/** Normalizes the file-input plugin's initial empty string and delete state into a File-or-null value. */
function toFile(value: ConfigFileInputValue): File | null {
  return value instanceof File ? value : null;
}
