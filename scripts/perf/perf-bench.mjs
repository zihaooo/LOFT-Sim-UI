#!/usr/bin/env node
/**
 * Reproducible frame-time benchmark: drives the REAL app in a system Chrome under a FIXED, SELF-CONTAINED
 * workload and reports per-frame CPU cost with a confidence interval, so every run prints a delta vs a
 * committed baseline — this is how you track a performance change and know whether it beat the noise.
 *
 * SELF-CONTAINED WORKLOAD (record → replay):
 *   The benchmark does NOT depend on gen_mock_data.py / mock/*.json / mock_ws_server.mjs at run time.
 *   `npm run perf:record` captures, ONCE, the real telemetry the app receives (the registry handshake +
 *   a short loop of steady-state binary snapshot frames) into scripts/perf/fixtures/telemetry.json. Every
 *   normal run then injects a WebSocket STUB into the page that replays that fixture — one snapshot per
 *   rendered frame, looping — so the workload is byte-identical every run and immune to edits of those
 *   three files. Re-capture deliberately (and commit the fixture diff) when you WANT the workload to change.
 *   If no fixture exists yet, it falls back to the live mock stack and hints you to record one.
 *
 * WHY this shape (and not a Vitest `perf.test.ts`):
 *   - Vitest runs in jsdom: no WebGL, no GPU, no real rAF loop — it cannot measure the frame body.
 *   - This app is CPU-bound (context/PERFORMANCE.md: ~94% scripting, GPU idle); the number your changes
 *     move is per-frame CPU work, which is what this measures.
 *
 * HEADED vs HEADLESS: headed uses a REAL GPU — no software-raster stalls, no renderer crashes, tight CI,
 * representative. Headless uses SwiftShader (software WebGL): CPU-bound, flaky (crash-retry path), noisier.
 * Auto-picks headed when a display exists (DISPLAY set), headless for CI. Force with PERF_HEADED/PERF_HEADLESS=1.
 *
 * METRIC: the headline is the compute MEAN with a 95% CI taken ACROSS PERF_REPEATS isolated runs (plus
 * PERF_WARMUP_RUNS discarded so a cold machine doesn't skew it). The mean, not the median, is used: it
 * averages out the 0.1ms timer quantization (~0.1/√N), while the median is an order statistic locked to
 * that grid. The gate fires only beyond max(PERF_REGRESS_PCT, 2×CI), so the tool reports its OWN
 * sensitivity ("resolves changes > X%"). Smaller changes: raise PERF_REPEATS (∝1/√N) or PERF_DRONES.
 *
 *   npm run perf                       # measure vs scripts/perf/baseline.json (replay if a fixture exists)
 *   npm run perf -- --update-baseline  # write the baseline from this run (commit it)
 *   npm run perf:diff                  # A/B this working tree vs HEAD (perf-diff.mjs; never touches baseline.json)
 *   npm run perf:record                # (re)capture the workload fixture from the live mock stack
 *   PERF_HEADLESS=1 npm run perf       # force software WebGL (what CI uses)
 *   PERF_REPEATS=8 PERF_DRONES=1000 npm run perf   # tighter CI + amplified signal for small changes
 *
 * Env knobs (all optional): PERF_DRONES=240 PERF_WARMUP_MS=8000 PERF_FRAMES=600 PERF_REPEATS=3
 *   PERF_WARMUP_RUNS=1 PERF_COOLDOWN_MS=1500 PERF_RECORD_FRAMES=90 PERF_WIDTH=1600 PERF_HEIGHT=1000
 *   PERF_REGRESS_PCT=5 PERF_HEADED=1 PERF_HEADLESS=1 CHROME_PATH=… WS_PORT=8765
 *
 * IMPLEMENTATION: this file is the CLI + the two command flows (record, benchmark); the reusable pieces
 * live in ./lib — config.mjs (knobs), stats.mjs (numbers), inject.mjs (in-page instrumentation),
 * browser.mjs (puppeteer driving), stack.mjs (mock WS / Vite), report.mjs (console output), paths.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { BASELINE, FIXTURE, FIXTURES_DIR, LAST_RUN, PERF_DIR, ROOT } from "./lib/paths.mjs";
import { cfg, findChrome } from "./lib/config.mjs";
import { launchBrowser, measure } from "./lib/browser.mjs";
import { captureSetup } from "./lib/inject.mjs";
import { ensureMockData, gitHash, startStack } from "./lib/stack.mjs";
import { r2, summarize } from "./lib/stats.mjs";
import { printReport } from "./lib/report.mjs";

/** Captures the registry + a loop of steady-state snapshot frames from the LIVE mock stack into FIXTURE. */
async function recordFixture(chromePath) {
  ensureMockData();
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const { url, children } = await startStack(true);
  try {
    console.log(`[perf] recording ${cfg.recordFrames} steady-state frames after ${cfg.warmupMs}ms warmup…`);
    const browser = await launchBrowser(chromePath);
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(captureSetup);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      await page.waitForSelector("canvas", { timeout: 15000 });
      await sleep(cfg.warmupMs); // stream long enough to reach steady state
      const active = Number((await page.$eval("#hud-stats", (el) => el.textContent || "").catch(() => "")).match(/UAVs:\s*([\d,]+)/)?.[1]?.replace(/,/g, "") ?? "0");
      const cap = await page.evaluate((n) => ({
        registry: window.__cap.registry,
        frames: window.__cap.frames.slice(-n), // last N = steady state (early frames have few active UAVs)
        total: window.__cap.frames.length,
      }), cfg.recordFrames);

      if (!cap.frames.length) throw new Error("captured 0 binary frames — is the mock WS streaming?");
      if (!cap.registry) console.log("[perf] ⚠ no registry message captured; ids will fall back to D<handle>.");

      const fixture = {
        meta: { capturedFromCommit: gitHash(), drones: cfg.drones, activeCount: active, frameCount: cap.frames.length, totalStreamed: cap.total },
        registry: cap.registry,
        frames: cap.frames,
      };
      writeFileSync(FIXTURE, JSON.stringify(fixture));
      console.log(`[perf] wrote fixture → ${FIXTURE.replace(ROOT, "")}  (${cap.frames.length} frames, ${active} active UAVs)`);
    } finally {
      await browser.close();
    }
  } finally {
    for (const c of children) { try { c.kill("SIGTERM"); } catch { /* already gone */ } }
  }
}

async function runBenchmark(chromePath) {
  const haveFixture = existsSync(FIXTURE);
  let injectOpts = { replay: false };
  if (haveFixture) {
    const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
    injectOpts = { replay: true, registry: fx.registry, frames: fx.frames };
    console.log(`[perf] workload: hermetic replay fixture (${fx.frames.length} frames, ${fx.meta?.activeCount ?? "?"} active UAVs, from ${fx.meta?.capturedFromCommit ?? "?"})`);
  } else {
    console.log("[perf] workload: LIVE mock stack (no fixture yet — run `npm run perf:record` for a self-contained, reproducible workload).");
    ensureMockData();
  }

  const { url, children } = await startStack(!haveFixture); // replay needs no mock WS
  try {
    console.log(`[perf] ${cfg.headed ? "headed (real GPU)" : "headless (SwiftShader)"} · ${cfg.repeats} runs × ${cfg.frames} frames · warmup ${cfg.warmupMs}ms @ ${cfg.width}x${cfg.height}…`);

    const raw = await measure(chromePath, url, injectOpts);
    if (raw.errors.length) console.log(`[perf] page errors (ignored for timing): ${raw.errors.slice(0, 3).join("; ")}`);
    if (!raw.bursts.length || !raw.bursts[0].frames.length) throw new Error("no frames captured — app may not have started rendering");

    const summary = summarize(raw.bursts, cfg.frames);
    const record = { commit: gitHash(), workloadMode: haveFixture ? "replay" : "live", config: cfg, ...summary };
    writeFileSync(LAST_RUN, JSON.stringify(record, null, 2));

    const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
    const cur = summary.computeMs;
    const noisePct = Math.max(cfg.regressPct, 2 * cur.relCiPct, 2 * (base?.computeMs.relCiPct ?? 0));

    printReport(summary, base, noisePct, record.commit);

    console.log(`\n[perf] wrote ${LAST_RUN.replace(ROOT, "")}`);
    let regressed = false;
    if (cfg.updateBaseline || !base) {
      writeFileSync(BASELINE, JSON.stringify(record, null, 2));
      console.log(`[perf] ${base ? "updated" : "created"} baseline → ${BASELINE.replace(ROOT, "")}  (commit this to track diffs)`);
    } else {
      const dMs = cur.mean - base.computeMs.mean;
      const dPct = (dMs / base.computeMs.mean) * 100;
      regressed = dPct > noisePct && dMs > cfg.regressMs;
      const improved = -dPct > noisePct && -dMs > cfg.regressMs;
      console.log(
        regressed ? `[perf] ⚠ compute mean regressed ${r2(dPct)}% (${r2(dMs)}ms) — beyond the ±${r2(noisePct)}% noise band.`
        : improved ? `[perf] ✅ compute mean improved ${r2(-dPct)}% (${r2(dMs)}ms) — beyond the ±${r2(noisePct)}% noise band.`
        : `[perf] compute mean within noise (Δ ${r2(dPct)}%, band ±${r2(noisePct)}%). Re-baseline: npm run perf -- --update-baseline`);
    }
    return regressed ? 1 : 0;
  } finally {
    for (const c of children) { try { c.kill("SIGTERM"); } catch { /* already gone */ } }
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("[perf] SKIP — no system Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.");
    return 0;
  }
  console.log(`[perf] chrome: ${chrome}`);
  mkdirSync(PERF_DIR, { recursive: true });

  if (cfg.record) { await recordFixture(chrome); return 0; }
  return runBenchmark(chrome);
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => { console.error("[perf] error:", e.message); process.exit(1); },
);
