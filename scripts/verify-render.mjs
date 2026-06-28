#!/usr/bin/env node
/**
 * Manual render smoke-test: drives the real app in a system Chrome (headless, WebGL via SwiftShader),
 * confirms the per-type UAV models render and that selecting a drone turns it solid red.
 *
 * This is an OPT-IN, local tool — not part of `npm test` and not a CI gate. It needs a system Chrome
 * (puppeteer-core downloads no browser); set CHROME_PATH to override auto-detection. If no Chrome is
 * found it SKIPS (exit 0) rather than failing, so it never breaks an unattended run.
 *
 * It starts its own mock telemetry WS + Vite dev server, captures screenshots, then tears them down.
 *
 *   npm run verify:render
 *   CHROME_PATH=/path/to/chrome npm run verify:render
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = `${ROOT}mock/render-check`; // mock/ is gitignored
const MOCK_DATA = `${ROOT}mock/mock_telemetry.json`;
const WS_PORT = 8765;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
}

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

async function capture(chromePath, url) {
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      "--ignore-gpu-blocklist", "--window-size=1600,1000",
    ],
    defaultViewport: { width: 1600, height: 1000 },
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("canvas", { timeout: 15000 });
    await sleep(7000); // scene build + telemetry frames

    const hud = () => page.$eval("#hud-stats", (el) => el.textContent || "").catch(() => "");
    const TYPE = ["quadrotor", "fixed_wing", "hybrid"];
    const isSel = (t) => TYPE.some((k) => t.includes(k));

    const active = (await hud()).match(/UAVs:\s*(\d+)\s*active/)?.[1] ?? "0";
    await page.screenshot({ path: `${OUT}/fleet.png` });

    const box = await page.$eval("canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    let hit = null, tries = 0;
    outer:
    for (let gy = box.y + box.h * 0.12; gy < box.y + box.h * 0.88; gy += 16) {
      for (let gx = box.x + 24; gx < box.x + box.w - 360; gx += 16) {
        tries++;
        await page.mouse.click(gx, gy);
        const t = await hud();
        if (isSel(t)) { hit = { hud: t }; break outer; }
      }
    }
    if (hit) {
      await page.evaluate(() => {
        for (const s of document.querySelectorAll("select"))
          for (const o of s.options)
            if (/follow/i.test(o.textContent || "")) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return; }
      });
      await sleep(2000);
      await page.screenshot({ path: `${OUT}/selected.png` });
    }
    return { active, selectedHud: hit?.hud ?? null, tries, errors };
  } finally {
    await browser.close();
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("[verify:render] SKIP — no system Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.");
    process.exit(0);
  }
  console.log(`[verify:render] chrome: ${chrome}`);
  mkdirSync(OUT, { recursive: true });

  if (!existsSync(MOCK_DATA)) {
    console.log("[verify:render] generating mock telemetry (240 drones, 3 types)…");
    spawnSync("python3", ["scripts/gen_mock_data.py", "--drones", "240", "--speed", "2"], { cwd: ROOT, stdio: "inherit" });
  }

  const children = [];
  try {
    if (await portInUse(WS_PORT)) {
      console.log(`[verify:render] reusing mock WS already on :${WS_PORT}`);
    } else {
      const { child } = await spawnUntil("node", ["scripts/mock_ws_server.mjs", "--data", "mock/mock_telemetry.json", "--hz", "60"], (o) => /data=/.test(o));
      children.push(child);
      console.log(`[verify:render] started mock WS on :${WS_PORT}`);
    }

    const { child: vite, match } = await spawnUntil("node", ["node_modules/vite/bin/vite.js"], (o) => o.match(/http:\/\/localhost:\d+/));
    children.push(vite);
    const url = match[0].replace(/\/+$/, "") + "/";
    console.log(`[verify:render] vite at ${url}`);

    const r = await capture(chrome, url);
    console.log(`\n[verify:render] active UAVs: ${r.active}`);
    console.log(`[verify:render] selection: ${r.selectedHud ? r.selectedHud.split("·").slice(-3).join("·").trim() : `FAILED (no drone hit in ${r.tries} clicks)`}`);
    console.log(`[verify:render] WebGL/page errors: ${r.errors.length ? r.errors.join("; ") : "none"}`);
    console.log(`[verify:render] screenshots → ${OUT}/fleet.png, ${OUT}/selected.png`);

    const ok = Number(r.active) > 0 && r.selectedHud && r.errors.length === 0;
    process.exit(ok ? 0 : 1);
  } finally {
    for (const c of children) { try { c.kill("SIGTERM"); } catch { /* already gone */ } }
  }
}

main().catch((e) => { console.error("[verify:render] error:", e.message); process.exit(1); });
