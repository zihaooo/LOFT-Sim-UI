/**
 * Shared filesystem locations for the perf tooling. Both perf-bench.mjs and perf-diff.mjs import these, so
 * the two stay in lockstep — perf-diff reads the same baseline.json / last-run.json that the bench writes.
 * Resolved from this module's own URL, which lives one level below scripts/perf/ (in scripts/perf/lib/).
 *
 * PERF_ROOT override: perf-diff's commit/commit mode runs a PINNED COPY of the harness from a temp dir
 * OUTSIDE scripts/perf (so `git checkout` can't overwrite the instrument mid-run). From there this file's
 * URL no longer points at the repo, so the caller sets PERF_ROOT to the real working tree and every path
 * below is derived from it. Unset (the normal case) it falls back to this file's location and resolves to
 * exactly the same paths as before.
 */
const ROOT_URL = new URL("../../../", import.meta.url); // repo root (for spawning vite / mock stack)
const withSlash = (p) => (p.endsWith("/") ? p : `${p}/`);

export const ROOT = process.env.PERF_ROOT ? withSlash(process.env.PERF_ROOT) : ROOT_URL.pathname;
export const PERF_DIR = `${ROOT}scripts/perf`;
export const FIXTURES_DIR = `${PERF_DIR}/fixtures`;
export const FIXTURE = `${FIXTURES_DIR}/telemetry.json`;
export const BASELINE = `${PERF_DIR}/baseline.json`;
export const LAST_RUN = `${PERF_DIR}/last-run.json`;
export const MOCK_DATA = `${ROOT}mock/mock_telemetry.json`;
export const BENCH = new URL("../perf-bench.mjs", import.meta.url).pathname; // perf-diff spawns this
