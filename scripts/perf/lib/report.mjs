/**
 * Console presentation of a run's results: the signed-delta metric line and the full results block
 * (headline compute mean + CI, secondary distribution, heap). Formatting only — the regression gate and
 * file writes stay in perf-bench.mjs, which owns the decisions and side effects.
 */
import { cfg } from "./config.mjs";
import { r2 } from "./stats.mjs";

/**
 * Prints one metric line with a signed % delta vs baseline. Flags REGRESSION/improved only when the change
 * clears BOTH the % threshold and the absolute floor, so timer jitter on small values isn't mislabelled.
 */
export function line(label, cur, base, unit, lowerIsBetter = true, floor = 0, pctThreshold = cfg.regressPct) {
  let delta = "";
  if (base != null && base !== 0) {
    const pctChange = ((cur - base) / base) * 100;
    const overPct = Math.abs(pctChange) > pctThreshold;
    const overFloor = Math.abs(cur - base) > floor;
    const worse = overPct && overFloor && (lowerIsBetter ? pctChange > 0 : pctChange < 0);
    const better = overPct && overFloor && (lowerIsBetter ? pctChange < 0 : pctChange > 0);
    const tag = worse ? " ⚠ REGRESSION" : better ? " ✅ improved" : "";
    delta = `  (${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}% vs ${base}${unit})${tag}`;
  }
  console.log(`  ${label.padEnd(22)} ${String(cur).padStart(8)}${unit}${delta}`);
}

/** Prints the full results block for one summarized run, with per-metric deltas vs `base` (may be null). */
export function printReport(summary, base, noisePct, commit) {
  const cur = summary.computeMs;
  console.log(`\n[perf] results  (commit ${commit})`);
  if (summary.repeats < cfg.repeats) console.log(`  ⚠ only ${summary.repeats}/${cfg.repeats} runs survived (SwiftShader crashes) — CI over fewer samples; PERF_HEADED=1 avoids this.`);
  console.log(`  workload: ${summary.workload.activeUavMean} active UAVs (±${summary.workload.activeUavStd}), ${summary.workload.drawCallsMean} draw calls/frame · ${summary.repeats} runs × ${summary.framesPerRun} frames`);
  if (base) console.log(`  baseline: commit ${base.commit}, ${base.workload.activeUavMean} active UAVs`);
  console.log("");
  console.log(`  CPU work per frame (mean of ${summary.repeats} runs, stalls removed — the reproducible signal):`);
  line("compute mean", cur.mean, base?.computeMs.mean, "ms", true, cfg.regressMs, noisePct);
  console.log(`  ${"↳ 95% CI".padEnd(22)} ${("±" + cur.ci95).padStart(8)}ms  (±${cur.relCiPct}% over ${summary.repeats} runs; per-run ${summary.perRunMeans.join(", ")})`);
  line("total / run", summary.totalMsPerRun, base?.totalMsPerRun, "ms", true, Infinity);
  line("draw calls/frame", summary.workload.drawCallsMean, base?.workload.drawCallsMean, "", true, 0);
  console.log(`  ${"sensitivity".padEnd(22)} ${("~" + r2(noisePct) + "%").padStart(8)}   (resolves changes larger than this; raise PERF_REPEATS or PERF_DRONES to tighten)`);
  console.log("");
  console.log("  secondary (headless-noisy — for context, not gated):");
  console.log(`    compute median ${cur.median}ms · p95 ${cur.p95}ms · p99 ${cur.p99}ms`);
  console.log(`    raster/GC stalls ${summary.stalls.rate}% (worst ${summary.stalls.worstMs}ms)${cfg.headed ? "" : " — SwiftShader artifact; PERF_HEADED=1 for clean tails"}`);
  line("    heap growth (approx)", summary.heapApproxMb, base?.heapApproxMb, "MB", true, 3);
  if (summary.loftPerf) console.log(`\n  per-phase (window.__loftPerf): ${JSON.stringify(summary.loftPerf)}`);
}
