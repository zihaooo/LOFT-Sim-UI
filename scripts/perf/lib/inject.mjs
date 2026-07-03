/**
 * Functions that run INSIDE the page — puppeteer serializes them (via evaluateOnNewDocument) and re-parses
 * the source in the browser, so they must be fully self-contained: they may reference only browser globals,
 * never anything from this module's scope (no imports, no other module functions).
 */

/**
 * Injected before any app script runs. Always installs the perf instrumentation (manual rAF stepping +
 * draw-call counting). When `opts.replay` is set, it also REPLACES window.WebSocket with a stub that
 * replays the captured fixture: on connect it emits the registry string, then a snapshot per rendered
 * frame (looping), rewriting the 4-byte sequence header each time so TelemetrySnapshotBuffer (which drops
 * any frame with sequence <= latest) always accepts it. Fully self-contained — no live server involved.
 */
export function pageSetup(opts) {
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
export function captureSetup() {
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
