import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  store,
  ROOT,
  DATA_DIR,
  WORKSPACE_DIR,
  TOOL_CATALOG,
  ROLE_TOOLS,
  taskTranscript,
} from './store.mjs';
import {
  agentRouteForExecution,
  isQueued,
  isScheduled,
  scheduleTask,
  schedulerSnapshot,
  stopTask,
  chat,
  buildContextPack,
  compactTaskContext,
  listTaskCompactions,
  replayTaskCompaction,
  isRunning,
  replanTask,
  workMsOf,
  timeoutAuditFor,
} from './orchestrator.mjs';
import { probeClis, spawnCli, clearResolveCache } from './adapters.mjs';
import { redactProvider } from './providers.mjs';
import { redactAgentProfile } from './profiles.mjs';
import { timeoutCatalog } from './timeouts.mjs';
import { AttachError, admitImage, readAttachment } from './attachments.mjs';
import { adoptInstalledClis, rebalanceTeam } from './adopt.mjs';
import { ensureRealTeam, refreshTeam, judgeHealth } from './team.mjs';
import { toolGateway } from './tool-gateway.mjs';
import {
  probeMcpServer,
  redactMcpServer,
} from './mcp.mjs';
import { executionPolicyCatalog, resolveCliPolicy } from './cli-policy.mjs';
import {
  WorkspaceError,
  workspacePoolInfo,
  workspaceInfo,
} from './workspace.mjs';
import { crossTaskOverview, taskGraph, taskReplay } from './overview.mjs';
import { OtlpExporter, otlpSpanFromEvent, resolveOtlpConfig } from './otlp.mjs';
import {
  authenticateApi,
  authorizeApi,
  clientAddress,
  corsDecision,
  corsHeaders,
  resolveSecurityConfig,
  securitySummary,
  tenantFilterForPrincipal,
  validateListenSecurity,
} from './security.mjs';
import {
  automationRunnerSnapshot,
  automationSnapshot,
  cancelAutomationWait,
  createAutomation,
  getAutomation,
  removeAutomation,
  runAutomationNow,
  startAutomationRunner,
  stopAutomationRunner,
  updateAutomation,
  waitForAutomationEvent,
  wakeAutomationEvent,
} from './automation.mjs';
import { CommandRunner, CommandError, publicCommand } from './command-runner.mjs';
import {
  approvalsForPrincipal,
  approvalsSnapshot,
  cancelApproval,
  createApprovalRequest,
  decideApproval,
  executeApproval,
  expireApprovals,
  getApproval,
  recoverInterruptedApprovals,
} from './approvals.mjs';

const PORT = Number(process.env.PORT || 8787);
// 本地桌面场景只监听回环；被托管平台注入 PORT 时（容器 / 云沙箱）需要对外绑定
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const SECURITY = resolveSecurityConfig(process.env);
const LISTEN_SECURITY = validateListenSecurity({ host: HOST, config: SECURITY });
if (!LISTEN_SECURITY.ok) {
  console.error(`  ✗ ${LISTEN_SECURITY.error}`);
  process.exit(2);
}
if (LISTEN_SECURITY.warning) console.warn(`  !  ${LISTEN_SECURITY.warning}`);
const PUBLIC_DIR = path.join(ROOT, 'public');
const OTLP = resolveOtlpConfig(process.env);
const otlpExporter = new OtlpExporter(OTLP);
const commandRunner = new CommandRunner({
  workspaceRoot: WORKSPACE_DIR,
  dataRoot: DATA_DIR,
  getTask: (taskId) => store.getTask(taskId),
});
commandRunner.configure(store.commandWhitelist);
recoverInterruptedApprovals();
expireApprovals();
store.subscribe((event) => {
  if (event?.type === 'commands.changed') commandRunner.configure(store.commandWhitelist);
  if (event?.type === 'trace.span') {
    otlpExporter.enqueue(otlpSpanFromEvent(event.span, event.task));
  }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------------------- 工具函数 ---------------------------- */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
    req.on('error', reject);
  });
}

function agentView(agent) {
  if (!agent) return agent;
  return {
    ...agent,
    cliPolicy: resolveCliPolicy(agent),
    timeouts: timeoutAuditFor(agent),
  };
}

function stateSettings() {
  const {
    approvals: _approvals,
    commandWhitelist: _commandWhitelist,
    securityAudit: _securityAudit,
    mcpServers: _mcpServers,
    automations: _automations,
    ...settings
  } = store.db.settings;
  return settings;
}

function principalTenant(principal) {
  return tenantFilterForPrincipal(principal).tenantId;
}

function requestedTenant(principal, value) {
  if (principal?.kind !== 'owner') return principalTenant(principal) || 'default';
  return String(value || 'default').trim().slice(0, 80) || 'default';
}

function numericSetting(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function visibleTasks(principal) {
  const tenantId = principalTenant(principal);
  if (tenantId === null) return store.tasks;
  return store.tasks.filter(
    (task) => String(task.tenantId || 'default') === tenantId,
  );
}

function visibleTask(principal, taskId) {
  return visibleTasks(principal).find((task) => task.id === String(taskId || '')) || null;
}

function visibleAutomations(principal) {
  return automationSnapshot({ tenantId: principalTenant(principal) });
}

function visibleApprovals(principal) {
  return approvalsForPrincipal(principal);
}

const TASK_SUMMARY_FIELDS = new Set([
  'id',
  'tenantId',
  'ownerId',
  'title',
  'goal',
  'mode',
  'flowMode',
  'sourceWorkspace',
  'worktree',
  'status',
  'createdAt',
  'clientMessageId',
  'clientMessageScope',
  'endedAt',
  'queuedAt',
  'startedAt',
  'finishedAt',
  'queuePosition',
  'waitingReason',
  'queueMs',
  'executionMs',
  'scheduler',
  'runId',
  'trace',
  'recovery',
  'repairRound',
  'planVersion',
  'planVersions',
  'quality',
  'usage',
  'skillActivations',
  'stats',
  'steps',
  'doneSteps',
  'messages',
  'files',
  'changes',
  'events',
]);

function encodeTaskCursor(task) {
  return Buffer.from(
    JSON.stringify({ createdAt: Number(task.createdAt) || 0, id: task.id }),
  ).toString('base64url');
}

function decodeTaskCursor(value) {
  if (!value) return null;
  try {
    const raw = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (
      !raw ||
      !Number.isFinite(Number(raw.createdAt)) ||
      typeof raw.id !== 'string' ||
      !raw.id
    ) {
      return null;
    }
    return { createdAt: Number(raw.createdAt), id: raw.id };
  } catch {
    return null;
  }
}

function compareTaskOrder(a, b) {
  return Number(b.createdAt) - Number(a.createdAt) || String(a.id).localeCompare(String(b.id));
}

function activeTaskOf(tasks) {
  return (
    tasks.find((task) => isRunning(task.id)) ||
    tasks.find((task) => isQueued(task.id)) ||
    [...tasks].sort(compareTaskOrder)[0] ||
    null
  );
}

function selectTaskSummaryFields(summary, fields) {
  if (!fields.length) return summary;
  const selected = {};
  for (const field of fields) {
    if (field === 'id' || TASK_SUMMARY_FIELDS.has(field)) selected[field] = summary[field];
  }
  selected.id = summary.id;
  return selected;
}

function taskStatePage(tasks, searchParams) {
  const sorted = [...tasks].sort(compareTaskOrder);
  const limitRaw = searchParams.get('limit');
  const fields = String(searchParams.get('fields') || '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  if (!limitRaw) {
    return {
      tasks: sorted.map((task) => selectTaskSummaryFields(store.taskSummary(task), fields)),
      pagination: null,
      cursor: null,
    };
  }
  const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
  const cursorRaw = searchParams.get('cursor');
  const cursor = decodeTaskCursor(cursorRaw);
  if (cursorRaw && !cursor) {
    return { error: { code: 'invalid-cursor', message: '分页游标无效' } };
  }
  let start = 0;
  if (cursor) {
    start = sorted.findIndex(
      (task) =>
        Number(task.createdAt) < cursor.createdAt ||
        (Number(task.createdAt) === cursor.createdAt && String(task.id) > cursor.id),
    );
    if (start < 0) start = sorted.length;
  }
  const page = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  return {
    tasks: page.map((task) => selectTaskSummaryFields(store.taskSummary(task), fields)),
    pagination: {
      total: sorted.length,
      limit,
      hasMore,
      nextCursor: hasMore && page.length ? encodeTaskCursor(page[page.length - 1]) : null,
    },
    cursor: page.length ? encodeTaskCursor(page[page.length - 1]) : null,
  };
}

function taskDetail(task) {
  const summary = store.taskSummary(task);
  const poolAgent = task.plan?.find((step) => step.agentId && store.getAgent(step.agentId));
  // 老任务当时没记工时，按工序时间补算，别拿墙钟（含排队与重试等待）冒充
  if (!summary.stats?.ms) {
    const real = workMsOf(task);
    if (real) summary.stats = { ...summary.stats, ms: real };
  }
  return {
    ...summary,
    plan: task.plan,
    planVersion: task.planVersion || 0,
    planVersions: task.planVersions || [],
    usageLedger: (task.usageLedger || []).slice(-200),
    messages: task.messages,
    artifacts: task.artifacts,
    debate: task.debate || null,
    error: task.error || null,
    running: isRunning(task.id),
    queued: isQueued(task.id),
    scheduled: isScheduled(task.id),
    workspace: task.workspace,
    sourceWorkspace: task.sourceWorkspace || task.workspace,
    worktree: task.worktree || null,
    workspaceInfo: workspaceInfo(task),
    workspacePool: workspacePoolInfo(
      task,
      poolAgent ? store.getAgent(poolAgent.agentId) : null,
    ),
    external: !!task.external,
    fileChanges: task.fileChanges || [],
    events: (task.events || []).slice(-160),
    toolCalls: (task.events || [])
      .filter((event) => {
        const type = String(event.type || '');
        return type.startsWith('tool.') || type.startsWith('cli.policy.');
      })
      .slice(-120),
    context: buildContextPack(task),
  };
}

/* ---------------------------- SSE ---------------------------- */

const clients = new Set();

store.subscribe((event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
});

setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 20000).unref();

/* ---------------------------- 路由 ---------------------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  {
    const cors = corsDecision(req, SECURITY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    for (const [key, value] of Object.entries(corsHeaders(cors))) res.setHeader(key, value);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AgentForge-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (!cors.allowed) {
      store.recordSecurityEvent({
        type: 'cors.denied',
        method,
        path: pathname,
        requestId,
        remoteAddress: clientAddress(req),
        origin: cors.origin,
        reason: '来源不在允许列表',
      });
      return json(res, 403, { error: '来源不被允许' });
    }
    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
  }

  try {
    const isHook = /^\/api\/hooks\/[\w-]+$/.test(pathname);
    const isPublicHealth = pathname === '/api/health';
    let principal = null;
    if (!isHook && !isPublicHealth) {
      const auth = authenticateApi(req, url, SECURITY);
      if (!auth.ok) {
        store.recordSecurityEvent({
          type: 'api.auth.denied',
          method,
          path: pathname,
          requestId,
          remoteAddress: clientAddress(req),
          origin: req.headers.origin || '',
          reason: auth.reason,
          tenantId: 'default',
          tokenSource: auth.source,
        });
        return json(res, 401, {
          error: auth.reason,
          code: 'api-token-required',
          authRequired: true,
        });
      }
      principal = auth.principal;
      const authorization = authorizeApi(principal, method, pathname);
      if (!authorization.ok) {
        store.recordSecurityEvent({
          type: 'api.scope.denied',
          method,
          path: pathname,
          requestId,
          remoteAddress: clientAddress(req),
          origin: req.headers.origin || '',
          reason: authorization.reason,
          actorId: principal.id,
          actorKind: principal.kind,
          tenantId: principal.tenantId || 'default',
          tokenScope: authorization.scope,
          tokenSource: principal.source,
        });
        return json(res, 403, {
          error: authorization.reason,
          code: 'api-scope-required',
          requiredScope: authorization.scope,
        });
      }
    }

    /* ---- SSE ---- */
    if (pathname === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    /* ---- 工作流参数（界面可视化配置，替代手改 db.json） ---- */
    if (pathname === '/api/settings' && method === 'PATCH') {
      const body = await readBody(req);
      return json(res, 200, { settings: store.updateSettings(body || {}) });
    }

    /* ---- 全量状态 ---- */
    if (pathname === '/api/state' && method === 'GET') {
      const scopedTasks = visibleTasks(principal);
      const page = taskStatePage(scopedTasks, searchParams);
      if (page.error) {
        return json(res, 400, {
          error: page.error.message,
          code: page.error.code,
        });
      }
      const active = activeTaskOf(scopedTasks);
      const includeActiveTask = searchParams.get('includeActiveTask') !== '0';
      return json(res, 200, {
        agents: store.agents.map(agentView),
        profiles: store.profiles.map((profile) =>
          redactAgentProfile(profile, store.profileOptions()),
        ),
        providers: store.providers.map(redactProvider),
        tasks: page.tasks,
        pagination: page.pagination,
        cursor: page.cursor,
        settings: stateSettings(),
        mcpServers: store.mcpServers.map(redactMcpServer),
        commands: principal?.kind === 'agent' ? [] : commandRunner.snapshot(),
        approvals: visibleApprovals(principal),
        scheduler: schedulerSnapshot(),
        automations: visibleAutomations(principal),
        automationRunner: automationRunnerSnapshot(),
        otlp: otlpExporter.snapshot(),
        storage: store.storageSnapshot(),
        security: {
          ...securitySummary({ host: HOST, config: SECURITY }),
          principal: {
            id: principal?.id || 'owner',
            kind: principal?.kind || 'owner',
            tenantId: principal?.tenantId || '*',
          },
          audit: (store.db.settings.securityAudit || [])
            .filter(
              (entry) =>
                principal?.kind === 'owner' ||
                String(entry.tenantId || 'default') === String(principal?.tenantId || 'default'),
            )
            .slice(-20)
            .reverse(),
        },
        toolCatalog: TOOL_CATALOG,
        roleTools: ROLE_TOOLS,
        executionPolicies: executionPolicyCatalog(),
        timeoutCatalog: timeoutCatalog(),
        activeTaskId: active?.id || null,
        activeTask: active && includeActiveTask ? taskDetail(active) : null,
        overview: crossTaskOverview({ tenantId: principalTenant(principal) }),
      });
    }

    if (pathname === '/api/overview' && method === 'GET') {
      return json(res, 200, crossTaskOverview({ tenantId: principalTenant(principal) }));
    }

    if (pathname === '/api/security' && method === 'GET') {
      return json(res, 200, {
        security: securitySummary({ host: HOST, config: SECURITY }),
        audit: (store.db.settings.securityAudit || [])
          .filter(
            (entry) =>
              principal?.kind === 'owner' ||
              String(entry.tenantId || 'default') === String(principal?.tenantId || 'default'),
          )
          .slice(-100)
          .reverse(),
      });
    }

    /* ---- Automation ---- */
    if (pathname === '/api/automations' && method === 'GET') {
      return json(res, 200, {
        automations: visibleAutomations(principal),
        runner: automationRunnerSnapshot(),
      });
    }
    if (pathname === '/api/automations' && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 201, {
          automation: createAutomation({
            ...body,
            tenantId: requestedTenant(principal, body.tenantId),
            ownerId: principal?.id || 'owner',
            taskLimit: principal?.kind === 'owner' ? 0 : principal?.taskLimit || 0,
          }),
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    const automationMatch = pathname.match(
      /^\/api\/automations\/([\w-]+)(?:\/(run|wait|events))?$/,
    );
    if (automationMatch) {
      const automationId = automationMatch[1];
      const automation = getAutomation(automationId);
      if (
        !automation ||
        (principal?.kind !== 'owner' &&
          String(automation.tenantId || 'default') !== String(principal?.tenantId || 'default'))
      ) {
        return json(res, 404, { error: '自动化不存在' });
      }
      if (automationMatch[2] === 'run' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const clientMessageId =
          typeof body.clientMessageId === 'string' ? body.clientMessageId.trim() : '';
        if (clientMessageId.length > 200) {
          return json(res, 400, { error: 'clientMessageId 不能超过 200 个字符' });
        }
        const result = runAutomationNow(automationId, { clientMessageId });
        return json(res, result.ok ? 202 : 409, result);
      }
      if (automationMatch[2] === 'wait' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const result = waitForAutomationEvent(automationId, {
          eventId: body.eventId,
        });
        return json(res, result.ok ? 200 : 409, result);
      }
      if (automationMatch[2] === 'wait' && method === 'DELETE') {
        const result = cancelAutomationWait(automationId);
        return json(res, result.ok ? 200 : 409, result);
      }
      if (automationMatch[2] === 'events' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const result = wakeAutomationEvent(automationId, {
          eventId: body.eventId,
        });
        return json(res, result.ok ? 202 : 409, result);
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        try {
          return json(res, 200, { automation: updateAutomation(automationId, body) });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (method === 'DELETE') {
        return json(res, 200, { ok: removeAutomation(automationId) });
      }
      if (method === 'GET') {
        return json(res, 200, { automation });
      }
    }

    /* ---- 智能体 ---- */
    if (pathname === '/api/tools' && method === 'GET') {
      return json(res, 200, {
        tools: toolGateway.descriptors(),
        executionPolicies: executionPolicyCatalog(),
        timeoutCatalog: timeoutCatalog(),
      });
    }
    if (pathname === '/api/cli-policy' && method === 'GET') {
      const tools = String(searchParams.get('tools') || '')
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean);
      const policy = resolveCliPolicy({
        executionPolicy: searchParams.get('policy') || 'inherit',
        tools,
        cli: { command: searchParams.get('command') || '' },
      });
      return json(res, 200, { policy });
    }
    if (pathname === '/api/scheduler' && method === 'GET') {
      return json(res, 200, { scheduler: schedulerSnapshot() });
    }
    if (pathname === '/api/commands' && method === 'GET') {
      return json(res, 200, {
        commands: principal?.kind === 'agent' ? [] : commandRunner.snapshot(),
        approvals: visibleApprovals(principal),
      });
    }
    if (pathname === '/api/commands' && method === 'PATCH') {
      const body = await readBody(req);
      try {
        const entries = store.setCommandWhitelist(body.commands || []);
        commandRunner.configure(entries);
        return json(res, 200, { commands: commandRunner.snapshot() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    const commandMatch = pathname.match(/^\/api\/commands\/([\w-]+)\/run$/);
    if (commandMatch && method === 'POST') {
      if (principal?.kind === 'agent') {
        return json(res, 403, {
          error: 'Agent 不能直接执行固定命令，请先申请审批',
          code: 'command-approval-required',
        });
      }
      const body = await readBody(req);
      const task = visibleTask(principal, body.taskId);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const commandEntry = commandRunner.get(commandMatch[1]);
      if (commandEntry?.requireApproval) {
        return json(res, 409, {
          error: '该命令需要审批，请先提交审批申请',
          code: 'command-approval-required',
        });
      }
      try {
        const request = commandRunner.normalizeRequest({
          commandId: commandMatch[1],
          workingDirectory: body.workingDirectory,
        });
        const result = await commandRunner.execute({
          task,
          request,
          principal,
        });
        return json(res, 200, { ok: result.code === 0, result });
      } catch (err) {
        store.addTaskEvent(task.id, {
          type: 'command.rejected',
          data: {
            commandId: commandMatch[1],
            reason: err.message,
            principal,
          },
        });
        return json(res, Number(err?.status) || 400, { ok: false, error: err.message });
      }
    }
    if (pathname === '/api/approvals' && method === 'GET') {
      expireApprovals();
      return json(res, 200, {
        approvals: visibleApprovals(principal),
        commands: principal?.kind === 'agent' ? [] : commandRunner.snapshot(),
      });
    }
    if (pathname === '/api/approvals' && method === 'POST') {
      const body = await readBody(req);
      const task = visibleTask(principal, body.taskId);
      if (!task) return json(res, 404, { error: '任务不存在' });
      if (
        principal?.kind === 'agent' &&
        body.agentId !== undefined &&
        String(body.agentId) !== String(principal.id)
      ) {
        return json(res, 403, { error: 'Agent 只能为自己的身份申请审批' });
      }
      try {
        const approval = createApprovalRequest({
          taskId: body.taskId,
          agentId: body.agentId,
          commandId: body.commandId,
          workingDirectory: body.workingDirectory || '',
          requestedBy: principal,
          reason: body.reason || '',
          ttlMs: body.ttlMs,
          runner: commandRunner,
        });
        return json(res, 201, { approval });
      } catch (err) {
        return json(res, Number(err?.status) || 400, { ok: false, error: err.message });
      }
    }
    const approvalMatch = pathname.match(
      /^\/api\/approvals\/([\w-]+)(\/execute|\/cancel)?$/,
    );
    if (approvalMatch) {
      const approval = getApproval(approvalMatch[1]);
      if (
        !approval ||
        (principal?.kind !== 'owner' &&
          String(approval.tenantId || 'default') !== String(principal?.tenantId || 'default'))
      ) {
        return json(res, 404, { error: '审批不存在' });
      }
      if (
        principal?.kind === 'agent' &&
        String(approval.agentId) !== String(principal.id)
      ) {
        return json(res, 404, { error: '审批不存在' });
      }
      if (approvalMatch[2] === '/cancel' && method === 'POST') {
        try {
          const updated = cancelApproval(approval.id, {
            principal,
            runner: commandRunner,
          });
          return json(res, updated.status === 'executing' ? 202 : 200, {
            approval: updated,
            cancelRequested: updated.status === 'executing',
          });
        } catch (err) {
          return json(res, Number(err?.status) || 400, { ok: false, error: err.message });
        }
      }
      if (approvalMatch[2] === '/execute' && method === 'POST') {
        try {
          const result = await executeApproval(approval.id, {
            principal,
            runner: commandRunner,
          });
          return json(res, result.result.code === 0 ? 200 : 409, {
            ...result,
            ok: result.result.code === 0,
          });
        } catch (err) {
          return json(res, Number(err?.status) || 400, { ok: false, error: err.message });
        }
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        try {
          const updated = decideApproval(approval.id, {
            decision: body.decision,
            principal,
            runner: commandRunner,
          });
          return json(res, 200, { approval: updated });
        } catch (err) {
          return json(res, Number(err?.status) || 400, { ok: false, error: err.message });
        }
      }
      if (method === 'GET') return json(res, 200, { approval });
    }
    if (pathname === '/api/providers' && method === 'GET') {
      return json(res, 200, { providers: store.providers.map(redactProvider) });
    }
    if (pathname === '/api/profiles' && method === 'GET') {
      return json(res, 200, {
        profiles: store.profiles.map((profile) =>
          redactAgentProfile(profile, store.profileOptions()),
        ),
      });
    }
    if (pathname === '/api/profiles' && method === 'POST') {
      const body = await readBody(req);
      try {
        const profile = store.addProfile(body);
        return json(res, 201, {
          profile: redactAgentProfile(profile, store.profileOptions()),
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (pathname === '/api/profiles/import' && method === 'POST') {
      const body = await readBody(req);
      try {
        const profile = store.importProfile(body.profile || body);
        return json(res, 201, {
          profile: redactAgentProfile(profile, store.profileOptions()),
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    const profileMatch = pathname.match(/^\/api\/profiles\/([\w-]+)(\/export)?$/);
    if (profileMatch) {
      const profile = store.getProfile(profileMatch[1]);
      if (!profile) return json(res, 404, { error: 'Profile 不存在' });
      if (profileMatch[2] && method === 'GET') {
        return json(res, 200, {
          profile: redactAgentProfile(store.exportProfile(profile.id), store.profileOptions()),
        });
      }
      if (method === 'GET') {
        return json(res, 200, {
          profile: redactAgentProfile(profile, store.profileOptions()),
        });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const updated = store.updateProfile(profile.id, body);
        return json(res, 200, {
          profile: redactAgentProfile(updated, store.profileOptions()),
        });
      }
      if (method === 'DELETE') {
        return json(res, 200, { ok: store.removeProfile(profile.id) });
      }
    }
    if (pathname === '/api/mcp/servers' && method === 'GET') {
      return json(res, 200, { servers: store.mcpServers.map(redactMcpServer) });
    }
    if (pathname === '/api/mcp/servers' && method === 'POST') {
      const body = await readBody(req);
      try {
        const serverConfig = store.addMcpServer(body);
        return json(res, 201, { server: redactMcpServer(serverConfig) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    const mcpServerMatch = pathname.match(/^\/api\/mcp\/servers\/([\w-]+)(\/probe)?$/);
    if (mcpServerMatch) {
      const mcpServer = store.getMcpServer(mcpServerMatch[1]);
      if (!mcpServer) return json(res, 404, { error: 'MCP server 不存在' });
      if (mcpServerMatch[2] && method === 'POST') {
        try {
          const result = await probeMcpServer(mcpServer, { cwd: WORKSPACE_DIR });
          return json(res, 200, result);
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        try {
          const updated = store.updateMcpServer(mcpServer.id, body);
          return json(res, 200, { server: redactMcpServer(updated) });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (method === 'DELETE') {
        return json(res, 200, { ok: store.removeMcpServer(mcpServer.id) });
      }
      if (method === 'GET') {
        return json(res, 200, { server: redactMcpServer(mcpServer) });
      }
    }
    if (pathname === '/api/providers' && method === 'POST') {
      const body = await readBody(req);
      try {
        const provider = store.addProvider(body);
        return json(res, 201, { provider: redactProvider(provider) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    const providerMatch = pathname.match(/^\/api\/providers\/([\w-]+)$/);
    if (providerMatch) {
      const providerId = providerMatch[1];
      if (method === 'PATCH') {
        const body = await readBody(req);
        const provider = store.updateProvider(providerId, body);
        if (!provider) return json(res, 404, { error: 'Provider 不存在' });
        return json(res, 200, { provider: redactProvider(provider) });
      }
      if (method === 'DELETE') {
        if (providerId === 'local-default') {
          return json(res, 400, { error: '默认 Provider 不能删除' });
        }
        const ok = store.removeProvider(providerId);
        return json(res, ok ? 200 : 404, { ok });
      }
    }
    if (pathname === '/api/agents' && method === 'GET') {
      return json(res, 200, {
        agents: store.agents.map(agentView),
        profiles: store.profiles.map((profile) =>
          redactAgentProfile(profile, store.profileOptions()),
        ),
        providers: store.providers.map(redactProvider),
        toolCatalog: TOOL_CATALOG,
        roleTools: ROLE_TOOLS,
        executionPolicies: executionPolicyCatalog(),
      });
    }
    if (pathname === '/api/agents' && method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: '缺少 name' });
      try {
        return json(res, 201, { agent: agentView(store.addAgent(body)) });
      } catch (err) {
        return json(res, 409, { error: err.message });
      }
    }
    if (pathname === '/api/probe' && method === 'GET') {
      clearResolveCache();
      return json(res, 200, { candidates: await probeClis() });
    }

    if (pathname === '/api/context-preview' && method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      const context = buildContextPack({
        goal,
        workspace: body.workspace || WORKSPACE_DIR,
        status: 'idle',
        mode: 'auto',
        messages: [],
      }, { maxMessages: 0 });
      return json(res, 200, { context });
    }

    const contextCompactMatch = pathname.match(/^\/api\/tasks\/([\w-]+)\/context\/compact$/);
    if (contextCompactMatch && method === 'POST') {
      const task = store.getTask(contextCompactMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const body = await readBody(req).catch(() => ({}));
      const result = compactTaskContext(task.id, {
        maxMessages: Math.max(2, Math.min(40, Number(body.maxMessages) || 8)),
        force: body.force === true,
      });
      return json(res, 200, result);
    }

    const contextCompactionsMatch = pathname.match(
      /^\/api\/tasks\/([\w-]+)\/context\/compactions$/,
    );
    if (contextCompactionsMatch && method === 'GET') {
      const task = store.getTask(contextCompactionsMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, { compactions: listTaskCompactions(task.id) });
    }

    const contextReplayMatch = pathname.match(
      /^\/api\/tasks\/([\w-]+)\/context\/compactions\/([\w-]+)\/replay$/,
    );
    if (contextReplayMatch && method === 'GET') {
      const replay = replayTaskCompaction(contextReplayMatch[1], contextReplayMatch[2]);
      if (!replay) return json(res, 404, { error: '压缩记录不存在' });
      return json(res, 200, replay);
    }

    const contextStateMatch = pathname.match(/^\/api\/tasks\/([\w-]+)\/context$/);
    if (contextStateMatch && method === 'PATCH') {
      const task = store.getTask(contextStateMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const body = await readBody(req);
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body, 'contextWindow')) {
        patch.contextWindow = numericSetting(body.contextWindow);
        if (body.contextWindow !== null && body.contextWindow !== '' && patch.contextWindow === null) {
          return json(res, 400, { error: 'contextWindow 必须是正数或 null' });
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'autoCompactAt')) {
        patch.autoCompactAt = numericSetting(body.autoCompactAt);
        if (body.autoCompactAt !== null && body.autoCompactAt !== '' && patch.autoCompactAt === null) {
          return json(res, 400, { error: 'autoCompactAt 必须是正数或 null' });
        }
      }
      return json(res, 200, {
        contextState: store.updateContextState(task.id, patch),
      });
    }

    /* ---- 目录选择器（本机服务，供「选文件夹开工」用） ---- */
    if (pathname === '/api/fs' && method === 'GET') {
      const raw = String(searchParams.get('path') || '').trim();
      if (!raw) {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const dirs = [];
        if (process.platform === 'win32') {
          for (const letter of 'CDEFGH') {
            const drive = `${letter}:\\`;
            if (fs.existsSync(drive)) dirs.push({ name: `${letter}:`, path: drive });
          }
        } else {
          dirs.push({ name: '/', path: '/' });
        }
        if (home && fs.existsSync(home)) dirs.unshift({ name: '用户目录', path: home });
        dirs.push({ name: 'AgentForge 工作区', path: WORKSPACE_DIR });
        return json(res, 200, { path: '', parent: null, dirs });
      }
      const abs = path.resolve(raw);
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        return json(res, 400, { error: `目录不存在：${abs}` });
      }
      if (!stat.isDirectory()) return json(res, 400, { error: `不是目录：${abs}` });
      let entries = [];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch (err) {
        return json(res, 400, { error: `无法读取：${err.code || err.message}` });
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        .slice(0, 400)
        .map((e) => ({ name: e.name, path: path.join(abs, e.name) }));
      const parent = path.dirname(abs);
      return json(res, 200, { path: abs, parent: parent === abs ? null : parent, dirs });
    }
    if (pathname === '/api/agents/adopt' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, await adoptInstalledClis({ dryRun: body?.dryRun === true }));
    }
    if (pathname === '/api/agents/rebalance' && method === 'POST') {
      return json(res, 200, {
        assignments: rebalanceTeam(),
        agents: store.agents.map(agentView),
      });
    }
    // 把内置演示席位换成真实 CLI：ensure 只补齐内置席位，refresh 强制重体检并重组
    if (pathname === '/api/team/ensure' && method === 'POST') {
      return json(res, 200, await ensureRealTeam());
    }
    if (pathname === '/api/team/refresh' && method === 'POST') {
      clearResolveCache();
      return json(res, 200, await refreshTeam());
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([\w-]+)(\/test)?$/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const agent = store.getAgent(agentId);
      if (!agent) return json(res, 404, { error: '智能体不存在' });
      if (agentMatch[2] && method === 'POST') {
        if (!agent.cli?.command) return json(res, 400, { ok: false, message: '未配置 CLI 命令' });
        const route = agentRouteForExecution(agent);
        const res2 = await spawnCli(route[0], '只回答两个字：在线', {
          timeout: agent.cli.healthTimeout || 60000,
          cwd: ROOT,
        });
        const health = judgeHealth(res2);
        const ok = health.ok;
        // 单个体检结果必须落回智能体，否则界面会一直挂着上一次的「不可用」
        store.updateAgent(agentId, { health });
        return json(res, 200, {
          ok,
          code: res2.code,
          ms: res2.elapsed,
          health,
          policy: res2.policy || resolveCliPolicy(route[0]),
          providerId: route[0]?.provider?.id || agent.providerId || '',
          output: (res2.stdout || res2.stderr || '').trim().slice(0, 500),
        });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, { agent: agentView(store.updateAgent(agentId, body)) });
      }
      if (method === 'DELETE') {
        const ok = store.removeAgent(agentId);
        if (ok) store.removeAgentReferences(agentId);
        return json(res, 200, { ok });
      }
    }

    /* ---- 任务 ---- */
    if (pathname === '/api/tasks' && method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      if (goal.length < 2) return json(res, 400, { error: '目标太短，至少 2 个字' });
      const clientMessageId =
        typeof body.clientMessageId === 'string' ? body.clientMessageId.trim() : '';
      if (clientMessageId.length > 200) {
        return json(res, 400, { error: 'clientMessageId 不能超过 200 个字符' });
      }
      const taskTenant = requestedTenant(principal, body.tenantId);
      const existing = clientMessageId
        ? store.findTenantIdempotentTask(clientMessageId, taskTenant, 'task:create')
        : null;
      if (existing) {
        return json(res, 200, {
          task: taskDetail(existing),
          idempotentReplay: true,
        });
      }
      let task;
      try {
        task = store.createTask({
          goal,
          mode: body.mode === 'manual' ? 'manual' : 'auto',
          workspace: typeof body.workspace === 'string' ? body.workspace : '',
          isolation: body.isolation === 'worktree' ? 'worktree' : 'direct',
          debate: body.flowMode === 'direct' || body.flowMode === 'debate' ? body.flowMode : null,
          clientMessageId,
          clientMessageScope: clientMessageId ? 'task:create' : '',
          tenantId: taskTenant,
          ownerId: principal?.id || 'owner',
          taskLimit: principal?.kind === 'owner' ? 0 : principal?.taskLimit || 0,
        });
      } catch (err) {
        return json(res, Number(err?.status) || 400, {
          error: err.message,
          code: err.code || '',
        });
      }
      const speed = Number(body.speed) || 1;
      if (body.autoRun !== false) {
        scheduleTask(task.id, { speed, source: 'api.create' });
      }
      return json(res, 201, { task: taskDetail(store.getTask(task.id)) });
    }

    const taskMcpMatch = pathname.match(/^\/api\/tasks\/([\w-]+)\/mcp\/call$/);
    if (taskMcpMatch && method === 'POST') {
      const task = visibleTask(principal, taskMcpMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const body = await readBody(req);
      try {
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'mcp.call',
          operation: 'call',
          args: {
            op: 'call',
            serverId: body.serverId,
            tool: body.tool,
            arguments: body.arguments || {},
          },
          agentId: typeof body.agentId === 'string' ? body.agentId : '',
          principal,
          stepId: typeof body.stepId === 'string' ? body.stepId : '',
          source: body.agentId ? 'api.agent' : 'api.owner',
        });
        return json(res, 200, {
          ok: true,
          callId: call.callId,
          result: call.result,
        });
      } catch (err) {
        return json(res, Number(err?.status) || 400, { ok: false, error: err.message });
      }
    }

    const exportMatch = pathname.match(/^\/api\/tasks\/([\w-]+)\/export$/);
    if (exportMatch && method === 'GET') {
      const task = visibleTask(principal, exportMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const transcript = taskTranscript(task, searchParams.get('format') || 'markdown');
      res.writeHead(200, {
        'Content-Type': transcript.contentType,
        'Content-Disposition': `attachment; filename="${transcript.filename}"`,
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(transcript.body),
        ...(transcript.spill
          ? {
              'X-AgentForge-Spill': encodeURIComponent(transcript.spill.locator),
              'X-AgentForge-Spill-Bytes': String(transcript.spill.bytes),
              'X-AgentForge-Spill-Sha256': transcript.spill.sha256,
            }
          : {}),
      });
      return res.end(transcript.body);
    }

    const attachmentMatch = pathname.match(/^\/api\/tasks\/([\w-]+)\/attachments$/);
    if (attachmentMatch && method === 'POST') {
      const task = visibleTask(principal, attachmentMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const raw = await readBody(req, 12 * 1024 * 1024);
      try {
        const buffer = Buffer.from(String(raw.data || ''), 'base64');
        const image = admitImage(buffer, { name: raw.name });
        store.addTaskAttachment(task.id, image);
        return json(res, 201, { image });
      } catch (err) {
        if (err instanceof AttachError) {
          return json(res, err.status || 400, { error: err.message, code: err.code });
        }
        throw err;
      }
    }

    const attachmentFileMatch = pathname.match(
      /^\/api\/tasks\/([\w-]+)\/attachments\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/i,
    );
    if (attachmentFileMatch && method === 'GET') {
      const task = visibleTask(principal, attachmentFileMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const sha256 = attachmentFileMatch[2].toLowerCase();
      const mime = {
        png: 'image/png',
        jpg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
      }[attachmentFileMatch[3].toLowerCase()];
      if (!store.taskHasAttachment(task.id, sha256, mime)) {
        return json(res, 404, { error: '图片附件不属于该任务', code: 'IMAGE_NOT_FOUND' });
      }
      try {
        const { buffer } = readAttachment({ sha256, mime });
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Length': buffer.length,
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(buffer);
      } catch (err) {
        if (err instanceof AttachError) {
          return json(res, err.status || 404, { error: err.message, code: err.code });
        }
        throw err;
      }
    }

    const taskMatch = pathname.match(
      /^\/api\/tasks\/([\w-]+)(?:\/(run|stop|chat|replan|files|file|workspace|search|events|changes|diff|fs|tools|graph|replay))?$/,
    );
    if (taskMatch) {
      const task = visibleTask(principal, taskMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const action = taskMatch[2];

      if (!action && method === 'GET') return json(res, 200, { task: taskDetail(task) });
      if (!action && method === 'DELETE') {
        stopTask(task.id);
        commandRunner.cancelTask(task.id);
        return json(res, 200, { ok: store.removeTask(task.id) });
      }
      if (action === 'run' && method === 'POST') {
        const body = await readBody(req);
        if (isScheduled(task.id)) return json(res, 409, { error: '该任务正在协作中或排队中' });
        // 重新编排时允许顺带改流程模式（先讨论 / 直接开工），不必删掉重开任务
        if (body.flowMode === 'direct' || body.flowMode === 'debate') {
          store.updateTask(task.id, { flowMode: body.flowMode });
        } else if (body.flowMode === null) {
          store.updateTask(task.id, { flowMode: null });
        }
        const scheduled = scheduleTask(task.id, {
          speed: Number(body.speed) || 1,
          source: 'api.run',
        });
        return json(res, scheduled.accepted ? 202 : 409, {
          ok: scheduled.accepted,
          scheduler: scheduled,
        });
      }
      if (action === 'stop' && method === 'POST') {
        commandRunner.cancelTask(task.id);
        return json(res, 200, { ok: stopTask(task.id) });
      }
      if (action === 'chat' && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        const attachment = body.image?.sha256
          ? {
              sha256: String(body.image.sha256),
              mime: String(body.image.mime || ''),
              width: Number(body.image.width) || 0,
              height: Number(body.image.height) || 0,
              bytes: Number(body.image.bytes) || 0,
            }
          : null;
        if (!text && !attachment) return json(res, 400, { error: '消息为空' });
        if (
          attachment &&
          !store.taskHasAttachment(task.id, attachment.sha256, attachment.mime)
        ) {
          return json(res, 400, {
            error: '图片附件不属于该任务，请重新上传',
            code: 'IMAGE_INVALID_REFERENCE',
          });
        }
        chat(task.id, text, { speed: Number(body.speed) || 1, image: attachment }).catch((e) =>
          console.error('[chat]', e),
        );
        return json(res, 202, { ok: true });
      }
      if (action === 'replan' && method === 'POST') {
        const body = await readBody(req);
        try {
          const result = replanTask(task.id, {
            reason: String(body.reason || '').trim(),
            steps: Array.isArray(body.steps) ? body.steps : null,
          });
          return json(res, 200, {
            ok: true,
            replan: {
              preserved: result?.preserved || [],
              reopened: result?.reopened || [],
            },
            task: taskDetail(store.getTask(task.id)),
          });
        } catch (err) {
          return json(res, /正在执行/.test(err.message) ? 409 : 400, { error: err.message });
        }
      }
      if (action === 'tools' && method === 'GET') {
        return json(res, 200, {
          tools: toolGateway.descriptors(),
          events: (task.events || [])
            .filter((event) => {
              const type = String(event.type || '');
              return type.startsWith('tool.') || type.startsWith('cli.policy.');
            })
            .slice(-240),
        });
      }
      if (action === 'graph' && method === 'GET') {
        return json(res, 200, taskGraph(task));
      }
      if (action === 'replay' && method === 'GET') {
        return json(res, 200, taskReplay(task));
      }
      if (action === 'files' && method === 'GET') {
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'workspace.read',
          operation: 'files',
          args: { op: 'files' },
          agentId: searchParams.get('agentId') || '',
          principal,
          source: searchParams.get('agentId') ? 'api.agent' : 'api.owner',
          audit: !!searchParams.get('agentId'),
        });
        return json(res, 200, call.result);
      }
      if (action === 'workspace' && method === 'GET') {
        const lazyPath = searchParams.get('path');
        const lazy = searchParams.has('path');
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'workspace.read',
          operation: lazy ? 'directory' : 'tree',
          args: lazy ? { op: 'directory', path: lazyPath || '' } : { op: 'tree' },
          agentId: searchParams.get('agentId') || '',
          principal,
          source: searchParams.get('agentId') ? 'api.agent' : 'api.owner',
          audit: !!searchParams.get('agentId'),
        });
        return json(res, 200, call.result);
      }
      if (action === 'search' && method === 'GET') {
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'workspace.search',
          operation: 'search',
          args: { op: 'search', query: searchParams.get('q') || '' },
          agentId: searchParams.get('agentId') || '',
          principal,
          source: searchParams.get('agentId') ? 'api.agent' : 'api.owner',
          audit: !!searchParams.get('agentId'),
        });
        return json(res, 200, call.result);
      }
      if (action === 'events' && method === 'GET') {
        const limit = Math.max(1, Math.min(800, Number(searchParams.get('limit')) || 160));
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'workspace.read',
          operation: 'events',
          args: { op: 'events', limit },
          agentId: searchParams.get('agentId') || '',
          principal,
          source: searchParams.get('agentId') ? 'api.agent' : 'api.owner',
          audit: !!searchParams.get('agentId'),
        });
        return json(res, 200, call.result);
      }
      if (action === 'changes' && method === 'GET') {
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'workspace.read',
          operation: 'changes',
          args: { op: 'changes' },
          agentId: searchParams.get('agentId') || '',
          principal,
          source: searchParams.get('agentId') ? 'api.agent' : 'api.owner',
          audit: !!searchParams.get('agentId'),
        });
        return json(res, 200, call.result);
      }
      if (action === 'diff' && method === 'GET') {
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'workspace.read',
          operation: 'diff',
          args: { op: 'diff', path: searchParams.get('path') || '' },
          agentId: searchParams.get('agentId') || '',
          principal,
          source: searchParams.get('agentId') ? 'api.agent' : 'api.owner',
          audit: !!searchParams.get('agentId'),
        });
        return json(res, 200, call.result);
      }
      if (action === 'fs' && method === 'POST') {
        const body = await readBody(req);
        const op = String(body.op || '').trim();
        if (op === 'transaction') {
          const call = await toolGateway.invokeTool({
            taskId: task.id,
            toolId: 'workspace.transaction',
            operation: 'apply',
            args: { op: 'apply', operations: body.operations },
            agentId: typeof body.agentId === 'string' ? body.agentId : '',
            principal,
            stepId: typeof body.stepId === 'string' ? body.stepId : '',
            source: body.agentId ? 'api.agent' : 'api.owner',
          });
          return json(res, 200, { ok: true, result: call.result, callId: call.callId });
        }
        const toolId =
          op === 'move'
            ? 'workspace.move'
            : op === 'delete'
              ? 'workspace.delete'
              : op === 'write' || op === 'mkdir'
                ? 'workspace.write'
                : '';
        if (!toolId) return json(res, 400, { error: '不支持的 fs op' });
        const args =
          op === 'move'
            ? { op, from: body.from, to: body.to }
            : op === 'write'
              ? {
                  op,
                  path: body.path,
                  content: body.content,
                  expectedVersion:
                    typeof body.expectedVersion === 'string' ? body.expectedVersion : '',
                }
              : { op, path: body.path };
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId,
          operation: op,
          args,
          agentId: typeof body.agentId === 'string' ? body.agentId : '',
          principal,
          stepId: typeof body.stepId === 'string' ? body.stepId : '',
          source: body.agentId ? 'api.agent' : 'api.owner',
        });
        return json(res, 200, { ok: true, result: call.result, callId: call.callId });
      }
      if (action === 'file' && method === 'GET') {
        const rel = searchParams.get('path') || '';
        const call = await toolGateway.invokeTool({
          taskId: task.id,
          toolId: 'workspace.read',
          operation: 'file',
          args: { op: 'file', path: rel },
          agentId: searchParams.get('agentId') || '',
          principal,
          source: searchParams.get('agentId') ? 'api.agent' : 'api.owner',
          audit: !!searchParams.get('agentId'),
        });
        return json(res, 200, call.result);
      }
    }

    /* ---- 外部 bot webhook ---- */
    const hookMatch = pathname.match(/^\/api\/hooks\/([\w-]+)$/);
    if (hookMatch) {
      if (hookMatch[1] !== store.db.settings.hookToken) return json(res, 401, { error: 'token 无效' });
      if (method === 'GET') {
        return json(res, 200, {
          ok: true,
          tasks: store.tasks.slice(0, 5).map((t) => store.taskSummary(t)),
        });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const goal = String(body.goal || body.text || body.message || '').trim();
        if (!goal) return json(res, 400, { error: '需要 goal / text / message 字段' });
        const task = store.createTask({ goal, tenantId: 'default', ownerId: 'hook' });
        scheduleTask(task.id, { source: 'hook' });
        return json(res, 202, {
          ok: true,
          taskId: task.id,
          stream: `/api/tasks/${task.id}`,
          reply: `已收到任务「${task.title}」，团队开始协作。`,
        });
      }
    }

    /* ---- 桌面模式：退出应用 ---- */
    if (pathname === '/api/shutdown' && method === 'POST') {
      const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (!['127.0.0.1', '::1'].includes(addr)) return json(res, 403, { error: '仅允许本机调用' });
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        agents: store.agents.length,
        tasks: store.tasks.length,
        scheduler: schedulerSnapshot(),
        automationRunner: automationRunnerSnapshot(),
        otlp: otlpExporter.snapshot(),
        storage: store.storageSnapshot(),
        security: securitySummary({ host: HOST, config: SECURITY }),
        uptime: process.uptime(),
      });
    }

    return json(res, 404, { error: '接口不存在' });
  } catch (err) {
    if (err?.message === '请求体过大') return json(res, 413, { error: '请求体过大' });
    if (err instanceof WorkspaceError) {
      return json(res, err.status || 400, { error: err.message });
    }
    console.error('[api]', err);
    return json(res, 500, { error: err.message });
  }
});

/* ---------------------------- 静态资源 ---------------------------- */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const publicRoot = path.resolve(PUBLIC_DIR);
  const abs = path.resolve(publicRoot, '.' + rel);
  if (abs !== publicRoot && !abs.startsWith(publicRoot + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat || stat.isDirectory()) {
    // 带后缀的请求就是静态资源，缺了就老实 404，不要回退成首页 HTML
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    // SPA 回退
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(fs.readFileSync(index));
    }
    res.writeHead(404);
    return res.end('Not Found');
  }
  const ext = path.extname(abs).toLowerCase();
  // 桌面应用会长期常驻：脚本样式不缓存，避免更新后还跑旧前端；字体图片可以长缓存
  const cacheable = ['.woff2', '.png', '.ico', '.svg'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
    'Content-Length': stat.size,
  });
  fs.createReadStream(abs).pipe(res);
}

/* 本地常驻服务：漏网异常只记录，不让进程带着窗口一起退出 */
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAutomationRunner();
  store.releaseAllLeases();
  await otlpExporter.flush();
  for (const res of clients) res.end();
  clients.clear();
  server.close(() => {
    store.flush();
    process.exit(0);
  });
  setTimeout(() => {
    store.flush();
    process.exit(0);
  }, 1500).unref();
}

process.once('SIGINT', () => {
  shutdown().catch((err) => console.error('[shutdown]', err));
});
process.once('SIGTERM', () => {
  shutdown().catch((err) => console.error('[shutdown]', err));
});
process.once('exit', () => store.flush());

// 端口被占用时 Node 只会抛一个裸 EADDRINUSE 并静默退出，容易误判成「启动成功但页面打不开」
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`  ✗ 端口 ${PORT} 已被占用：本机可能已有一个 AgentForge 在运行。`);
    console.error('    先关掉旧进程（或设 PORT=xxxx 换端口）再启动。');
    process.exit(2);
  }
  console.error('  ✗ 服务启动失败: ' + (err && err.message));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  AgentForge · 多智能体开发协作台');
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log(`  ➜  工作区: ${path.join(DATA_DIR, 'workspaces')}`);
  console.log(
    `  ➜  API 鉴权: ${SECURITY.tokenEnabled ? 'Bearer Token 已启用' : '仅回环或显式无鉴权模式'}`,
  );
  console.log('');
  startAutomationRunner();
  // 后台把内置演示席位换成体检通过的真实 CLI；体检较慢，不阻塞服务可用
  if (process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP !== '1') {
    setTimeout(() => {
      ensureRealTeam()
        .then((r) => {
          if (r.changed) {
            console.log(`  ➜  真实席位: ${r.seats.map((s) => `${s.role}→${s.name}`).join('、')}`);
            console.log(`  ➜  ${r.reason}`);
          } else {
            console.log(`  ➜  团队: ${r.reason}`);
          }
        })
        .catch((err) => console.warn('  !  组建真实团队失败: ' + err.message));
    }, 200);
  }
});
