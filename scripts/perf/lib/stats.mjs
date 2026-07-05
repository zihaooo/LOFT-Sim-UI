/**
 * Statistics over the frame-time samples: order statistics, the compute/stall split, and the cross-run
 * aggregation that produces the headline mean + 95% CI. All pure — no I/O, no config — so the numeric
 * behaviour is easy to reason about, unit-test, and reproduce.
 */

export function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
export function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
export function r2(n) { return Math.round(n * 100) / 100; }

/**
 * Splits one burst's frames at a robust cutoff into `compute` (reproducible CPU work — what your code
 * changes move) and `stalls` (SwiftShader inline-raster / GC hiccups). Headline stats use the compute set.
 *
 * CAVEAT — stall rate anticorrelates with compute speed, so compare it only between runs of similar
 * compute mean. The harness steps frames back-to-back (no vsync idle), so the faster the body, the less
 * wall-clock the GPU process gets to drain the queued draws/uploads per frame; past a threshold the
 * renderer blocks inside a GL call and the block lands in the timed body as a "stall". Verified
 * 2026-07-05: padding the frame body with a pure busy-wait (no app change) from 1.38ms to 2.15ms took
 * the stall rate from 2.6% to 0.0%. At real vsync pacing (~15ms idle/frame) this backpressure never
 * happens, so a stall-rate rise on a faster build is a harness-pacing artifact, not an app regression —
 * which is why stalls are reported but never gated.
 */
export function computeStats(frames) {
  const cutoff = Math.max(8, pct(frames, 50) * 4);
  const c = frames.filter((x) => x <= cutoff);
  const use = c.length ? c : frames;
  return {
    mean: mean(use), median: pct(use, 50), p95: pct(use, 95), p99: pct(use, 99), std: stddev(use),
    stallCount: frames.length - c.length,
  };
}

/** Student-t 95% two-sided critical value by degrees of freedom (K-1); falls back to the normal z. */
export function t95(k) {
  const T = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 };
  return T[k - 1] ?? 1.96;
}

/**
 * Aggregates K bursts. Headline is the compute MEAN with a 95% CI taken ACROSS the K burst means, which
 * reflects real run-to-run noise — the tool's true sensitivity. The mean, not the median, is the headline
 * because it averages out the 0.1ms timer quantization; the median is locked to that grid.
 */
export function summarize(bursts, framesPerRun) {
  const perRunMeans = bursts.map((b) => computeStats(b.frames).mean);
  const grandMean = mean(perRunMeans);
  const sem = bursts.length > 1 ? stddev(perRunMeans) / Math.sqrt(bursts.length) : 0;
  const ci95 = t95(bursts.length) * sem;
  const relCiPct = grandMean ? (ci95 / grandMean) * 100 : 0;

  const allFrames = bursts.flatMap((b) => b.frames);
  const allDraws = bursts.flatMap((b) => b.draws);
  const allActives = bursts.flatMap((b) => b.actives);
  const dist = computeStats(allFrames);
  const stallCount = allFrames.length - allFrames.filter((x) => x <= Math.max(8, pct(allFrames, 50) * 4)).length;

  return {
    repeats: bursts.length,
    framesPerRun,
    workload: {
      activeUavMean: Math.round(mean(allActives)),
      activeUavStd: r2(stddev(allActives)),
      drawCallsMean: Math.round(mean(allDraws)),
    },
    computeMs: {
      mean: r2(grandMean), ci95: r2(ci95), relCiPct: r2(relCiPct),
      median: r2(dist.median), p95: r2(dist.p95), p99: r2(dist.p99), std: r2(dist.std),
    },
    totalMsPerRun: r2(grandMean * framesPerRun),
    perRunMeans: perRunMeans.map(r2),
    stalls: { rate: r2((stallCount / allFrames.length) * 100), count: stallCount, worstMs: r2(allFrames.length ? Math.max(...allFrames) : 0) },
    heapApproxMb: r2(mean(bursts.map((b) => b.heapEndMb - b.heapStartMb))),
    loftPerf: bursts[0]?.loftPerf ?? null,
  };
}
