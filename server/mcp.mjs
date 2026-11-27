import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MCP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 10000;
const DEFAULT_CALL_TIMEOUT_MS = 15000;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function integer(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function stringList(value, max = 32, itemMax = 80) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((item) => text(item, itemMax)).filter(Boolean)),
  ].slice(0, max);
}

function normalizeEnvRefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 64)) {
    const key = text(rawKey, 80);
    if (!ENV_NAME.test(key)) continue;
    const ref = text(rawValue, 240);
    if (!ref) continue;
    out[key] = ref;
  }
  return out;
}

export function normalizeMcpServer(input = {}, fallback = {}) {
  const source = { ...fallback, ...input };
  const rawId = text(source.id || fallback.id, 64);
  const id = MCP_ID.test(rawId) ? rawId : '';
  if (!id) throw new Error('MCP server id 只能包含字母、数字、下划线和短横线');
  const command = text(source.command, 1000);
  if (!command) throw new Error('MCP server 需要 command');
  const transport = source.transport === 'stdio' ? 'stdio' : 'stdio';
  return {
    id,
    label: text(source.label, 80) || id,
    transport,
    command,
    args: Array.isArray(source.args)
      ? source.args.map((arg) => String(arg ?? '').slice(0, 4000)).slice(0, 64)
      : [],
    workingDirectory: text(source.workingDirectory, 1000),
    envRefs: normalizeEnvRefs(source.envRefs),
    startTimeoutMs: integer(source.startTimeoutMs, 100, 120000, DEFAULT_START_TIMEOUT_MS),
    callTimeoutMs: integer(source.callTimeoutMs, 100, 300000, DEFAULT_CALL_TIMEOUT_MS),
    maxOutputBytes: integer(source.maxOutputBytes, 1024, 16 * 1024 * 1024, MAX_OUTPUT_BYTES),
    enabled: source.enabled !== false,
    createdAt: Number(source.createdAt) || Date.now(),
  };
}

export function redactMcpServer(server) {
  const normalized = normalizeMcpServer(server);
  return {
    ...normalized,
    envRefs: { ...(normalized.envRefs || {}) },
  };
}

export function mcpServerEnv(server, baseEnv = process.env) {
  const env = {};
  for (const [key, ref] of Object.entries(server?.envRefs || {})) {
    if (!ref.startsWith('env:')) continue;
    const sourceName = ref.slice(4);
    if (!ENV_NAME.test(sourceName) || !Object.hasOwn(baseEnv, sourceName)) continue;
    env[key] = String(baseEnv[sourceName]);
  }
  return env;
}

export function mcpWorkingDirectory(server, fallback = '') {
  const requested = text(server?.workingDirectory, 1000);
  const root = path.resolve(fallback || process.cwd());
  if (!requested) return root;
  const resolved = path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('MCP workingDirectory 必须位于任务工作区内');
  }
  return resolved;
}

export class McpClient {
  constructor({ server, cwd, env = process.env, onSpawn } = {}) {
    this.server = normalizeMcpServer(server);
    this.cwd = cwd;
    this.env = env;
    this.onSpawn = onSpawn;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.spawnedAt = 0;
  }

  async start() {
    if (this.child) return;
    const env = { ...this.env, ...mcpServerEnv(this.server, this.env) };
    const child = spawn(this.server.command, this.server.args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.spawnedAt = Date.now();
    this.onSpawn?.(child);
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.stdout.on('data', (chunk) => this._consume(chunk.toString('utf8')));
    child.once('error', (err) => this._rejectAll(err));
    child.once('exit', (code, signal) => {
      this._rejectAll(
        new Error(`MCP server 已退出：${signal || `code ${code}`}${this.stderr ? `；${this.stderr.slice(-500)}` : ''}`),
      );
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'AgentForge', version: '1.0.0' },
    }, this.server.startTimeoutMs);
    this._send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
  }

  _send(message) {
    if (!this.child?.stdin?.writable) throw new Error('MCP server 未启动');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.server.maxOutputBytes) {
      this.buffer = this.buffer.slice(-this.server.maxOutputBytes);
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(String(message.error.message || 'MCP 调用失败')));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  _rejectAll(err) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  request(method, params = {}, timeoutMs = this.server.callTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 调用超时：${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async listTools() {
    await this.start();
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    await this.start();
    return this.request('tools/call', { name: String(name), arguments: args });
  }

  close() {
    this._rejectAll(new Error('MCP client 已关闭'));
    try {
      this.child?.stdin?.end();
    } catch {
      /* already closed */
    }
    try {
      this.child?.kill();
    } catch {
      /* already exited */
    }
    this.child = null;
  }
}

export async function probeMcpServer(server, { cwd = '', env = process.env } = {}) {
  const normalized = normalizeMcpServer(server);
  const root = mcpWorkingDirectory(normalized, cwd || process.cwd());
  if (!fs.existsSync(root)) throw new Error(`MCP workingDirectory 不存在：${root}`);
  const client = new McpClient({
    server: normalized,
    cwd: root,
    env,
  });
  try {
    const tools = await client.listTools();
    return {
      ok: true,
      server: redactMcpServer(normalized),
      tools: tools.map((tool) => ({
        name: text(tool.name, 120),
        description: text(tool.description, 500),
        effect: text(tool.annotations?.effect || tool.effect || 'unknown', 40),
        readOnlyHint: tool.annotations?.readOnlyHint === true,
      })),
    };
  } finally {
    client.close();
  }
}

export function assertReadOnlyMcpTool(tool) {
  const effect = String(tool?.annotations?.effect || tool?.effect || 'unknown').toLowerCase();
  const explicitlyReadOnly =
    tool?.annotations?.readOnlyHint === true ||
    ['read', 'readonly', 'read-only'].includes(effect);
  if (!explicitlyReadOnly) {
    throw new Error(`MCP 工具 ${tool?.name || ''} 不是只读工具，当前版本拒绝调用`);
  }
  return true;
}

export async function callReadOnlyMcpTool({
  server,
  tool,
  arguments: args = {},
  cwd = '',
  env = process.env,
  maxOutputBytes = MAX_OUTPUT_BYTES,
}) {
  const normalized = normalizeMcpServer(server);
  const root = mcpWorkingDirectory(normalized, cwd || process.cwd());
  const client = new McpClient({ server: normalized, cwd: root, env });
  try {
    const tools = await client.listTools();
    const found = tools.find((item) => item.name === String(tool));
    if (!found) throw new Error(`MCP server ${normalized.id} 不存在工具：${tool}`);
    assertReadOnlyMcpTool(found);
    const result = await client.callTool(found.name, args);
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > Math.min(normalized.maxOutputBytes, maxOutputBytes)) {
      return {
        truncated: true,
        bytes: Buffer.byteLength(serialized),
        result: { content: [{ type: 'text', text: serialized.slice(0, Math.min(normalized.maxOutputBytes, maxOutputBytes)) }] },
      };
    }
    return { truncated: false, bytes: Buffer.byteLength(serialized), result };
  } finally {
    client.close();
  }
}
