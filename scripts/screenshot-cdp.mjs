#!/usr/bin/env node
/**
 * CDP 截图工具（真实时间等待，非 virtual-time）：
 * 用法: node scripts/screenshot-cdp.mjs <url> <out.png> <width> <height> [waitMs]
 * 同时输出 console 错误（hydration 等）供验收。
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [url, out, w = "1440", h = "900", waitMs = "8000"] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node screenshot-cdp.mjs <url> <out> <w> <h> [waitMs]"); process.exit(2); }

const EDGE = process.env.EDGE_BIN ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333;

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, `--window-size=${w},${h}`,
  "--user-data-dir=" + process.env.TEMP + "\\edge-cdp-profile-" + Date.now(),
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("CDP target not found");
}

const wsUrl = await getTarget();
const ws = new WebSocket(wsUrl);
let seq = 0;
const pending = new Map();
const consoleErrors = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (!/vite|DevTools|Download the React/.test(text)) consoleErrors.push(`[${msg.params.type}] ${text.slice(0, 400)}`);
  }
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    consoleErrors.push(`[log] ${String(msg.params.entry.text).slice(0, 400)}`);
  }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });

await new Promise((r) => { ws.onopen = r; });
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 500 });
await send("Page.navigate", { url });
await sleep(Number(waitMs));
const shot = await send("Page.captureScreenshot", { format: "png" });
if (!shot.result?.data) { console.error("screenshot failed"); process.exit(1); }
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log(`saved ${out}`);
console.log(consoleErrors.length ? `console errors:\n${consoleErrors.join("\n")}` : "console: no errors");
ws.close();
edge.kill();
process.exit(0);
