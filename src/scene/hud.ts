/** Value nodes in the HUD stats block, updated in place each frame by updateHud(). */
export type HudRefs = {
  statusValue: HTMLElement;
  speedValue: HTMLElement;
  uavsValue: HTMLElement;
  selectedValue: HTMLElement;
};

/** Simulation-facing state the HUD renders each frame. */
export type HudState = {
  running: boolean;
  speed: number;
  activeCount: number;
  /** Selected UAV summary, or null/empty when nothing is selected. */
  selectedSummary: string | null;
};

/** Builds the three-line HUD stats block into the host and returns its value nodes. */
export function createHud(host: HTMLElement): HudRefs {
  // Labels stay plain text; only values are spans so state and tabular figures can be styled per field.
  host.innerHTML = `
      <div class="hud-line">
        <span class="hud-field">Status: <span class="hud-value hud-value--status is-paused" data-hud="status">Paused</span></span>
        <span class="hud-sep" aria-hidden="true">|</span>
        <span class="hud-field">Speed: <span class="hud-value hud-num" data-hud="speed">1x</span></span>
      </div>
      <div class="hud-line">
        <span class="hud-field">Active UAVs: <span class="hud-value hud-num" data-hud="uavs">0</span></span>
      </div>
      <div class="hud-line">
        <span class="hud-field">Selected: <span class="hud-value hud-value--selected is-empty" data-hud="selected">none</span></span>
      </div>
    `;

  return {
    statusValue: requireHudNode(host, "status"),
    speedValue: requireHudNode(host, "speed"),
    uavsValue: requireHudNode(host, "uavs"),
    selectedValue: requireHudNode(host, "selected"),
  };
}

/** Writes the current simulation state into the HUD value nodes. Called every frame; no dirty-checking. */
export function updateHud(refs: HudRefs, state: HudState): void {
  refs.statusValue.textContent = state.running ? "Playing" : "Paused";
  refs.statusValue.classList.toggle("is-playing", state.running);
  refs.statusValue.classList.toggle("is-paused", !state.running);

  refs.speedValue.textContent = `${state.speed}x`;

  refs.uavsValue.textContent = state.activeCount.toLocaleString();

  const hasSelection = Boolean(state.selectedSummary);
  refs.selectedValue.textContent = hasSelection ? state.selectedSummary! : "none";
  refs.selectedValue.classList.toggle("is-empty", !hasSelection);
}

/** Looks up a `[data-hud="..."]` value node in the HUD host and throws if it's missing. */
function requireHudNode(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-hud="${name}"]`);
  if (!element) {
    throw new Error(`Missing HUD node: ${name}`);
  }

  return element;
}
