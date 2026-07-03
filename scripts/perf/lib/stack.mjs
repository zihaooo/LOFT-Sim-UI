/**
 * Local process orchestration: probing/starting the mock WS + Vite dev server the app connects to,
 * ensuring the mock telemetry JSON exists, and reading the current git hash. Everything that shells out.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { cfg } from "./config.mjs";
import { MOCK_DATA, ROOT } from "./paths.mjs";

export function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
  });
}

/** Spawn a child, resolving once its stdout matches `ready` (or rejecting on timeout). */
export function spawnUntil(cmd, args, ready, timeoutMs = 30000) {
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

export function gitHash() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT });
  return r.status === 0 ? r.stdout.toString().trim() : "unknown";
}

/** Ensures mock telemetry exists (used only by --record and the live fallback), generating it if absent. */
export function ensureMockData() {
  if (existsSync(MOCK_DATA)) return;
  console.log(`[perf] generating mock telemetry (${cfg.drones} drones)…`);
  spawnSync("python3", ["scripts/gen_mock_data.py", "--drones", String(cfg.drones), "--speed", "2"], { cwd: ROOT, stdio: "inherit" });
}

/** Starts the mock WS (unless already up) + Vite; returns { url, children } for teardown. */
export async function startStack(withMockWs) {
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
