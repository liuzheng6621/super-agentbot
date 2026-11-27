import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { store } from './store.mjs';

const COMMAND_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CONCURRENCY = 4;
const MAX_RATE_PER_MINUTE = 30;

export class CommandError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.name = 'CommandError';
    this.status = status;
    Object.assign(this, details);
  }
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function commandArgs(value, maxItems = 32) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').slice(0, 2000)).slice(0, maxItems);
}

function relativeWorkspacePath(value) {
  const raw = text(value, 1000).replace(/\\/g, '/');
  if (!raw) return '';
  if (path.isAbsolute(raw) || /^[a-z]:\//i.test(raw)) {
    throw new CommandError('命令工作目录必须是任务工作区内的相对路径', 403);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new CommandError('命令工作目录不能越出任务工作区', 403);
  }
  return normalized === '.' ? '' : normalized;
}

export function normalizeCommandWhitelist(input) {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const item of source.slice(0, 64)) {
    const id = text(item?.id, 64);
    if (!COMMAND_ID.test(id) || seen.has(id)) continue;
    const command = text(item?.command, 1000);
    if (!command) continue;
    seen.add(id);
    out.push({
      id,
      label: text(item?.label, 80) || id,
      command,
      args: commandArgs(item?.args),
      workingDirectory: relativeWorkspacePath(item?.workingDirectory || ''),
      timeoutMs: clamp(item?.timeoutMs, 100, MAX_TIMEOUT_MS, 120000),
      maxOutputBytes: clamp(item?.maxOutputBytes, 1024, 1024 * 1024, MAX_OUTPUT_BYTES),
      maxConcurrency: clamp(item?.maxConcurrency, 1, MAX_CONCURRENCY, 1),
      maxPerMinute: clamp(item?.maxPerMinute, 1, MAX_RATE_PER_MINUTE, 6),
      requireApproval: item?.requireApproval !== false,
      enabled: item?.enabled !== false,
      createdAt: Number(item?.createdAt) || Date.now(),
    });
  }
  return out;
}

export function publicCommand(entry) {
  return {
    id: entry.id,
    label: entry.label,
    command: entry.command,
    args: [...entry.args],
    workingDirectory: entry.workingDirectory,
    timeoutMs: entry.timeoutMs,
    maxOutputBytes: entry.maxOutputBytes,
    maxConcurrency: entry.maxConcurrency,
    maxPerMinute: entry.maxPerMinute,
    requireApproval: entry.requireApproval,
    enabled: entry.enabled,
  };
}

function shellQuote(value) {
  const raw = String(value ?? '');
  return /[\s"'&|<>^()]/.test(raw) ? `"${raw.replace(/"/g, '\\"')}"` : raw;
}

export function commandText(command, args = []) {
  return [command, ...args].map(shellQuote).join(' ');
}

function tail(value, maxBytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  return buffer.subarray(buffer.length - maxBytes).toString('utf8');
}

function processTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

export class CommandRunner {
  constructor({ workspaceRoot, dataRoot, getTask } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot || process.cwd());
    this.dataRoot = path.resolve(dataRoot || this.workspaceRoot);
    this.getTask = typeof getTask === 'function' ? getTask : null;
    this.active = new Map();
    this.rate = new Map();
    this.commands = new Map();
  }

  configure(entries = []) {
    this.commands = new Map(normalizeCommandWhitelist(entries).map((entry) => [entry.id, entry]));
  }

  snapshot() {
    return [...this.commands.values()].map(publicCommand);
  }

  get(id) {
    return this.commands.get(String(id || '')) || null;
  }

  resolveWorkingDirectory(task, entry, requested = '') {
    const root = path.resolve(task?.workspace || '');
    if (!task?.workspace || !fs.existsSync(root)) {
      throw new CommandError('任务工作区不存在', 404);
    }
    const relative = relativeWorkspacePath(requested || entry.workingDirectory || '');
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new CommandError('命令工作目录不能越出任务工作区', 403);
    }
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new CommandError(`命令工作目录不存在：${relative || '.'}`, 400);
    }
    if (!stat.isDirectory()) throw new CommandError('命令工作目录不是目录', 400);
    return target;
  }

  normalizeRequest({ commandId, args, workingDirectory } = {}) {
    const entry = this.get(commandId);
    if (!entry) throw new CommandError('命令不在固定白名单中', 403);
    if (!entry.enabled) throw new CommandError('命令已停用', 403);
    if (args !== undefined) {
      throw new CommandError('白名单命令不接受自定义参数', 403);
    }
    return {
      commandId: entry.id,
      label: entry.label,
      command: entry.command,
      args: [...entry.args],
      workingDirectory: relativeWorkspacePath(workingDirectory || entry.workingDirectory || ''),
    };
  }

  validateForExecution(task, request) {
    const entry = this.get(request?.commandId);
    if (!entry) throw new CommandError('命令不在固定白名单中', 403);
    if (!entry.enabled) throw new CommandError('命令已停用', 403);
    this.resolveWorkingDirectory(task, entry, request.workingDirectory);
    return entry;
  }

  _rateLimit(entry, agentId = '') {
    const key = `${entry.id}:${agentId || 'operator'}`;
    const now = Date.now();
    const recent = (this.rate.get(key) || []).filter((at) => now - at < 60000);
    if (recent.length >= entry.maxPerMinute) {
      throw new CommandError('命令触发频率限制', 429);
    }
    recent.push(now);
    this.rate.set(key, recent);
  }

  _isCancelled(id) {
    return this.active.get(id)?.cancelled === true;
  }

  async execute({ task, request, agentId = '', principal = null, runId = null, approvalId = '' } = {}) {
    if (!task?.id) throw new CommandError('任务不存在', 404);
    const entry = this.get(request.commandId);
    if (!entry) throw new CommandError('命令不在固定白名单中', 403);
    if (this.active.size >= MAX_CONCURRENCY) {
      throw new CommandError('受控命令并发已满', 429);
    }
    const activeForCommand = [...this.active.values()].filter(
      (item) => item.commandId === entry.id,
    ).length;
    if (activeForCommand >= entry.maxConcurrency) {
      throw new CommandError('该命令并发已满', 429);
    }
    this._rateLimit(entry, agentId);
    const approvalIdForRun = approvalId;
    const cwd = this.resolveWorkingDirectory(task, entry, request.workingDirectory);
    const startedAt = Date.now();
    const id = randomUUID();
    const command = commandText(entry.command, entry.args);
    const taskBefore = this._snapshotWorkspace(task);
    store.addTaskEvent(task.id, {
      type: 'command.start',
      agentId,
      data: {
        commandId: entry.id,
        command,
        args: [...entry.args],
        cwd: path.relative(path.resolve(task.workspace), cwd) || '.',
        timeoutMs: entry.timeoutMs,
        approvalId: approvalIdForRun,
        principal: principal
          ? { kind: principal.kind || '', id: principal.id || '', name: principal.name || '' }
          : null,
      },
    });
    const env = {
      ...process.env,
      AGENTFORGE_TASK_ID: task.id,
      AGENTFORGE_COMMAND_ID: entry.id,
      AGENTFORGE_RUN_ID: runId || task.runId || '',
    };
    delete env.NODE_TEST_CONTEXT;
    let child;
    try {
      child = spawn(entry.command, entry.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new CommandError(`命令启动失败：${err.message}`, 500);
    }
    this.active.set(id, {
      id,
      approvalId: approvalIdForRun,
      commandId: entry.id,
      taskId: task.id,
      child,
      startedAt,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const result = await new Promise((resolve) => {
      let settled = false;
      const settleTimer = setTimeout(() => {
        cancelled = this._isCancelled(id);
        finish(-4, 'SIGKILL');
      }, entry.timeoutMs + 3000);
      const finish = (code, signal, error = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(settleTimer);
        cancelled = this._isCancelled(id);
        this.active.delete(id);
        resolve({
          id,
          approvalId: approvalIdForRun,
          commandId: entry.id,
          label: entry.label,
          command,
          args: [...entry.args],
          cwd: path.relative(path.resolve(task.workspace), cwd) || '.',
          code: Number.isFinite(Number(code)) ? Number(code) : -1,
          signal: signal || '',
          timedOut,
          cancelled,
          elapsed: Date.now() - startedAt,
          stdout: tail(stdout, entry.maxOutputBytes),
          stderr: tail(`${stderr}${error}`, entry.maxOutputBytes),
          truncated:
            Buffer.byteLength(stdout) > entry.maxOutputBytes ||
            Buffer.byteLength(stderr) > entry.maxOutputBytes,
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        processTree(child);
        finish(-3, 'SIGTERM');
      }, entry.timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout = tail(`${stdout}${chunk.toString('utf8')}`, entry.maxOutputBytes * 2);
      });
      child.stderr.on('data', (chunk) => {
        stderr = tail(`${stderr}${chunk.toString('utf8')}`, entry.maxOutputBytes * 2);
      });
      child.once('error', (error) => finish(-1, '', error.message));
      child.once('exit', (code, signal) => finish(code, signal));
    });
    result.agentId = agentId;
    result.principal = principal
      ? { kind: principal.kind || '', id: principal.id || '', name: principal.name || '' }
      : null;
    result.fileChanges = this._recordChanges(task, taskBefore, result, agentId);
    store.addTaskEvent(task.id, {
      type: result.code === 0 ? 'command.end' : 'command.failed',
      agentId,
      data: {
        commandId: result.commandId,
        command: result.command,
        args: result.args,
        cwd: result.cwd,
        code: result.code,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        elapsed: result.elapsed,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        fileChanges: result.fileChanges,
        approvalId: result.approvalId,
      },
    });
    return result;
  }

  _recordChanges(task, before, result, agentId) {
    const changes = [];
    const files = [];
    const walk = (dir, prefix = '') => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name)) {
          continue;
        }
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    walk(path.resolve(task.workspace));
    const current = new Map();
    for (const rel of files.slice(0, 10000)) {
      try {
        const stat = fs.statSync(path.join(task.workspace, rel));
        current.set(rel, { mtimeMs: stat.mtimeMs, bytes: stat.size });
      } catch {
        /* File may disappear between listing and stat. */
      }
    }
    for (const [rel, meta] of current) {
      const previous = before.files.get(rel);
      if (!previous) {
        const saved = store.addFileChange(task.id, {
          path: rel,
          status: 'A',
          agentId,
          source: 'command',
        });
        changes.push({ path: rel, status: saved?.status || 'A' });
        store.addArtifact(task.id, {
          path: rel,
          bytes: meta.bytes,
          mtimeMs: meta.mtimeMs,
          agentId,
          source: 'command',
        });
      } else if (previous.mtimeMs !== meta.mtimeMs || previous.bytes !== meta.bytes) {
        const saved = store.addFileChange(task.id, {
          path: rel,
          status: 'M',
          agentId,
          source: 'command',
        });
        changes.push({ path: rel, status: saved?.status || 'M' });
        store.addArtifact(task.id, {
          path: rel,
          bytes: meta.bytes,
          mtimeMs: meta.mtimeMs,
          agentId,
          source: 'command',
        });
      }
    }
    for (const [rel] of before.files) {
      if (!current.has(rel)) {
        const saved = store.addFileChange(task.id, {
          path: rel,
          status: 'D',
          agentId,
          source: 'command',
        });
        changes.push({ path: rel, status: saved?.status || 'D' });
      }
    }
    return changes;
  }

  _snapshotWorkspace(task) {
    const root = path.resolve(task.workspace);
    const files = new Map();
    const walk = (dir, prefix = '') => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name)) {
          continue;
        }
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, rel);
        else if (entry.isFile()) {
          try {
            const stat = fs.statSync(abs);
            files.set(rel, { mtimeMs: stat.mtimeMs, bytes: stat.size });
          } catch {
            /* A file may disappear during the snapshot. */
          }
        }
      }
    };
    walk(root);
    return { files, task };
  }

  cancel(approvalId) {
    let cancelled = 0;
    for (const item of this.active.values()) {
      if (approvalId && item.approvalId !== approvalId) continue;
      item.cancelled = true;
      processTree(item.child);
      cancelled += 1;
    }
    return cancelled;
  }

  cancelTask(taskId) {
    let cancelled = 0;
    for (const item of this.active.values()) {
      if (taskId && item.taskId !== taskId) continue;
      item.cancelled = true;
      processTree(item.child);
      cancelled += 1;
    }
    return cancelled;
  }
}

export const commandInternals = {
  COMMAND_ID,
  MAX_CONCURRENCY,
  relativeWorkspacePath,
};
