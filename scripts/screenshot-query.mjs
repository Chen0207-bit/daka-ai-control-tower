#!/usr/bin/env node
/**
 * 查询工作台交互截图：导航 → 等待图加载 → 填入问题 → 点运行 → 等待 → 截图。
 * 用法: node scripts/screenshot-query.mjs <out.png> <width> <height> ["问题"]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [out, w = "1440", h = "900", question = "过去三年我应付了哪些账单？"] = process.argv.slice(2);
if (!out) { console.error("usage: node screenshot-query.mjs <out.png> <w> <h> [question]"); process.exit(2); }

const EDGE = process.env.EDGE_BIN ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9334;
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, `--window-size=${w},${h}`, "--user-data-dir=" + process.env.TEMP + "\\edge-cdp-q-" + Date.now(), "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const page = list.find((t) => t.type === "page"); if (page) return page.webSocketDebuggerUrl; } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("CDP target not found");
}
const ws = new WebSocket(await getTarget());
let seq = 0; const pending = new Map(); const errors = [];
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) { const t = (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (!/vite|DevTools|Download the React/.test(t)) errors.push(`[${m.params.type}] ${t.slice(0, 300)}`); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => { ws.onopen = r; });
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 500 });
await send("Page.navigate", { url: "http://localhost:3000/?view=query" });
await sleep(7000); // 图加载
// 填问题 + 点运行（React 受控输入需用原生 setter + input 事件）
await send("Runtime.evaluate", { expression: `
  (() => {
    const input = document.querySelector('.qw-askbar input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(question)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'input set';
  })()`, returnByValue: true });
await sleep(300);
await send("Runtime.evaluate", { expression: `document.querySelector('.qw-run').click(); 'run clicked'`, returnByValue: true });
await sleep(4000); // 查询 + 高亮
const shot = await send("Page.captureScreenshot", { format: "png" });
if (!shot.result?.data) { console.error("screenshot failed"); process.exit(1); }
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log(`saved ${out}`);
console.log(errors.length ? `console:\n${errors.join("\n")}` : "console: no errors");
ws.close(); edge.kill(); process.exit(0);
