/**
 * Puppeteer measurement orchestration: launch a browser tuned for reproducible timing, warm one page up,
 * hand off to manual rAF driving, and collect frame-time bursts across fresh, isolated runs.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { cfg } from "./config.mjs";
import { pageSetup } from "./inject.mjs";
import { computeStats, r2 } from "./stats.mjs";

export async function launchBrowser(chromePath) {
  const puppeteer = (await import("puppeteer-core")).default;
  return puppeteer.launch({
    executablePath: chromePath,
    headless: cfg.headed ? false : "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      ...(cfg.headed ? [] : ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"]),
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
      "--js-flags=--expose-gc",
      // SwiftShader rasterizes some frames inline for hundreds of ms; without this the GPU watchdog kills
      // the GPU process on those frames. Harmless for a benchmark; irrelevant when headed.
      ...(cfg.headed ? [] : ["--disable-gpu-watchdog", "--disable-gpu-process-crash-limit"]),
      `--window-size=${cfg.width},${cfg.height}`,
    ],
    defaultViewport: { width: cfg.width, height: cfg.height },
    protocolTimeout: 600000, // each burst runs many frames in one evaluate; don't time out
  });
}

/** Runs one measurement burst on an already-warmed, manual-mode page: N frames, GC-bracketed heap. */
export async function runBurst(page) {
  return page.evaluate(async (n) => {
    const p = window.__perf;
    if (typeof window.gc === "function") window.gc();
    p.frames.length = 0; p.draws.length = 0;
    const heap0 = performance.memory?.usedJSHeapSize ?? 0;
    await p.runFrames(n);
    const heap1 = performance.memory?.usedJSHeapSize ?? 0;
    return {
      frames: p.frames.slice(),
      draws: p.draws.slice(),
      heapStartMb: heap0 / 1048576,
      heapEndMb: heap1 / 1048576,
      loftPerf: window.__loftPerf ?? null,
    };
  }, cfg.frames);
}

/** One isolated run in its own browser: load, warm up, hand off to manual driving, measure one burst. */
export async function measureOnce(browser, url, errors, injectOpts) {
  const page = await browser.newPage();
  await page.bringToFront();
  await page.evaluateOnNewDocument(pageSetup, injectOpts);
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text() + (process.env.PERF_DEBUG ? ` @ ${m.location()?.url}:${m.location()?.lineNumber}` : "")); });
  page.on("pageerror", (e) => errors.push(process.env.PERF_DEBUG ? (e.stack || e.message) : e.message));

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("canvas", { timeout: 15000 });

  // Warmup (auto mode): scene builds, telemetry (replayed frame 0, or live stream) renders, JITs settle.
  const hud = () => page.$eval("#hud-stats", (el) => el.textContent || "").catch(() => "");
  const activeOf = (t) => Number(t.match(/UAVs:\s*([\d,]+)/)?.[1]?.replace(/,/g, "") ?? "0");
  const tail = Math.min(2500, cfg.warmupMs);
  if (cfg.warmupMs > tail) await sleep(cfg.warmupMs - tail);
  const actives = [];
  for (let i = 0; i < 5; i++) { await sleep(tail / 5); actives.push(activeOf(await hud())); }

  // Hand off to manual driving; wait for the in-flight rAF to arm `pending`, then JIT-warm the manual path.
  await page.evaluate(() => { window.__perf.mode = "manual"; });
  await page.evaluate(async () => {
    const p = window.__perf, t0 = performance.now();
    while (!p.pending && performance.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 16));
  });
  await page.evaluate(() => window.__perf.runFrames(60)); // throwaway warmup frames

  return { ...(await runBurst(page)), actives };
}

/**
 * Runs PERF_WARMUP_RUNS discarded + PERF_REPEATS measured runs, each in a FRESH browser with a cooldown.
 * Fresh browsers are required because headless SwiftShader survives exactly one burst per renderer (a 2nd
 * burst or a reload crashes its context); the cooldown restores spacing so back-to-back launches don't
 * thermally inflate later runs. Each run gets up to 2 attempts so one stochastic crash never aborts the set.
 */
export async function measure(chromePath, url, injectOpts) {
  const errors = [];
  const bursts = [];
  const total = cfg.warmupRuns + cfg.repeats;
  let launched = 0;
  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const label = isWarmup ? `warmup ${i + 1}/${cfg.warmupRuns}` : `run ${i - cfg.warmupRuns + 1}/${cfg.repeats}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (launched++ > 0) await sleep(cfg.cooldownMs);
      const browser = await launchBrowser(chromePath);
      try {
        const b = await measureOnce(browser, url, errors, injectOpts);
        const q = computeStats(b.frames);
        if (!isWarmup) bursts.push(b);
        console.log(`[perf]   ${label}: compute mean ${r2(q.mean)}ms · ${q.stallCount} stalls${isWarmup ? " (discarded)" : ""}`);
        break;
      } catch (e) {
        errors.push(`${label} attempt ${attempt}: ${e.message}`);
        console.log(`[perf]   ${label}: ${attempt < 2 ? "crashed, retrying…" : "crashed twice, skipping"} (${e.message})`);
      } finally {
        try { await browser.close(); } catch { /* already gone */ }
      }
    }
  }
  return { bursts, errors };
}
