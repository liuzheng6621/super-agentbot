import { spawn, spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 模拟适配器：把文本按块吐出，制造真实流式观感                         */
/* ------------------------------------------------------------------ */

export async function* streamText(text, { minMs = 700, maxMs = 3200, speed = 1, signal } = {}) {
  const total = Math.min(maxMs, Math.max(minMs, text.length * 1.6)) / Math.max(0.2, speed);
  const size = Math.max(2, Math.ceil(text.length / 90));
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  const delay = total / Math.max(1, chunks.length);
  for (const chunk of chunks) {
    await sleep(delay, signal);
    yield chunk;
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* 真实 CLI 适配器                                                      */
/* ------------------------------------------------------------------ */

function quoteArg(arg) {
  if (process.platform === 'win32') {
    if (arg === '') return '""';
    if (!/[\s"&|<>^()]/.test(arg)) return arg;
    return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
  }
  if (!/[\s"'$`\\!*?[\]{}()<>|&;#~]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function buildArgs(agent, prompt) {
  const { args = [] } = agent.cli || {};
  return (args.length ? args : ['-p', '{{prompt}}']).map((a) =>
    String(a).replace(/\{\{prompt\}\}/g, prompt),
  );
}

function buildCommand(agent, prompt) {
  const { command } = agent.cli || {};
  const finalArgs = buildArgs(agent, prompt);
  return [command, ...finalArgs].map((a, i) => (i === 0 ? a : quoteArg(a))).join(' ');
}

/**
 * 执行一次真实 CLI 调用，把 stdout 增量回调出去。
 * @returns {Promise<{code:number, stdout:string, stderr:string, elapsed:number}>}
 */
export function spawnCli(agent, prompt, { cwd, onChunk, timeout = 180000, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (!agent.cli?.command) {
      resolve({ code: -2, stdout: '', stderr: '未配置 CLI 命令', elapsed: 0 });
      return;
    }
    // 与 buildCommand 保持同一套默认参数，避免既走参数又走 stdin
    const declaredArgs = agent.cli.args?.length ? agent.cli.args : ['-p', '{{prompt}}'];
    const passByStdin = !declaredArgs.some((a) => String(a).includes('{{prompt}}'));

    const runCwd = cwd || agent.cli.cwd || process.cwd();
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const resolved = resolveCommand(agent.cli.command);
    // 真 .exe 直连：Node 用宽字符命令行传参，中文不会被代码页吃掉，也没有引号转义问题
    const direct = resolved && !/\.(cmd|bat|ps1)$/i.test(resolved);

    let child;
    try {
      if (direct) {
        child = spawn(resolved, buildArgs(agent, prompt), {
          cwd: runCwd,
          shell: false,
          windowsHide: true,
          env,
          // prompt 已在参数里时不给 stdin 管道：codex 会一直等「Reading additional input from stdin...」不退出
          stdio: [passByStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } else {
        // .cmd / .bat 只能过 cmd.exe，先把代码页切到 UTF-8，否则中文参数会乱码
        const prefix = process.platform === 'win32' ? 'chcp 65001>nul & ' : '';
        child = spawn(prefix + buildCommand(agent, prompt), {
          cwd: runCwd,
          shell: true,
          windowsHide: true,
          env,
          stdio: [passByStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      }
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message, elapsed: 0 });
      return;
    }

    // 必须把 stdin 交完就关掉：aider 这类 CLI 会一直读到超时。
    // prompt 在参数里时 stdin 是 ignore（null），用可选链避免抛错。
    try {
      if (passByStdin) child.stdin?.end(`${prompt}\n`);
      else child.stdin?.end();
    } catch {
      /* 子进程可能已退出 */
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let onAbort = null;
    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr: stderr + (err ? String(err) : ''), elapsed: Date.now() - started });
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish(-3, `\n[超时] 超过 ${Math.round(timeout / 1000)}s 未结束，已终止`);
    }, timeout);

    child.on('error', (err) => finish(-1, err.message));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      stdout += d;
      onChunk?.(d);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => finish(code ?? 0));
    if (signal) {
      onAbort = () => {
        killTree(child);
        finish(-4, '已取消');
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 本机 CLI 探测                                                        */
/* ------------------------------------------------------------------ */

const CANDIDATES = [
  { command: 'claude', label: 'Claude Code', args: ['-p', '{{prompt}}', '--output-format', 'text'] },
  // codex 在非 git 目录会直接拒绝执行，沙箱限定为工作区可写
  { command: 'codex', label: 'Codex CLI', args: ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '{{prompt}}'] },
  { command: 'opencode', label: 'OpenCode', args: ['run', '--auto', '{{prompt}}'] },
  { command: 'cursor-agent', label: 'Cursor Agent', args: ['-p', '{{prompt}}'] },
  { command: 'copilot', label: 'Copilot CLI', args: ['-p', '{{prompt}}'] },
  { command: 'cn', label: 'Continue CLI', args: ['-p', '{{prompt}}'] },
  { command: 'dsh', label: 'DSH Agent', args: ['headless', '{{prompt}}'] },
  { command: 'kimi', label: 'Kimi Code', args: ['-p', '{{prompt}}', '--output-format', 'text'] },
  { command: 'trae-cli', label: 'Trae Agent', args: ['run', '{{prompt}}'] },
  // workbuddy 是业务系统 CLI（jobs/crm/mcp），没有一次性提示词入口，不能当编排成员用
  { command: 'crush', label: 'Crush', args: ['run', '{{prompt}}'] },
  { command: 'goose', label: 'Goose', args: ['run', '-t', '{{prompt}}'] },
  { command: 'aider', label: 'Aider', args: ['--message', '{{prompt}}', '--yes'] },
  { command: 'gemini', label: 'Gemini CLI', args: ['-p', '{{prompt}}'] },
  { command: 'qwen', label: 'Qwen Code', args: ['-p', '{{prompt}}'] },
  { command: 'ollama', label: 'Ollama', args: ['run', 'qwen2.5-coder', '{{prompt}}'] },
];

/**
 * 只靠退出码判断会误判：很多 CLI 的 --version 会去等 stdin 或跑很久。
 * 所以先用 where.exe 确认命令真实存在，再尽力读取版本。
 */
export function resolveCommand(command) {
  try {
    const raw = String(command || '').trim();
    if (raw && (path.isAbsolute(raw) || /[\\/]/.test(raw)) && fs.existsSync(raw)) return path.resolve(raw);
    if (process.platform === 'win32') {
      const res = spawnSync('where.exe', [command], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (res.status === 0) {
        const found = (res.stdout || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((p) => p && fs.existsSync(p));
        // npm 全局包会同时生成无扩展名 shim / .cmd / .ps1，必须挑能直接执行的
        const best =
          found.find((p) => /\.exe$/i.test(p)) ||
          found.find((p) => /\.(cmd|bat)$/i.test(p)) ||
          found[0];
        if (best) return best;
      }
    } else {
      const res = spawnSync('which', [command], { encoding: 'utf8', timeout: 5000 });
      if (res.status === 0) {
        const first = (res.stdout || '').trim().split('\n')[0];
        if (first && fs.existsSync(first)) return first;
      }
    }
    // 兜底：PATH 之外的常见安装目录（npm 全局、uv/pipx、winget、Programs…）
    for (const dir of commonBinDirs()) {
      for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
        const p = path.join(dir, command + ext);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {
    /* 忽略，按未找到处理 */
  }
  return null;
}

/** 常见可执行文件目录：很多 CLI 装完不进 PATH，或只进用户级 PATH */
export function commonBinDirs() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const dirs = [
    path.join(home, '.local', 'bin'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.ProgramFiles || '',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  return dirs.filter((d) => d && fs.existsSync(d));
}

function readVersion(exe) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let done = false;
    let child;
    const timer = setTimeout(() => finish(true), 6000);
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (timedOut && child) killTree(child);
      resolve({ out: out.trim(), timedOut, ms: Date.now() - started });
    };
    try {
      // stdin 必须直接 ignore，否则 --version 也可能卡在读输入上
      child = spawn(`"${exe}" --version`, {
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return finish(false);
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', () => finish(false));
    child.on('close', () => finish(false));
  });
}

async function probeOne(candidate) {
  const exe = resolveCommand(candidate.command);
  if (!exe) return { ...candidate, found: false, reason: 'missing', path: '', version: '', ms: 0 };

  const res = await readVersion(exe);
  const first = res.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  return {
    ...candidate,
    found: true,
    path: exe,
    reason: res.timedOut ? 'timeout' : 'ok',
    version: first.slice(0, 90) || (res.timedOut ? '已安装（版本探测超时）' : '已安装'),
    ms: res.ms,
  };
}

export async function probeClis() {
  return Promise.all(CANDIDATES.map(probeOne));
}

export { CANDIDATES };
