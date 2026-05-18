import "./styles.css";
import { createSceneData } from "./data/osm";
import type { ConfigFileSelection, DemoPreset } from "./scene/control";
import { FleetScene, loadDroneGeometry } from "./scene/FleetScene";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("Missing #root element");
}

root.innerHTML = `
  <main class="app-shell">
    <section class="scene-shell" aria-label="UAM Simulator">
      <div id="scene-host" class="scene-host"></div>
      <div id="label-layer" class="label-layer" aria-hidden="true"></div>
      <div class="hud">
        <div class="hud__title">UAM Simulator</div>
        <div id="hud-stats" class="hud__stats">Loading scene data...</div>
      </div>
      <div class="help-panel">
        Right-drag rotate · Left-drag pan · Scroll zoom · WASD/arrows move · Click UAV to select
      </div>
      <div id="loading-overlay" class="loading-overlay" role="status" aria-live="polite">
        <div class="loading-overlay__spinner" aria-hidden="true"></div>
        <div class="loading-overlay__text">Loading scene</div>
      </div>
    </section>
    <aside id="control-panel" class="control-panel" aria-label="Simulation controls"></aside>
  </main>
`;

type SceneSourceTexts = {
  routeOsm: string;
  buildingOsm: string;
  flowJson: string;
};

let currentSources: SceneSourceTexts | null = null;
let activeScene: FleetScene | null = null;
let uavGeometry: Awaited<ReturnType<typeof loadDroneGeometry>> = null;
let reloadInProgress = false;
let activeDemoPreset: DemoPreset | null = null;

void start();

/** Bootstraps the app: fetches OSM/flow assets in parallel, builds scene data, and mounts the FleetScene. */
async function start(): Promise<void> {
  const loadingOverlay = showLoadingOverlay();

  try {
    currentSources = await loadDefaultSources();
    uavGeometry = await loadDroneGeometry();
    activeScene = mountScene(createSceneData(
      currentSources.routeOsm,
      currentSources.buildingOsm,
      currentSources.flowJson,
    ));
    hideLoadingOverlay(loadingOverlay);
  } catch (error) {
    showLoadingError(loadingOverlay, error);
    throw error;
  }
}

/** Rebuilds the scene from uploaded files, keeping existing source texts for any omitted file. */
async function handleReloadScene(files: ConfigFileSelection): Promise<void> {
  if (!currentSources || reloadInProgress) {
    return;
  }

  const stats = requireElement<HTMLDivElement>("#hud-stats");
  const loadingOverlay = showLoadingOverlay();
  reloadInProgress = true;
  stats.textContent = "Reloading scene data...";

  try {
    const nextSources = await mergeUploadedSources(currentSources, files);
    const sceneData = createSceneData(
      nextSources.routeOsm,
      nextSources.buildingOsm,
      nextSources.flowJson,
    );

    activeDemoPreset = null;
    activeScene?.dispose();
    activeScene = null;
    activeScene = mountScene(sceneData);
    currentSources = nextSources;
  } catch (error) {
    stats.textContent = `Failed to reload scene: ${formatError(error)}`;
    console.error(error);
  } finally {
    reloadInProgress = false;
    hideLoadingOverlay(loadingOverlay);
  }
}

/** Loads a frontend-only demo preset, or restores the default telemetry-backed scene when preset is null. */
async function handleLoadDemoPreset(preset: DemoPreset | null): Promise<void> {
  if (reloadInProgress || preset === activeDemoPreset) {
    return;
  }

  const stats = requireElement<HTMLDivElement>("#hud-stats");
  const loadingOverlay = showLoadingOverlay();
  reloadInProgress = true;
  stats.textContent = preset ? "Loading demo..." : "Loading default scene...";

  try {
    const nextSources = await loadDemoSources(preset);
    const sceneData = createSceneData(
      nextSources.routeOsm,
      nextSources.buildingOsm,
      nextSources.flowJson,
    );

    activeDemoPreset = preset;
    activeScene?.dispose();
    activeScene = null;
    activeScene = mountScene(sceneData);
    currentSources = nextSources;
  } catch (error) {
    stats.textContent = `Failed to load ${preset ? "demo" : "default scene"}: ${formatError(error)}`;
    console.error(error);
  } finally {
    reloadInProgress = false;
    hideLoadingOverlay(loadingOverlay);
  }
}

/** Builds and starts a FleetScene against the current shared DOM hosts. */
function mountScene(sceneData: ReturnType<typeof createSceneData>): FleetScene {
  const host = requireElement<HTMLDivElement>("#scene-host");
  const panel = requireElement<HTMLDivElement>("#control-panel");
  const labelLayer = requireElement<HTMLDivElement>("#label-layer");
  const stats = requireElement<HTMLDivElement>("#hud-stats");

  const fleetScene = new FleetScene({
    host,
    panel,
    labelLayer,
    stats,
    sceneData,
    uavGeometry: uavGeometry?.clone() ?? null,
    onReloadScene: handleReloadScene,
    onLoadDemoPreset: handleLoadDemoPreset,
    activeDemoPreset,
    telemetryUrl: activeDemoPreset === null ? "ws://127.0.0.1:8765/ws" : undefined,
  });

  fleetScene.start();
  return fleetScene;
}

/** Reads the bundled startup files into the same shape used for later reloads. */
async function loadDefaultSources(): Promise<SceneSourceTexts> {
  const [routeOsm, buildingOsm, flowJson] = await Promise.all([
    loadText("/data/map/air_route.osm"),
    loadText("/data/map/map.osm"),
    loadText("/data/demand/flow.json"),
  ]);

  return { routeOsm, buildingOsm, flowJson };
}

/** Reads a built-in demo preset. Demo presets are always frontend-only. */
async function loadDemoSources(preset: DemoPreset | null): Promise<SceneSourceTexts> {
  if (preset === "stressTest") {
    const [routeOsm, buildingOsm, flowJson] = await Promise.all([
      loadText("/data/map/stress_air_route.osm"),
      loadText("/data/map/map.osm"),
      loadText("/data/demand/stress_flow.json"),
    ]);

    return { routeOsm, buildingOsm, flowJson };
  } else if (preset === "twoRoutes") {
      const [routeOsm, buildingOsm, flowJson] = await Promise.all([
          loadText("/data/map/two_air_route.osm"),
          loadText("/data/map/map.osm"),
          loadText("/data/demand/two_flow.json"),
      ]);

      return { routeOsm, buildingOsm, flowJson };
  }

  return loadDefaultSources();
}

/** Applies uploaded files over the existing source texts without mutating the current running scene. */
async function mergeUploadedSources(
  sources: SceneSourceTexts,
  files: ConfigFileSelection,
): Promise<SceneSourceTexts> {
  return {
    routeOsm: files.routeFile ? await files.routeFile.text() : sources.routeOsm,
    buildingOsm: files.mapFile ? await files.mapFile.text() : sources.buildingOsm,
    flowJson: files.demandFile ? await files.demandFile.text() : sources.flowJson,
  };
}

/** Fetches a text asset and throws when the response is not OK so caller errors are explicit. */
async function loadText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }

  return response.text();
}

/** Like document.querySelector but throws when the element is missing, narrowing the type for callers. */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

/** Creates or restores the full-scene loading overlay used during initial load and scene reloads. */
function showLoadingOverlay(): HTMLDivElement {
  const existingOverlay = document.querySelector<HTMLDivElement>("#loading-overlay");
  const loadingOverlay = existingOverlay ?? createLoadingOverlay();
  loadingOverlay.classList.remove("loading-overlay--hidden", "loading-overlay--error");
  loadingOverlay.replaceChildren(
    createLoadingSpinner(),
    createLoadingText(),
  );
  return loadingOverlay;
}

/** Builds the loading overlay if the static shell markup is unavailable. */
function createLoadingOverlay(): HTMLDivElement {
  const sceneShell = requireElement<HTMLElement>(".scene-shell");
  const loadingOverlay = document.createElement("div");
  loadingOverlay.id = "loading-overlay";
  loadingOverlay.className = "loading-overlay";
  loadingOverlay.setAttribute("role", "status");
  loadingOverlay.setAttribute("aria-live", "polite");
  sceneShell.appendChild(loadingOverlay);
  return loadingOverlay;
}

/** Creates the loading spinner element with the same markup used by the initial shell. */
function createLoadingSpinner(): HTMLDivElement {
  const spinner = document.createElement("div");
  spinner.className = "loading-overlay__spinner";
  spinner.setAttribute("aria-hidden", "true");
  return spinner;
}

/** Creates the loading text element with the same text used by the initial shell. */
function createLoadingText(): HTMLDivElement {
  const text = document.createElement("div");
  text.className = "loading-overlay__text";
  text.textContent = "Loading scene";
  return text;
}

/** Fades the loading overlay out after the scene frame has been scheduled. */
function hideLoadingOverlay(loadingOverlay: HTMLDivElement): void {
  loadingOverlay.classList.add("loading-overlay--hidden");
}

/** Leaves a failed first load visible instead of spinning forever. */
function showLoadingError(loadingOverlay: HTMLDivElement, error: unknown): void {
  loadingOverlay.classList.add("loading-overlay--error");
  loadingOverlay.textContent = `Failed to load scene: ${formatError(error)}`;
}

/** Converts unknown thrown values into concise user-facing text. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
