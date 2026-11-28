/**
 * 开发期截图工具：启动 headless Edge/Chrome，用 CDP 打开页面并截图。
 * 用法：node scripts/ui-shot.mjs http://127.0.0.1:8787/ out.png [宽] [高]
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  process.env.AGENTFORGE_BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const executable = CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!executable) {
  console.error('未找到 Edge/Chrome');
  process.exit(1);
}

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const out = path.resolve(process.argv[3] || 'ui.png');
const width = Number(process.argv[4]) || 1680;
const height = Number(process.argv[5]) || 1050;

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const assigned = server.address().port;
    server.close((err) => (err ? reject(err) : resolve(assigned)));
  });
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'af-shot-'));
const child = spawn(
  executable,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error('CDP target 未就绪');
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

try {
  const wsUrl = await waitForTarget();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(6000);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`[shot] ${out} (${width}x${height})`);
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  child.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* Windows may hold the profile briefly */
  }
}
