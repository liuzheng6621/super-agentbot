import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const ROLES = ['owner', 'operator', 'agent'];
const OWNER_TOKEN = '{{SECRET_hvk8n6ma}}';
const AGENT_TOKEN = 'agent-web-agent-token-0123456789';
const OPERATOR_TOKEN = 'agent-web-operator-token-0123456789';

const MANIFEST = {
  adapter: 'agentforge-http',
  adapter_version: '0.1.0',
  reset_strategy: 'reseed',
  clock_policies: ['wall'],
  description: 'AgentForge real HTTP service: tasks, workspace, quality, review and export',
  scopes: ['tasks', 'events', 'exports'],
  events_scope: 'events',
  events_complete: false,
  events_types: [
    'task.created',
    'task.updated',
    'task.run.started',
    'task.run.finished',
    'quality.gate.passed',
    'quality.gate.failed',
    'quality.gate.timeout',
    'review.independence',
    'workspace.write',
    'workspace.move',
    'workspace.delete',
    'workspace.transaction',
    'export.created',
  ],
  roles: ROLES,
  view: {
    version: 'agent-web/view/1',
    collections: {
      tasks: {
        kind: 'list',
        required: ['id', 'goal', 'status', 'flowMode'],
        semantics: '任务及其当前状态',
      },
      events: {
        kind: 'list',
        required: ['id', 'type', 'taskId'],
        semantics: '任务事件流，不保证完整',
      },
      exports: {
        kind: 'list',
        required: ['taskId', 'format', 'contentType', 'body'],
        semantics: '按需生成的运行记录导出',
      },
    },
  },
  capabilities: [
    { id: 'task.create', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'task.run', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'task.stop', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'task.observe', kind: 'read', evidence_level: 'validated', roles: ['owner', 'operator', 'agent'] },
    { id: 'task.wait', kind: 'read', evidence_level: 'validated', roles: ['owner', 'operator', 'agent'] },
    { id: 'agent.update', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'settings.update', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'workspace.tree', kind: 'read', evidence_level: 'validated', roles: ['owner', 'operator', 'agent'] },
    { id: 'workspace.read', kind: 'read', evidence_level: 'validated', roles: ['owner', 'operator', 'agent'] },
    { id: 'workspace.write', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'workspace.move', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'workspace.delete', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'workspace.transaction', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'export.markdown', kind: 'read', evidence_level: 'validated', roles: ['owner', 'operator', 'agent'] },
    { id: 'export.html', kind: 'read', evidence_level: 'validated', roles: ['owner', 'operator', 'agent'] },
    { id: 'health.read', kind: 'read', evidence_level: 'validated', roles: ['owner', 'operator', 'agent'] },
    { id: 'environment.prepare', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
    { id: 'environment.restart', kind: 'write', evidence_level: 'validated', roles: ['owner', 'operator'] },
  ],
};

class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of [
    'AGENTFORGE_API_TOKEN',
    'AGENTFORGE_OPERATOR_TOKEN',
    'AGENTFORGE_AGENT_TOKENS',
    'AGENTFORGE_OPERATOR_SCOPES',
    'AGENTFORGE_ALLOW_INSECURE_REMOTE',
  ]) {
    delete env[key];
  }
  return env;
}

async function waitForHealth(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`AgentForge exited with ${child.exitCode}: ${readLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      /* retry while the real server starts */
    }
    await delay(50);
  }
  throw new Error(`AgentForge did not become healthy: ${readLogs()}`);
}

async function stopChild(child, { baseUrl = '', token = '' } = {}) {
  if (!child || child.exitCode !== null) return;
  if (baseUrl) {
    try {
      await fetch(`${baseUrl}/api/shutdown`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      /* fall back to process signals when the graceful shutdown route is unavailable */
    }
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000),
  ]);
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(1000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function normalizeTask(task, events = []) {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    flowMode: task.flowMode ?? null,
    mode: task.mode,
    quality: task.quality ?? { status: 'pending' },
    review: task.review ?? null,
    recovery: task.recovery ?? null,
    repairRound: Number(task.repairRound) || 0,
    steps: Array.isArray(task.steps) ? task.steps : task.plan ?? [],
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      taskId: task.id,
      at: event.at,
      data: event.data ?? null,
    })),
  };
}

function materializeAgentPatch(patch) {
  const next = JSON.parse(JSON.stringify(patch || {}));
  if (next.cli?.command === '__NODE__') next.cli.command = process.execPath;
  return next;
}

function taskFromCreate(payload) {
  const task = payload?.task ?? payload;
  if (!task?.id) throw new Error('create task response has no task id');
  return task;
}

function responseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readHttp(response) {
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: responseBody(text), text };
}

function classifyRejection(status, body) {
  if (status >= 400 && status < 500) {
    return {
      outcome: 'rejected',
      error: {
        code: String(body?.code || `http-${status}`),
        message: String(body?.error || body?.message || `HTTP ${status}`),
      },
    };
  }
  return null;
}

async function createRuntime(seed = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-agent-web-'));
  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = '';
  let stderr = '';
  const startChild = () => {
    const spawned = spawn(process.execPath, ['server/index.mjs'], {
      cwd: REPO_ROOT,
      env: {
        ...cleanEnv(),
        PORT: String(port),
        HOST: '127.0.0.1',
        AGENTFORGE_DATA_DIR: dataDir,
        AGENTFORGE_API_TOKEN: OWNER_TOKEN,
        AGENTFORGE_OPERATOR_TOKEN: OPERATOR_TOKEN,
        AGENTFORGE_OPERATOR_ID: 'agent-web-operator',
        AGENTFORGE_OPERATOR_SCOPES: 'read,task:write,operator:admin',
        AGENTFORGE_AGENT_TOKENS: JSON.stringify([
          { token: AGENT_TOKEN, id: 'agent-web-agent', name: 'Agent Web Agent' },
        ]),
        AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
        AGENTFORGE_SEED: JSON.stringify(seed || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    spawned.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    spawned.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    return spawned;
  };
  let child = startChild();
  const logs = () => `stdout=${stdout.slice(-2000)} stderr=${stderr.slice(-2000)}`;
  try {
    await waitForHealth(baseUrl, child, logs);
  } catch (err) {
    await stopChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    throw err;
  }
  return {
    dataDir,
    workspaceDir,
    baseUrl,
    get child() {
      return child;
    },
    logs,
    tokens: { owner: OWNER_TOKEN, operator: OPERATOR_TOKEN, agent: AGENT_TOKEN },
    closed: false,
    async restart() {
      await stopChild(child, { baseUrl, token: OWNER_TOKEN });
      child = startChild();
      await waitForHealth(baseUrl, child, logs);
    },
  };
}

async function closeRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.closed = true;
  await stopChild(runtime.child, {
    baseUrl: runtime.baseUrl,
    token: OWNER_TOKEN,
  });
  try {
    fs.rmSync(runtime.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may hold the data directory briefly; the temp path remains diagnosable. */
  }
}

export function createAdapter(options = {}) {
  const runs = new Map();
  let seq = 0;

  async function manifest() {
    return JSON.parse(JSON.stringify(MANIFEST));
  }

  async function reset({ seed } = {}) {
    seq += 1;
    const runId = `agentforge-${seq}`;
    const runtime = await createRuntime(seed);
    runs.set(runId, runtime);
    return {
      runId,
      state: {
        tasks: [],
        events: [],
        exports: [],
      },
      roleBindings: {
        owner: 'owner',
        operator: 'agent-web-operator',
        agent: 'agent-web-agent',
      },
    };
  }

  async function request(runtimeOrRunId, method, pathname, { body, as = 'owner', timeoutMs = 15000 } = {}) {
    const runtime =
      typeof runtimeOrRunId === 'string' ? runs.get(runtimeOrRunId) : runtimeOrRunId;
    if (!runtime) throw new Error(`run ${runtimeOrRunId} does not exist`);
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = runtime.tokens[as];
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${runtime.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await readHttp(response);
    if (!result.ok) throw new HttpError(`HTTP ${result.status} ${pathname}`, result.status, result.body);
    return result;
  }

  async function taskDetail(runtime, taskId, as = 'owner') {
    const result = await request(runtime, 'GET', `/api/tasks/${taskId}`, { as });
    return result.body.task;
  }

  async function waitForTask(runtime, taskId, predicate, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await taskDetail(runtime, taskId);
      if (predicate(latest)) return latest;
      await delay(80);
    }
    throw new Error(
      `task ${taskId} did not reach the expected state: ${JSON.stringify({
        status: latest?.status || null,
        quality: latest?.quality || null,
      })}`,
    );
  }

  async function observe(runId) {
    const runtime = runs.get(runId);
    if (!runtime) return { state: null, missingScopes: MANIFEST.scopes };
    try {
      const stateResult = await request(runId, 'GET', '/api/state');
      const tasks = Array.isArray(stateResult.body.tasks) ? stateResult.body.tasks : [];
      const details = [];
      const events = [];
      for (const summary of tasks) {
        const result = await request(runId, 'GET', `/api/tasks/${summary.id}`);
        const detail = result.body.task;
        details.push(normalizeTask(detail, detail.events || []));
        events.push(
          ...(detail.events || []).map((event) => ({
            id: event.id,
            type: event.type,
            taskId: detail.id,
            at: event.at,
            data: event.data ?? null,
          })),
        );
      }
      return {
        state: { tasks: details, events, exports: [] },
        missingScopes: [],
      };
    } catch (err) {
      return {
        state: null,
        missingScopes: MANIFEST.scopes,
        error: { code: 'observe_failed', message: err.message },
      };
    }
  }

  async function execute(runId, action) {
    const runtime = runs.get(runId);
    if (!runtime) return { outcome: 'infra_error', error: { code: 'no_run', message: `run ${runId} does not exist` } };
    const role = action.as ?? 'owner';
    if (!ROLES.includes(role)) {
      return { outcome: 'rejected', error: { code: 'unknown_role', message: `role ${role} is not in manifest.roles` } };
    }
    const args = action.arguments ?? {};
    runtime.runId = runId;
    try {
      switch (action.capability) {
        case 'health.read': {
          const result = await request(runId, 'GET', '/api/health', { as: role });
          return { outcome: 'applied', payload: result.body };
        }
        case 'task.create': {
          const result = await request(runId, 'POST', '/api/tasks', {
            as: role,
            body: {
              goal: String(args.goal || 'AgentForge agent-web acceptance task'),
              workspace: args.workspace || runtime.workspaceDir,
              isolation: args.isolation === 'worktree' ? 'worktree' : 'direct',
              flowMode: args.flowMode === 'debate' ? 'debate' : 'direct',
              autoRun: args.autoRun === true,
              clientMessageId: args.clientMessageId,
            },
          });
          const task = taskFromCreate(result.body);
          return { outcome: 'applied', payload: { taskId: task.id, status: task.status } };
        }
        case 'task.observe': {
          const result = await request(runId, 'GET', `/api/tasks/${args.taskId}`, { as: role });
          return { outcome: 'applied', payload: result.body.task };
        }
        case 'task.wait': {
          const task = await waitForTask(
            runtime,
            args.taskId,
            (latest) => {
              if (args.until === 'terminal') {
                return ['done', 'needs_attention', 'error', 'stopped'].includes(latest.status);
              }
              if (args.until === 'running') return latest.status === 'running';
              if (args.until === 'quality') {
                return ['passed', 'failed', 'timeout', 'no-test-entry', 'not-run'].includes(
                  latest.quality?.status,
                );
              }
              return true;
            },
            Number(args.timeoutMs) || 45_000,
          );
          return { outcome: 'applied', payload: task };
        }
        case 'task.run': {
          const result = await request(runId, 'POST', `/api/tasks/${args.taskId}/run`, {
            as: role,
            body: { flowMode: args.flowMode, speed: args.speed },
          });
          return { outcome: 'applied', payload: result.body };
        }
        case 'task.stop': {
          const result = await request(runId, 'POST', `/api/tasks/${args.taskId}/stop`, { as: role });
          return { outcome: 'applied', payload: result.body };
        }
        case 'settings.update': {
          const result = await request(runId, 'PATCH', '/api/settings', { as: role, body: args.patch || {} });
          return { outcome: 'applied', payload: result.body.settings };
        }
        case 'agent.update': {
          const stateResult = await request(runId, 'GET', '/api/state', { as: role });
          const agents = Array.isArray(stateResult.body.agents) ? stateResult.body.agents : [];
          const target =
            agents.find((agent) => agent.id === args.agentId) ||
            agents.find((agent) => agent.role === String(args.role || 'planner'));
          if (!target) {
            return {
              outcome: 'rejected',
              error: { code: 'agent_not_found', message: `agent ${args.agentId || args.role} does not exist` },
            };
          }
          const result = await request(runId, 'PATCH', `/api/agents/${target.id}`, {
            as: role,
            body: materializeAgentPatch(args.patch),
          });
          return { outcome: 'applied', payload: result.body.agent };
        }
        case 'environment.prepare': {
          const files = args.files && typeof args.files === 'object' ? args.files : {};
          const workspace = path.resolve(args.workspace || runtime.workspaceDir);
          for (const [rel, content] of Object.entries(files)) {
            const abs = path.resolve(workspace, String(rel));
            if (!abs.startsWith(workspace + path.sep)) {
              return {
                outcome: 'rejected',
                error: { code: 'path_escape', message: `refusing to write outside workspace: ${rel}` },
              };
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, String(content), 'utf8');
          }
          return { outcome: 'applied', payload: { workspace, files: Object.keys(files) } };
        }
        case 'environment.restart': {
          await runtime.restart();
          return { outcome: 'applied', payload: { restarted: true, baseUrl: runtime.baseUrl } };
        }
        case 'workspace.tree': {
          const result = await request(
            runId,
            'GET',
            `/api/tasks/${args.taskId}/workspace?path=${encodeURIComponent(args.path || '')}`,
            { as: role },
          );
          return { outcome: 'applied', payload: result.body };
        }
        case 'workspace.read': {
          const result = await request(
            runId,
            'GET',
            `/api/tasks/${args.taskId}/file?path=${encodeURIComponent(args.path || '')}`,
            { as: role },
          );
          return { outcome: 'applied', payload: result.body };
        }
        case 'workspace.write': {
          const result = await request(runId, 'POST', `/api/tasks/${args.taskId}/fs`, {
            as: role,
            body: {
              op: 'write',
              path: args.path,
              content: args.content,
              expectedVersion: args.expectedVersion,
            },
          });
          return { outcome: 'applied', payload: result.body };
        }
        case 'workspace.move': {
          const result = await request(runId, 'POST', `/api/tasks/${args.taskId}/fs`, {
            as: role,
            body: { op: 'move', from: args.from, to: args.to },
          });
          return { outcome: 'applied', payload: result.body };
        }
        case 'workspace.delete': {
          const result = await request(runId, 'POST', `/api/tasks/${args.taskId}/fs`, {
            as: role,
            body: { op: 'delete', path: args.path },
          });
          return { outcome: 'applied', payload: result.body };
        }
        case 'workspace.transaction': {
          const result = await request(runId, 'POST', `/api/tasks/${args.taskId}/fs`, {
            as: role,
            body: { op: 'transaction', operations: args.operations },
          });
          return { outcome: 'applied', payload: result.body };
        }
        case 'export.markdown':
        case 'export.html': {
          const format = action.capability === 'export.html' ? 'html' : 'markdown';
          const response = await fetch(
            `${runtime.baseUrl}/api/tasks/${args.taskId}/export?format=${format}`,
            {
              headers: { Authorization: `Bearer ${runtime.tokens[role]}` },
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.text();
          if (!response.ok) {
            return {
              outcome: 'rejected',
              error: { code: `http-${response.status}`, message: body.slice(0, 500) },
            };
          }
          return {
            outcome: 'applied',
            payload: {
              taskId: args.taskId,
              format,
              contentType: response.headers.get('content-type') || '',
              body,
            },
          };
        }
        default:
          return { outcome: 'unsupported', error: { code: 'unsupported_capability', message: action.capability } };
      }
    } catch (err) {
      if (err instanceof HttpError) {
        const rejected = classifyRejection(err.status, err.body);
        if (rejected) return rejected;
      }
      return { outcome: 'infra_error', error: { code: 'adapter_error', message: err.message } };
    }
  }

  async function close(runId) {
    const runtime = runs.get(runId);
    if (!runtime) return;
    runs.delete(runId);
    await closeRuntime(runtime);
  }

  return { manifest, reset, observe, execute, close };
}

export default createAdapter;
