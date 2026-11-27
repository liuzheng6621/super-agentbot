import { spawn, spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { prepareCliExecution } from './cli-policy.mjs';

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

function isGeminiCommand(command) {
  const base = path
    .basename(String(command || '').trim())
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return base === 'gemini';
}

function isTraeCommand(command) {
  const base = path
    .basename(String(command || '').trim())
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return base === 'trae-cli' || base === 'trae';
}

/**
 * Gemini's interactive mode can wait forever even after stdin is closed.
 * `--prompt=` switches it to headless mode while the actual prompt still
 * travels through stdin, avoiding Windows command-line escaping issues.
 */
export function normalizeCliArgs(command, args = []) {
  const normalized = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  if (isGeminiCommand(command)) {
    const hasPromptFlag = normalized.some(
      (arg) => arg === '-p' || arg === '--prompt' || arg.startsWith('--prompt='),
    );
    return hasPromptFlag ? normalized : [...normalized, '--prompt='];
  }
  if (isTraeCommand(command) && normalized[0] === 'run') {
    if (!normalized.some((arg) => arg === '--max-steps' || arg.startsWith('--max-steps='))) {
      normalized.splice(1, 0, '--max-steps', '16');
    }
    if (
      !normalized.some(
        (arg) => arg === '--console-type' || arg.startsWith('--console-type='),
      )
    ) {
      normalized.splice(1, 0, '--console-type', 'simple');
    }
  }
  return normalized;
}

function replaceOption(args, names, value) {
  if (!value) return args;
  const out = [...args];
  for (let index = 0; index < out.length; index += 1) {
    if (!names.includes(out[index])) continue;
    if (index + 1 < out.length) out[index + 1] = value;
    return out;
  }
  return out;
}

function applyProviderArgs(agent, args) {
  const provider = agent?.provider;
  if (!provider) return args;
  let out = [...args];
  if (provider.model) {
    out = replaceOption(out, ['--model', '-m'], provider.model);
    out = out.map((arg) => (String(arg).startsWith('model=') ? `model=${provider.model}` : arg));
  }
  if (provider.baseUrl) {
    out = replaceOption(
      out,
      ['--openai-api-base', '--openai-base-url', '--base-url'],
      provider.baseUrl,
    );
  }
  return out;
}

function buildArgs(agent, prompt) {
  const { args = [] } = agent.cli || {};
  const normalized = applyProviderArgs(
    agent,
    normalizeCliArgs(agent.cli?.command, args.length ? args : ['-p', '{{prompt}}']),
  );
  return normalized.map((a) => a.replace(/\{\{prompt\}\}/g, prompt));
}

function buildCommand(agent, prompt) {
  const { command } = agent.cli || {};
  const finalArgs = buildArgs(agent, prompt);
  // 命令本身也可能带空格（例如 Program Files 下的 CLI），不能只给参数加引号。
  return [command, ...finalArgs].map((a) => quoteArg(a)).join(' ');
}

/**
 * 把 Windows 的 32 位进程退出码显示成用户能搜索、能对照事件查看器的格式。
 * Node 在 Windows 上通常把 0xC0000142 这类状态码作为无符号整数返回。
 */
export function formatExitCode(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return '未知';
  if (value < 0) return String(value);
  const unsigned = value >>> 0;
  if (unsigned >= 0x40000000) {
    return `${value} (0x${unsigned.toString(16).toUpperCase().padStart(8, '0')})`;
  }
  return String(value);
}

/**
 * 把退出码翻译成可操作的失败类型。尤其不要把 0xC0000142 当成普通业务错误，
 * 它表示 Windows 在进程/DLL 初始化阶段就失败了，重试和换成员比改 prompt 更有效。
 */
export function classifyCliExit(codeOrResult) {
  const res = typeof codeOrResult === 'object' && codeOrResult ? codeOrResult : { code: codeOrResult };
  const code = Number(res.code);
  if (code === 0) return { kind: 'ok', label: '成功', retryable: false };
  if (res.timedOut || code === -3) {
    return { kind: 'timeout', label: '执行超时', retryable: false };
  }
  if (code === -4) return { kind: 'stopped', label: '已停止', retryable: false };
  if (code === -6) return { kind: 'policy', label: '执行策略拒绝', retryable: false };
  if (code === -2) return { kind: 'missing', label: '未配置 CLI 命令', retryable: false };
  if (code === -1) return { kind: 'spawn', label: '进程启动失败', retryable: true };
  if (code === 3221225794) {
    return {
      kind: 'windows-init',
      label: 'Windows 进程初始化失败（0xC0000142）',
      retryable: true,
    };
  }
  if (code === 1073807364) {
    return {
      kind: 'terminated',
      label: '进程被外部终止（0x40010004）',
      retryable: false,
    };
  }
  return { kind: 'cli', label: `CLI 退出码 ${formatExitCode(code)}`, retryable: false };
}

export function describeCliResult(res = {}) {
  const failure = classifyCliExit(res);
  if (failure.kind === 'ok') return '成功';
  const detail = String(res.stderr || res.stdout || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return detail ? `${failure.label}：${detail}` : failure.label;
}

function runtimePathEnv(env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH';
  const current = String(env[key] || '');
  const parts = current.split(path.delimiter).filter(Boolean);
  const known = new Set(parts.map((part) => part.toLowerCase()));
  for (const dir of [path.dirname(process.execPath), ...commonBinDirs()]) {
    if (!dir || known.has(dir.toLowerCase())) continue;
    parts.unshift(dir);
    known.add(dir.toLowerCase());
  }
  env[key] = parts.join(path.delimiter);
  return env;
}

/**
 * 执行一次真实 CLI 调用，把 stdout 增量回调出去。
 * @returns {Promise<{code:number, stdout:string, stderr:string, elapsed:number}>}
 */
export function spawnCli(
  agent,
  prompt,
  { cwd, onChunk, timeout = 180000, signal, completeWhen = null, settleMs = 0 } = {},
) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (!agent.cli?.command) {
      resolve({ code: -2, stdout: '', stderr: '未配置 CLI 命令', elapsed: 0 });
      return;
    }
    // 与 buildCommand 保持同一套默认参数，避免既走参数又走 stdin
    const declaredArgs = normalizeCliArgs(
      agent.cli.command,
      agent.cli.args?.length ? agent.cli.args : ['-p', '{{prompt}}'],
    );
    const prepared = prepareCliExecution(agent, { args: declaredArgs });
    if (!prepared.ok) {
      resolve({
        code: -6,
        stdout: '',
        stderr: prepared.policy.reason,
        elapsed: Date.now() - started,
        policyDenied: true,
        policy: prepared.policy,
      });
      return;
    }
    const execAgent = prepared.agent;
    const passByStdin = !execAgent.cli.args.some((a) => String(a).includes('{{prompt}}'));

    const runCwd = cwd || execAgent.cli.cwd || process.cwd();
    let cwdOk = true;
    try {
      cwdOk = fs.statSync(runCwd).isDirectory();
    } catch {
      cwdOk = false;
    }
    if (!cwdOk) {
      resolve({
        code: -5,
        stdout: '',
        stderr: `工作目录不存在：${runCwd}`,
        elapsed: 0,
        policy: prepared.policy,
      });
      return;
    }
    const env = runtimePathEnv({
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // Python 系 CLI（trae-cli / aider / goose）在中文 Windows 的 GBK 代码页下打 emoji 会崩，统一给 UTF-8
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      // 单个 CLI 的自定义环境变量（如 gemini 的 GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL）
      ...(execAgent.cli.env || {}),
      // Provider Profile 只把引用解析成子进程环境，不把明文密钥写回 store。
      ...(execAgent.provider?.env || {}),
    });
    // 质量门可能在 node --test 中运行 node --test；子测试进程不能继承父测试上下文。
    delete env.NODE_TEST_CONTEXT;
    const resolved = resolveCommand(execAgent.cli.command);
    if (!resolved) {
      resolve({
        code: -2,
        stdout: '',
        stderr: `找不到 CLI 命令：${execAgent.cli.command}`,
        elapsed: 0,
        policy: prepared.policy,
      });
      return;
    }
    // 真 .exe 直连：Node 用宽字符命令行传参，中文不会被代码页吃掉，也没有引号转义问题
    const direct = resolved && !/\.(cmd|bat|ps1)$/i.test(resolved);

    let child;
    try {
      if (direct) {
        child = spawn(resolved, buildArgs(execAgent, prompt), {
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
        child = spawn(prefix + buildCommand(execAgent, prompt), {
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
    let timer = null;
    let settleTimer = null;
    const finish = (code, err, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout,
        stderr: stderr + (err ? String(err) : ''),
        elapsed: Date.now() - started,
        partial: stdout.trim().length > 0,
        policy: prepared.policy,
        ...extra,
      });
    };

    const scheduleSettle = () => {
      if (settled || typeof completeWhen !== 'function' || !(Number(settleMs) > 0)) return;
      let complete = false;
      try {
        complete = !!completeWhen(stdout);
      } catch {
        complete = false;
      }
      clearTimeout(settleTimer);
      if (!complete) return;
      settleTimer = setTimeout(() => {
        if (settled) return;
        let stillComplete = false;
        try {
          stillComplete = !!completeWhen(stdout);
        } catch {
          stillComplete = false;
        }
        if (!stillComplete) return;
        killTree(child);
        finish(0, '', { settledEarly: true });
      }, Number(settleMs));
    };

    timer = setTimeout(() => {
      killTree(child);
      finish(-3, `\n[超时] 超过 ${Math.round(timeout / 1000)}s 未结束，已终止`, { timedOut: true });
    }, timeout);

    child.on('error', (err) => finish(-1, err.message, { spawnError: true }));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      stdout += d;
      onChunk?.(d);
      scheduleSettle();
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code, closeSignal) => finish(code ?? 0, '', { signal: closeSignal || '' }));
    if (signal) {
      onAbort = () => {
        killTree(child);
        finish(-4, '已取消', { stopped: true });
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

// 本机 magpie 网关的可用模型：各 CLI 默认模型会落到 codar 等失效 provider 上，统一钉一个健康档
const MAGPIE_MODEL = process.env.AGENTFORGE_MODEL || 'trae-cn/glm-5.3-flash';

// 非交互（-p / exec）下没有人在旁边点「允许」，各 CLI 默认会把写盘动作判成待审批并卡死。
// 这里逐家给一次性的免审批开关，作用域都限定在被调用的工作区。
const CANDIDATES = [
  { command: 'claude', label: 'Claude Code', args: ['-p', '{{prompt}}', '--output-format', 'text', '--model', MAGPIE_MODEL, '--permission-mode', 'bypassPermissions'] },
  // codex 在非 git 目录会直接拒绝执行，沙箱限定为工作区可写
  { command: 'codex', label: 'Codex CLI', args: ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', `model=${MAGPIE_MODEL}`, '{{prompt}}'] },
  // 下面这些命令在本机是 .cmd/.ps1 包装器，只能过 cmd.exe：prompt 一律改走 stdin。
  // 理由：cmd.exe 会把参数里的换行当成命令分隔符，多行 prompt 一旦进了命令行，
  // 后面的 flag（如 gemini 的 --skip-trust）就被截断，实测报「not running in a trusted directory」。
  { command: 'opencode', label: 'OpenCode', args: ['run', '--auto'], healthTimeout: 60000 },
  { command: 'cursor-agent', label: 'Cursor Agent', args: ['-p', '{{prompt}}'] },
  { command: 'copilot', label: 'Copilot CLI', args: ['-p', '{{prompt}}'] },
  { command: 'cn', label: 'Continue CLI', args: ['-p', '{{prompt}}'] },
  // dsh 的 headless 用「-」表示从 stdin 读任务
  { command: 'dsh', label: 'DSH Agent', args: ['headless', '--permission-mode', 'workspace-write', '--approval-policy', 'never', '-'], healthTimeout: 90000 },
  // kimi 只有「-p <文本>」一种喂法（-p 必须带值，无参数会进交互界面，实测 stdin 也不支持），
  // 因此它没法像上面几家那样绕开 cmd 引号：多行 prompt 会被 cmd.exe 截断，只适合单行任务。
  { command: 'kimi', label: 'Kimi Code', args: ['-p', '{{prompt}}', '--output-format', 'text'] },
  // Python 写的 CLI 需要 UTF-8 环境，否则 rich 控制台在 GBK 代码页下打 ✅ 会直接抛 UnicodeEncodeError
  { command: 'trae-cli', label: 'Trae Agent', args: ['run', '--config-file', `${process.env.USERPROFILE || process.env.HOME}/.trae-cli/config.json`, '--max-steps', '16', '--console-type', 'simple', '{{prompt}}'], healthTimeout: 60000 },
  // workbuddy 是业务系统 CLI（jobs/crm/mcp），没有一次性提示词入口，不能当编排成员用
  { command: 'crush', label: 'Crush', args: ['run', '-y'] },
  { command: 'goose', label: 'Goose', args: ['run', '-t', '{{prompt}}'] },
  { command: 'aider', label: 'Aider', args: ['--message', '{{prompt}}', '--yes', '--openai-api-base', 'http://127.0.0.1:3425/v1', '--openai-api-key', 'magpie', '--model', `openai/${MAGPIE_MODEL}`, '--no-git'] },
  { command: 'gemini', label: 'Gemini CLI', args: ['--skip-trust', '--approval-mode', 'yolo', '-m', MAGPIE_MODEL, '--prompt='], env: { GEMINI_API_KEY: 'magpie', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:3425' } },
  { command: 'qwen', label: 'Qwen Code', args: ['--approval-mode', 'yolo', '--auth-type', 'openai', '--openai-api-key', 'magpie', '--openai-base-url', 'http://127.0.0.1:3425/v1', '-m', MAGPIE_MODEL] },
  { command: 'ollama', label: 'Ollama', args: ['run', 'qwen2.5-coder', '{{prompt}}'] },
];

/**
 * 只靠退出码判断会误判：很多 CLI 的 --version 会去等 stdin 或跑很久。
 * 所以先用 where.exe 确认命令真实存在，再尽力读取版本。
 */
const resolveCache = new Map();
export const resolveStats = {
  cacheHits: 0,
  cacheMisses: 0,
  whereCalls: 0,
  whichCalls: 0,
  clears: 0,
};

/** 探测结果缓存：每次 CLI 调用都同步跑一遍 where.exe 会阻塞事件循环。 */
export function resolveCommand(command) {
  const key = String(command || '').trim();
  if (resolveCache.has(key)) {
    resolveStats.cacheHits += 1;
    return resolveCache.get(key);
  }
  resolveStats.cacheMisses += 1;
  const found = resolveUncached(key);
  resolveCache.set(key, found);
  return found;
}

/** CLI 装卸或 PATH 变化后，由 /api/probe、/api/team/refresh 显式失效。 */
export function clearResolveCache() {
  resolveCache.clear();
  resolveStats.clears += 1;
}

function executableToken(command) {
  const raw = String(command || '').trim();
  if (!raw) return '';
  if ((path.isAbsolute(raw) || /[\\/]/.test(raw)) && fs.existsSync(raw)) return raw;
  const quoted = raw.match(/^"([^"]+)"(?:\s|$)|^'([^']+)'(?:\s|$)/);
  if (quoted) return quoted[1] || quoted[2] || raw;
  const windowsExecutable = raw.match(/^(.+?\.(?:exe|cmd|bat|ps1))(?:\s|$)/i);
  if (windowsExecutable && fs.existsSync(windowsExecutable[1])) return windowsExecutable[1];
  return raw.match(/^\S+/)?.[0] || raw;
}

function resolveUncached(command) {
  try {
    const raw = String(command || '').trim();
    if (raw && (path.isAbsolute(raw) || /[\\/]/.test(raw)) && fs.existsSync(raw)) return path.resolve(raw);
    const executable = executableToken(raw);
    if (
      executable &&
      (path.isAbsolute(executable) || /[\\/]/.test(executable)) &&
      fs.existsSync(executable)
    ) {
      return path.resolve(executable);
    }
    if (process.platform === 'win32') {
      resolveStats.whereCalls += 1;
      const res = spawnSync('where.exe', [executable], { encoding: 'utf8', timeout: 5000, windowsHide: true });
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
      resolveStats.whichCalls += 1;
      const res = spawnSync('which', [executable], { encoding: 'utf8', timeout: 5000 });
      if (res.status === 0) {
        const first = (res.stdout || '').trim().split('\n')[0];
        if (first && fs.existsSync(first)) return first;
      }
    }
    // 兜底：PATH 之外的常见安装目录（npm 全局、uv/pipx、winget、Programs…）
    for (const dir of commonBinDirs()) {
      for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
        const p = path.join(dir, executable + ext);
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
    path.dirname(process.execPath),
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
        env: runtimePathEnv({ ...process.env }),
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
