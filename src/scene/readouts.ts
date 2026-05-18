import * as THREE from "three";
import Stats from "stats.js";
import { STATS_PANEL_LEFT_PX, STATS_PANEL_TOP_PX, STATS_PANEL_Z_INDEX } from "../constant";

export type ReadoutPanels = {
  simulationClockValue: HTMLElement;
  sceneRoutesValue: HTMLElement;
  sceneBuildingsValue: HTMLElement;
  sceneRoadsValue: HTMLElement;
  sceneTreesValue: HTMLElement;
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

/** Mounts the stats.js FPS panel above the scene host with the configured offsets. */
export function mountStatsPanel(host: HTMLElement, performanceStats: Stats): void {
  performanceStats.showPanel(0);
  performanceStats.dom.classList.add("stats-panel");
  Object.assign(performanceStats.dom.style, {
    position: "absolute",
    top: STATS_PANEL_TOP_PX,
    left: STATS_PANEL_LEFT_PX,
    zIndex: STATS_PANEL_Z_INDEX,
  });
  host.parentElement?.appendChild(performanceStats.dom);
}

/** Builds the simulation and debug readout DOM into the control panel and returns their value nodes. */
export function createReadoutPanels(panel: HTMLElement): ReadoutPanels {
  const simulationPanel = document.createElement("section");
  simulationPanel.className = "control-readout";
  simulationPanel.innerHTML = `
      <div class="control-readout__title">Simulation Clock</div>
      <div class="control-readout__value" data-readout="simulation-clock">00:00:00.0</div>
    `;

  const sceneDebugPanel = document.createElement("section");
  sceneDebugPanel.className = "control-readout control-readout--debug";
  sceneDebugPanel.innerHTML = `
      <div class="control-readout__title">Scene Debug</div>
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
    `;

  const cameraDebugPanel = document.createElement("section");
  cameraDebugPanel.className = "control-readout control-readout--debug";
  cameraDebugPanel.innerHTML = `
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

  const telemetryDebugPanel = document.createElement("section");
  telemetryDebugPanel.className = "control-readout control-readout--debug";
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

  panel.append(simulationPanel, sceneDebugPanel, cameraDebugPanel, telemetryDebugPanel);

  return {
    simulationClockValue: requireReadout(simulationPanel, "simulation-clock"),
    sceneRoutesValue: requireReadout(sceneDebugPanel, "scene-routes"),
    sceneBuildingsValue: requireReadout(sceneDebugPanel, "scene-buildings"),
    sceneRoadsValue: requireReadout(sceneDebugPanel, "scene-roads"),
    sceneTreesValue: requireReadout(sceneDebugPanel, "scene-trees"),
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

/** Formats elapsed seconds as HH:MM:SS.t for the simulation clock readout. */
export function formatSimulationTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)}.${tenths}`;
}

/** Pretty-prints a Vector3 as `x ## · y ## · z ##` for the camera debug readouts. */
export function formatVector(vector: THREE.Vector3): string {
  return `x ${vector.x.toFixed(1)} · y ${vector.y.toFixed(1)} · z ${vector.z.toFixed(1)}`;
}

/** Left-pads an integer to 2 digits with a leading zero for clock formatting. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Looks up a `[data-readout="..."]` value node in a panel and throws if it's missing. */
function requireReadout(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-readout="${name}"]`);
  if (!element) {
    throw new Error(`Missing readout: ${name}`);
  }

  return element;
}
