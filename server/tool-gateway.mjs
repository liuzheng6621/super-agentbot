import { randomUUID } from 'node:crypto';
import { store, TOOL_CATALOG, redactTranscriptText } from './store.mjs';
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
import { callReadOnlyMcpTool } from './mcp.mjs';

const TOOL_BY_ID = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
const DEFAULT_OPERATION = {
  'workspace.read': 'tree',
  'workspace.search': 'search',
  'workspace.write': 'write',
  'workspace.move': 'move',
  'workspace.delete': 'delete',
  history_search: 'search',
  history_read: 'read',
  'mcp.call': 'call',
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
  const secretKey = /(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)/i;
  const auditValue = (value, depth = 0) => {
    if (depth > 4) return '[TRUNCATED]';
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactTranscriptText(value).slice(0, 240);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => auditValue(item, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value).slice(0, 40)) {
        out[key] = secretKey.test(key) ? '[REDACTED]' : auditValue(item, depth + 1);
      }
      return out;
    }
    return '';
  };
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
    if (key === 'arguments' && value && typeof value === 'object' && !Array.isArray(value)) {
      const audited = auditValue(value);
      const serialized = JSON.stringify(audited);
      output.arguments = audited;
      output.argumentsBytes = Buffer.byteLength(serialized);
      output.argumentsTruncated = serialized.length > 1000;
      if (output.argumentsTruncated) {
        output.arguments = {
          preview: serialized.slice(0, 1000),
          truncated: true,
        };
      }
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
  if (operation === 'search') {
    return {
      query: result?.query || '',
      results: result?.results?.length || 0,
      scanned: result?.scanned || 0,
      truncated: !!result?.truncated,
    };
  }
  if (operation === 'read') {
    return {
      items: result?.items?.length || 0,
      truncated: !!result?.truncated,
    };
  }
  if (operation === 'call') {
    return {
      serverId: result?.serverId || '',
      tool: result?.tool || '',
      truncated: !!result?.truncated,
      bytes: result?.bytes || 0,
    };
  }
  return {};
}

function encodeHistoryCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function historyTasks(task, scope = 'task') {
  return scope === 'all' ? store.tasks : [task];
}

function historySearch(task, args = {}) {
  const query = String(args.query || '').trim().toLowerCase();
  if (query.length < 2) fail('历史检索关键词至少需要 2 个字符', 400);
  const scope = args.scope === 'all' ? 'all' : 'task';
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 12));
  const cursor = decodeHistoryCursor(args.cursor);
  if (args.cursor && !cursor) fail('历史检索 cursor 无效', 400);
  const after = Number(cursor?.after) || 0;
  const items = [];
  let scanned = 0;
  for (const item of historyTasks(task, scope)) {
    const messages = item.messages || [];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      scanned += 1;
      const text = String(message.text || '');
      if (!text || !text.toLowerCase().includes(query)) continue;
      items.push({
        at: Number(message.createdAt) || 0,
        taskId: item.id,
        kind: 'message',
        id: message.id,
        name: message.name || message.role || 'AI',
        text: text.slice(0, 240),
        cursor: encodeHistoryCursor({
          taskId: item.id,
          kind: 'message',
          at: Number(message.createdAt) || 0,
          after: messageIndex,
        }),
      });
    }
    const events = item.events || [];
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      scanned += 1;
      const data = event.data && typeof event.data === 'object' ? JSON.stringify(event.data) : '';
      const text = `${event.type || ''} ${data}`;
      if (!text.toLowerCase().includes(query)) continue;
      items.push({
        at: Number(event.at) || 0,
        taskId: item.id,
        kind: 'event',
        id: event.id,
        name: event.type || 'event',
        text: data.slice(0, 240),
        cursor: encodeHistoryCursor({
          taskId: item.id,
          kind: 'event',
          at: Number(event.at) || 0,
          after: eventIndex,
        }),
      });
    }
    const summary = item.contextState?.compaction?.summary || '';
    if (summary) {
      scanned += 1;
      if (summary.toLowerCase().includes(query)) {
        items.push({
          at: Number(item.contextState?.compaction?.generatedAt) || 0,
          taskId: item.id,
          kind: 'summary',
          id: `summary-${item.id}`,
          name: '早先上下文摘要',
          text: summary.slice(0, 240),
          cursor: encodeHistoryCursor({
            taskId: item.id,
            kind: 'summary',
            at: Number(item.contextState?.compaction?.generatedAt) || 0,
            after: 0,
          }),
        });
      }
    }
  }
  items.sort((a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id)));
  const page = items.slice(after, after + limit);
  const next = after + page.length < items.length ? after + page.length : null;
  return {
    query: args.query,
    scope,
    results: page,
    scanned,
    truncated: next !== null,
    cursor: next === null ? null : encodeHistoryCursor({ after: next }),
  };
}

function historyRead(task, args = {}) {
  const cursor = decodeHistoryCursor(args.cursor);
  if (!cursor) fail('历史读取 cursor 无效', 400);
  const target = cursor.taskId ? store.getTask(cursor.taskId) : task;
  if (!target) fail('历史任务不存在', 404);
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
  const all =
    cursor.kind === 'message'
      ? (target.messages || []).map((message) => ({
          id: message.id,
          at: Number(message.createdAt) || 0,
          kind: 'message',
          name: message.name || message.role || 'AI',
          text: String(message.text || ''),
        }))
      : cursor.kind === 'event'
        ? (target.events || []).map((event) => ({
            id: event.id,
            at: Number(event.at) || 0,
            kind: 'event',
            name: event.type || 'event',
            text: JSON.stringify(event.data || {}),
          }))
        : target.contextState?.compaction
          ? [
              {
                id: `summary-${target.id}`,
                at: Number(target.contextState.compaction.generatedAt) || 0,
                kind: 'summary',
                name: '早先上下文摘要',
                text: String(target.contextState.compaction.summary || ''),
              },
            ]
          : [];
  const after = Number(cursor.after) || 0;
  const source = all.filter((item) => {
    const at = Number(cursor.at) || 0;
    return at ? item.at <= at : true;
  });
  const items = source.slice(after, after + limit);
  const next = after + items.length < source.length ? after + items.length : null;
  return {
    items,
    truncated: next !== null,
    cursor:
      next === null
        ? null
        : encodeHistoryCursor({ ...cursor, after: next }),
  };
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
  if (toolId === 'history_search') return historySearch(task, args);
  if (toolId === 'history_read') return historyRead(task, args);
  if (toolId === 'shell') {
    fail('Shell 只接受固定命令白名单；请使用 /api/commands 或审批队列。', 501);
  }
  fail(`未实现的工具：${toolId}`, 501);
}

function visibleMcpServer(args, agentId) {
  const server = store.getMcpServer(String(args.serverId || ''));
  if (!server || server.enabled === false) fail('MCP server 不存在或已停用', 404);
  if (agentId) {
    const agent = store.getAgent(agentId);
    const allowed = new Set(Array.isArray(agent?.mcpServers) ? agent.mcpServers : []);
    if (!allowed.has(server.id)) {
      fail(`智能体「${agent?.name || agentId}」没有 MCP server ${server.id} 权限`, 403);
    }
  }
  return server;
}

async function callMcpTool(task, args, meta) {
  const server = visibleMcpServer(args, meta.agentId);
  const call = await callReadOnlyMcpTool({
    server,
    tool: args.tool,
    arguments: args.arguments || {},
    cwd: task.workspace,
    env: process.env,
  });
  return {
    serverId: server.id,
    serverLabel: server.label,
    tool: String(args.tool),
    ...call,
  };
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

  async invokeTool({
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
      const result =
        tool.id === 'mcp.call'
          ? await callMcpTool(task, normalized, meta)
          : executeWorkspaceTool(task, tool.id, op, normalized, meta);
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
