/**
 * Run configuration: every PERF_* env knob and CLI flag resolved once into `cfg`, plus system-Chrome
 * discovery. All defaults and the headed/headless auto-pick live here; see perf-bench.mjs's header for
 * what each knob does.
 */
import { existsSync } from "node:fs";

function int(v, d) { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; }

export const cfg = {
  drones: int(process.env.PERF_DRONES, 240),
  warmupMs: int(process.env.PERF_WARMUP_MS, 8000),
  frames: int(process.env.PERF_FRAMES, 600),
  repeats: Math.max(1, int(process.env.PERF_REPEATS, 3)),
  // Discard the first N runs: a cold machine (CPU-frequency governor, OS/file caches, GPU clocks) makes
  // early runs drift until it reaches steady state. Measuring only warmed runs collapses that trend.
  warmupRuns: Math.max(0, int(process.env.PERF_WARMUP_RUNS, 1)),
  cooldownMs: int(process.env.PERF_COOLDOWN_MS, 1500), // gap between per-repeat browser launches (see measure)
  recordFrames: Math.max(1, int(process.env.PERF_RECORD_FRAMES, 90)), // snapshot frames captured into the fixture
  width: int(process.env.PERF_WIDTH, 1600),
  height: int(process.env.PERF_HEIGHT, 1000),
  regressPct: num(process.env.PERF_REGRESS_PCT, 5),
  regressMs: num(process.env.PERF_REGRESS_MS, 0.05), // absolute floor paired with regressPct to suppress jitter
  wsPort: int(process.env.WS_PORT, 8765),
  updateBaseline: process.argv.includes("--update-baseline"),
  record: process.argv.includes("--record") || process.env.PERF_RECORD === "1",
  // Real GPU when a display exists (clean, representative); SwiftShader headless for CI. Force with env.
  headed:
    process.env.PERF_HEADLESS === "1" || process.argv.includes("--headless")
      ? false
      : process.env.PERF_HEADED === "1" || process.argv.includes("--headed") || Boolean(process.env.DISPLAY),
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findChrome() { return CHROME_CANDIDATES.find((p) => existsSync(p)) || null; }
