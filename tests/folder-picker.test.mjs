import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE_CANDIDATES = [
  process.env.AGENTFORGE_EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function edgePath() {
  return EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || '';
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitFor(fn, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForHealth(baseUrl, child) {
  return waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    const response = await fetch(`${baseUrl}/api/health`);
    return response.ok ? response.json() : null;
  }, 'server health');
}

async function startServer(dataDir) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: dataDir,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForHealth(baseUrl, child);
    return { baseUrl, child, logs: () => `${stdout}\n${stderr}` };
  } catch (err) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

async function stopServer(server) {
  if (!server) return;
  if (server.child.exitCode === null) {
    try {
      await fetch(`${server.baseUrl}/api/shutdown`, { method: 'POST' });
    } catch {
      server.child.kill('SIGTERM');
    }
  }
  await new Promise((resolve) => {
    if (server.child.exitCode !== null) resolve();
    else server.child.once('exit', resolve);
    setTimeout(resolve, 3000).unref();
  });
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.socket = null;
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error('CDP WebSocket failed'));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method) this.events.push(message);
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000).unref();
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'page evaluation failed');
    }
    return result.result?.value;
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }
}

async function startEdge() {
  const executable = edgePath();
  if (!executable) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-edge-'));
  const port = await availablePort();
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  try {
    const version = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Edge exited with ${child.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok ? response.json() : null;
    }, 'Edge CDP');
    return { child, profile, browserUrl: version.webSocketDebuggerUrl };
  } catch (err) {
    if (child.exitCode === null) child.kill();
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Edge may still hold its profile. */
    }
    throw err;
  }
}

async function stopEdge(edge) {
  if (!edge) return;
  if (edge.child.exitCode === null) edge.child.kill();
  await new Promise((resolve) => {
    if (edge.child.exitCode !== null) resolve();
    else edge.child.once('exit', resolve);
    setTimeout(resolve, 2000).unref();
  });
  try {
    fs.rmSync(edge.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* Best-effort cleanup for browser profile locks. */
  }
}

async function openPage(edge, url) {
  const browser = new Cdp(edge.browserUrl);
  await browser.open();
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const targets = await waitFor(async () => {
    const response = await fetch(
      `http://127.0.0.1:${new URL(edge.browserUrl).port}/json/list`,
    );
    if (!response.ok) return null;
    const list = await response.json();
    return list.find((item) => item.id === targetId && item.webSocketDebuggerUrl) ? list : null;
  }, 'page target');
  const target = targets.find((item) => item.id === targetId);
  assert.ok(target?.webSocketDebuggerUrl, 'created page must expose a CDP target');
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.open();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Page.navigate', { url });
  await waitFor(
    () => page.evaluate("document.readyState === 'complete' && !!document.querySelector('#dirPick')"),
    'page ready',
  );
  return { browser, page, targetId };
}

async function closePage(session) {
  if (!session) return;
  session.page.close();
  try {
    await session.browser.send('Target.closeTarget', { targetId: session.targetId });
  } catch {
    /* page may already be gone */
  }
  session.browser.close();
}

function directoryPathForUrl(value) {
  return value.replace(/\\/g, '/');
}

test('文件夹选择器在真实浏览器中可见、可浏览并保留中文空格路径', async (t) => {
  const edge = await startEdge();
  if (!edge) {
    t.skip('未找到 Microsoft Edge；设置 AGENTFORGE_EDGE_PATH 后运行浏览器验收');
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-folder-'));
  const artifactDir = path.resolve('artifacts', 'folder-picker');
  fs.mkdirSync(artifactDir, { recursive: true });
  const root = path.join(dataDir, '项目 目录');
  const child = path.join(root, '子 目录');
  fs.mkdirSync(child, { recursive: true });
  let server = null;
  let session = null;
  try {
    server = await startServer(dataDir);
    session = await openPage(edge, server.baseUrl);
    const { page } = session;

    const initial = await page.evaluate(`(() => {
      const button = document.querySelector('#dirPick');
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        text: button.textContent.trim(),
        label: document.querySelector('#dirLabel').textContent.trim(),
        modalOpen: document.querySelector('#dirModal').open,
      };
    })()`);
    assert.equal(initial.visible, true, '文件夹按钮必须在首屏可见');
    assert.equal(initial.modalOpen, false);
    assert.match(initial.label, /自动新建工作区/);

    await page.evaluate("document.querySelector('#dirPick').click()");
    await waitFor(
      () => page.evaluate("document.querySelector('#dirModal').open"),
      'directory modal open',
    );
    await waitFor(
      () => page.evaluate("document.querySelector('#dirList').textContent.includes('用户目录')"),
      'root directory listing',
    );

    await page.evaluate(`(() => {
      const userDir = [...document.querySelectorAll('#dirList [data-dir]')]
        .find((item) => item.textContent.includes('用户目录'));
      userDir.click();
    })()`);
    await waitFor(
      () => page.evaluate("document.querySelector('#dirPath').textContent !== '我的电脑'"),
      'user directory navigation',
    );

    const listing = await fetch(
      `${server.baseUrl}/api/fs?path=${encodeURIComponent(root)}`,
    ).then((response) => response.json());
    assert.equal(listing.path, path.resolve(root));
    assert.ok(listing.dirs.some((entry) => entry.name === '子 目录'));

    const home = path.resolve(process.env.USERPROFILE || process.env.HOME);
    const parent = path.dirname(home);
    await page.evaluate("document.querySelector('#dirUp').click()");
    await waitFor(
      () =>
        page.evaluate(
          `document.querySelector('#dirPath').textContent === ${JSON.stringify(parent)}`,
        ),
      'first parent navigation',
    );
    await page.evaluate(`(async () => {
      for (let i = 0; i < 20 && !document.querySelector('#dirUp').disabled; i += 1) {
        const before = document.querySelector('#dirPath').textContent;
        document.querySelector('#dirUp').click();
        for (let tick = 0; tick < 100; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (document.querySelector('#dirPath').textContent !== before) break;
        }
      }
    })()`);
    await waitFor(
      () => page.evaluate("document.querySelector('#dirUp').disabled"),
      'filesystem root navigation',
    );

    await page.evaluate(`(() => {
      const list = document.querySelector('#dirList');
      list.innerHTML = '<button type="button" class="dir-item" data-dir="' +
        ${JSON.stringify(directoryPathForUrl(root).replace(/"/g, '&quot;'))} +
        '"><span>项目 目录</span></button>';
    })()`);
    await page.evaluate("document.querySelector('#dirList [data-dir]').click()");
    await waitFor(
      () => page.evaluate(`document.querySelector('#dirPath').textContent === ${JSON.stringify(path.resolve(root))}`),
      'Chinese-space path listing',
    );

    await page.evaluate("document.querySelector('#dirConfirm').click()");
    await waitFor(
      () => page.evaluate("!document.querySelector('#dirModal').open"),
      'directory confirm closes modal',
    );
    const chosen = await page.evaluate(`({
      label: document.querySelector('#dirLabel').textContent,
      stored: localStorage.getItem('agentforge:dir'),
      on: document.querySelector('#dirPick').classList.contains('on'),
    })`);
    assert.equal(chosen.stored, path.resolve(root));
    assert.equal(chosen.on, true);
    assert.match(chosen.label, /项目 目录/);

    await page.evaluate("document.querySelector('#dirPick').click()");
    await waitFor(
      () => page.evaluate("document.querySelector('#dirModal').open"),
      'reopen directory modal',
    );
    await page.evaluate("document.querySelector('#dirReset').click()");
    await waitFor(
      () => page.evaluate("!document.querySelector('#dirModal').open"),
      'reset closes modal',
    );
    const reset = await page.evaluate(`({
      label: document.querySelector('#dirLabel').textContent,
      stored: localStorage.getItem('agentforge:dir'),
    })`);
    assert.match(reset.label, /自动新建工作区/);
    assert.equal(reset.stored, null);

    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.join(artifactDir, 'folder-picker.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    assert.ok(fs.statSync(screenshotPath).size > 1000, '当前构建截图应非空');
    console.log(`[folder-picker] screenshot=${screenshotPath} bytes=${fs.statSync(screenshotPath).size}`);
  } catch (err) {
    throw new Error(`${err.message}\n${server?.logs() || ''}`);
  } finally {
    await closePage(session);
    await stopServer(server);
    await stopEdge(edge);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows 临时目录偶发占用 */
    }
  }
});

test('/api/fs reports invalid and non-directory paths explicitly', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-folder-api-'));
  const regularFile = path.join(dataDir, 'not-a-directory.txt');
  fs.writeFileSync(regularFile, 'plain file');
  let server = null;
  try {
    server = await startServer(dataDir);
    const missing = await fetch(
      `${server.baseUrl}/api/fs?path=${encodeURIComponent(path.join(dataDir, 'missing'))}`,
    );
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /目录不存在/);

    const file = await fetch(
      `${server.baseUrl}/api/fs?path=${encodeURIComponent(regularFile)}`,
    );
    assert.equal(file.status, 400);
    assert.match((await file.json()).error, /不是目录/);

    const unreadable = await fetch(
      `${server.baseUrl}/api/fs?path=${encodeURIComponent(path.join(dataDir, 'unreadable'))}`,
    );
    assert.equal(unreadable.status, 400);
    assert.match((await unreadable.json()).error, /目录不存在|无法读取/);
  } finally {
    await stopServer(server);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows 临时目录偶发占用 */
    }
  }
});
