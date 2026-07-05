#!/usr/bin/env node
/**
 * A/B performance diff: measures a BEFORE tree vs an AFTER tree against the SAME hermetic replay fixture and
 * prints the delta — "does this change move per-frame CPU work, beyond the noise?". Three modes:
 *
 *   npm run perf:diff                       # BEFORE = HEAD, AFTER = your working tree  (the default)
 *   npm run perf:diff -- <commit>           # BEFORE = <commit>, AFTER = your working tree
 *   npm run perf:diff -- <before> <after>   # BEFORE = <before>, AFTER = <after>  (two commits)
 *
 * <commit> is anything git resolves — a hash, tag, branch, HEAD~3. Honors every PERF_* knob (PERF_HEADED=1,
 * PERF_REPEATS=8, PERF_DRONES=1000, …); see perf-bench.mjs. More repeats/drones = a smaller resolvable change.
 *
 * ── DEFAULT MODE (HEAD vs working tree), via stash → baseline → pop → compare ──────────────────────────
 *   1. Back up scripts/perf/baseline.json in memory (your long-term reference — restored byte-for-byte).
 *   2. `git stash` your tracked changes → the working tree reverts to HEAD. (The fixture and baseline.json
 *      are gitignored, so a plain stash leaves them in place; replay still works during the HEAD run.
 *      Untracked files are NOT stashed — present in BOTH runs; we warn if any exist.)
 *   3. Run perf-bench on HEAD with --update-baseline → baseline.json now holds the BEFORE numbers.
 *   4. `git stash pop` → your changes come back.
 *   5. Run perf-bench again → it diffs your changes against that BEFORE baseline.
 *   6. Restore your original baseline.json (or remove it if you had none).
 *   It drives baseline.json directly (not a code flag) so it stays correct even when the change you're
 *   profiling is perf-bench.mjs itself: a redirect living in perf-bench.mjs would be stashed away during
 *   the before-run and clobber your real baseline. Backing up/restoring the file HERE is the only approach
 *   that survives that, and it guarantees your long-term baseline is untouched.
 *
 * ── COMMIT MODE (<before> [<after>]), via checkout with a PINNED harness ──────────────────────────────
 *   Same idea, but it `git checkout`s each commit instead of stashing to HEAD. Two properties make this safe
 *   and meaningful:
 *   • PINNED HARNESS — a checkout would swap the perf tooling too, so BEFORE and AFTER could be measured by
 *     DIFFERENT instruments. Instead we copy the CURRENT scripts/perf/{perf-bench.mjs,lib} to a temp dir once
 *     and run THAT against each checked-out app (PERF_ROOT points its paths back at the real tree). Only the
 *     app code varies between the two numbers — never the measuring code.
 *   • STASH-FIRST SAFETY — your uncommitted tracked changes are moved into `git stash` BEFORE the first
 *     checkout. Even a crash mid-run leaves them recoverable (`git stash pop`); nothing is ever discarded.
 *
 * ── SAFETY (both modes) ───────────────────────────────────────────────────────────────────────────────
 *   A cleanup guard runs on EVERY exit path — normal return, thrown error, or Ctrl-C — and it:
 *     (a) returns you to your original branch/commit, (b) pops the stash so your changes come back, and
 *     (c) restores baseline.json. Untracked files are never touched by `git checkout`, so they survive too.
 *   The only irrecoverable-looking case, a failed `git stash pop`, isn't a loss: the message tells you the
 *   changes are still in the stash and how to recover them.
 *
 * Requires a HEAD commit; the default mode also requires ≥1 uncommitted tracked change.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE, BENCH, LAST_RUN, PERF_DIR, ROOT } from "./lib/paths.mjs";

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const step = (msg) => console.log(`\n${bold(`[perf:diff] ${msg}`)}`);
const git = (args, opts = {}) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
const checkout = (ref) => git(["checkout", ref], { stdio: "inherit" }).status ?? 1;

/** Run perf-bench once (inherits every PERF_* env knob). `bench` may be the pinned copy; `env` overrides. */
function runBench(updateBaseline, bench = BENCH, env = null) {
  const args = [bench, ...(updateBaseline ? ["--update-baseline"] : [])];
  return spawnSync("node", args, { cwd: ROOT, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env }).status ?? 0;
}

/** Resolve a ref to a full commit SHA (or null if it isn't a commit). */
function resolveCommit(ref) {
  const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}
const shortSha = (sha) => git(["rev-parse", "--short", sha]).stdout.trim() || sha.slice(0, 9);
/** The ref to return to afterwards: the current branch name, or the bare SHA if HEAD is detached. */
function currentRef() {
  const b = git(["symbolic-ref", "-q", "--short", "HEAD"]);
  return b.status === 0 ? b.stdout.trim() : git(["rev-parse", "HEAD"]).stdout.trim();
}

/**
 * Copy the CURRENT harness to a temp dir so it survives the checkouts (checkout would overwrite the tracked
 * scripts/perf files). Kept as a child of ROOT so `puppeteer-core` still resolves via the repo's node_modules;
 * run with PERF_ROOT=ROOT so its paths point back at the real tree, not the temp dir.
 */
function pinHarness() {
  const dir = mkdtempSync(join(ROOT, ".perf-diff-"));
  cpSync(BENCH, join(dir, "perf-bench.mjs"));
  cpSync(join(PERF_DIR, "lib"), join(dir, "lib"), { recursive: true });
  return { dir, bench: join(dir, "perf-bench.mjs") };
}

// State captured before we touch anything, so cleanup() can put it all back on ANY exit path.
let stashed = false;
let originalRef = null;     // set in commit mode: the branch/SHA to check back out
let pinnedDir = null;       // set in commit mode: temp harness copy to remove
let hadBaseline = false;
let baselineBackup = null;  // original baseline.json contents (string), or null if there was none
function cleanup() {
  // Return to where you were BEFORE popping, so the stash lands on its original base (a clean, conflict-free pop).
  if (originalRef) {
    step(`returning to ${originalRef}…`);
    if (checkout(originalRef) !== 0)
      console.error(`[perf:diff] ⚠ could not check out ${originalRef} — do it manually (\`git checkout ${originalRef}\`); your changes are safe in the stash.`);
    originalRef = null;
  }
  if (stashed) {
    step("restoring your changes (git stash pop)…");
    if (git(["stash", "pop"], { stdio: "inherit" }).status !== 0)
      console.error("[perf:diff] ⚠ `git stash pop` failed — your changes are safe in the stash; recover with `git stash pop`.");
    stashed = false;
  }
  // Put your long-term baseline back exactly as it was (or remove the one we synthesized if you had none).
  if (hadBaseline) { try { writeFileSync(BASELINE, baselineBackup); } catch { /* best effort */ } }
  else if (existsSync(BASELINE)) { try { rmSync(BASELINE); } catch { /* best effort */ } }
  if (pinnedDir) { try { rmSync(pinnedDir, { recursive: true, force: true }); } catch { /* best effort */ } pinnedDir = null; }
}
// Pop + restore even if the user aborts mid-run, so neither the tree nor the baseline is left disturbed.
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

/** Compact before→after headline. Read BEFORE cleanup restores the original baseline. */
function printSummary(beforeLabel, afterLabel) {
  try {
    const before = JSON.parse(readFileSync(BASELINE, "utf8")).computeMs; // still the BEFORE run (after-run doesn't --update)
    const after = JSON.parse(readFileSync(LAST_RUN, "utf8")).computeMs;
    const dMs = Math.round((after.mean - before.mean) * 100) / 100;
    const dPct = before.mean ? ((after.mean - before.mean) / before.mean) * 100 : 0;
    const arrow = dMs > 0 ? "▲" : dMs < 0 ? "▼" : "=";
    console.log(`\n${bold("[perf:diff] summary — compute mean per frame")}`);
    console.log(`  before (${beforeLabel}): ${before.mean}ms  (±${before.ci95})`);
    console.log(`  after  (${afterLabel}): ${after.mean}ms  (±${after.ci95})`);
    console.log(`  delta:  ${arrow} ${dMs >= 0 ? "+" : ""}${dMs}ms  (${dPct >= 0 ? "+" : ""}${dPct.toFixed(1)}%)`);
    console.log("  (see the AFTER run above for the gated verdict and CI/noise band.)");
  } catch { /* a run produced no parseable output; the per-run logs above explain why */ }
}

/** Warn about untracked files: they're never stashed, so they sit on disk unchanged through every run. */
function warnUntracked() {
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).stdout.trim();
  if (!untracked) return;
  console.log("[perf:diff] ⚠ untracked files are NOT stashed — they are present in every run:");
  console.log(untracked.split("\n").map((f) => "      " + f).join("\n"));
}

/** DEFAULT MODE: HEAD (before, via stash) vs your working tree (after). */
function runHeadMode() {
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (!dirty) { console.error("[perf:diff] no uncommitted tracked changes — nothing to compare against HEAD. (Pass a commit to diff two commits.)"); return 1; }
  warnUntracked();

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

  printSummary("HEAD", "yours");
  return code; // propagate the regression exit code (0 = ok / within noise, 1 = regressed)
}

/**
 * COMMIT MODE: BEFORE = <beforeArg>, AFTER = <afterArg> (a commit) or your working tree (afterArg == null).
 * Checks out each tree and measures it with the pinned harness. Uncommitted changes are stashed first, and
 * cleanup() restores your ref + changes + baseline on every exit path.
 */
function runCommitMode(beforeArg, afterArg) {
  const before = resolveCommit(beforeArg);
  if (!before) { console.error(`[perf:diff] not a commit: ${beforeArg}`); return 1; }
  const after = afterArg == null ? null : resolveCommit(afterArg);
  if (afterArg != null && !after) { console.error(`[perf:diff] not a commit: ${afterArg}`); return 1; }

  originalRef = currentRef(); // where to return you afterwards
  const beforeLabel = shortSha(before);
  const afterLabel = after ? shortSha(after) : "working tree";

  warnUntracked();
  // SAFETY: move all tracked changes into the stash BEFORE any checkout. From here on they live in git's
  // stash, so even a hard crash can't lose them — the worst case is a manual `git stash pop`.
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (dirty) {
    step("stashing your uncommitted changes for safe-keeping…");
    if (git(["stash", "push", "--message", "perf:diff (auto — safe to drop)"], { stdio: "inherit" }).status !== 0) {
      console.error("[perf:diff] `git stash push` failed; aborting (nothing changed)."); return 1;
    }
    stashed = true;
  }

  // Capture the long-term baseline so cleanup() can restore it byte-for-byte.
  hadBaseline = existsSync(BASELINE);
  if (hadBaseline) baselineBackup = readFileSync(BASELINE, "utf8");

  const pin = pinHarness();
  pinnedDir = pin.dir;
  const pinnedEnv = { PERF_ROOT: ROOT };

  step(`measuring BEFORE — ${beforeLabel} → baseline…`);
  if (checkout(before) !== 0) { console.error(`[perf:diff] \`git checkout ${beforeLabel}\` failed; aborting.`); return 1; }
  if (existsSync(BASELINE)) rmSync(BASELINE); // start clean so the before-run reports no spurious delta
  runBench(true, pin.bench, pinnedEnv);       // --update-baseline: baseline.json := BEFORE numbers

  if (after) {
    step(`measuring AFTER — ${afterLabel}, diffed against ${beforeLabel}…`);
    if (checkout(after) !== 0) { console.error(`[perf:diff] \`git checkout ${afterLabel}\` failed; aborting.`); return 1; }
  } else {
    // AFTER = your working tree: return to it and pop your changes back BEFORE measuring. The pop lands on
    // originalRef (its exact base), so it's conflict-free; the pinned harness then measures your real tree.
    step(`restoring your working tree (${originalRef}) for the AFTER run…`);
    if (checkout(originalRef) !== 0) { console.error(`[perf:diff] \`git checkout ${originalRef}\` failed; aborting.`); return 1; }
    originalRef = null; // back home — cleanup no longer needs to move the tree
    if (stashed) {
      if (git(["stash", "pop"], { stdio: "inherit" }).status !== 0) {
        console.error("[perf:diff] `git stash pop` failed — aborting before the AFTER run (your changes are in the stash)."); return 1;
      }
      stashed = false;
    }
    step(`measuring AFTER — working tree, diffed against ${beforeLabel}…`);
  }
  const code = runBench(false, pin.bench, pinnedEnv); // prints the full delta vs the BEFORE baseline

  printSummary(beforeLabel, afterLabel);
  return code;
}

function main() {
  if (git(["rev-parse", "--verify", "HEAD"]).status !== 0) {
    console.error("[perf:diff] no HEAD commit to compare against."); return 1;
  }
  const positionals = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (positionals.length === 0) return runHeadMode();
  if (positionals.length <= 2) return runCommitMode(positionals[0], positionals[1] ?? null);
  console.error("[perf:diff] usage: perf:diff [<before-commit> [<after-commit>]]"); return 1;
}

let exitCode = 1;
try { exitCode = main(); }
catch (e) { console.error("[perf:diff] error:", e?.message ?? e); exitCode = 1; }
finally { cleanup(); }
process.exit(exitCode ?? 0);
