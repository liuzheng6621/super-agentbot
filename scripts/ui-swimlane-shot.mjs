#!/usr/bin/env node
/**
 * Capture the workspace swimlane view through real DOM interactions.
 * Usage: node scripts/ui-swimlane-shot.mjs [url] [outPrefix] [taskId]
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CANDIDATES = [
  process.env.AGENTFORGE_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const executable = CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!executable) {
  console.error("Edge/Chrome not found");
  process.exit(1);
}

const url = process.argv[2] || "http://127.0.0.1:8787/";
const prefix = path.resolve(process.argv[3] || "docs/ux-final-swimlane");
const requestedTaskId = process.argv[4] || "";

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const assigned = server.address().port;
    server.close((err) => (err ? reject(err) : resolve(assigned)));
  });
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "af-swimlane-"));
const child = spawn(executable, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--window-size=1440,1000",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  "about:blank",
], { stdio: "ignore", windowsHide: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error("CDP target not ready");
}

let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function assertOk(label, condition, detail = "") {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`[ok] ${label}${detail ? ` ${detail}` : ""}`);
}

try {
  ws = new WebSocket(await waitForTarget());
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params?.exceptionDetails;
      console.error("[browser-exception]", detail?.exception?.description || detail?.text || "unknown");
    }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });

  const evalJs = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "Runtime.evaluate failed");
    }
    return result.result.value;
  };

  const waitFor = async (expression, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await evalJs(expression);
        if (value) return value;
      } catch (err) {
        lastError = err;
      }
      await sleep(50);
    }
    throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
  };

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor("Boolean(document.querySelector('.task-item'))", "task list");

  const selector = requestedTaskId
    ? `[data-task="${requestedTaskId}"]`
    : ".task-item";
  assertOk(
    "task present",
    await evalJs(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
    requestedTaskId || "first task",
  );
  await evalJs(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})?.classList.contains("active")
      && Boolean(document.querySelector('#wcTaskCode')?.textContent?.trim())`,
    "task selection",
  );

  await evalJs("document.querySelector('#workspaceExpand')?.click()");
  await waitFor("!document.querySelector('#workspaceConsole')?.hidden", "workspace console");
  await evalJs(`document.querySelector('[data-wc-view="swimlane"]')?.click()`);
  await sleep(250);
  const swimlaneDiagnostics = await evalJs(`({
    activeTab: document.querySelector('#wcViewTabs .active')?.dataset?.wcView || '',
    consoleHidden: Boolean(document.querySelector('#workspaceConsole')?.hidden),
    swimlaneViewHidden: Boolean(document.querySelector('#wcSwimlaneView')?.hidden),
    count: document.querySelector('#wcSwimlaneCount')?.textContent || '',
    htmlLength: (document.querySelector('#wcSwimlane')?.innerHTML || '').length,
    htmlHead: (document.querySelector('#wcSwimlane')?.innerHTML || '').slice(0, 300),
  })`);
  console.log("[diagnostics] swimlane", JSON.stringify(swimlaneDiagnostics, null, 2));
  await waitFor("document.querySelectorAll('.wc-swimlane-block').length > 0", "swimlane blocks");

  const rows = await evalJs("document.querySelectorAll('.wc-swimlane-row').length");
  const blocks = await evalJs("document.querySelectorAll('.wc-swimlane-block').length");
  assertOk("swimlane rendered", rows > 0 && blocks > 0, `rows=${rows} blocks=${blocks}`);

  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const desktopShot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${prefix}-desktop.png`, Buffer.from(desktopShot.data, "base64"));
  console.log(`[shot] ${prefix}-desktop.png (1440x1000)`);

  const scrubberMin = await evalJs("String(document.querySelector('#wcSwimlaneScrubber').min)");
  await evalJs(`
    const scrubber = document.querySelector('#wcSwimlaneScrubber');
    scrubber.value = scrubber.min;
    scrubber.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(100);
  const scrubberValue = await evalJs("String(document.querySelector('#wcSwimlaneScrubber').value)");
  const liveSnapshot = await evalJs("document.querySelector('#wcSwimlaneLive')?.textContent || ''");
  assertOk(
    "replay snapshot updated",
    scrubberValue === scrubberMin && liveSnapshot.trim().length > 0,
    `scrubber=${scrubberValue}`,
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(600);
  const mobileRows = await evalJs("document.querySelectorAll('.wc-swimlane-row').length");
  const mobileBlocks = await evalJs("document.querySelectorAll('.wc-swimlane-block').length");
  assertOk("mobile swimlane rendered", mobileRows > 0 && mobileBlocks > 0, `rows=${mobileRows} blocks=${mobileBlocks}`);
  const mobileShot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${prefix}-mobile.png`, Buffer.from(mobileShot.data, "base64"));
  console.log(`[shot] ${prefix}-mobile.png (390x844)`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* Windows may hold the profile briefly */ }
}
