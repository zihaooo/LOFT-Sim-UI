#!/usr/bin/env node
/**
 * A/B performance diff: measures HEAD (BEFORE your uncommitted changes) vs your working tree (AFTER),
 * driving the SAME hermetic replay fixture for both, and prints the delta — "does the change I'm about to
 * commit move per-frame CPU work, beyond the noise?".
 *
 * HOW (your stash → baseline → pop → compare flow, made safe):
 *   1. Back up scripts/perf/baseline.json in memory (your long-term reference — restored byte-for-byte).
 *   2. `git stash` your tracked changes → the working tree reverts to HEAD. (The 15 MB fixture and
 *      baseline.json are gitignored, so a plain stash leaves them in place; replay still works during the
 *      HEAD run. Untracked files are NOT stashed — present in BOTH runs; we warn if any exist.)
 *   3. Run perf-bench on HEAD with --update-baseline → baseline.json now holds the BEFORE numbers.
 *   4. `git stash pop` → your changes come back.
 *   5. Run perf-bench again → it diffs your changes against that BEFORE baseline. Its delta report IS the
 *      changes report; a compact before→after summary is printed on top.
 *   6. Restore your original baseline.json (or remove it if you had none).
 *
 * WHY it drives baseline.json directly instead of a code flag: the before-run measures HEAD, so ANY
 * uncommitted change is stashed away first — including changes to this perf tooling itself. A redirect that
 * lived in perf-bench.mjs would vanish during the before-run and clobber your real baseline. Backing up and
 * restoring the file HERE is the only approach that stays correct even when the thing you're profiling is
 * perf-bench.mjs, and it guarantees your long-term baseline survives untouched.
 *
 * SAFETY: a cleanup guard runs on every exit path — normal return, thrown error, or Ctrl-C — and it
 * (a) pops the stash so your tree is never left stashed, and (b) restores baseline.json.
 *
 *   npm run perf:diff
 *
 * Honors every PERF_* knob (PERF_HEADED=1, PERF_REPEATS=8, PERF_DRONES=1000, …); see perf-bench.mjs. More
 * repeats/drones = a smaller change you can resolve. Requires a HEAD commit and ≥1 uncommitted tracked change.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const BENCH = new URL("./perf-bench.mjs", import.meta.url).pathname;
const BASELINE = new URL("./baseline.json", import.meta.url).pathname;
const LAST_RUN = new URL("./last-run.json", import.meta.url).pathname;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const step = (msg) => console.log(`\n${bold(`[perf:diff] ${msg}`)}`);
const git = (args, opts = {}) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });

/** Run perf-bench once (inherits every PERF_* env knob from the caller). */
function runBench(updateBaseline) {
  const args = [BENCH, ...(updateBaseline ? ["--update-baseline"] : [])];
  return spawnSync("node", args, { cwd: ROOT, stdio: "inherit" }).status ?? 0;
}

// State captured before we touch anything, so cleanup() can put it all back on ANY exit path.
let stashed = false;
let hadBaseline = false;
let baselineBackup = null; // original file contents (string), or null if there was no baseline
function cleanup() {
  if (stashed) {
    step("restoring your changes (git stash pop)…");
    if (git(["stash", "pop"], { stdio: "inherit" }).status !== 0)
      console.error("[perf:diff] ⚠ `git stash pop` failed — your changes are safe in the stash; recover with `git stash pop`.");
    stashed = false;
  }
  // Put your long-term baseline back exactly as it was (or remove the one we synthesized if you had none).
  if (hadBaseline) { try { writeFileSync(BASELINE, baselineBackup); } catch { /* best effort */ } }
  else if (existsSync(BASELINE)) { try { rmSync(BASELINE); } catch { /* best effort */ } }
}
// Pop + restore even if the user aborts mid-run, so neither the tree nor the baseline is left disturbed.
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

/** Compact before→after headline. Read BEFORE cleanup restores the original baseline. */
function printSummary() {
  try {
    const before = JSON.parse(readFileSync(BASELINE, "utf8")).computeMs; // still the HEAD run (after-run doesn't --update)
    const after = JSON.parse(readFileSync(LAST_RUN, "utf8")).computeMs;
    const dMs = Math.round((after.mean - before.mean) * 100) / 100;
    const dPct = before.mean ? ((after.mean - before.mean) / before.mean) * 100 : 0;
    const arrow = dMs > 0 ? "▲" : dMs < 0 ? "▼" : "=";
    console.log(`\n${bold("[perf:diff] summary — compute mean per frame")}`);
    console.log(`  before (HEAD):  ${before.mean}ms  (±${before.ci95})`);
    console.log(`  after  (yours): ${after.mean}ms  (±${after.ci95})`);
    console.log(`  delta:          ${arrow} ${dMs >= 0 ? "+" : ""}${dMs}ms  (${dPct >= 0 ? "+" : ""}${dPct.toFixed(1)}%)`);
    console.log("  (see the AFTER run above for the gated verdict and CI/noise band.)");
  } catch { /* a run produced no parseable output; the per-run logs above explain why */ }
}

function main() {
  if (git(["rev-parse", "--verify", "HEAD"]).status !== 0) {
    console.error("[perf:diff] no HEAD commit to compare against."); return 1;
  }
  // Tracked changes only (staged + unstaged). Ignored files (fixture, baseline) are never stashed.
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (!dirty) { console.error("[perf:diff] no uncommitted tracked changes — nothing to compare against HEAD."); return 1; }
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).stdout.trim();
  if (untracked) {
    console.log("[perf:diff] ⚠ untracked files are NOT stashed — they are present in BOTH the before and after runs:");
    console.log(untracked.split("\n").map((f) => "      " + f).join("\n"));
  }

  // Capture the long-term baseline so cleanup() can restore it byte-for-byte.
  hadBaseline = existsSync(BASELINE);
  if (hadBaseline) baselineBackup = readFileSync(BASELINE, "utf8");

  step("stashing your changes to measure HEAD (before)…");
  if (git(["stash", "push", "--message", "perf:diff (auto — safe to drop)"], { stdio: "inherit" }).status !== 0) {
    console.error("[perf:diff] `git stash push` failed; aborting."); return 1;
  }
  stashed = true;

  step("measuring BEFORE — HEAD → baseline…");
  if (existsSync(BASELINE)) rmSync(BASELINE); // start clean so the before-run reports no spurious delta
  runBench(true);                             // --update-baseline: baseline.json := HEAD numbers

  step("restoring your changes (git stash pop)…");
  if (git(["stash", "pop"], { stdio: "inherit" }).status !== 0) {
    console.error("[perf:diff] `git stash pop` failed — resolve manually (your changes are in the stash)."); return 1;
  }
  stashed = false;

  step("measuring AFTER — your changes, diffed against the HEAD baseline…");
  const code = runBench(false); // prints the full delta vs the HEAD baseline; exits 1 on regression

  printSummary();
  return code; // propagate the regression exit code (0 = ok / within noise, 1 = regressed)
}

let exitCode = 1;
try { exitCode = main(); }
catch (e) { console.error("[perf:diff] error:", e?.message ?? e); exitCode = 1; }
finally { cleanup(); }
process.exit(exitCode ?? 0);
