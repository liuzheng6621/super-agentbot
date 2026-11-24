/**
 * AGENTFORGE 桌面启动器
 * 1) 复用已在运行的实例，或拉起本地服务（隐藏控制台）
 * 2) 用 Edge/Chrome 的 --app 模式打开独立窗口（无地址栏、独立任务栏图标）
 * 3) 窗口关闭后回收服务进程
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = process.env.AGENTFORGE_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'AgentForge');
const LOG_DIR = path.join(HOME, 'logs');
const PROFILE_DIR = path.join(HOME, 'browser');
const LOCK_FILE = path.join(HOME, 'runtime.json');
const BASE_PORT = Number(process.env.PORT || 8787);

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'launcher.log'), line);
  } catch {
    /* 日志失败不影响启动 */
  }
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 900 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data && data.ok ? data : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await portIsFree(p)) return p;
  }
  return BASE_PORT + 20;
}

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ];
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(data) {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log('写 lock 失败', err.message);
  }
}

function dropLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

async function startServer() {
  const port = await pickPort();
  const outFd = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');
  const errFd = fs.openSync(path.join(LOG_DIR, 'server.err.log'), 'a');

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    detached: false,
  });

  child.on('exit', (code, signal) => log(`server 退出 code=${code} signal=${signal}`));
  child.on('error', (err) => log('server 启动失败', err.message));

  for (let i = 0; i < 80; i++) {
    const ok = await health(port);
    if (ok) {
      log(`server 就绪 port=${port} pid=${child.pid}`);
      return { port, child };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log('server 启动超时');
  killTree(child.pid);
  throw new Error('本地服务启动超时');
}

function openWindow(port) {
  const browser = findBrowser();
  const url = `http://127.0.0.1:${port}/`;

  if (!browser) {
    log('未找到 Edge/Chrome，回退默认浏览器');
    spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', url], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
    return null;
  }

  const args = [
    `--app=${url}?app=1`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--window-size=1520,960',
    '--window-position=80,60',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-features=Translate,BackgroundMode',
    '--disable-sync',
    '--hide-crash-restore-bubble',
    '--disable-popup-blocking',
  ];

  log('启动窗口', browser);
  return spawn(browser, args, { cwd: ROOT, stdio: 'ignore', windowsHide: false });
}

async function main() {
  /* 已有实例：只开窗口，不接管服务 */
  const lock = readLock();
  if (lock?.port && (await health(lock.port))) {
    log('复用已有实例', lock.port);
    const win = openWindow(lock.port);
    if (win) win.on('exit', () => process.exit(0));
    else setTimeout(() => process.exit(0), 1500);
    return;
  }

  /* 默认端口上已有本应用（例如手动 npm start）：直接开窗口，不接管进程 */
  if (await health(BASE_PORT)) {
    log('复用默认端口上的实例', BASE_PORT);
    const win = openWindow(BASE_PORT);
    if (win) win.on('exit', () => process.exit(0));
    else setTimeout(() => process.exit(0), 1500);
    return;
  }

  const { port, child } = await startServer();
  writeLock({ pid: child.pid, port, startedAt: Date.now() });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    killTree(child.pid);
    dropLock();
    log('已回收服务进程');
  };

  process.on('exit', shutdown);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    log('未捕获异常', err.message);
    process.exit(1);
  });

  const win = openWindow(port);

  if (!win) {
    // 没有可控窗口时保持服务存活，直到用户手动结束
    log('无窗口进程，服务持续运行');
    return;
  }

  /* 反向回收：界面里点「退出」会关掉服务，这里要连带把窗口关掉 */
  child.on('exit', (code) => {
    if (closing) return;
    log(`server 主动退出 code=${code}，关闭窗口`);
    closing = true;
    dropLock();
    killTree(win.pid);
    setTimeout(() => process.exit(0), 300);
  });

  win.on('exit', (code) => {
    log(`窗口关闭 code=${code}`);
    process.exit(0);
  });

  win.on('error', (err) => {
    log('窗口启动失败', err.message);
    process.exit(1);
  });
}

main().catch((err) => {
  log('致命错误', err.stack || err.message);
  process.exit(1);
});
