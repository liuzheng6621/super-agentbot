import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BROWSER_CANDIDATES = [
  process.env.AGENTFORGE_BROWSER_PATH,
  process.env.AGENTFORGE_EDGE_PATH,
  'C:////Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:////Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:////Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:////Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function browserPath() {
  return BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || '';
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

async function waitFor(fn, label, timeoutMs = 25000) {
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

async function startServer(dataDir, extraEnv = {}) {
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
      ...extraEnv,
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

class WebSocketConnection {
  constructor(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:') throw new Error(`unsupported WebSocket protocol: ${parsed.protocol}`);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 80);
    this.path = `${parsed.pathname}${parsed.search}`;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onmessage = null;
    this.onclose = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      let handshake = Buffer.alloc(0);
      let upgraded = false;
      const fail = (err) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.write(
          `GET ${this.path} HTTP/1.1\r\n` +
            `Host: ${this.host}:${this.port}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      socket.on('data', (chunk) => {
        if (upgraded) {
          this.receive(chunk);
          return;
        }
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = handshake.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101\b/.test(headers)) {
          fail(new Error(`CDP WebSocket handshake failed: ${headers.split('\r\n')[0]}`));
          return;
        }
        upgraded = true;
        socket.removeListener('error', fail);
        socket.on('error', () => this.onclose?.());
        socket.on('close', () => this.onclose?.());
        resolve();
        const rest = handshake.subarray(end + 4);
        if (rest.length) this.receive(rest);
      });
    });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const size = this.buffer.readBigUInt64BE(2);
        if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('CDP WebSocket frame is too large');
        }
        length = Number(size);
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      } else {
        payload = Buffer.from(payload);
      }
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(payload, 0x0a);
        continue;
      }
      if (opcode === 0x0a) continue;
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onmessage?.({ data: message });
        }
        continue;
      }
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        continue;
      }
      if (opcode === 0x1) this.onmessage?.({ data: payload.toString('utf8') });
    }
  }

  sendFrame(payload, opcode = 0x1) {
    if (!this.socket || this.socket.destroyed) throw new Error('CDP WebSocket is closed');
    const data = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | data.length;
    } else if (data.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(data.length);
    for (let index = 0; index < data.length; index += 1) {
      masked[index] = data[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(value) {
    this.sendFrame(value);
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.sendFrame(Buffer.alloc(0), 0x8);
    } catch {
      /* The socket may already be closing. */
    }
    this.socket.end();
  }
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
    this.socket = new WebSocketConnection(this.url);
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
    await this.socket.open();
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
  const executable = browserPath();
  if (!executable) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-edge-'));
  const port = await availablePort();
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      // CI 容器里 Chrome 的沙箱与 /dev/shm 不可用，必须显式关闭。
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
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
    const required =
      process.env.AGENTFORGE_REQUIRE_BROWSER_TESTS === '1' ||
      process.env.CI === 'true' ||
      process.env.CI === '1';
    const message =
      '未找到 Edge / Chrome；设置 AGENTFORGE_BROWSER_PATH 后运行浏览器验收';
    // CI 与显式要求下，跳过等于失败：浏览器用例必须真跑。
    if (required) assert.fail(message);
    t.skip(message);
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

    const shell = await page.evaluate(`(() => ({
      workspaceEntry: !!document.querySelector('#heroInput'),
      taskList: !!document.querySelector('#taskList'),
      identityChip: !!document.querySelector('#identityChip'),
      authModal: !!document.querySelector('#authModal'),
      authModalOpen: document.querySelector('#authModal').open,
      taskFilters: !!document.querySelector('#taskFilters'),
      missionCard: !!document.querySelector('#missionCard'),
      inspectorCollapsed: document.querySelector('.app').classList.contains('insp-collapsed'),
      inspectorExpand: !!document.querySelector('#inspectorExpand'),
    }))()`);
    assert.equal(shell.workspaceEntry, true, '状态页必须渲染工作区入口');
    assert.equal(shell.taskList, true, '状态页必须渲染任务列表');
    assert.equal(shell.identityChip, true, '状态页必须渲染主体标识');
    assert.equal(shell.authModal, true, '登录弹窗必须在 DOM 中');
    assert.equal(shell.authModalOpen, false, '无 Token 回环不需要登录');
    assert.equal(shell.taskFilters, true, '任务筛选必须常驻左栏');
    assert.equal(shell.missionCard, true, '任务概览卡槽位必须存在');
    assert.equal(shell.inspectorCollapsed, true, '详情面板默认收起，避免三栏同时抢占注意力');
    assert.equal(shell.inspectorExpand, true, '收起后必须保留展开入口');

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

    // 登录：Token 服务下必须先弹登录框，输入后主体标识可见。
    const securedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-auth-'));
    const token = ['agentforge', 'browser', 'login', '0123456789'].join('-');
    const secured = await startServer(securedDir, { AGENTFORGE_API_TOKEN: token });
    let securedSession = null;
    try {
      securedSession = await openPage(edge, secured.baseUrl);
      await waitFor(
        () => securedSession.page.evaluate("document.querySelector('#authModal').open"),
        'auth modal opens on 401',
      );
      await securedSession.page.evaluate(`(() => {
        const input = document.querySelector('#authTokenInput');
        input.value = ${JSON.stringify(token)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#authSave').click();
      })()`);
      await waitFor(
        () => securedSession.page.evaluate("!document.querySelector('#authModal').open"),
        'auth modal closes after login',
      );
      await waitFor(
        () => securedSession.page.evaluate("!document.querySelector('#identityChip').hidden"),
        'identity chip after login',
      );
    } finally {
      await closePage(securedSession);
      if (secured.child.exitCode === null) secured.child.kill('SIGTERM');
      await new Promise((resolve) => {
        if (secured.child.exitCode !== null) resolve();
        else secured.child.once('exit', resolve);
        setTimeout(resolve, 2000).unref();
      });
      try {
        fs.rmSync(securedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
      } catch {
        /* Windows may hold the directory briefly. */
      }
    }
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
