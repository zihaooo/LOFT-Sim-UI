import type { FleetStats, SelectedUavDetail } from "../fleet/source";

/** Value nodes in the HUD stats block, updated in place each frame by updateHud(). */
export type HudRefs = {
  statusValue: HTMLElement;
  speedValue: HTMLElement;
  uavsValue: HTMLElement;
  selectedValue: HTMLElement;
  /** Wrapper around the per-UAV detail rows; hidden entirely while nothing is selected. */
  selectedDetailRows: HTMLElement;
  selectedRouteValue: HTMLElement;
  selectedCorridorValue: HTMLElement;
  selectedStateValue: HTMLElement;
  selectedSpeedValue: HTMLElement;
  selectedAltitudeValue: HTMLElement;
  selectedEnergyValue: HTMLElement;
  selectedPowerValue: HTMLElement;
  selectedOdValue: HTMLElement;
  fleetEnergyValue: HTMLElement;
  fleetStatesValue: HTMLElement;
  fleetArrivedValue: HTMLElement;
};

/** Simulation-facing state the HUD renders each frame. */
export type HudState = {
  running: boolean;
  speed: number;
  activeCount: number;
  /** Selected UAV "id · type" summary, or null/empty when nothing is selected. */
  selectedSummary: string | null;
  /** Selected UAV's route display name, or null when nothing is selected. */
  selectedRouteText: string | null;
  /** Selected UAV's current corridor display name, or null when unknown or nothing is selected. */
  selectedCorridorText: string | null;
  /** Selected UAV detail rows, or null when nothing is selected or the source has no detail (demo). */
  selectedDetail: SelectedUavDetail | null;
  /** Sim-computed fleet aggregates, or null when the source has none (demo). */
  fleetStats: FleetStats | null;
};

/** Builds the sectioned HUD stats block (Sim / Selected / Fleet) into the host and returns its value nodes. */
export function createHud(host: HTMLElement): HudRefs {
  // Labels stay plain text; only values are spans so state and tabular figures can be styled per field.
  // The per-UAV detail rows are hidden as a block while nothing is selected; with a selection, a row
  // whose value is unavailable (e.g. demo mode) shows a dimmed em dash instead.
  host.innerHTML = `
      <div class="hud-section">
        <div class="hud-section__title">Sim</div>
        <div class="hud-line">
          <span class="hud-field">Status: <span class="hud-value hud-value--status is-paused" data-hud="status">Paused</span></span>
          <span class="hud-sep" aria-hidden="true">|</span>
          <span class="hud-field">Speed: <span class="hud-value hud-num" data-hud="speed">1x</span></span>
        </div>
        <div class="hud-line">
          <span class="hud-field">Active UAVs: <span class="hud-value hud-num" data-hud="uavs">0</span></span>
        </div>
      </div>
      <div class="hud-section">
        <div class="hud-section__title">Fleet</div>
        <div class="hud-line">
          <span class="hud-field">Energy: <span class="hud-value hud-num" data-hud="fleet-energy">—</span></span>
        </div>
        <div class="hud-line">
          <span class="hud-field"><span class="hud-value hud-num" data-hud="fleet-states">—</span></span>
        </div>
        <div class="hud-line">
          <span class="hud-field">Arrived: <span class="hud-value hud-num" data-hud="fleet-arrived">—</span></span>
        </div>
      </div>
      <div class="hud-section">
        <div class="hud-section__title">Selected</div>
        <div class="hud-line">
          <span class="hud-field"><span class="hud-value hud-value--selected is-empty" data-hud="selected">none</span></span>
        </div>
        <div class="hud-selected-detail is-hidden" data-hud="sel-detail">
          <div class="hud-line">
            <span class="hud-field">Route: <span class="hud-value" data-hud="sel-route">—</span></span>
          </div>
          <div class="hud-line">
            <span class="hud-field">Corridor: <span class="hud-value" data-hud="sel-corridor">—</span></span>
          </div>
          <div class="hud-line">
            <span class="hud-field">OD: <span class="hud-value" data-hud="sel-od">—</span></span>
          </div>
          <div class="hud-line">
            <span class="hud-field">State: <span class="hud-value" data-hud="sel-state">—</span></span>
          </div>
          <div class="hud-line">
            <span class="hud-field">Speed: <span class="hud-value hud-num" data-hud="sel-speed">—</span></span>
            <span class="hud-sep" aria-hidden="true">|</span>
            <span class="hud-field">Alt: <span class="hud-value hud-num" data-hud="sel-alt">—</span></span>
          </div>
          <div class="hud-line">
            <span class="hud-field">Energy: <span class="hud-value hud-num" data-hud="sel-energy">—</span></span>
            <span class="hud-sep" aria-hidden="true">|</span>
            <span class="hud-field">Power: <span class="hud-value hud-num" data-hud="sel-power">—</span></span>
          </div>
        </div>
      </div>
    `;

  return {
    statusValue: requireHudNode(host, "status"),
    speedValue: requireHudNode(host, "speed"),
    uavsValue: requireHudNode(host, "uavs"),
    selectedValue: requireHudNode(host, "selected"),
    selectedDetailRows: requireHudNode(host, "sel-detail"),
    selectedRouteValue: requireHudNode(host, "sel-route"),
    selectedCorridorValue: requireHudNode(host, "sel-corridor"),
    selectedStateValue: requireHudNode(host, "sel-state"),
    selectedSpeedValue: requireHudNode(host, "sel-speed"),
    selectedAltitudeValue: requireHudNode(host, "sel-alt"),
    selectedEnergyValue: requireHudNode(host, "sel-energy"),
    selectedPowerValue: requireHudNode(host, "sel-power"),
    selectedOdValue: requireHudNode(host, "sel-od"),
    fleetEnergyValue: requireHudNode(host, "fleet-energy"),
    fleetStatesValue: requireHudNode(host, "fleet-states"),
    fleetArrivedValue: requireHudNode(host, "fleet-arrived"),
  };
}

/** Writes the current simulation state into the HUD value nodes. Called every frame; no dirty-checking. */
export function updateHud(refs: HudRefs, state: HudState): void {
  refs.statusValue.textContent = state.running ? "Playing" : "Paused";
  refs.statusValue.classList.toggle("is-playing", state.running);
  refs.statusValue.classList.toggle("is-paused", !state.running);

  refs.speedValue.textContent = `${state.speed}x`;

  refs.uavsValue.textContent = state.activeCount.toLocaleString();

  const hasSelection = Boolean(state.selectedSummary) && state.selectedSummary !== "none";
  refs.selectedValue.textContent = hasSelection ? state.selectedSummary! : "none";
  refs.selectedValue.classList.toggle("is-empty", !hasSelection);
  refs.selectedDetailRows.classList.toggle("is-hidden", !hasSelection);

  setHudValue(refs.selectedRouteValue, state.selectedRouteText);
  setHudValue(refs.selectedCorridorValue, state.selectedCorridorText);

  const detail = state.selectedDetail;
  setHudValue(refs.selectedStateValue, detail && detail.stateLabel);
  setHudValue(refs.selectedSpeedValue, detail && `${detail.speedMetersPerSecond.toFixed(1)} m/s`);
  setHudValue(refs.selectedAltitudeValue, detail && `${detail.altitudeMeters.toFixed(0)} m`);
  setHudValue(refs.selectedEnergyValue, detail && formatEnergy(detail.energyJoules));
  setHudValue(refs.selectedPowerValue, detail && formatPower(detail.powerWatts));
  setHudValue(refs.selectedOdValue, detail && formatOriginDestination(detail));

  const stats = state.fleetStats;
  setHudValue(refs.fleetEnergyValue, stats && formatEnergy(stats.totalEnergyJoules));
  setHudValue(
    refs.fleetStatesValue,
    stats && `Takeoff ${stats.takeoffCount} · Cruise ${stats.cruiseCount} · Landing ${stats.landingCount} · Hold ${stats.holdCount}`,
  );
  setHudValue(
    refs.fleetArrivedValue,
    stats && `${stats.arrivedCount.toLocaleString()} / ${stats.spawnedCount.toLocaleString()} spawned`,
  );
}

/** Writes a value node, falling back to a dimmed em dash when the value is unavailable. */
function setHudValue(element: HTMLElement, text: string | null): void {
  element.textContent = text ?? "—";
  element.classList.toggle("is-empty", text === null);
}

/** Formats joules with an auto-scaled Wh/kWh unit (e.g. "4.2 Wh", "342 Wh", "18.2 kWh"). */
function formatEnergy(joules: number): string {
  const wattHours = joules / 3600;
  if (wattHours >= 1000) {
    const kilowattHours = wattHours / 1000;
    return `${kilowattHours.toFixed(kilowattHours >= 10 ? 1 : 2)} kWh`;
  }
  return `${wattHours.toFixed(wattHours >= 10 ? 0 : 1)} Wh`;
}

/** Formats watts with an auto-scaled W/kW unit (e.g. "820 W", "2.1 kW"). */
function formatPower(watts: number): string {
  return watts >= 1000 ? `${(watts / 1000).toFixed(1)} kW` : `${watts.toFixed(0)} W`;
}

/** Formats the origin → destination pair, or null when neither endpoint is known. */
function formatOriginDestination(detail: SelectedUavDetail): string | null {
  if (!detail.origin && !detail.destination) {
    return null;
  }
  return `${detail.origin || "?"} → ${detail.destination || "?"}`;
}

/** Looks up a `[data-hud="..."]` value node in the HUD host and throws if it's missing. */
function requireHudNode(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-hud="${name}"]`);
  if (!element) {
    throw new Error(`Missing HUD node: ${name}`);
  }

  return element;
}
