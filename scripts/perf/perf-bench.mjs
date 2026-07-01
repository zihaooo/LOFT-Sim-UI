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
 *   npm run perf:record                # (re)capture the workload fixture from the live mock stack
 *   PERF_HEADLESS=1 npm run perf       # force software WebGL (what CI uses)
 *   PERF_REPEATS=8 PERF_DRONES=1000 npm run perf   # tighter CI + amplified signal for small changes
 *
 * Env knobs (all optional): PERF_DRONES=240 PERF_WARMUP_MS=8000 PERF_FRAMES=600 PERF_REPEATS=3
 *   PERF_WARMUP_RUNS=1 PERF_COOLDOWN_MS=1500 PERF_RECORD_FRAMES=90 PERF_WIDTH=1600 PERF_HEIGHT=1000
 *   PERF_REGRESS_PCT=5 PERF_HEADED=1 PERF_HEADLESS=1 CHROME_PATH=… WS_PORT=8765
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = new URL("./", import.meta.url).pathname;       // …/scripts/perf/
const ROOT = new URL("../../", import.meta.url).pathname;   // repo root (for spawning vite / mock stack)
const PERF_DIR = HERE.replace(/\/$/, "");
const FIXTURES_DIR = `${PERF_DIR}/fixtures`;
const FIXTURE = `${FIXTURES_DIR}/telemetry.json`;
const BASELINE = `${PERF_DIR}/baseline.json`;
const LAST_RUN = `${PERF_DIR}/last-run.json`;
const MOCK_DATA = `${ROOT}mock/mock_telemetry.json`;

const cfg = {
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

function int(v, d) { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; }
function findChrome() { return CHROME_CANDIDATES.find((p) => existsSync(p)) || null; }

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
  });
}

/** Spawn a child, resolving once its stdout matches `ready` (or rejecting on timeout). */
function spawnUntil(cmd, args, ready, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${cmd}: ${out.slice(-200)}`)), timeoutMs);
    const onData = (b) => {
      out += b.toString();
      const m = ready(out);
      if (m) { clearTimeout(timer); resolve({ child, match: m }); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`${cmd} exited (${code}) before ready: ${out.slice(-200)}`)); });
  });
}

/**
 * Injected before any app script runs. Always installs the perf instrumentation (manual rAF stepping +
 * draw-call counting). When `opts.replay` is set, it also REPLACES window.WebSocket with a stub that
 * replays the captured fixture: on connect it emits the registry string, then a snapshot per rendered
 * frame (looping), rewriting the 4-byte sequence header each time so TelemetrySnapshotBuffer (which drops
 * any frame with sequence <= latest) always accepts it. Fully self-contained — no live server involved.
 */
function pageSetup(opts) {
  const perf = { frames: [], draws: [], drawCount: 0, pending: null, mode: "auto", beforeFrame: null };
  window.__perf = perf;

  const rafOrig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    if (perf.mode === "manual") { perf.pending = cb; return 1; }
    return rafOrig(cb);
  };

  perf.step = () => {
    const cb = perf.pending;
    if (!cb) return false;
    perf.pending = null; // animate() re-arms this synchronously via requestAnimationFrame at its top
    const d0 = perf.drawCount;
    const s = performance.now();
    cb(performance.now());
    const e = performance.now();
    perf.frames.push(e - s);
    perf.draws.push(perf.drawCount - d0);
    return true;
  };

  // Yield via MessageChannel (NOT setTimeout, which headless throttles to a few Hz) so queued GL commands
  // flush and rasterize OFF the main thread, as under a normal rAF cadence.
  const mc = new MessageChannel();
  let resumeYield = null;
  mc.port1.onmessage = () => { const r = resumeYield; resumeYield = null; if (r) r(); };
  const yieldToLoop = () => new Promise((res) => { resumeYield = res; mc.port2.postMessage(0); });

  perf.runFrames = async (n) => {
    let done = 0;
    for (let i = 0; i < n; i++) {
      if (perf.beforeFrame) perf.beforeFrame(i); // deliver the next replay snapshot in lockstep
      if (!perf.step()) break;
      done++;
      await yieldToLoop();
    }
    return done;
  };

  const getCtxOrig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = getCtxOrig.call(this, type, ...rest);
    if (ctx && (type === "webgl2" || type === "webgl") && !ctx.__perfWrapped) {
      ctx.__perfWrapped = true;
      for (const m of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
        const orig = ctx[m];
        if (typeof orig === "function") ctx[m] = function (...a) { perf.drawCount++; return orig.apply(this, a); };
      }
    }
    return ctx;
  };

  if (opts && opts.replay) {
    const b64ToBuf = (b64) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u.buffer;
    };
    const rep = { socket: null, buffers: (opts.frames || []).map(b64ToBuf), seq: 1, registry: opts.registry || null };
    window.__replay = rep;
    rep.deliver = (i) => {
      const s = rep.socket;
      if (!s || !rep.buffers.length) return;
      const buf = rep.buffers[i % rep.buffers.length];
      new DataView(buf).setUint32(0, rep.seq++, true); // keep sequence monotonic so the frame is accepted
      s._emit("message", { data: buf });
    };
    perf.beforeFrame = (i) => rep.deliver(i);

    class ReplayWebSocket {
      constructor(url) {
        this.url = url;
        this.binaryType = "blob";
        this.readyState = 0;
        this._l = { open: [], message: [], close: [], error: [] };
        rep.socket = this;
        Promise.resolve().then(() => {
          this.readyState = 1;
          this._emit("open", {});
          if (rep.registry) this._emit("message", { data: rep.registry });
          rep.deliver(0); // seed a snapshot so warmup renders the real fleet, not the demo fallback
        });
      }
      addEventListener(t, cb) { (this._l[t] || (this._l[t] = [])).push(cb); }
      removeEventListener(t, cb) { const a = this._l[t]; if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } }
      _emit(t, ev) { for (const cb of (this._l[t] || [])) { try { cb(ev); } catch { /* listener threw */ } } }
      send() { /* control messages (pause/resume/speed) are irrelevant to replay */ }
      close() { this.readyState = 3; this._emit("close", {}); }
      get bufferedAmount() { return 0; }
    }
    ReplayWebSocket.CONNECTING = 0; ReplayWebSocket.OPEN = 1; ReplayWebSocket.CLOSING = 2; ReplayWebSocket.CLOSED = 3;

    // Stub ONLY the telemetry socket (/ws path or the mock port). Everything else — crucially Vite's HMR
    // socket — must pass through to the real WebSocket, or it would JSON.parse our binary frames and throw.
    const RealWS = window.WebSocket;
    const isTelemetry = (url) => /\/ws(\?|$)/.test(String(url)) || String(url).includes(":8765");
    const WSProxy = function (url, protocols) {
      return isTelemetry(url) ? new ReplayWebSocket(url) : new RealWS(url, protocols);
    };
    WSProxy.CONNECTING = RealWS.CONNECTING; WSProxy.OPEN = RealWS.OPEN; WSProxy.CLOSING = RealWS.CLOSING; WSProxy.CLOSED = RealWS.CLOSED;
    window.WebSocket = WSProxy;
  }
}

/** Injected for `--record` only: wraps window.WebSocket to capture the registry string + binary frames. */
function captureSetup() {
  window.__cap = { registry: null, frames: [] };
  const bufToB64 = (buf) => {
    const u = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  };
  const RealWS = window.WebSocket;
  const isTelemetry = (url) => /\/ws(\?|$)/.test(String(url)) || String(url).includes(":8765");
  window.WebSocket = class extends RealWS {
    constructor(url, protocols) {
      super(url, protocols);
      if (!isTelemetry(url)) return; // ignore Vite's HMR socket and any other connections
      this.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          try { if (JSON.parse(ev.data).type === "registry") window.__cap.registry = ev.data; } catch { /* not JSON */ }
        } else if (ev.data instanceof ArrayBuffer) {
          window.__cap.frames.push(bufToB64(ev.data));
        }
      });
    }
  };
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function r2(n) { return Math.round(n * 100) / 100; }

async function launchBrowser(chromePath) {
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
async function runBurst(page) {
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
async function measureOnce(browser, url, errors, injectOpts) {
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
async function measure(chromePath, url, injectOpts) {
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

/**
 * Splits one burst's frames at a robust cutoff into `compute` (reproducible CPU work — what your code
 * changes move) and `stalls` (SwiftShader inline-raster / GC hiccups). Headline stats use the compute set.
 */
function computeStats(frames) {
  const cutoff = Math.max(8, pct(frames, 50) * 4);
  const c = frames.filter((x) => x <= cutoff);
  const use = c.length ? c : frames;
  return {
    mean: mean(use), median: pct(use, 50), p95: pct(use, 95), p99: pct(use, 99), std: stddev(use),
    stallCount: frames.length - c.length,
  };
}

/** Student-t 95% two-sided critical value by degrees of freedom (K-1); falls back to the normal z. */
function t95(k) {
  const T = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 };
  return T[k - 1] ?? 1.96;
}

/**
 * Aggregates K bursts. Headline is the compute MEAN with a 95% CI taken ACROSS the K burst means, which
 * reflects real run-to-run noise — the tool's true sensitivity. The mean, not the median, is the headline
 * because it averages out the 0.1ms timer quantization; the median is locked to that grid.
 */
function summarize(bursts) {
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
    framesPerRun: cfg.frames,
    workload: {
      activeUavMean: Math.round(mean(allActives)),
      activeUavStd: r2(stddev(allActives)),
      drawCallsMean: Math.round(mean(allDraws)),
    },
    computeMs: {
      mean: r2(grandMean), ci95: r2(ci95), relCiPct: r2(relCiPct),
      median: r2(dist.median), p95: r2(dist.p95), p99: r2(dist.p99), std: r2(dist.std),
    },
    totalMsPerRun: r2(grandMean * cfg.frames),
    perRunMeans: perRunMeans.map(r2),
    stalls: { rate: r2((stallCount / allFrames.length) * 100), count: stallCount, worstMs: r2(allFrames.length ? Math.max(...allFrames) : 0) },
    heapApproxMb: r2(mean(bursts.map((b) => b.heapEndMb - b.heapStartMb))),
    loftPerf: bursts[0]?.loftPerf ?? null,
  };
}

function gitHash() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT });
  return r.status === 0 ? r.stdout.toString().trim() : "unknown";
}

/**
 * Prints one metric line with a signed % delta vs baseline. Flags REGRESSION/improved only when the change
 * clears BOTH the % threshold and the absolute floor, so timer jitter on small values isn't mislabelled.
 */
function line(label, cur, base, unit, lowerIsBetter = true, floor = 0, pctThreshold = cfg.regressPct) {
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

/** Ensures mock telemetry exists (used only by --record and the live fallback), generating it if absent. */
function ensureMockData() {
  if (existsSync(MOCK_DATA)) return;
  console.log(`[perf] generating mock telemetry (${cfg.drones} drones)…`);
  spawnSync("python3", ["scripts/gen_mock_data.py", "--drones", String(cfg.drones), "--speed", "2"], { cwd: ROOT, stdio: "inherit" });
}

/** Starts the mock WS (unless already up) + Vite; returns { url, children } for teardown. */
async function startStack(withMockWs) {
  const children = [];
  if (withMockWs) {
    if (await portInUse(cfg.wsPort)) {
      console.log(`[perf] reusing mock WS already on :${cfg.wsPort}`);
    } else {
      const { child } = await spawnUntil("node", ["scripts/mock_ws_server.mjs", "--data", "mock/mock_telemetry.json", "--hz", "60"], (o) => /data=/.test(o));
      children.push(child);
      console.log(`[perf] started mock WS on :${cfg.wsPort}`);
    }
  }
  const { child: vite, match } = await spawnUntil("node", ["node_modules/vite/bin/vite.js"], (o) => o.match(/http:\/\/localhost:\d+/));
  children.push(vite);
  const url = match[0].replace(/\/+$/, "") + "/";
  console.log(`[perf] vite at ${url}`);
  return { url, children };
}

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

    const summary = summarize(raw.bursts);
    const record = { commit: gitHash(), workloadMode: haveFixture ? "replay" : "live", config: cfg, ...summary };
    writeFileSync(LAST_RUN, JSON.stringify(record, null, 2));

    const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
    const cur = summary.computeMs;
    const noisePct = Math.max(cfg.regressPct, 2 * cur.relCiPct, 2 * (base?.computeMs.relCiPct ?? 0));

    console.log(`\n[perf] results  (commit ${record.commit})`);
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
