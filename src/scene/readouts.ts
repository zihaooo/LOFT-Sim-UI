import * as THREE from "three";
import Stats from "stats.js";
import type { SceneData } from "../types";
import type { TelemetryDebugReadout } from "../fleet/source";
import { SUPPORTED_VEHICLE_TYPE_NAMES, type CnsSiteType } from "../constant";

export type ReadoutPanels = {
  sceneCorridorsValue: HTMLElement;
  sceneRoutesValue: HTMLElement;
  sceneVertiportsValue: HTMLElement;
  sceneContingencySitesValue: HTMLElement;
  sceneCnsSitesValue: HTMLElement;
  sceneBuildingsValue: HTMLElement;
  sceneRoadsValue: HTMLElement;
  sceneTreesValue: HTMLElement;
  sceneUavTypesValue: HTMLElement;
  cameraPositionValue: HTMLElement;
  cameraLookAtValue: HTMLElement;
  telemetryConnectionValue: HTMLElement;
  telemetryFrequencyValue: HTMLElement;
  telemetrySequenceValue: HTMLElement;
  telemetryAgeValue: HTMLElement;
  telemetryParseValue: HTMLElement;
  telemetrySkippedValue: HTMLElement;
  telemetryErrorValue: HTMLElement;
};

/** Mounts the stats.js FPS panel above the scene host; the .stats-panel stylesheet rules position it. */
export function mountStatsPanel(host: HTMLElement, performanceStats: Stats): void {
  performanceStats.showPanel(0);
  // stats.js hardcodes fixed top-left placement as inline styles, which would beat any stylesheet
  // rule. Strip them so .stats-panel (and its mobile breakpoint override) governs the position.
  for (const property of ["position", "top", "left", "z-index"]) {
    performanceStats.dom.style.removeProperty(property);
  }
  performanceStats.dom.classList.add("stats-panel");
  host.parentElement?.appendChild(performanceStats.dom);
}

/** Applies the "Debug" toggle: hides the FPS panel and the readout sections (all of which are debug). */
export function setDebugInstrumentationVisible(panel: HTMLElement, performanceStats: Stats, visible: boolean): void {
  panel.classList.toggle("control-panel--debug-hidden", !visible);
  performanceStats.dom.style.display = visible ? "" : "none";
}

/** Builds the debug readout DOM into the control panel and returns their value nodes. */
export function createReadoutPanels(panel: HTMLElement): ReadoutPanels {
  const sceneDebugPanel = document.createElement("section");
  sceneDebugPanel.className = "control-readout";
  sceneDebugPanel.innerHTML = `
      <div class="control-readout__title">Scene Debug</div>
      <div class="control-readout__row">
        <span>Vertiports</span>
        <code data-readout="scene-vertiports">0</code>
      </div>
      <div class="control-readout__row">
        <span>CLS</span>
        <code data-readout="scene-contingency-landing-sites">0</code>
      </div>
      <div class="control-readout__row">
        <span>C/N/S Sites</span>
        <code data-readout="scene-cns-sites">0/0/0</code>
      </div>
      <div class="control-readout__row">
        <span>Corridors</span>
        <code data-readout="scene-corridors">0</code>
      </div>
      <div class="control-readout__row">
        <span>Routes</span>
        <code data-readout="scene-routes">0</code>
      </div>
      <div class="control-readout__row">
        <span>Buildings</span>
        <code data-readout="scene-buildings">0</code>
      </div>
      <div class="control-readout__row">
        <span>Roads</span>
        <code data-readout="scene-roads">0</code>
      </div>
      <div class="control-readout__row">
        <span>Trees</span>
        <code data-readout="scene-trees">0</code>
      </div>
      <div class="control-readout__row">
        <span>Support UAV</span>
        <code data-readout="scene-uav-types">-</code>
      </div>
    `;

  const cameraDebugPanel = document.createElement("section");
  cameraDebugPanel.className = "control-readout";
  cameraDebugPanel.innerHTML = `
      <div class="control-readout__title">Camera Debug</div>
      <div class="control-readout__row">
        <span>Position</span>
        <code data-readout="camera-position">(0.0, 0.0, 0.0)</code>
      </div>
      <div class="control-readout__row">
        <span>Lookat</span>
        <code data-readout="camera-lookat">(0.0, 0.0, 0.0)</code>
      </div>
    `;

  const telemetryDebugPanel = document.createElement("section");
  telemetryDebugPanel.className = "control-readout";
  telemetryDebugPanel.innerHTML = `
      <div class="control-readout__title">Telemetry Debug</div>
      <div class="control-readout__row">
        <span>Connection</span>
        <code data-readout="telemetry-connection">disabled</code>
      </div>
      <div class="control-readout__row">
        <span>Hz</span>
        <code data-readout="telemetry-frequency">-</code>
      </div>
      <div class="control-readout__row">
        <span>Seq</span>
        <code data-readout="telemetry-sequence">-</code>
      </div>
      <div class="control-readout__row">
        <span>Age</span>
        <code data-readout="telemetry-age">-</code>
      </div>
      <div class="control-readout__row">
        <span>Parse</span>
        <code data-readout="telemetry-parse">-</code>
      </div>
      <div class="control-readout__row">
        <span>Skipped</span>
        <code data-readout="telemetry-skipped">-</code>
      </div>
      <div class="control-readout__row">
        <span>Error</span>
        <code data-readout="telemetry-error">-</code>
      </div>
    `;

  panel.append(sceneDebugPanel, cameraDebugPanel, telemetryDebugPanel);

  return {
    sceneCorridorsValue: requireReadout(sceneDebugPanel, "scene-corridors"),
    sceneRoutesValue: requireReadout(sceneDebugPanel, "scene-routes"),
    sceneVertiportsValue: requireReadout(sceneDebugPanel, "scene-vertiports"),
    sceneContingencySitesValue: requireReadout(sceneDebugPanel, "scene-contingency-landing-sites"),
    sceneCnsSitesValue: requireReadout(sceneDebugPanel, "scene-cns-sites"),
    sceneBuildingsValue: requireReadout(sceneDebugPanel, "scene-buildings"),
    sceneRoadsValue: requireReadout(sceneDebugPanel, "scene-roads"),
    sceneTreesValue: requireReadout(sceneDebugPanel, "scene-trees"),
    sceneUavTypesValue: requireReadout(sceneDebugPanel, "scene-uav-types"),
    cameraPositionValue: requireReadout(cameraDebugPanel, "camera-position"),
    cameraLookAtValue: requireReadout(cameraDebugPanel, "camera-lookat"),
    telemetryConnectionValue: requireReadout(telemetryDebugPanel, "telemetry-connection"),
    telemetryFrequencyValue: requireReadout(telemetryDebugPanel, "telemetry-frequency"),
    telemetrySequenceValue: requireReadout(telemetryDebugPanel, "telemetry-sequence"),
    telemetryAgeValue: requireReadout(telemetryDebugPanel, "telemetry-age"),
    telemetryParseValue: requireReadout(telemetryDebugPanel, "telemetry-parse"),
    telemetrySkippedValue: requireReadout(telemetryDebugPanel, "telemetry-skipped"),
    telemetryErrorValue: requireReadout(telemetryDebugPanel, "telemetry-error"),
  };
}

/** Fills the Scene Debug rows that are fixed for the scene's lifetime; called once at construction. */
export function writeStaticSceneReadouts(panels: ReadoutPanels, sceneData: SceneData): void {
  panels.sceneCorridorsValue.textContent = sceneData.corridors.length.toLocaleString();
  panels.sceneRoutesValue.textContent = sceneData.routes.length.toLocaleString();
  panels.sceneVertiportsValue.textContent = sceneData.vertiports.length.toLocaleString();
  panels.sceneContingencySitesValue.textContent = sceneData.contingencySites.length.toLocaleString();
  panels.sceneCnsSitesValue.textContent = formatCnsSiteCounts(sceneData.sites);
  panels.sceneBuildingsValue.textContent = sceneData.buildings.length.toLocaleString();
  panels.sceneRoadsValue.textContent = sceneData.roads.length.toLocaleString();
  panels.sceneTreesValue.textContent = sceneData.trees.length.toLocaleString();
  panels.sceneUavTypesValue.textContent = SUPPORTED_VEHICLE_TYPE_NAMES;
}

/** Formats CNS site counts as `comm/nav/surv`, matching the row's C/N/S label order. */
function formatCnsSiteCounts(sites: SceneData["sites"]): string {
  const countOf = (type: CnsSiteType): number => sites.filter((site) => site.type === type).length;
  return `${countOf("comm_site")}/${countOf("nav_site")}/${countOf("surv_site")}`;
}

/** Live state the per-frame debug readout refresh consumes. */
export type DebugReadoutUpdate = {
  cameraPosition: THREE.Vector3;
  cameraTarget: THREE.Vector3;
  /** Transport stats from the telemetry source, or null when no telemetry is configured. */
  telemetry: TelemetryDebugReadout | null;
};

/** Refreshes the camera and telemetry debug readouts; callers skip this while the Debug toggle is off. */
export function updateDebugReadoutPanels(panels: ReadoutPanels, update: DebugReadoutUpdate): void {
  panels.cameraPositionValue.textContent = formatVector(update.cameraPosition);
  panels.cameraLookAtValue.textContent = formatVector(update.cameraTarget);
  panels.telemetryConnectionValue.textContent = update.telemetry?.connection ?? "disabled";
  panels.telemetryFrequencyValue.textContent = update.telemetry?.frequency ?? "-";
  panels.telemetrySequenceValue.textContent = update.telemetry?.sequence ?? "-";
  panels.telemetryAgeValue.textContent = update.telemetry?.age ?? "-";
  panels.telemetryParseValue.textContent = update.telemetry?.parse ?? "-";
  panels.telemetrySkippedValue.textContent = update.telemetry?.skipped ?? "-";
  panels.telemetryErrorValue.textContent = update.telemetry?.error ?? "-";
}

/** Pretty-prints a Vector3 as `(x ##, y ##, z ##)` for the camera debug readouts. */
function formatVector(vector: THREE.Vector3): string {
  return `(${vector.x.toFixed(1)}, ${vector.y.toFixed(1)}, ${vector.z.toFixed(1)})`;
}

/** Looks up a `[data-readout="..."]` value node in a panel and throws if it's missing. */
function requireReadout(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-readout="${name}"]`);
  if (!element) {
    throw new Error(`Missing readout: ${name}`);
  }

  return element;
}
