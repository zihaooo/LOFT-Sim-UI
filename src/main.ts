import "./styles.css";
import { createSceneData } from "./data/osm";
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
    </section>
    <aside id="control-panel" class="control-panel" aria-label="Simulation controls"></aside>
  </main>
`;

void start();

/** Bootstraps the app: fetches OSM/flow assets in parallel, builds scene data, and mounts the FleetScene. */
async function start(): Promise<void> {
  const [routeOsm, buildingOsm, flowJson] = await Promise.all([
    loadText("/asset/map/air_route.osm"),
    loadText("/asset/map/map.osm"),
    loadText("/asset/demand/flow.json"),
  ]);

  const sceneData = createSceneData(routeOsm, buildingOsm, flowJson);
  const uavGeometry = await loadDroneGeometry();
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
    uavGeometry,
  });

  fleetScene.start();
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
