/**
 * Shared filesystem locations for the perf tooling. Both perf-bench.mjs and perf-diff.mjs import these, so
 * the two stay in lockstep — perf-diff reads the same baseline.json / last-run.json that the bench writes.
 * Resolved from this module's own URL, which lives one level below scripts/perf/ (in scripts/perf/lib/).
 */
const PERF_URL = new URL("../", import.meta.url);       // …/scripts/perf/
const ROOT_URL = new URL("../../../", import.meta.url); // repo root (for spawning vite / mock stack)

export const ROOT = ROOT_URL.pathname;
export const PERF_DIR = PERF_URL.pathname.replace(/\/$/, "");
export const FIXTURES_DIR = `${PERF_DIR}/fixtures`;
export const FIXTURE = `${FIXTURES_DIR}/telemetry.json`;
export const BASELINE = `${PERF_DIR}/baseline.json`;
export const LAST_RUN = `${PERF_DIR}/last-run.json`;
export const MOCK_DATA = `${ROOT}mock/mock_telemetry.json`;
export const BENCH = new URL("../perf-bench.mjs", import.meta.url).pathname; // perf-diff spawns this
