import * as THREE from "three";
import Stats from "stats.js";
import { STATS_PANEL_LEFT_PX, STATS_PANEL_TOP_PX, STATS_PANEL_Z_INDEX } from "../constant";

export type ReadoutPanels = {
  simulationClockValue: HTMLDivElement;
  cameraPositionValue: HTMLDivElement;
  cameraLookAtValue: HTMLDivElement;
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

/** Builds the simulation-clock and camera-debug readout DOM into the control panel and returns their value nodes. */
export function createReadoutPanels(panel: HTMLElement): ReadoutPanels {
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

  panel.append(simulationPanel, debugPanel);

  return {
    simulationClockValue: requireReadout(simulationPanel, "simulation-clock"),
    cameraPositionValue: requireReadout(debugPanel, "camera-position"),
    cameraLookAtValue: requireReadout(debugPanel, "camera-lookat"),
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
function requireReadout(root: HTMLElement, name: string): HTMLDivElement {
  const element = root.querySelector<HTMLDivElement>(`[data-readout="${name}"]`);
  if (!element) {
    throw new Error(`Missing readout: ${name}`);
  }

  return element;
}
