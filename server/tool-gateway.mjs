import { randomUUID } from 'node:crypto';
import { store, TOOL_CATALOG } from './store.mjs';
import {
  WorkspaceError,
  deleteWorkspaceEntry,
  makeWorkspaceDir,
  moveWorkspaceEntry,
  readWorkspaceFile,
  searchWorkspace,
  workspaceDiff,
  workspaceSnapshot,
  writeWorkspaceEntry,
} from './workspace.mjs';

const TOOL_BY_ID = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
const DEFAULT_OPERATION = {
  'workspace.read': 'tree',
  'workspace.search': 'search',
  'workspace.write': 'write',
  'workspace.move': 'move',
  'workspace.delete': 'delete',
  shell: 'exec',
};

function fail(message, status = 400) {
  throw new WorkspaceError(message, status);
}

function resolvePrincipal(agentId = '', principal = null) {
  if (principal && typeof principal === 'object') {
    const kind = ['owner', 'agent', 'system'].includes(principal.kind)
      ? principal.kind
      : 'owner';
    const id = String(principal.id || (kind === 'owner' ? 'owner' : agentId) || '');
    return {
      kind,
      id,
      name: String(principal.name || (kind === 'owner' ? 'Owner UI' : id)),
      role: String(principal.role || kind),
    };
  }
  if (agentId) {
    const agent = store.getAgent(agentId);
    if (!agent) fail(`智能体不存在：${agentId}`, 404);
    return {
      kind: 'agent',
      id: agent.id,
      name: agent.name,
      role: agent.role,
    };
  }
  return { kind: 'owner', id: 'owner', name: 'Owner UI', role: 'owner' };
}

function normalizeArguments(tool, operation, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('工具参数必须是对象', 400);
  }
  const args = { ...input, op: operation };
  const descriptor = tool;
  if (!descriptor.operations.includes(operation)) {
    fail(`工具 ${tool.id} 不支持操作：${operation}`, 400);
  }
  for (const key of descriptor.inputSchema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      fail(`工具 ${tool.id} 缺少参数：${key}`, 400);
    }
  }
  return args;
}

function auditArguments(args = {}) {
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'content') {
      output.contentBytes = Buffer.byteLength(String(value ?? ''));
      continue;
    }
    if (key === 'args' && Array.isArray(value)) {
      output.args = value.slice(0, 20).map((item) => String(item).slice(0, 240));
      continue;
    }
    if (typeof value === 'string') output[key] = value.slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean') output[key] = value;
  }
  return output;
}

function resultSummary(operation, result) {
  if (operation === 'tree') {
    return {
      entries: result?.entries || 0,
      files: result?.summary?.files || 0,
      truncated: !!result?.truncated,
    };
  }
  if (operation === 'files') return { files: result?.files?.length || 0 };
  if (operation === 'file') {
    return {
      path: result?.path || '',
      bytes: result?.bytes || 0,
      binary: !!result?.binary,
      version: result?.version || '',
    };
  }
  if (operation === 'search') {
    return {
      query: result?.query || '',
      results: result?.results?.length || 0,
      scanned: result?.scanned || 0,
      truncated: !!result?.truncated,
    };
  }
  if (operation === 'events') return { events: result?.events?.length || 0 };
  if (operation === 'changes') return { changes: result?.changes?.length || 0 };
  if (operation === 'diff') {
    return {
      path: result?.path || '',
      available: !!result?.available,
      bytes: Buffer.byteLength(String(result?.diff || '')),
    };
  }
  if (operation === 'write') {
    return {
      path: result?.path || '',
      bytes: result?.bytes || 0,
      version: result?.version || '',
    };
  }
  if (operation === 'mkdir') return { path: result?.path || '' };
  if (operation === 'move') {
    return { from: result?.from || '', to: result?.to || '', moved: result?.moved?.length || 0 };
  }
  if (operation === 'delete') {
    return { path: result?.path || '', trashPath: result?.trashPath || '' };
  }
  return {};
}

function executeWorkspaceTool(task, toolId, operation, args, meta) {
  if (toolId === 'workspace.read') {
    if (operation === 'tree') return workspaceSnapshot(task);
    if (operation === 'files') {
      const snapshot = workspaceSnapshot(task);
      return {
        files: (snapshot.files || []).map((file) => ({
          path: file.path,
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
          lang: file.lang,
          status: file.status,
        })),
      };
    }
    if (operation === 'file') return readWorkspaceFile(task, args.path);
    if (operation === 'events') {
      const limit = Math.max(1, Math.min(800, Number(args.limit) || 160));
      return { events: (task.events || []).slice(-limit) };
    }
    if (operation === 'changes') return { changes: task.fileChanges || [] };
    if (operation === 'diff') return workspaceDiff(task, args.path || '');
  }
  if (toolId === 'workspace.search') return searchWorkspace(task, args.query);
  if (toolId === 'workspace.write') {
    if (operation === 'write') {
      return writeWorkspaceEntry(task, args.path, args.content, meta);
    }
    return makeWorkspaceDir(task, args.path, meta);
  }
  if (toolId === 'workspace.move') {
    return moveWorkspaceEntry(task, args.from, args.to, meta);
  }
  if (toolId === 'workspace.delete') {
    return deleteWorkspaceEntry(task, args.path, meta);
  }
  if (toolId === 'shell') {
    fail('平台 Shell 执行入口尚未开放；请使用受控 CLI 运行器。', 501);
  }
  fail(`未实现的工具：${toolId}`, 501);
}

export class ToolGateway {
  descriptors() {
    return TOOL_CATALOG.map((tool) => ({
      ...tool,
      operations: [...(tool.operations || [])],
      inputSchema: JSON.parse(JSON.stringify(tool.inputSchema || {})),
    }));
  }

  assertAllowed({ agentId = '', principal = null, toolId }) {
    const tool = TOOL_BY_ID.get(String(toolId));
    if (!tool) fail(`工具不存在：${toolId}`, 404);
    const actor = resolvePrincipal(agentId, principal);
    if (actor.kind === 'agent') {
      const agent = store.getAgent(actor.id);
      if (!agent) fail(`智能体不存在：${actor.id}`, 404);
      const allowed = new Set(Array.isArray(agent.tools) ? agent.tools : []);
      if (!allowed.has(tool.id)) {
        fail(`智能体「${agent.name}」没有 ${tool.id} 权限`, 403);
      }
    }
    return { tool, principal: actor };
  }

  invokeTool({
    taskId,
    toolId,
    operation,
    args = {},
    agentId = '',
    principal = null,
    stepId = '',
    source = 'api',
    audit = true,
  } = {}) {
    const task = store.getTask(String(taskId || ''));
    if (!task) fail('任务不存在', 404);
    const tool = TOOL_BY_ID.get(String(toolId));
    if (!tool) fail(`工具不存在：${toolId}`, 404);
    const actor = resolvePrincipal(agentId, principal);
    const op = String(operation || DEFAULT_OPERATION[tool.id] || '');
    const callId = randomUUID();
    const startedAt = Date.now();
    const auditMeta = {
      callId,
      tool: tool.id,
      label: tool.label,
      operation: op,
      principal: actor,
      agentId: actor.kind === 'agent' ? actor.id : String(agentId || ''),
      stepId: String(stepId || ''),
      source: String(source || 'api'),
      risk: tool.risk,
      arguments: auditArguments({ ...args, op }),
    };

    if (audit) {
      store.addTaskEvent(task.id, {
        type: 'tool.call.start',
        agentId: auditMeta.agentId,
        stepId: auditMeta.stepId,
        data: auditMeta,
      });
    }

    try {
      const normalized = normalizeArguments(tool, op, args);
      if (actor.kind === 'agent') {
        const agent = store.getAgent(actor.id);
        if (!agent) fail(`智能体不存在：${actor.id}`, 404);
        const allowed = new Set(Array.isArray(agent.tools) ? agent.tools : []);
        if (!allowed.has(tool.id)) {
          const message = `智能体「${agent.name}」没有 ${tool.id} 权限`;
          if (audit) {
            store.addTaskEvent(task.id, {
              type: 'tool.policy.denied',
              agentId: agent.id,
              stepId: auditMeta.stepId,
              data: { ...auditMeta, error: message },
            });
          }
          throw new WorkspaceError(message, 403);
        }
      }

      const meta = {
        agentId: auditMeta.agentId,
        stepId: auditMeta.stepId,
        principal: actor,
        callId,
      };
      const result = executeWorkspaceTool(task, tool.id, op, normalized, meta);
      const durationMs = Date.now() - startedAt;
      if (audit) {
        store.addTaskEvent(task.id, {
          type: 'tool.call.end',
          agentId: auditMeta.agentId,
          stepId: auditMeta.stepId,
          data: {
            ...auditMeta,
            status: 'ok',
            ok: true,
            durationMs,
            result: resultSummary(op, result),
          },
        });
      }
      return {
        ok: true,
        callId,
        tool: tool.id,
        operation: op,
        principal: actor,
        result,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (audit) {
        store.addTaskEvent(task.id, {
          type: 'tool.call.end',
          agentId: auditMeta.agentId,
          stepId: auditMeta.stepId,
          data: {
            ...auditMeta,
            status: err instanceof WorkspaceError && err.status === 403 ? 'denied' : 'error',
            ok: false,
            denied: err instanceof WorkspaceError && err.status === 403,
            durationMs,
            error: err?.message || String(err),
            statusCode: Number(err?.status) || 500,
          },
        });
      }
      throw err;
    }
  }
}

export const toolGateway = new ToolGateway();
