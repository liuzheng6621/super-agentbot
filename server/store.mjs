import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { estimateTokens } from './tokens.mjs';
import { spillText, spillValue } from './fs.mjs';
import {
  defaultTimeouts,
  normalizeTimeoutOverrides,
  resolveTimeouts,
} from './timeouts.mjs';
import {
  createMessageEnvelope,
  createPlanSnapshot,
  ensureMessageEnvelope,
  ensurePlanVersionState,
} from './collaboration.mjs';
import {
  DEFAULT_PROVIDER_ID,
  defaultProviders,
  normalizeProvider,
  redactProvider,
  resolveProvider,
} from './providers.mjs';
import { publicImageRef, supportsVision } from './attachments.mjs';
import * as persistence from './persistence.mjs';
import { TaskShardStore } from './persistence.mjs';
import {
  DEFAULT_AUTOMATION_CLAIM_MS,
  DEFAULT_TASK_LEASE_MS,
  pruneExpiredLeases,
  taskLeaseIsLive,
} from './leases.mjs';
import { resolveParentSpanId, safeSpanId } from './events.mjs';
import { normalizeExecutionPolicy } from './cli-policy.mjs';
import { normalizeRoots, withinAnyRoot } from './path-roots.mjs';
import { normalizeMcpServer } from './mcp.mjs';
import {
  agentToProfile,
  defaultAgentWorkspacePolicy,
  normalizeAgentConcurrency,
  normalizeAgentModel,
  normalizeAgentProfile,
  normalizeAgentProfileId,
  normalizeAgentWorkspacePolicy,
  normalizeProfileImport,
  profileToAgentPatch,
} from './profiles.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.AGENTFORGE_DATA_DIR
  ? path.resolve(process.env.AGENTFORGE_DATA_DIR)
  : path.join(ROOT, 'data');
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspaces');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const MAX_MESSAGES = 400;
const MAX_TASK_EVENTS = 800;
const MAX_FILE_CHANGES = 500;
const MAX_PLAN_VERSIONS = 40;
const MAX_SKILL_ACTIVATIONS = 40;
const MAX_INLINE_EVENT_BYTES = 32 * 1024;
const MAX_INLINE_MESSAGE_BYTES = 64 * 1024;
const MAX_INLINE_TRANSCRIPT_BYTES = 512 * 1024;
const SAVE_WINDOW_MS = 200;
const MAX_MCP_SERVERS = 32;
const LOCK_FILE = path.join(DATA_DIR, '.db.lock');
const LEASE_FILE = path.join(DATA_DIR, '.leases.json');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 15000;

const acquireFileLockSync = (options = {}) =>
  persistence.acquireFileLockSync(LOCK_FILE, { ...options, dataDir: DATA_DIR });
const releaseFileLockSync = (token) => persistence.releaseFileLockSync(LOCK_FILE, token);
const readJsonFile = persistence.readJsonFile;
const writeTextAtomic = persistence.writeTextAtomic;
const writeJsonAtomic = persistence.writeJsonAtomic;
const processIsAlive = persistence.processIsAlive;

function cryptoHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const ROLE_ORDER = ['planner', 'architect', 'coder', 'tester', 'reviewer'];
export const ROLE_LABEL = {
  planner: '规划',
  architect: '架构',
  coder: '实现',
  tester: '测试',
  reviewer: '评审',
};
export const TASK_PRIORITIES = ['low', 'normal', 'high'];

export function normalizeTaskPriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  return TASK_PRIORITIES.includes(priority) ? priority : 'normal';
}

export const TOOL_CATALOG = [
  {
    id: 'workspace.read',
    label: '读取工作区',
    description: '读取工作树、文件、事件、变更和 Git diff。',
    risk: 'read',
    scope: 'workspace',
    audit: true,
    operations: ['tree', 'directory', 'files', 'file', 'events', 'changes', 'diff'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { enum: ['tree', 'directory', 'files', 'file', 'events', 'changes', 'diff'] },
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 800 },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    id: 'workspace.search',
    label: '搜索工作区',
    description: '按文本搜索工作区中的非敏感文件。',
    risk: 'read',
    scope: 'workspace',
    audit: true,
    operations: ['search'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'search' },
        query: { type: 'string', minLength: 2 },
      },
      required: ['op', 'query'],
      additionalProperties: false,
    },
  },
  {
    id: 'workspace.write',
    label: '创建或修改文件',
    description: '创建目录或原子写入工作区文件；修改已有文件时必须匹配最近读取版本。',
    risk: 'write',
    scope: 'workspace',
    audit: true,
    operations: ['write', 'mkdir'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { enum: ['write', 'mkdir'] },
        path: { type: 'string' },
        content: { type: 'string', maxLength: 2097152 },
        expectedVersion: { type: 'string', maxLength: 80 },
      },
      required: ['op', 'path'],
      additionalProperties: false,
    },
  },
  {
    id: 'workspace.move',
    label: '移动或重命名',
    description: '移动或重命名工作区中的文件与目录。',
    risk: 'write',
    scope: 'workspace',
    audit: true,
    operations: ['move'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'move' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['op', 'from', 'to'],
      additionalProperties: false,
    },
  },
  {
    id: 'workspace.delete',
    label: '移入回收站',
    description: '把工作区文件或目录移入可恢复的回收站。',
    risk: 'destructive',
    scope: 'workspace',
    audit: true,
    operations: ['delete'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'delete' },
        path: { type: 'string' },
      },
      required: ['op', 'path'],
      additionalProperties: false,
    },
  },
  {
    id: 'workspace.transaction',
    label: '事务化工作区操作',
    description: '按顺序执行一批写入、建目录、移动或删除操作；任一步失败时恢复文件与任务元数据。',
    risk: 'destructive',
    scope: 'workspace',
    audit: true,
    operations: ['apply'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'apply' },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              op: { enum: ['write', 'mkdir', 'move', 'delete'] },
              path: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              content: { type: 'string', maxLength: 2097152 },
              expectedVersion: { type: 'string', maxLength: 80 },
            },
            required: ['op'],
          },
        },
      },
      required: ['op', 'operations'],
      additionalProperties: false,
    },
  },
  {
    id: 'shell',
    label: '执行 Shell',
    description: '执行受控命令。当前版本只声明能力，尚未开放平台执行入口。',
    risk: 'execute',
    scope: 'workspace',
    audit: true,
    operations: ['exec'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'exec' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['op', 'command'],
      additionalProperties: false,
    },
  },
  {
    id: 'history_search',
    label: '搜索历史',
    description: '只读检索当前任务的消息、事件和摘要；可选跨任务检索。',
    risk: 'read',
    scope: 'history',
    audit: true,
    operations: ['search'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'search' },
        query: { type: 'string', minLength: 2 },
        scope: { enum: ['task', 'all'] },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['op', 'query'],
      additionalProperties: false,
    },
  },
  {
    id: 'history_read',
    label: '读取历史',
    description: '按 cursor 分页读取历史命中项的原始消息或事件。',
    risk: 'read',
    scope: 'history',
    audit: true,
    operations: ['read'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'read' },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['op', 'cursor'],
      additionalProperties: false,
    },
  },
  {
    id: 'mcp.call',
    label: '调用 MCP 只读工具',
    description: '通过本地 stdio MCP server 调用已白名单的只读工具。',
    risk: 'read',
    scope: 'mcp',
    audit: true,
    operations: ['call'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { const: 'call' },
        serverId: { type: 'string' },
        tool: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['op', 'serverId', 'tool'],
      additionalProperties: false,
    },
  },
];

export const ROLE_TOOLS = {
  planner: ['workspace.read', 'workspace.search', 'history_search', 'history_read'],
  architect: ['workspace.read', 'workspace.search', 'history_search', 'history_read'],
  coder: [
    'workspace.read',
    'workspace.search',
    'workspace.write',
    'workspace.move',
    'workspace.delete',
    'workspace.transaction',
    'shell',
    'history_search',
    'history_read',
  ],
  tester: [
    'workspace.read',
    'workspace.search',
    'workspace.write',
    'workspace.transaction',
    'shell',
    'history_search',
    'history_read',
  ],
  reviewer: [
    'workspace.read',
    'workspace.search',
    'shell',
    'history_search',
    'history_read',
  ],
};

export function toolsForRole(role) {
  return [...(ROLE_TOOLS[role] || ROLE_TOOLS.coder)];
}

export function normalizeTools(value, role) {
  const allowed = new Set(TOOL_CATALOG.map((tool) => tool.id));
  const input = Array.isArray(value) ? value : toolsForRole(role);
  return [...new Set(input.filter((tool) => allowed.has(String(tool))))];
}

export function normalizeSkills(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 40),
    ),
  ];
}

export function normalizeMcpServerIds(value, servers = []) {
  if (!Array.isArray(value)) return [];
  const known = new Set((servers || []).map((server) => String(server?.id || '')));
  return [
    ...new Set(
      value
        .map((id) => String(id || '').trim())
        .filter((id) => id && known.has(id)),
    ),
  ].slice(0, 16);
}

function normalizePlanStep(step = {}, fallbackId = 'step-1', used = new Set(), reset = false) {
  let id = String(step.id || fallbackId);
  if (used.has(id)) id = `${fallbackId}-${randomUUID().slice(0, 4)}`;
  used.add(id);
  const saved = {
    ...step,
    id,
    title: String(step.title || id),
    role: String(step.role || 'coder'),
    agentId: String(step.agentId || ''),
    needs: [...new Set((step.needs || []).map(String).filter(Boolean))],
    outputPaths: Array.isArray(step.outputPaths) ? [...step.outputPaths] : [],
    status: reset ? 'pending' : String(step.status || 'pending'),
    note: reset ? '' : String(step.note || ''),
    attempt: reset ? 0 : Math.max(0, Number(step.attempt) || 0),
    maxAttempts: Math.max(1, Number(step.maxAttempts) || 1),
    round: Math.max(0, Number(step.round) || 0),
  };
  if (reset) {
    delete saved.startedAt;
    delete saved.endedAt;
    delete saved.verdict;
    delete saved.verdictDetails;
    delete saved.selfReview;
    delete saved.reviewerId;
    delete saved.implementerId;
    delete saved.traceSpanId;
    delete saved.traceParentSpanId;
    delete saved.resultText;
    delete saved.outputRole;
    delete saved.outputName;
  }
  return saved;
}

/** 默认团队：覆盖「规划 → 架构 → 实现 → 测试 → 评审」完整链路 */
function defaultAgents() {
  const base = (name, role, title, color, tagline, skills) => ({
    id: randomUUID(),
    name,
    role,
    title,
    color,
    tagline,
    skills,
    tools: toolsForRole(role),
    mcpServers: [],
    executionPolicy: 'inherit',
    mode: 'sim',
    providerId: DEFAULT_PROVIDER_ID,
    fallbackProviderIds: [],
    profileId: '',
    model: '',
    maxConcurrency: 1,
    workspacePolicy: defaultAgentWorkspacePolicy(),
    // 内置演示席位：服务启动后会用本机真实 CLI 顶替（见 server/team.mjs）
    builtin: true,
    seat: true,
    status: 'idle',
    activity: '',
    cli: { command: '', args: [], cwd: '' },
    createdAt: Date.now(),
    stats: { runs: 0, tokens: 0 },
  });
  return [
    base('Nova', 'planner', '规划师', '#a78bfa', '拆需求、定路线、做交付收口', ['需求拆解', '任务编排', '风险预判']),
    base('Forge', 'architect', '架构师', '#fbbf24', '定接口契约与技术方案', ['系统设计', '接口契约', '技术选型']),
    base('Kilo', 'coder', '实现工程师', '#38bdf8', '写代码、落文件、跑通主链路', ['前端实现', '服务端逻辑', '重构']),
    base('Probe', 'tester', '测试工程师', '#34d399', '用例设计、边界覆盖、回归验证', ['单元测试', '边界分析', '回归']),
    base('Lens', 'reviewer', '代码评审', '#f472b6', '挑毛病、评风险、卡质量门', ['代码评审', '安全审计', '性能']),
  ];
}

function emptyDb() {
  return {
    agents: defaultAgents(),
    providers: defaultProviders(),
    profiles: [],
    tasks: [],
    settings: {
      hookToken: randomUUID().replace(/-/g, '').slice(0, 24),
      // Hook 入口默认开启；路径令牌保留兼容，推荐改用 X-Hook-Token 请求头。
      hookTokenEnabled: true,
      hookTokenPathEnabled: true,
      defaultMode: 'auto',
      simSpeed: 1,
      maxConcurrency: 2,
      maxTaskConcurrency: 2,
      maxRepairRounds: 1,
      maxAutoReplans: 1,
      maxStepAttempts: 2,
      // 0 表示不限；平台只统计自己产出的文件，避免扫描用户整棵外部仓库。
      workspaceQuotaBytes: 0,
      workspaceTrashRetentionDays: 0,
      // 方案讨论：默认 5 位提案人（4 个执行席位 + 1 个工具池 CLI），决策后再实施。
      debateEnabled: true,
      debateParticipants: 5,
      debatePoolSeats: 1,
      debateConcurrency: 2,
      dynamicPlanEnabled: true,
      maxPlanSteps: 12,
      timeouts: defaultTimeouts(),
      // 成本确认门：0 表示关闭；非零时按同模式历史 token 区间判断是否需要人工确认。
      costGateTokens: 0,
      // 目录白名单：空数组表示未配置，保持零配置行为；非空时白名单外一律拒绝。
      workspaceRoots: [],
      fsBrowseRoots: [],
      automations: [],
      mcpServers: [],
      approvals: [],
      commandWhitelist: [],
      securityAudit: [],
    },
  };
}

/** 老数据没有席位概念：同一角色只保留第一个成员，其余自动归入工具池。 */
function normalizeSeats(agents) {
  const seated = new Set();
  for (const agent of agents) {
    if (agent.seat === undefined) agent.seat = !seated.has(agent.role);
    if (agent.seat && !seated.has(agent.role)) seated.add(agent.role);
    else agent.seat = false;
  }
}

function normalizeProviderIds(value, providers, primaryId = '') {
  if (!Array.isArray(value)) return [];
  const known = new Set((providers || []).map((provider) => provider.id));
  return [
    ...new Set(
      value
        .map((id) => String(id || '').trim())
        .filter((id) => id && id !== primaryId && known.has(id)),
    ),
  ];
}

function runGit(root, args, timeout = 15000) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(
      result.stderr ||
        result.error?.message ||
        (result.signal ? `git 被信号 ${result.signal} 终止` : ''),
    ).trim(),
  };
}

function createIsolatedWorkspace(source, taskId) {
  const check = runGit(source, ['rev-parse', '--is-inside-work-tree']);
  if (!check.ok || check.stdout !== 'true') {
    throw new Error('所选目录不是 Git 工作区，无法创建隔离工作树');
  }
  const root = path.join(WORKSPACE_DIR, 'worktrees', taskId);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const added = runGit(source, ['worktree', 'add', '--detach', root, 'HEAD']);
  if (added.ok) {
    const head = runGit(root, ['rev-parse', '--short', 'HEAD']);
    return {
      source,
      path: root,
      head: head.ok ? head.stdout : '',
      mode: 'worktree',
      createdAt: Date.now(),
      status: 'active',
    };
  }

  // 某些 Windows 文件系统无法正确保存 .git/worktrees 的 ACL。
  // 共享对象克隆仍能提供独立工作目录，且不会改动源仓库。
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* A failed worktree add may not have created the destination. */
  }
  const cloned = runGit(source, [
    'clone',
    '--shared',
    '--no-checkout',
    '--',
    source,
    root,
  ], 120000);
  if (!cloned.ok) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* A timed-out clone may still hold files briefly on Windows. */
    }
    throw new Error(
      `创建 Git 隔离工作区失败：${added.stderr || 'worktree add 失败'}；回退 clone 也失败：${cloned.stderr || 'git clone 返回非零状态'}`,
    );
  }
  const checkedOut = runGit(root, ['checkout', '--detach', 'HEAD'], 120000);
  if (!checkedOut.ok) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* The failed clone may still hold files briefly on Windows. */
    }
    throw new Error(`Git 隔离工作区已创建，但检出 HEAD 失败：${checkedOut.stderr}`);
  }
  const head = runGit(root, ['rev-parse', '--short', 'HEAD']);
  return {
    source,
    path: root,
    head: head.ok ? head.stdout : '',
    mode: 'clone',
    fallbackReason: added.stderr.slice(0, 300),
    createdAt: Date.now(),
    status: 'active',
  };
}

function removeWorktree(task) {
  if (!task?.worktree?.source || !task.worktree.path) return;
  if (task.worktree.mode !== 'clone') {
    runGit(task.worktree.source, ['worktree', 'remove', '--force', task.worktree.path]);
  }
  try {
    fs.rmSync(task.worktree.path, { recursive: true, force: true });
  } catch {
    /* Git may already have removed the directory. */
  }
}

function traceKindFor(type) {
  const value = String(type || '');
  if (value.startsWith('run.')) return 'run';
  if (value.startsWith('tool.') || value.startsWith('cli.')) return 'tool';
  if (value.startsWith('quality.')) return 'quality';
  if (value.startsWith('review.')) return 'review';
  if (value.startsWith('skill.')) return 'skill';
  if (value.startsWith('message.')) return 'message';
  if (value.startsWith('plan.')) return 'plan';
  if (value.startsWith('file.') || value.startsWith('fs.')) return 'file';
  if (value.startsWith('automation.')) return 'automation';
  if (value.startsWith('scheduler.')) return 'scheduler';
  return 'event';
}

function ensureTaskTrace(task, runId, spanId, at) {
  const traceId = String(runId || task.id);
  if (!task.trace || typeof task.trace !== 'object' || task.trace.traceId !== traceId) {
    task.trace = {
      version: 1,
      traceId,
      runId: runId || null,
      rootSpanId: spanId,
      startedAt: at,
      endedAt: null,
      updatedAt: at,
    };
  } else {
    task.trace.updatedAt = at;
  }
  return task.trace;
}

export class Store {
  constructor({ instanceId = '' } = {}) {
    this.instanceId =
      String(instanceId || process.env.AGENTFORGE_INSTANCE_ID || '').trim() || randomUUID();
    this.db = emptyDb();
    this._shards = new TaskShardStore(path.join(DATA_DIR, 'tasks'));
    this.listeners = new Set();
    this._saveTimer = null;
    this._lastSerialized = null;
    this._baseTaskHashes = new Map();
    this._storageConflicts = [];
    this._serialized = {
      agents: null,
      profiles: null,
      providers: null,
      tasks: new Map(),
      settings: null,
    };
    this._dirty = {
      all: true,
      agents: false,
      profiles: false,
      providers: false,
      tasks: new Set(),
      tasksAll: false,
      tasksRemoved: new Set(),
      settings: false,
    };
    this.persistenceStats = {
      saveCalls: 0,
      scheduledFlushes: 0,
      flushes: 0,
      writes: 0,
      taskSerializations: 0,
      fullSerializations: 0,
      conflicts: 0,
      leaseAcquires: 0,
      leaseRenewals: 0,
      taskShards: 0,
    };
    this._load();
    process.once('exit', () => this.flush());
  }

  _load() {
    try {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        // 旧格式把任务放在 db.json；首次加载时迁到 tasks/<id>.json 并备份原文件。
        const legacyTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
        const shardState = this._shards.migrate(legacyTasks, { backupFile: DB_FILE });
        this._lastSerialized = JSON.stringify(this._parseDiskDb(raw));
        const defaults = defaultProviders();
        const capabilitiesMigrated = raw.settings?.providerCapabilitiesMigrated === true;
        const providers = (Array.isArray(raw.providers) && raw.providers.length
          ? raw.providers
          : defaults
        ).map((provider) => {
          const normalized = normalizeProvider(
            provider,
            provider?.id === DEFAULT_PROVIDER_ID ? defaults[0] : {},
          );
          if (
            !capabilitiesMigrated &&
            normalized.id === DEFAULT_PROVIDER_ID &&
            normalized.builtin &&
            normalized.capabilities.length === 0
          ) {
            normalized.capabilities = [...defaults[0].capabilities];
          }
          return normalized;
        });
        if (!providers.some((provider) => provider.id === DEFAULT_PROVIDER_ID)) {
          providers.unshift(...defaults);
        }
        this.db = {
          agents: Array.isArray(raw.agents) && raw.agents.length ? raw.agents : defaultAgents(),
          providers,
          profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
          tasks: shardState.tasks,
          settings: {
            ...emptyDb().settings,
            ...(raw.settings || {}),
            providerCapabilitiesMigrated: true,
          },
        };
        this.db.settings.timeouts = resolveTimeouts({ settings: this.db.settings });
        for (const task of this.db.tasks) {
          this._baseTaskHashes.set(task.id, cryptoHash(JSON.stringify(task)));
        }
        if (!Array.isArray(this.db.settings.automations)) this.db.settings.automations = [];
        if (!Array.isArray(this.db.settings.mcpServers)) this.db.settings.mcpServers = [];
        if (!Array.isArray(this.db.settings.approvals)) this.db.settings.approvals = [];
        if (!Array.isArray(this.db.settings.commandWhitelist)) {
          this.db.settings.commandWhitelist = [];
        }
        if (!Array.isArray(this.db.settings.securityAudit)) this.db.settings.securityAudit = [];
        if (!Array.isArray(this.db.settings.workspaceRoots)) this.db.settings.workspaceRoots = [];
        if (!Array.isArray(this.db.settings.fsBrowseRoots)) this.db.settings.fsBrowseRoots = [];
        this.db.profiles = this.db.profiles
          .map((profile) =>
            normalizeAgentProfile(profile, {}, {
              providers: this.db.providers,
              normalizeTools,
              normalizeSkills,
            }),
          )
          .filter(
            (profile, index, list) =>
              list.findIndex((candidate) => candidate.id === profile.id) === index,
          );
        // 运行状态不跨进程保留
        normalizeSeats(this.db.agents);
        let recovered = !capabilitiesMigrated;
        for (const a of this.db.agents) {
          const providerId = String(a.providerId || DEFAULT_PROVIDER_ID);
          if (!this.db.providers.some((provider) => provider.id === providerId)) {
            a.providerId = DEFAULT_PROVIDER_ID;
            recovered = true;
          } else if (a.providerId !== providerId) {
            a.providerId = providerId;
            recovered = true;
          }
          const fallbackProviderIds = normalizeProviderIds(
            a.fallbackProviderIds,
            this.db.providers,
            a.providerId,
          );
          if (JSON.stringify(fallbackProviderIds) !== JSON.stringify(a.fallbackProviderIds || [])) {
            recovered = true;
          }
          a.fallbackProviderIds = fallbackProviderIds;
          a.status = 'idle';
          a.activity = '';
          const tools = normalizeTools(a.tools, a.role);
          if (JSON.stringify(tools) !== JSON.stringify(a.tools || [])) recovered = true;
          a.tools = tools;
          const executionPolicy = normalizeExecutionPolicy(a.executionPolicy);
          if (executionPolicy !== a.executionPolicy) recovered = true;
          a.executionPolicy = executionPolicy;
          const skills = normalizeSkills(a.skills);
          if (JSON.stringify(skills) !== JSON.stringify(a.skills || [])) recovered = true;
          a.skills = skills;
          const mcpServers = normalizeMcpServerIds(a.mcpServers, this.db.settings.mcpServers);
          if (JSON.stringify(mcpServers) !== JSON.stringify(a.mcpServers || [])) recovered = true;
          a.mcpServers = mcpServers;
          const profileId = normalizeAgentProfileId(a.profileId);
          if (profileId !== (a.profileId || '')) recovered = true;
          a.profileId = profileId;
          a.model = normalizeAgentModel(a.model);
          const maxConcurrency = normalizeAgentConcurrency(a.maxConcurrency);
          if (maxConcurrency !== a.maxConcurrency) recovered = true;
          a.maxConcurrency = maxConcurrency;
          const workspacePolicy = normalizeAgentWorkspacePolicy(a.workspacePolicy);
          if (JSON.stringify(workspacePolicy) !== JSON.stringify(a.workspacePolicy || {})) {
            recovered = true;
          }
          a.workspacePolicy = workspacePolicy;
          a.timeouts = normalizeTimeoutOverrides(a.timeouts);
        }
        for (const t of this.db.tasks) {
          const priority = normalizeTaskPriority(t.priority);
          if (t.priority !== priority) {
            t.priority = priority;
            recovered = true;
          }
          if (!t.tenantId) {
            t.tenantId = 'default';
            recovered = true;
          }
          if (!t.ownerId) {
            t.ownerId = 'owner';
            recovered = true;
          }
          if (!Array.isArray(t.usageLedger)) t.usageLedger = [];
          t.contextState = {
            contextWindow: null,
            autoCompactAt: null,
            compaction: null,
            compactions: [],
            autoCompaction: null,
            ...(t.contextState || {}),
          };
          const lease = this.taskLease(t.id, { renew: false });
          if (
            (t.status === 'running' || t.status === 'stopping' || t.status === 'queued') &&
            (!lease || lease.instanceId === this.instanceId)
          ) {
            const previousStatus = t.status;
            const recoveredAt = Date.now();
            const recoveryReason = lease
              ? '服务重启时本实例运行中的任务已中断，可从任务详情重新运行'
              : '运行中任务没有有效实例租约，已按中断恢复';
            t.status = 'stopped';
            t.endedAt ||= recoveredAt;
            t.queuePosition = null;
            t.waitingReason ||= recoveryReason;
            t.recovery = {
              previousStatus,
              status: 'interrupted',
              at: recoveredAt,
              reason: recoveryReason,
            };
            if (!Array.isArray(t.events)) t.events = [];
            t.events.push({
              id: randomUUID(),
              at: recoveredAt,
              runId: t.runId || null,
              traceId: t.runId || t.id,
              spanId: randomUUID(),
              parentSpanId: null,
              kind: 'run',
              type: 'run.recovered',
              agentId: '',
              stepId: '',
              data: {
                previousStatus,
                status: 'stopped',
                reason: recoveryReason,
              },
            });
            recovered = true;
          }
          for (const s of t.plan || []) {
            if (t.status !== 'stopped' && ['running', 'retrying', 'queued'].includes(s.status)) {
              continue;
            }
            if (s.status === 'running' || s.status === 'retrying' || s.status === 'queued') {
              s.status = 'stopped';
              s.note ||= '服务重启时中断';
              recovered = true;
            }
          }
          if (t.debate && ['proposing', 'critiquing', 'deciding'].includes(t.debate.status)) {
            t.debate.status = 'stopped';
            for (const p of t.debate.proposals || []) {
              if (p.status === 'running') p.status = 'stopped';
            }
            recovered = true;
          }
          // 兼容旧版本：0 票裁决曾被错误地显示为「已采纳」。
          // 旧数据没有 degraded 字段，启动时补上，避免历史任务继续误导。
          if (t.debate?.decision && !t.debate.decision.degraded && Number(t.debate.decision.votes || 0) === 0) {
            t.debate.decision.degraded = true;
            t.debate.decision.confidence = 'none';
            t.debate.decision.reason ||=
              '交叉质询没有产生有效评分，按提案顺序临时采用，需人工复核。';
            if (t.debate.status === 'decided') t.debate.status = 'fallback';
            recovered = true;
          }
          if (ensurePlanVersionState(t)) recovered = true;
          for (const m of t.messages || []) {
            if (!m.done) {
              m.done = true;
              recovered = true;
            }
            if (ensureMessageEnvelope(t, m)) recovered = true;
          }
          if (!Array.isArray(t.events)) t.events = [];
          if (!Array.isArray(t.fileChanges)) t.fileChanges = [];
          if (!Array.isArray(t.skillActivations)) {
            t.skillActivations = [];
            recovered = true;
          }
          if (t.events.length > MAX_TASK_EVENTS) t.events.splice(0, t.events.length - MAX_TASK_EVENTS);
          if (t.fileChanges.length > MAX_FILE_CHANGES) {
            t.fileChanges.splice(0, t.fileChanges.length - MAX_FILE_CHANGES);
          }
          if (t.skillActivations.length > MAX_SKILL_ACTIVATIONS) {
            t.skillActivations.splice(0, t.skillActivations.length - MAX_SKILL_ACTIVATIONS);
          }
        }
        if (recovered) this.flush();
      } else {
        this.db.tasks = this._shards.loadAll();
        this.save();
      }
    } catch (err) {
      console.error('[store] 读取数据失败，使用默认数据:', err.message);
      this.db = emptyDb();
    }
  }

  _markDirty(dirty) {
    if (!dirty || dirty === true || dirty.all === true) {
      this._dirty.all = true;
      return;
    }
    let touched = false;
    if (dirty.agents) {
      this._dirty.agents = true;
      touched = true;
    }
    if (dirty.profiles) {
      this._dirty.profiles = true;
      touched = true;
    }
    if (dirty.providers) {
      this._dirty.providers = true;
      touched = true;
    }
    if (dirty.settings) {
      this._dirty.settings = true;
      touched = true;
    }
    if (Object.prototype.hasOwnProperty.call(dirty, 'tasks')) {
      touched = true;
      if (dirty.tasks === true) {
        this._dirty.tasksAll = true;
      } else {
        for (const id of dirty.tasks || []) {
          if (id) this._dirty.tasks.add(String(id));
        }
      }
      for (const id of dirty.tasksRemoved || []) {
        if (id) this._dirty.tasksRemoved.add(String(id));
      }
    }
    if (!touched) this._dirty.all = true;
  }

  _resetDirty() {
    this._dirty = {
      all: false,
      agents: false,
      profiles: false,
      providers: false,
      tasks: new Set(),
      tasksAll: false,
      tasksRemoved: new Set(),
      settings: false,
    };
  }

  _serializeTask(task) {
    this.persistenceStats.taskSerializations += 1;
    return JSON.stringify(task);
  }

  _parseDiskDb(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      agents: Array.isArray(raw.agents) ? raw.agents : [],
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
      providers: Array.isArray(raw.providers) ? raw.providers : [],
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
    };
  }

  _buildMergedDb() {
    const disk = this._parseDiskDb(readJsonFile(DB_FILE, null));
    const dirtyAll = this._dirty.all || this._dirty.tasksAll;
    const base = disk
      ? {
          agents: dirtyAll || this._dirty.agents ? this.db.agents : disk.agents,
          profiles: dirtyAll || this._dirty.profiles ? this.db.profiles : disk.profiles,
          providers: dirtyAll || this._dirty.providers ? this.db.providers : disk.providers,
          settings: dirtyAll || this._dirty.settings ? this.db.settings : disk.settings,
        }
      : {
          agents: this.db.agents,
          profiles: this.db.profiles,
          providers: this.db.providers,
          settings: this.db.settings,
        };

    // 任务以 tasks/<id>.json 为准，db.json 只保留其余元数据。
    const localTasks = new Map(this.db.tasks.map((task) => [task.id, task]));
    const mergedTasks = [...this.db.tasks];
    for (const id of this._dirty.tasksRemoved) {
      const index = mergedTasks.findIndex((task) => task.id === id);
      if (index >= 0) mergedTasks.splice(index, 1);
    }
    const known = new Set(mergedTasks.map((task) => task.id));
    for (const id of this._dirty.tasks) {
      if (!known.has(id)) continue;
      const diskTask = this._shards.readShard(id);
      if (!diskTask) continue;
      const local = localTasks.get(id);
      const baseHash = this._baseTaskHashes.get(id);
      const diskHash = cryptoHash(JSON.stringify(diskTask));
      const localHash = cryptoHash(JSON.stringify(local));
      if (baseHash && diskHash !== baseHash && localHash === baseHash) {
        const index = mergedTasks.findIndex((task) => task.id === id);
        if (index >= 0) mergedTasks[index] = diskTask;
        continue;
      }
      if (baseHash && diskHash !== baseHash && localHash !== baseHash && localHash !== diskHash) {
        this.persistenceStats.conflicts += 1;
        this._storageConflicts.push({ taskId: id, at: Date.now(), diskHash, baseHash });
        this._storageConflicts = this._storageConflicts.slice(-50);
        const error = new Error(`任务 ${id} 已被其他实例修改，拒绝静默覆盖`);
        error.code = 'STORE_CONFLICT';
        error.taskId = id;
        throw error;
      }
    }
    // 其他实例新建的任务：索引里有、本进程还没加载过。
    const index = this._shards.readIndex();
    for (const id of index?.ids || []) {
      if (known.has(id) || this._dirty.tasksRemoved.has(id)) continue;
      const task = this._shards.readShard(id);
      if (task?.id) {
        mergedTasks.push(task);
        known.add(id);
      }
    }
    return { ...base, tasks: mergedTasks };
  }
  _readLeasesLocked() {
    const leases = pruneExpiredLeases(
      readJsonFile(LEASE_FILE, { version: 1, tasks: {}, automations: {} }),
    );
    leases.version = 1;
    return leases;
  }

  _writeLeasesLocked(leases) {
    writeJsonAtomic(LEASE_FILE, pruneExpiredLeases(leases));
  }

  _leaseSnapshotUnlocked() {
    const leases = this._readLeasesLocked();
    return {
      tasks: Object.values(leases.tasks).map((lease) => ({
        taskId: lease.taskId,
        instanceId: lease.instanceId,
        pid: lease.pid,
        expiresAt: lease.expiresAt,
        owned: lease.instanceId === this.instanceId,
      })),
      automations: Object.values(leases.automations).map((claim) => ({
        automationId: claim.automationId,
        instanceId: claim.instanceId,
        pid: claim.pid,
        runKey: claim.runKey || '',
        expiresAt: claim.expiresAt,
        owned: claim.instanceId === this.instanceId,
      })),
    };
  }

  _withLeaseLock(fn) {
    const lockToken = acquireFileLockSync();
    try {
      const leases = this._readLeasesLocked();
      return fn(leases);
    } finally {
      releaseFileLockSync(lockToken);
    }
  }

  taskLease(taskId, { renew = true, ttlMs = DEFAULT_TASK_LEASE_MS } = {}) {
    const id = String(taskId || '');
    if (!id) return null;
    return this._withLeaseLock((leases) => {
      const now = Date.now();
      const existing = leases.tasks[id];
      if (taskLeaseIsLive(existing, now)) {
        if (renew && existing.instanceId === this.instanceId) {
          existing.expiresAt = now + Math.max(1000, Number(ttlMs) || DEFAULT_TASK_LEASE_MS);
          existing.updatedAt = now;
          this._writeLeasesLocked(leases);
          this.persistenceStats.leaseRenewals += 1;
        }
        return { ...existing, owned: existing.instanceId === this.instanceId };
      }
      if (!renew) return null;
      const lease = {
        taskId: id,
        instanceId: this.instanceId,
        pid: process.pid,
        acquiredAt: now,
        updatedAt: now,
        expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TASK_LEASE_MS),
      };
      leases.tasks[id] = lease;
      this._writeLeasesLocked(leases);
      this.persistenceStats.leaseAcquires += 1;
      return { ...lease, owned: true };
    });
  }

  acquireTaskLease(taskId, options = {}) {
    const lease = this.taskLease(taskId, { ...options, renew: true });
    return lease?.owned ? lease : null;
  }

  renewTaskLease(taskId, options = {}) {
    const existing = this.taskLease(taskId, { ...options, renew: false });
    if (!existing || existing.instanceId !== this.instanceId) return null;
    return this.taskLease(taskId, { ...options, renew: true });
  }

  releaseTaskLease(taskId) {
    const id = String(taskId || '');
    if (!id) return false;
    return this._withLeaseLock((leases) => {
      const lease = leases.tasks[id];
      if (!lease || lease.instanceId !== this.instanceId) return false;
      delete leases.tasks[id];
      this._writeLeasesLocked(leases);
      return true;
    });
  }

  /**
   * Cross-process Provider slots. In-process counting only protects one server
   * instance; the authoritative count lives in `.leases.json`.
   */
  acquireProviderSlots(taskId, providerIds, { limitFor = () => 1, ttlMs = DEFAULT_TASK_LEASE_MS } = {}) {
    const ids = [...new Set((providerIds || []).map(String).filter(Boolean))];
    if (!ids.length) return { ok: true, acquired: [], blocked: null };
    const id = String(taskId || '');
    if (!id) return { ok: false, acquired: [], blocked: { reason: '缺少 taskId' } };
    return this._withLeaseLock((leases) => {
      leases.providers ||= {};
      const now = Date.now();
      const acquired = [];
      for (const providerId of ids) {
        const all = leases.providers[providerId] || [];
        const mine = all.find((slot) => slot.taskId === id && slot.instanceId === this.instanceId);
        const others = all.filter(
          (slot) => !(slot.taskId === id && slot.instanceId === this.instanceId),
        );
        const limit = Math.max(1, Number(limitFor(providerId)) || 1);
        // 同一任务重复调度只续期，不重复占槽。
        if (mine) {
          mine.expiresAt = now + Math.max(1000, Number(ttlMs) || DEFAULT_TASK_LEASE_MS);
          mine.updatedAt = now;
          acquired.push(providerId);
          continue;
        }
        if (others.length >= limit) {
          if (acquired.length) {
            for (const got of acquired) {
              leases.providers[got] = (leases.providers[got] || []).filter(
                (slot) => !(slot.taskId === id && slot.instanceId === this.instanceId),
              );
              if (!leases.providers[got].length) delete leases.providers[got];
            }
            this._writeLeasesLocked(leases);
          }
          return {
            ok: false,
            acquired: [],
            blocked: { providerId, used: others.length, limit },
          };
        }
        leases.providers[providerId] = [
          ...others,
          {
            taskId: id,
            instanceId: this.instanceId,
            pid: process.pid,
            acquiredAt: now,
            updatedAt: now,
            expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TASK_LEASE_MS),
          },
        ];
        acquired.push(providerId);
      }
      this._writeLeasesLocked(leases);
      return { ok: true, acquired, blocked: null };
    });
  }

  releaseProviderSlots(taskId) {
    const id = String(taskId || '');
    if (!id) return 0;
    return this._withLeaseLock((leases) => {
      leases.providers ||= {};
      let released = 0;
      for (const [providerId, slots] of Object.entries(leases.providers)) {
        const kept = (Array.isArray(slots) ? slots : []).filter(
          (slot) => !(slot.taskId === id && slot.instanceId === this.instanceId),
        );
        released += (slots.length || 0) - kept.length;
        if (kept.length) leases.providers[providerId] = kept;
        else delete leases.providers[providerId];
      }
      if (released) this._writeLeasesLocked(leases);
      return released;
    });
  }

  providerSlotSnapshot() {
    return this._withLeaseLock((leases) => {
      const out = {};
      for (const [providerId, slots] of Object.entries(leases.providers || {})) {
        out[providerId] = slots.map((slot) => ({
          taskId: slot.taskId,
          instanceId: slot.instanceId,
          pid: slot.pid,
          expiresAt: slot.expiresAt,
          owned: slot.instanceId === this.instanceId,
        }));
      }
      return out;
    });
  }

  releaseAllLeases() {
    return this._withLeaseLock((leases) => {
      let released = 0;
      for (const [id, lease] of Object.entries(leases.tasks)) {
        if (lease.instanceId !== this.instanceId) continue;
        delete leases.tasks[id];
        released += 1;
      }
      for (const [id, claim] of Object.entries(leases.automations)) {
        if (claim.instanceId !== this.instanceId) continue;
        delete leases.automations[id];
        released += 1;
      }
      if (released) this._writeLeasesLocked(leases);
      return released;
    });
  }

  claimAutomation(id, { ttlMs = DEFAULT_AUTOMATION_CLAIM_MS, runKey = '', renew = false } = {}) {
    const automationId = String(id || '');
    if (!automationId) return null;
    return this._withLeaseLock((leases) => {
      const now = Date.now();
      const existing = leases.automations[automationId];
      if (taskLeaseIsLive(existing, now)) {
        if (existing.instanceId !== this.instanceId || !renew) {
          return existing.instanceId === this.instanceId
            ? { ...existing, owned: true }
            : null;
        }
        existing.runKey = String(runKey || existing.runKey || '');
        existing.updatedAt = now;
        existing.expiresAt = now + Math.max(1000, Number(ttlMs) || DEFAULT_AUTOMATION_CLAIM_MS);
        this._writeLeasesLocked(leases);
        return { ...existing, owned: true };
      }
      const claim = {
        automationId,
        instanceId: this.instanceId,
        pid: process.pid,
        runKey: String(runKey || ''),
        acquiredAt: now,
        updatedAt: now,
        expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_AUTOMATION_CLAIM_MS),
      };
      leases.automations[automationId] = claim;
      this._writeLeasesLocked(leases);
      return { ...claim, owned: true };
    });
  }

  /** 运行期续约：只有当前持有者能延长，过期后其他实例可重新 claim。 */
  renewAutomationClaim(id, { ttlMs = DEFAULT_AUTOMATION_CLAIM_MS, runKey = '' } = {}) {
    if (!this.automationClaimIsOwned(id)) return null;
    return this.claimAutomation(id, { ttlMs, runKey, renew: true });
  }

  automationClaimIsOwned(id) {
    const automationId = String(id || '');
    if (!automationId) return false;
    return this._withLeaseLock((leases) => {
      const claim = leases.automations[automationId];
      return !!claim && claim.instanceId === this.instanceId && taskLeaseIsLive(claim);
    });
  }

  releaseAutomationClaim(id) {
    const automationId = String(id || '');
    if (!automationId) return false;
    return this._withLeaseLock((leases) => {
      const claim = leases.automations[automationId];
      if (!claim || claim.instanceId !== this.instanceId) return false;
      delete leases.automations[automationId];
      this._writeLeasesLocked(leases);
      return true;
    });
  }

  leaseSnapshot() {
    const lockToken = acquireFileLockSync();
    try {
      return this._leaseSnapshotUnlocked();
    } finally {
      releaseFileLockSync(lockToken);
    }
  }

  storageSnapshot() {
    const lockToken = acquireFileLockSync();
    let leases;
    try {
      leases = this._leaseSnapshotUnlocked();
    } finally {
      releaseFileLockSync(lockToken);
    }
    return {
      instanceId: this.instanceId,
      persistence: { ...this.persistenceStats },
      conflicts: this._storageConflicts.slice(-10).map((conflict) => ({ ...conflict })),
      leases,
    };
  }

  _buildSerializedDb() {
    if (this._dirty.all) {
      this._serialized.agents = JSON.stringify(this.db.agents);
      this._serialized.profiles = JSON.stringify(this.db.profiles);
      this._serialized.providers = JSON.stringify(this.db.providers);
      this._serialized.settings = JSON.stringify(this.db.settings);
      this._serialized.tasks = new Map();
      for (const task of this.db.tasks) {
        this._serialized.tasks.set(task.id, this._serializeTask(task));
      }
      this.persistenceStats.fullSerializations += 1;
    } else {
      if (this._dirty.agents || this._serialized.agents === null) {
        this._serialized.agents = JSON.stringify(this.db.agents);
      }
      if (this._dirty.profiles || this._serialized.profiles === null) {
        this._serialized.profiles = JSON.stringify(this.db.profiles);
      }
      if (this._dirty.providers || this._serialized.providers === null) {
        this._serialized.providers = JSON.stringify(this.db.providers);
      }
      if (this._dirty.settings || this._serialized.settings === null) {
        this._serialized.settings = JSON.stringify(this.db.settings);
      }
      if (this._dirty.tasksAll) {
        this._serialized.tasks.clear();
        for (const task of this.db.tasks) {
          this._serialized.tasks.set(task.id, this._serializeTask(task));
        }
      } else {
        for (const id of this._dirty.tasks) {
          const task = this.db.tasks.find((item) => item.id === id);
          if (task) this._serialized.tasks.set(id, this._serializeTask(task));
          else this._serialized.tasks.delete(id);
        }
      }
    }

    const liveTaskIds = new Set(this.db.tasks.map((task) => task.id));
    for (const id of this._serialized.tasks.keys()) {
      if (!liveTaskIds.has(id)) this._serialized.tasks.delete(id);
    }
    const taskFragments = this.db.tasks.map((task) => {
      let fragment = this._serialized.tasks.get(task.id);
      if (fragment === undefined) {
        fragment = this._serializeTask(task);
        this._serialized.tasks.set(task.id, fragment);
      }
      return fragment;
    });
    return `{"agents":${this._serialized.agents},"profiles":${this._serialized.profiles},"providers":${this._serialized.providers},"tasks":[${taskFragments.join(',')}],"settings":${this._serialized.settings}}`;
  }

  save(dirty = null) {
    this.persistenceStats.saveCalls += 1;
    // 无参 save() 是旧调用的保守契约：无法确认改动范围时，下一次 flush 必须全量序列化。
    this._markDirty(dirty);
    // dirty 窗口只启动一次，窗口内的连续追加共享同一次落盘。
    if (this._saveTimer) return;
    this.persistenceStats.scheduledFlushes += 1;
    this._saveTimer = setTimeout(() => this.flush(), SAVE_WINDOW_MS);
  }

  /** 在跨进程锁内合并磁盘状态，再原子替换 db.json。 */
  flush({ throwOnConflict = false } = {}) {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this.persistenceStats.flushes += 1;
    let lockToken = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      lockToken = acquireFileLockSync();
      this._buildSerializedDb();
      const merged = this._buildMergedDb();
      // 任务先落分片：单个任务原子写，崩溃只会丢这一个任务的最后一次变更。
      const localTasks = new Map(this.db.tasks.map((task) => [task.id, task]));
      for (const task of merged.tasks) {
        const local = localTasks.get(task.id);
        const dirty = this._dirty.tasksAll || this._dirty.all || this._dirty.tasks.has(task.id);
        if (dirty || !local) this._shards.writeShard(task);
      }
      for (const id of this._dirty.tasksRemoved) this._shards.removeShard(id);
      this._shards.writeIndex(merged.tasks.map((task) => task.id));
      this.persistenceStats.taskShards = (this.persistenceStats.taskShards || 0) + 1;
      // db.json 只保留元数据，tasks 保持空数组兼容旧的五键形状。
      const json = `{"agents":${JSON.stringify(merged.agents)},"profiles":${JSON.stringify(merged.profiles)},"providers":${JSON.stringify(merged.providers)},"tasks":[],"settings":${JSON.stringify(merged.settings)}}`;
      if (json === this._lastSerialized) {
        this.db.agents = merged.agents;
        this.db.profiles = merged.profiles;
        this.db.providers = merged.providers;
        this.db.settings = merged.settings;
        this.db.tasks = merged.tasks;
        this._lastSerialized = json;
        this._resetDirty();
        return;
      }
      writeTextAtomic(DB_FILE, json);
      this.db.agents = merged.agents;
      this.db.profiles = merged.profiles;
      this.db.providers = merged.providers;
      this.db.settings = merged.settings;
      this.db.tasks = merged.tasks;
      this._baseTaskHashes.clear();
      for (const task of merged.tasks) {
        this._baseTaskHashes.set(task.id, cryptoHash(JSON.stringify(task)));
      }
      this._lastSerialized = json;
      this.persistenceStats.writes += 1;
      this._resetDirty();
    } catch (err) {
      if (err?.code === 'STORE_CONFLICT') this.broadcast({
        type: 'storage.conflict',
        conflict: this._storageConflicts[this._storageConflicts.length - 1] || null,
      });
      console.error('[store] 持久化失败:', err.message);
      if (throwOnConflict) throw err;
    } finally {
      if (lockToken) releaseFileLockSync(lockToken);
    }
  }

  /* ---------- 事件总线 ---------- */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* 单个订阅者异常不影响其他 */
      }
    }
  }

  /* ---------- agents ---------- */
  get providers() {
    return this.db.providers;
  }

  getProvider(id) {
    return this.db.providers.find((provider) => provider.id === id);
  }

  providerForAgent(agent) {
    return resolveProvider(agent, this.db.providers);
  }

  addProvider(patch = {}) {
    const provider = normalizeProvider(patch);
    if (this.db.providers.some((item) => item.id === provider.id)) {
      throw new Error(`Provider ID 已存在：${provider.id}`);
    }
    this.db.providers.push(provider);
    this.save({ providers: true });
    this.broadcast({ type: 'providers.changed', providers: this.db.providers.map(redactProvider) });
    return provider;
  }

  updateProvider(id, patch = {}) {
    const provider = this.getProvider(id);
    if (!provider) return null;
    const next = normalizeProvider(patch, provider);
    next.id = provider.id;
    next.builtin = provider.builtin === true;
    Object.assign(provider, next);
    this.save({ providers: true });
    this.broadcast({ type: 'providers.changed', providers: this.db.providers.map(redactProvider) });
    return provider;
  }

  copyProvider(id, patch = {}) {
    const source = this.getProvider(id);
    if (!source) return null;
    const requestedId = String(patch.id || '').trim();
    const requestedName = String(patch.name || '').trim();
    let copyId = requestedId;
    if (!copyId) {
      const base = `${source.id}-copy`;
      copyId = base;
      for (let index = 2; this.getProvider(copyId); index += 1) {
        copyId = `${base}-${index}`;
      }
    }
    return this.addProvider({
      ...normalizeProvider(source),
      ...patch,
      id: copyId,
      name: requestedName || `${source.name} 副本`,
      builtin: false,
      createdAt: Date.now(),
    });
  }

  removeProvider(id) {
    if (id === DEFAULT_PROVIDER_ID) return false;
    const index = this.db.providers.findIndex((provider) => provider.id === id);
    if (index < 0) return false;
    this.db.providers.splice(index, 1);
    for (const agent of this.db.agents) {
      if (agent.providerId === id) agent.providerId = DEFAULT_PROVIDER_ID;
      agent.fallbackProviderIds = (agent.fallbackProviderIds || []).filter(
        (providerId) => providerId !== id && providerId !== agent.providerId,
      );
    }
    for (const profile of this.profiles) {
      if (profile.providerId === id) profile.providerId = DEFAULT_PROVIDER_ID;
      profile.fallbackProviderIds = (profile.fallbackProviderIds || []).filter(
        (providerId) => providerId !== id && providerId !== profile.providerId,
      );
    }
    this.save({ providers: true, agents: true, profiles: true });
    this.broadcast({ type: 'providers.changed', providers: this.db.providers.map(redactProvider) });
    this.broadcast({ type: 'profiles.changed', profiles: this.profiles });
    this.broadcast({ type: 'agents.changed' });
    return true;
  }

  get agents() {
    return this.db.agents;
  }

  get profiles() {
    if (!Array.isArray(this.db.profiles)) this.db.profiles = [];
    return this.db.profiles;
  }

  getProfile(id) {
    return this.profiles.find((profile) => profile.id === id) || null;
  }

  profileOptions() {
    return {
      providers: this.db.providers,
      normalizeTools,
      normalizeSkills,
    };
  }

  addProfile(input = {}) {
    const profile = normalizeAgentProfile(input, {}, this.profileOptions());
    if (this.getProfile(profile.id)) throw new Error(`Profile ID 已存在：${profile.id}`);
    this.profiles.push(profile);
    this.save({ profiles: true });
    this.broadcast({ type: 'profiles.changed', profiles: this.profiles });
    return profile;
  }

  updateProfile(id, patch = {}) {
    const profile = this.getProfile(id);
    if (!profile) return null;
    const changedFields = new Set(Object.keys(patch || {}));
    const next = normalizeAgentProfile(
      { ...patch, id: profile.id },
      profile,
      this.profileOptions(),
    );
    next.updatedAt = Date.now();
    Object.assign(profile, next);
    const linked = profileToAgentPatch(profile, this.profileOptions());
    const linkedFields = [
      'name',
      'title',
      'role',
      'tagline',
      'skills',
      'tools',
      'mcpServers',
      'providerId',
      'model',
      'fallbackProviderIds',
      'maxConcurrency',
      'workspacePolicy',
      'executionPolicy',
      'timeouts',
    ].filter((field) => changedFields.has(field));
    for (const agent of this.db.agents) {
      if (agent.profileId !== id) continue;
      for (const field of linkedFields) agent[field] = linked[field];
      if (linkedFields.includes('tools') || linkedFields.includes('role')) {
        agent.tools = normalizeTools(agent.tools, agent.role);
      }
      if (linkedFields.includes('mcpServers')) {
        agent.mcpServers = normalizeMcpServerIds(agent.mcpServers, this.db.settings.mcpServers);
      }
    }
    this.save({ profiles: true, agents: true });
    this.broadcast({ type: 'profiles.changed', profiles: this.profiles });
    this.broadcast({ type: 'agents.changed' });
    return profile;
  }

  removeProfile(id) {
    const index = this.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) return false;
    this.profiles.splice(index, 1);
    for (const agent of this.db.agents) {
      if (agent.profileId === id) agent.profileId = '';
    }
    this.save({ profiles: true, agents: true });
    this.broadcast({ type: 'profiles.changed', profiles: this.profiles });
    this.broadcast({ type: 'agents.changed' });
    return true;
  }

  exportProfile(id) {
    const profile = this.getProfile(id);
    return profile ? normalizeProfileImport(profile, this.profileOptions()) : null;
  }

  importProfile(input = {}) {
    const profile = normalizeProfileImport(input, this.profileOptions());
    if (this.getProfile(profile.id)) {
      throw new Error(`Profile ID 已存在：${profile.id}`);
    }
    this.profiles.push(profile);
    this.save({ profiles: true });
    this.broadcast({ type: 'profiles.changed', profiles: this.profiles });
    return profile;
  }

  agentProfile(agent) {
    return agent ? agentToProfile(agent, this.profileOptions()) : null;
  }

  get mcpServers() {
    if (!Array.isArray(this.db.settings.mcpServers)) this.db.settings.mcpServers = [];
    return this.db.settings.mcpServers;
  }

  getMcpServer(id) {
    return this.mcpServers.find((server) => server.id === id) || null;
  }

  addMcpServer(input = {}) {
    if (this.mcpServers.length >= MAX_MCP_SERVERS) {
      throw new Error(`MCP server 最多 ${MAX_MCP_SERVERS} 个`);
    }
    const server = normalizeMcpServer(input);
    if (this.getMcpServer(server.id)) throw new Error(`MCP server ID 已存在：${server.id}`);
    this.mcpServers.push(server);
    this.save({ settings: true });
    this.broadcast({ type: 'mcp.changed' });
    return server;
  }

  updateMcpServer(id, patch = {}) {
    const server = this.getMcpServer(id);
    if (!server) return null;
    const next = normalizeMcpServer({ ...patch, id: server.id }, server);
    Object.assign(server, next);
    this.save({ settings: true });
    this.broadcast({ type: 'mcp.changed' });
    return server;
  }

  removeMcpServer(id) {
    const index = this.mcpServers.findIndex((server) => server.id === id);
    if (index < 0) return false;
    this.mcpServers.splice(index, 1);
    for (const agent of this.db.agents) {
      agent.mcpServers = (agent.mcpServers || []).filter((serverId) => serverId !== id);
    }
    for (const profile of this.profiles) {
      profile.mcpServers = (profile.mcpServers || []).filter((serverId) => serverId !== id);
    }
    this.save({ settings: true, agents: true, profiles: true });
    this.broadcast({ type: 'mcp.changed' });
    this.broadcast({ type: 'profiles.changed', profiles: this.profiles });
    this.broadcast({ type: 'agents.changed' });
    return true;
  }

  get commandWhitelist() {
    if (!Array.isArray(this.db.settings.commandWhitelist)) {
      this.db.settings.commandWhitelist = [];
    }
    return this.db.settings.commandWhitelist;
  }

  setCommandWhitelist(entries = []) {
    this.db.settings.commandWhitelist = Array.isArray(entries) ? entries : [];
    this.save({ settings: true });
    this.broadcast({ type: 'commands.changed' });
    return this.commandWhitelist;
  }

  getAgent(id) {
    return this.db.agents.find((a) => a.id === id);
  }

  findAgentByRole(role) {
    return this.db.agents.find((a) => a.role === role && a.seat !== false);
  }

  findAgentByNameOrRole(key) {
    const needle = String(key || '').toLowerCase();
    return this.db.agents.find(
      (a) => a.name.toLowerCase() === needle || a.role.toLowerCase() === needle || a.title === key,
    );
  }

  addAgent(patch) {
    const role = patch.role || 'coder';
    const requestedId = String(patch.id || '').trim();
    if (requestedId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(requestedId)) {
      throw new Error('Agent ID 只能包含字母、数字、下划线和连字符，且必须以字母或数字开头');
    }
    if (requestedId && this.getAgent(requestedId)) {
      throw new Error(`Agent ID 已存在：${requestedId}`);
    }
    const requestedProfileId = normalizeAgentProfileId(patch.profileId);
    const requestedProfile = requestedProfileId ? this.getProfile(requestedProfileId) : null;
    const effectivePatch = requestedProfile
      ? { ...profileToAgentPatch(requestedProfile, this.profileOptions()), ...patch }
      : patch;
    const effectiveRole = effectivePatch.role || role;
    const hasSeat = this.db.agents.some((a) => a.role === effectiveRole && a.seat !== false);
    const agent = {
      id: requestedId || randomUUID(),
      name: effectivePatch.name || 'Agent',
      role: effectiveRole,
      title: effectivePatch.title || '自定义智能体',
      color: effectivePatch.color || '#818cf8',
      tagline: effectivePatch.tagline || '',
      skills: normalizeSkills(effectivePatch.skills),
      tools: normalizeTools(effectivePatch.tools, effectiveRole),
      mcpServers: normalizeMcpServerIds(
        effectivePatch.mcpServers,
        this.db.settings.mcpServers,
      ),
      executionPolicy: normalizeExecutionPolicy(effectivePatch.executionPolicy),
      mode: effectivePatch.mode === 'cli' ? 'cli' : 'sim',
      providerId: this.getProvider(String(effectivePatch.providerId || DEFAULT_PROVIDER_ID))
        ? String(effectivePatch.providerId || DEFAULT_PROVIDER_ID)
        : DEFAULT_PROVIDER_ID,
      fallbackProviderIds: normalizeProviderIds(
        effectivePatch.fallbackProviderIds,
        this.db.providers,
        this.getProvider(String(effectivePatch.providerId || DEFAULT_PROVIDER_ID))
          ? String(effectivePatch.providerId || DEFAULT_PROVIDER_ID)
          : DEFAULT_PROVIDER_ID,
      ),
      profileId: requestedProfileId,
      model: normalizeAgentModel(effectivePatch.model),
      maxConcurrency: normalizeAgentConcurrency(effectivePatch.maxConcurrency),
      workspacePolicy: normalizeAgentWorkspacePolicy(effectivePatch.workspacePolicy),
      timeouts: normalizeTimeoutOverrides(effectivePatch.timeouts),
      builtin: false,
      health: patch.health || null,
      // 同一角色默认只有一个主执行席位，额外接入的 CLI 进入工具池。
      seat: patch.seat === true ? true : !hasSeat,
      status: 'idle',
      activity: '',
      cli: {
        command: effectivePatch.cli?.command || '',
        args: Array.isArray(effectivePatch.cli?.args) ? effectivePatch.cli.args : [],
        cwd: effectivePatch.cli?.cwd || '',
      },
      createdAt: Date.now(),
      stats: { runs: 0, tokens: 0 },
    };
    if (agent.seat) this.demoteRolePeers(effectiveRole, agent.id);
    this.db.agents.push(agent);
    this.save({ agents: true });
    this.broadcast({ type: 'agents.changed' });
    return agent;
  }

  demoteRolePeers(role, keepId) {
    for (const a of this.db.agents) {
      if (a.role === role && a.id !== keepId) a.seat = false;
    }
  }

  updateAgent(id, patch) {
    const agent = this.getAgent(id);
    if (!agent) return null;
    const prevRole = agent.role;
    const prevSeat = agent.seat;
    const prevCli = { ...(agent.cli || {}) };
    if (patch.profileId !== undefined) {
      const profileId = normalizeAgentProfileId(patch.profileId);
      const profile = profileId ? this.getProfile(profileId) : null;
      if (profile) {
        const linked = profileToAgentPatch(profile, this.profileOptions());
        const explicit = { ...patch };
        patch = { ...linked, ...explicit, profileId };
      }
    }
    const hasExplicitTools = Array.isArray(patch.tools);
    Object.assign(agent, patch, { id: agent.id });
    if (patch.providerId !== undefined) {
      agent.providerId = this.getProvider(String(patch.providerId))
        ? String(patch.providerId)
        : DEFAULT_PROVIDER_ID;
    }
    if (patch.fallbackProviderIds !== undefined) {
      agent.fallbackProviderIds = normalizeProviderIds(
        patch.fallbackProviderIds,
        this.db.providers,
        agent.providerId,
      );
    } else {
      agent.fallbackProviderIds = normalizeProviderIds(
        agent.fallbackProviderIds,
        this.db.providers,
        agent.providerId,
      );
    }
    if (patch.profileId !== undefined) {
      agent.profileId = normalizeAgentProfileId(patch.profileId);
    }
    if (patch.model !== undefined) agent.model = normalizeAgentModel(patch.model);
    if (patch.maxConcurrency !== undefined) {
      agent.maxConcurrency = normalizeAgentConcurrency(patch.maxConcurrency);
    }
    if (patch.workspacePolicy !== undefined) {
      agent.workspacePolicy = normalizeAgentWorkspacePolicy(
        patch.workspacePolicy,
        agent.workspacePolicy,
      );
    }
    if (patch.timeouts !== undefined) {
      agent.timeouts = normalizeTimeoutOverrides(patch.timeouts);
    }
    // 先把旧 cli 存下来再合并，否则 Object.assign 已经把 agent.cli 覆盖成新对象了
    if (patch.cli) agent.cli = { ...prevCli, ...patch.cli };
    if (patch.skills !== undefined) agent.skills = normalizeSkills(patch.skills);
    if (patch.mcpServers !== undefined) {
      agent.mcpServers = normalizeMcpServerIds(patch.mcpServers, this.db.settings.mcpServers);
    } else {
      agent.mcpServers = normalizeMcpServerIds(agent.mcpServers, this.db.settings.mcpServers);
    }
    const role = agent.role;
    if (hasExplicitTools) agent.tools = normalizeTools(patch.tools, role);
    else if (patch.role && role !== prevRole) agent.tools = toolsForRole(role);
    else agent.tools = normalizeTools(agent.tools, role);
    agent.executionPolicy = normalizeExecutionPolicy(agent.executionPolicy);
    if (patch.seat === true) {
      this.demoteRolePeers(role, agent.id);
      agent.seat = true;
    } else if (patch.role && role !== prevRole) {
      // 换到一个空角色时自动接席；目标角色已有主执行人则进入工具池。
      agent.seat = patch.seat === false ? false : !this.db.agents.some(
        (a) => a.id !== id && a.role === role && a.seat !== false,
      );
      if (agent.seat) this.demoteRolePeers(role, agent.id);
    }
    // 主执行人换岗后，旧角色从工具池补位；取消席位时若无人可补，则保留原席位。
    if (prevSeat && role !== prevRole) {
      const oldRoleSeat = this.db.agents.find(
        (a) => a.id !== id && a.role === prevRole && a.seat !== false,
      );
      if (!oldRoleSeat) {
        const replacement = this.db.agents.find((a) => a.id !== id && a.role === prevRole);
        if (replacement) replacement.seat = true;
      }
    }
    if (prevSeat && role === prevRole && agent.seat === false) {
      const replacement = this.db.agents.find(
        (a) => a.id !== id && a.role === prevRole && a.seat === false,
      );
      if (replacement) replacement.seat = true;
      else agent.seat = true;
    }
    // 从 CLI 切回模拟时，把上次失败留下的 error 状态清掉
    if (patch.mode === 'sim') {
      agent.status = 'idle';
      agent.activity = '';
    }
    this.save({ agents: true });
    this.broadcast({ type: 'agents.changed' });
    return agent;
  }

  removeAgent(id) {
    const target = this.getAgent(id);
    if (!target) return false;
    this.db.agents = this.db.agents.filter((a) => a.id !== id);
    // 删掉主执行人后，从同角色的工具池里自动补位，避免工序找不到人。
    if (target.seat !== false) {
      const next = this.db.agents.find((a) => a.role === target.role);
      if (next) next.seat = true;
    }
    this.save({ agents: true });
    this.broadcast({ type: 'agents.changed' });
    return true;
  }

  removeAgentReferences(id) {
    let changed = false;
    const taskIds = new Set();
    for (const task of this.db.tasks) {
      let taskChanged = false;
      for (const step of task.plan || []) {
        if (step.agentId === id) {
          step.agentId = '';
          changed = true;
          taskChanged = true;
        }
      }
      for (const artifact of task.artifacts || []) {
        if (artifact.agentId === id) {
          artifact.agentId = '';
          changed = true;
          taskChanged = true;
        }
      }
      if (taskChanged) taskIds.add(task.id);
    }
    if (changed) this.save({ tasks: [...taskIds] });
    return changed;
  }

  setAgentStatus(id, status, activity = '') {
    const agent = this.getAgent(id);
    if (!agent) return;
    agent.status = status;
    agent.activity = activity;
    this.broadcast({ type: 'agent.status', agentId: id, status, activity });
  }

  /* ---------- tasks ---------- */
  get tasks() {
    return this.db.tasks;
  }

  getTask(id) {
    return this.db.tasks.find((t) => t.id === id);
  }

  findIdempotentTask(clientMessageId, scope = '', now = Date.now(), windowMs = 24 * 60 * 60 * 1000) {
    const key = String(clientMessageId || '').trim();
    if (!key) return null;
    const normalizedScope = String(scope || '');
    const cutoff = now - Math.max(1, Number(windowMs) || 24 * 60 * 60 * 1000);
    return (
      this.db.tasks.find(
        (task) =>
          task.clientMessageId === key &&
          String(task.clientMessageScope || '') === normalizedScope &&
          Number(task.createdAt) >= cutoff,
      ) || null
    );
  }

  findTenantIdempotentTask(
    clientMessageId,
    tenantId = 'default',
    scope = '',
    now = Date.now(),
    windowMs = 24 * 60 * 60 * 1000,
  ) {
    const key = String(clientMessageId || '').trim();
    if (!key) return null;
    const tenant = String(tenantId || 'default').trim().slice(0, 80) || 'default';
    const normalizedScope = String(scope || '').trim().slice(0, 120);
    const cutoff = now - Math.max(1, Number(windowMs) || 24 * 60 * 60 * 1000);
    return (
      this.db.tasks.find(
        (task) =>
          task.clientMessageId === key &&
          String(task.tenantId || 'default') === tenant &&
          String(task.clientMessageScope || '') === normalizedScope &&
          Number(task.createdAt) >= cutoff,
      ) || null
    );
  }

  createTask({
    goal,
    costEstimate = null,
    pendingConfirmation = false,
    mode = 'auto',
    priority = 'normal',
    workspace = '',
    debate = null,
    isolation = 'direct',
    clientMessageId = '',
    clientMessageScope = '',
    tenantId = 'default',
    ownerId = 'owner',
    taskLimit = 0,
  }) {
    const taskTenant = String(tenantId || 'default').trim().slice(0, 80) || 'default';
    const taskOwner = String(ownerId || 'owner').trim().slice(0, 80) || 'owner';
    const activeCount = this.db.tasks.filter(
      (task) => String(task.tenantId || 'default') === taskTenant,
    ).length;
    const limit = Math.max(0, Math.round(Number(taskLimit) || 0));
    if (limit > 0 && activeCount >= limit) {
      const error = new Error(
        `租户「${taskTenant}」已达到任务配额（${activeCount}/${limit}）`,
      );
      error.status = 429;
      error.code = 'tenant-task-quota-exceeded';
      throw error;
    }
    const idempotencyKey = String(clientMessageId || '').trim().slice(0, 200);
    const idempotencyScope = String(clientMessageScope || '').trim().slice(0, 120);
    if (idempotencyKey) {
      const existing = this.findTenantIdempotentTask(
        idempotencyKey,
        taskTenant,
        idempotencyScope,
      );
      if (existing) return existing;
    }
    const id = randomUUID();
    let root = path.join(WORKSPACE_DIR, id);
    let external = false;
    let worktree = null;
    if (workspace) {
      const abs = path.resolve(String(workspace).trim());
      const allowedRoots = normalizeRoots(this.db.settings.workspaceRoots);
      if (allowedRoots.length && !withinAnyRoot(abs, allowedRoots)) {
        const error = new Error(
          `工作区不在白名单内：${abs}（可在设置 workspaceRoots 中显式加入）`,
        );
        error.status = 403;
        error.code = 'workspace-not-allowed';
        throw error;
      }
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch {
        throw new Error(`目录不存在：${abs}`);
      }
      if (!st.isDirectory()) throw new Error(`不是目录：${abs}`);
      if (isolation === 'worktree') {
        worktree = createIsolatedWorkspace(abs, id);
        root = worktree.path;
      } else {
        root = abs;
        external = true;
      }
    }
    const task = {
      id,
      tenantId: taskTenant,
      ownerId: taskOwner,
      title: goal.length > 26 ? goal.slice(0, 26) + '…' : goal,
      goal,
      mode,
      priority: normalizeTaskPriority(priority),
      // 工作流模式：null 跟随全局设置，debate 先讨论后实施，direct 直接开工
      flowMode: debate === 'direct' || debate === 'debate' ? debate : null,
      status: 'idle',
      createdAt: Date.now(),
      clientMessageId: idempotencyKey || '',
      clientMessageScope: idempotencyKey ? idempotencyScope : '',
      clientMessageAt: idempotencyKey ? Date.now() : null,
      endedAt: null,
      queuedAt: null,
      startedAt: null,
      finishedAt: null,
      queuePosition: null,
      waitingReason: '',
      queueMs: 0,
      executionMs: 0,
      scheduler: null,
      plan: [],
      messages: [],
      attachments: [],
      artifacts: [],
      runId: null,
      trace: null,
      recovery: null,
      repairRound: 0,
      costEstimate: costEstimate || null,
      pendingConfirmation: !!pendingConfirmation,
      planVersion: 0,
      planVersions: [],
      autoReplans: [],
      quality: { status: 'pending' },
      debate: { status: 'pending', proposals: [], critiques: [], decision: null },
      skillActivations: [],
      stats: { tokens: 0, tokensIn: 0, tokensOut: 0, agentRuns: 0, files: 0, ms: 0 },
      usageLedger: [],
      contextState: {
        contextWindow: null,
        autoCompactAt: null,
        compaction: null,
        compactions: [],
        autoCompaction: null,
      },
      workspace: root,
      sourceWorkspace: worktree?.source || root,
      worktree,
      // 用已有目录开工时，不替用户新建/改动它的目录结构
      external,
      events: [],
      fileChanges: [],
    };
    if (!external) fs.mkdirSync(root, { recursive: true });
    this.db.tasks.unshift(task);
    this.save({ tasks: [task.id] });
    this.broadcast({ type: 'task.created', task: this.taskSummary(task) });
    return task;
  }

  taskSummary(task) {
    return {
      id: task.id,
      tenantId: String(task.tenantId || 'default'),
      ownerId: String(task.ownerId || 'owner'),
      title: task.title,
      goal: task.goal,
      mode: task.mode,
      priority: normalizeTaskPriority(task.priority),
      flowMode: task.flowMode || null,
      sourceWorkspace: task.sourceWorkspace || task.workspace,
      worktree: task.worktree ? { ...task.worktree } : null,
      status: task.status,
      createdAt: task.createdAt,
      clientMessageId: task.clientMessageId || '',
      clientMessageScope: task.clientMessageScope || '',
      endedAt: task.endedAt,
      queuedAt: task.queuedAt || null,
      startedAt: task.startedAt || null,
      finishedAt: task.finishedAt || null,
      queuePosition: task.queuePosition ?? null,
      waitingReason: task.waitingReason || '',
      queueMs: Number(task.queueMs) || 0,
      executionMs: Number(task.executionMs) || 0,
      scheduler: task.scheduler || null,
      runId: task.runId || null,
      trace: task.trace ? { ...task.trace } : null,
      recovery: task.recovery ? { ...task.recovery } : null,
      repairRound: task.repairRound || 0,
      pendingConfirmation: task.pendingConfirmation === true,
      costEstimate: task.costEstimate || null,
      planVersion: task.planVersion || 0,
      planVersions: (task.planVersions || []).length,
      quality: task.quality || { status: 'pending' },
      usage: {
        entries: (task.usageLedger || []).length,
        tokensIn: (task.usageLedger || []).reduce((sum, entry) => sum + (entry.tokensIn || 0), 0),
        tokensOut: (task.usageLedger || []).reduce((sum, entry) => sum + (entry.tokensOut || 0), 0),
        cost: (task.usageLedger || []).some((entry) => Number.isFinite(entry.cost))
          ? (task.usageLedger || []).reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0)
          : null,
      },
      skillActivations: (task.skillActivations || []).slice(-8),
      stats: task.stats,
      steps: task.plan.length,
      doneSteps: task.plan.filter((s) => s.status === 'done').length,
      messages: task.messages.length,
      files: task.artifacts.length,
      changes: (task.fileChanges || []).length,
      events: (task.events || []).length,
    };
  }

  /** 工作流参数：只开放安全字段，逐项夹紧范围，改完广播给所有已连接界面。 */
  updateSettings(patch = {}) {
    const clamp = (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    };
    const s = this.db.settings;
    if (typeof patch.debateEnabled === 'boolean') s.debateEnabled = patch.debateEnabled;
    if (patch.debateParticipants !== undefined)
      s.debateParticipants = clamp(patch.debateParticipants, 2, 6, s.debateParticipants);
    if (patch.debatePoolSeats !== undefined)
      s.debatePoolSeats = clamp(patch.debatePoolSeats, 0, 3, s.debatePoolSeats);
    if (patch.debateConcurrency !== undefined)
      s.debateConcurrency = clamp(patch.debateConcurrency, 1, 4, s.debateConcurrency);
    if (typeof patch.dynamicPlanEnabled === 'boolean')
      s.dynamicPlanEnabled = patch.dynamicPlanEnabled;
    if (typeof patch.hookTokenEnabled === 'boolean') s.hookTokenEnabled = patch.hookTokenEnabled;
    if (typeof patch.hookTokenPathEnabled === 'boolean')
      s.hookTokenPathEnabled = patch.hookTokenPathEnabled;
    if (patch.maxPlanSteps !== undefined)
      s.maxPlanSteps = clamp(patch.maxPlanSteps, 2, 12, s.maxPlanSteps);
    if (patch.maxConcurrency !== undefined)
      s.maxConcurrency = clamp(patch.maxConcurrency, 1, 4, s.maxConcurrency);
    if (patch.maxTaskConcurrency !== undefined)
      s.maxTaskConcurrency = clamp(patch.maxTaskConcurrency, 1, 8, s.maxTaskConcurrency);
    if (patch.maxRepairRounds !== undefined)
      s.maxRepairRounds = clamp(patch.maxRepairRounds, 0, 3, s.maxRepairRounds);
    if (patch.maxAutoReplans !== undefined)
      s.maxAutoReplans = clamp(patch.maxAutoReplans, 0, 1, s.maxAutoReplans);
    if (patch.maxStepAttempts !== undefined)
      s.maxStepAttempts = clamp(patch.maxStepAttempts, 1, 3, s.maxStepAttempts);
    if (patch.workspaceQuotaBytes !== undefined)
      s.workspaceQuotaBytes = clamp(
        patch.workspaceQuotaBytes,
        0,
        1024 * 1024 * 1024,
        s.workspaceQuotaBytes,
      );
    if (patch.workspaceTrashRetentionDays !== undefined)
      s.workspaceTrashRetentionDays = clamp(
        patch.workspaceTrashRetentionDays,
        0,
        365,
        s.workspaceTrashRetentionDays,
      );
    if (patch.timeouts !== undefined) {
      s.timeouts = {
        ...defaultTimeouts(),
        ...normalizeTimeoutOverrides(patch.timeouts),
      };
    }
    if (patch.simSpeed !== undefined)
      s.simSpeed = clamp(patch.simSpeed, 1, 20, s.simSpeed);
    if (patch.costGateTokens !== undefined)
      s.costGateTokens = clamp(patch.costGateTokens, 0, 10000000, s.costGateTokens);
    if (patch.workspaceRoots !== undefined) {
      s.workspaceRoots = normalizeRoots(patch.workspaceRoots)
        .map((item) => item.slice(0, 500))
        .slice(0, 32);
    }
    if (patch.fsBrowseRoots !== undefined) {
      s.fsBrowseRoots = normalizeRoots(patch.fsBrowseRoots)
        .map((item) => item.slice(0, 500))
        .slice(0, 32);
    }
    if (patch.defaultMode !== undefined && ['auto', 'cli', 'sim'].includes(patch.defaultMode))
      s.defaultMode = patch.defaultMode;
    this.save({ settings: true });
    this.broadcast({ type: 'settings.changed', settings: { ...s } });
    return { ...s };
  }

  /** Token 区间只来自同模式历史任务的真实用量；没有价格来源就不换算费用。 */
  estimateTaskTokens({ mode = 'auto' } = {}) {
    const rows = (this.db.tasks || [])
      .filter((task) => (task.mode || 'auto') === mode)
      .map((task) =>
        (task.usageLedger || []).reduce(
          (sum, entry) => sum + (Number(entry.tokensIn) || 0) + (Number(entry.tokensOut) || 0),
          0,
        ),
      )
      .filter((total) => total > 0)
      .sort((a, b) => a - b);
    const pick = (ratio, round = Math.floor) =>
      rows[Math.min(rows.length - 1, round(ratio * (rows.length - 1)))];
    const ready = rows.length >= 3;
    return {
      ready,
      samples: rows.length,
      low: ready ? pick(0.1) : null,
      median: ready ? pick(0.5) : null,
      high: ready ? pick(0.9, Math.ceil) : null,
      cost: null,
    };
  }

  rotateHookToken() {
    const token = randomUUID().replace(/-/g, '').slice(0, 24);
    this.db.settings.hookToken = token;
    this.db.settings.hookTokenEnabled = true;
    this.save({ settings: true });
    // 不把新 token 广播出去：SSE 订阅者可能只有 read 作用域。
    this.broadcast({ type: 'hook.rotated', at: Date.now() });
    return token;
  }

  recordSecurityEvent(event = {}) {
    if (!Array.isArray(this.db.settings.securityAudit)) this.db.settings.securityAudit = [];
    const entry = {
      id: randomUUID(),
      at: Date.now(),
      type: String(event.type || 'security.event').slice(0, 80),
      method: String(event.method || '').slice(0, 12),
      path: String(event.path || '').slice(0, 500),
      requestId: String(event.requestId || '').slice(0, 80),
      actorId: String(event.actorId || '').slice(0, 80),
      actorKind: String(event.actorKind || '').slice(0, 20),
      tenantId: String(event.tenantId || 'default').slice(0, 80),
      tokenScope: String(event.tokenScope || '').slice(0, 80),
      remoteAddress: String(event.remoteAddress || '').slice(0, 120),
      origin: String(event.origin || '').slice(0, 500),
      reason: String(event.reason || '').slice(0, 500),
      tokenSource: String(event.tokenSource || '').slice(0, 20),
    };
    this.db.settings.securityAudit.push(entry);
    if (this.db.settings.securityAudit.length > 100) {
      this.db.settings.securityAudit.splice(0, this.db.settings.securityAudit.length - 100);
    }
    this.save({ settings: true });
    this.broadcast({ type: 'security.audit', event: entry });
    return entry;
  }

  updateTask(id, patch, event = 'task.updated') {
    const task = this.getTask(id);
    if (!task) return null;
    Object.assign(task, patch);
    this.save({ tasks: [id] });
    this.broadcast({ type: event, taskId: id, patch });
    return task;
  }

  removeTask(id) {
    const task = this.getTask(id);
    if (!task) return false;
    this.db.tasks = this.db.tasks.filter((t) => t.id !== id);
    removeWorktree(task);
    // 外部目录是用户自己的项目，删任务不能连目录一起删
    const own = path.resolve(task.workspace).startsWith(path.resolve(WORKSPACE_DIR) + path.sep);
    if (!task.external && own) {
      try {
        fs.rmSync(task.workspace, { recursive: true, force: true });
      } catch {
        /* 目录可能不存在 */
      }
    }
    this.save({ tasks: [], tasksRemoved: [id] });
    this.broadcast({ type: 'task.deleted', taskId: id });
    return true;
  }

  /* ---------- messages ---------- */
  publishMessage(taskId, msg, options = {}) {
    return this.addMessage(taskId, msg, options);
  }

  addMessage(taskId, msg, options = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const inlineText = String(msg?.text || '');
    const spilled = Buffer.byteLength(inlineText) > MAX_INLINE_MESSAGE_BYTES
      ? spillText({ taskId, name: `message-${msg?.kind || 'text'}`, content: inlineText })
      : null;
    const draft = {
      id: randomUUID(),
      createdAt: Date.now(),
      done: false,
      text: '',
      kind: 'text',
      ...msg,
      ...(spilled
        ? {
            text: spilled.excerpt,
            spill: {
              locator: spilled.locator,
              bytes: spilled.bytes,
              sha256: spilled.sha256,
              retrievalHint: spilled.retrievalHint,
            },
          }
        : {}),
    };
    const message = {
      ...draft,
      ...createMessageEnvelope(task, draft, options),
    };
    task.messages.push(message);
    if (task.messages.length > MAX_MESSAGES) task.messages.splice(0, task.messages.length - MAX_MESSAGES);
    // 已经写完的消息（如用户发言）必须带全量文本，否则前端会渲染成空气泡
    this.broadcast({
      type: 'message.start',
      taskId,
      runId: task.runId || null,
      message: { ...message, text: message.done ? message.text : '' },
    });
    this.addTaskEvent(taskId, {
      type: 'message.published',
      runId: task.runId || null,
      agentId: message.agentId || '',
      stepId: message.stepId || '',
      executionId: message.executionId || '',
      data: {
        messageId: message.id,
        executionId: message.executionId || '',
        correlationId: message.correlationId,
        from: message.from,
        to: message.to,
        route: message.route,
        parentMessageId: message.parentMessageId,
        causeBy: message.causeBy,
        artifactRefs: message.artifactRefs,
        kind: message.kind,
      },
    });
    this.save({ tasks: [taskId] });
    return message;
  }

  addImageMessage(taskId, msg = {}, image = null, { provider = null } = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (!image?.sha256) {
      const error = new Error('图片附件引用无效');
      error.code = 'IMAGE_INVALID_REFERENCE';
      error.status = 400;
      throw error;
    }
    const effectiveProvider =
      provider || this.providerForAgent({ providerId: msg.providerId || DEFAULT_PROVIDER_ID });
    if (!supportsVision(effectiveProvider)) {
      const error = new Error('当前模型不支持图片输入，请切换到声明了 vision 能力的 Provider');
      error.code = 'IMAGE_UNSUPPORTED_MODEL';
      error.status = 422;
      throw error;
    }
    this.addTaskAttachment(taskId, image);
    return this.addMessage(
      taskId,
      {
        ...msg,
        kind: 'image',
        image: publicImageRef(image),
      },
      { to: msg.to || { kind: 'owner', id: 'user', name: '你' } },
    );
  }

  addTaskAttachment(taskId, image = null) {
    const task = this.getTask(taskId);
    if (!task || !image?.sha256) return null;
    if (!Array.isArray(task.attachments)) task.attachments = [];
    const ref = publicImageRef(image);
    if (!ref) return null;
    if (!task.attachments.some((item) => item.sha256 === ref.sha256 && item.mime === ref.mime)) {
      task.attachments.push(ref);
      this.save({ tasks: [taskId] });
    }
    return ref;
  }

  taskHasAttachment(taskId, sha256, mime) {
    const task = this.getTask(taskId);
    if (!task) return false;
    const sha = String(sha256 || '').toLowerCase();
    const type = String(mime || '').toLowerCase();
    const matches = (image) =>
      String(image?.sha256 || '').toLowerCase() === sha &&
      (!type || String(image?.mime || '').toLowerCase() === type);
    return (
      (task.attachments || []).some(matches) ||
      (task.messages || []).some((message) => matches(message.image))
    );
  }

  /** 记一次真实发出去的提示词：token 账必须算输入，只算输出会把成本低估一个数量级。 */
  countPrompt(taskId, agentId, tokens) {
    const task = this.getTask(taskId);
    if (!task || !tokens) return 0;
    const n = Math.max(0, Math.round(tokens));
    task.stats.tokens += n;
    task.stats.tokensIn = (task.stats.tokensIn || 0) + n;
    if (agentId) {
      const agent = this.getAgent(agentId);
      if (agent) agent.stats.tokens += n;
    }
    this.broadcast({ type: 'task.stats', taskId, stats: task.stats });
    this.save({ tasks: [taskId], agents: !!agentId });
    return n;
  }

  recordProviderUsage(taskId, entry = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (!Array.isArray(task.usageLedger)) task.usageLedger = [];
    const tokensIn = Math.max(0, Math.round(Number(entry.tokensIn) || 0));
    const tokensOut = Math.max(0, Math.round(Number(entry.tokensOut) || 0));
    const cost =
      entry.cost !== null && entry.cost !== undefined && Number.isFinite(Number(entry.cost))
        ? Number(entry.cost)
        : null;
    const saved = {
      id: randomUUID(),
      at: Number(entry.at) || Date.now(),
      providerId: String(entry.providerId || '').slice(0, 64),
      model: String(entry.model || '').slice(0, 160),
      taskId: task.id,
      runId: String(entry.runId || task.runId || '') || null,
      agentId: String(entry.agentId || '').slice(0, 80),
      tokensIn,
      tokensOut,
      cost,
      source: ['cli', 'api', 'estimate'].includes(entry.source) ? entry.source : 'estimate',
      usageSource: ['provider', 'estimate'].includes(entry.usageSource)
        ? entry.usageSource
        : 'estimate',
      attempt: Math.max(1, Math.round(Number(entry.attempt) || 1)),
      routeIndex: Math.max(0, Math.round(Number(entry.routeIndex) || 0)),
      code: Number.isFinite(Number(entry.code)) ? Number(entry.code) : null,
      elapsedMs: Math.max(0, Math.round(Number(entry.elapsedMs) || 0)),
    };
    task.usageLedger.push(saved);
    if (task.usageLedger.length > 1000) {
      task.usageLedger.splice(0, task.usageLedger.length - 1000);
    }
    this.broadcast({ type: 'usage.recorded', taskId: task.id, entry: { ...saved } });
    this.save({ tasks: [task.id] });
    return saved;
  }

  updateContextState(taskId, patch = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.contextState = {
      contextWindow: null,
      autoCompactAt: null,
      compaction: null,
      compactions: [],
      autoCompaction: null,
      ...(task.contextState || {}),
      ...patch,
      updatedAt: Date.now(),
    };
    this.broadcast({ type: 'task.context', taskId, contextState: task.contextState });
    this.save({ tasks: [taskId] });
    return task.contextState;
  }

  appendMessage(taskId, messageId, delta) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.text += delta;
    const deltaTokens = estimateTokens(delta);
    if (msg.agentId) {
      const agent = this.getAgent(msg.agentId);
      if (agent) agent.stats.tokens += deltaTokens;
    }
    task.stats.tokens += deltaTokens;
    task.stats.tokensOut = (task.stats.tokensOut || 0) + deltaTokens;
    this.broadcast({ type: 'message.delta', taskId, runId: task.runId || null, id: messageId, delta });
    this.save({ tasks: [taskId], agents: !!msg.agentId });
  }

  /** 直接改写整条消息（用于撤掉「等待输出」这类临时提示） */
  replaceMessage(taskId, messageId, text) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.text = text;
    this.broadcast({ type: 'message.replace', taskId, runId: task.runId || null, id: messageId, text });
    this.save({ tasks: [taskId] });
  }

  endMessage(taskId, messageId, meta = {}) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.done = true;
    msg.meta = { ...msg.meta, ...meta };
    this.broadcast({ type: 'message.end', taskId, runId: task.runId || null, id: messageId, meta: msg.meta });
    this.save({ tasks: [taskId] });
  }

  /* ---------- plan ---------- */
  _recordPlanVersion(task, previousSteps, options = {}) {
    const version = Math.max(1, Number(task.planVersion || 0) + 1);
    const snapshot = createPlanSnapshot({
      version,
      previousSteps,
      steps: task.plan,
      reason: options.reason || 'plan-updated',
      source: options.source || 'orchestrator',
      runId: options.runId || task.runId || '',
      added: options.added,
      removed: options.removed,
      changed: options.changed,
    });
    task.planVersion = version;
    task.planVersions ||= [];
    task.planVersions.push(snapshot);
    if (task.planVersions.length > MAX_PLAN_VERSIONS) {
      task.planVersions.splice(0, task.planVersions.length - MAX_PLAN_VERSIONS);
    }
    return snapshot;
  }

  _emitPlan(task) {
    this.broadcast({
      type: 'plan.updated',
      taskId: task.id,
      runId: task.runId,
      plan: task.plan,
      planVersion: task.planVersion || 0,
      planVersions: task.planVersions || [],
    });
  }

  setPlan(taskId, steps, options = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const previous = task.plan || [];
    const used = new Set();
    task.plan = (Array.isArray(steps) ? steps : []).map((step, index) =>
      normalizePlanStep(step, `step-${index + 1}`, used, true),
    );
    this._recordPlanVersion(task, previous, {
      ...options,
      reason: options.reason || 'initial-plan',
      source: options.source || 'orchestrator',
    });
    this._emitPlan(task);
    this.save({ tasks: [taskId] });
    return task.plan;
  }

  appendPlan(taskId, steps, options = {}) {
    const task = this.getTask(taskId);
    if (!task) return [];
    const previous = task.plan.map((step) => ({ ...step, needs: [...(step.needs || [])] }));
    const used = new Set(task.plan.map((s) => s.id));
    const added = (Array.isArray(steps) ? steps : []).map((step, index) =>
      normalizePlanStep(step, `step-${task.plan.length + index + 1}`, used, true),
    );
    task.plan.push(...added);
    this._recordPlanVersion(task, previous, {
      ...options,
      reason: options.reason || 'plan-appended',
      source: options.source || 'orchestrator',
      added: added.map((step) => step.id),
    });
    this._emitPlan(task);
    this.save({ tasks: [taskId] });
    return added;
  }

  replacePlan(taskId, steps, options = {}) {
    const task = this.getTask(taskId);
    if (!task) return [];
    const previous = task.plan || [];
    const preserveDone = options.preserveDone !== false;
    const completed = preserveDone
      ? previous.filter((step) => ['done', 'skipped'].includes(step.status))
      : [];
    const used = new Set();
    const incoming = (Array.isArray(steps) ? steps : []).map((step, index) =>
      normalizePlanStep(step, `step-${index + 1}`, used, true),
    );
    const next = [];
    for (const step of completed) {
      if (!incoming.some((candidate) => candidate.id === step.id)) next.push(step);
    }
    for (const step of incoming) {
      const done = completed.find((candidate) => candidate.id === step.id);
      next.push(done || step);
    }
    for (const step of completed) {
      if (!next.some((candidate) => candidate.id === step.id)) next.push(step);
    }
    task.plan = next;
    this._recordPlanVersion(task, previous, {
      ...options,
      reason: options.reason || 'manual-replan',
      source: options.source || 'manual',
    });
    this._emitPlan(task);
    this.save({ tasks: [taskId] });
    return task.plan;
  }

  replanUnfinished(taskId, options = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const completed = task.plan.filter((step) => ['done', 'skipped'].includes(step.status));
    const unfinished = Array.isArray(options.steps)
      ? options.steps
      : task.plan.filter((step) => !['done', 'skipped'].includes(step.status));
    this.replacePlan(taskId, unfinished, {
      ...options,
      preserveDone: true,
      reason: options.reason || 'manual-replan',
      source: options.source || 'manual',
    });
    return {
      task: this.getTask(taskId),
      preserved: completed.map((step) => step.id),
      reopened: this.getTask(taskId).plan
        .filter((step) => !['done', 'skipped'].includes(step.status))
        .map((step) => step.id),
    };
  }

  updateStep(taskId, stepId, patch) {
    const task = this.getTask(taskId);
    if (!task) return;
    const step = task.plan.find((s) => s.id === stepId);
    if (!step) return;
    Object.assign(step, patch);
    this.broadcast({ type: 'plan.updated', taskId, runId: task.runId, plan: task.plan });
    this.save({ tasks: [taskId] });
  }

  /* ---------- debate ---------- */
  _emitDebate(task) {
    this.broadcast({
      type: 'debate.updated',
      taskId: task.id,
      runId: task.runId || null,
      debate: task.debate,
    });
    this.save({ tasks: [task.id] });
  }

  setDebate(taskId, patch) {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.debate = {
      status: 'pending',
      proposals: [],
      critiques: [],
      decision: null,
      ...(task.debate || {}),
      ...patch,
      updatedAt: Date.now(),
    };
    this._emitDebate(task);
    return task.debate;
  }

  addProposal(taskId, proposal) {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.debate ||= { status: 'proposing', proposals: [], critiques: [], decision: null };
    task.debate.proposals ||= [];
    const item = { votes: [], score: null, status: 'running', text: '', ...proposal };
    task.debate.proposals.push(item);
    this._emitDebate(task);
    return item;
  }

  updateProposal(taskId, proposalId, patch) {
    const task = this.getTask(taskId);
    const item = task?.debate?.proposals?.find((p) => p.id === proposalId);
    if (!item) return null;
    Object.assign(item, patch);
    this._emitDebate(task);
    return item;
  }

  addVote(taskId, proposalId, vote) {
    const task = this.getTask(taskId);
    const item = task?.debate?.proposals?.find((p) => p.id === proposalId);
    if (!item) return null;
    item.votes ||= [];
    if (vote?.byId && item.votes.some((v) => v.byId === vote.byId)) return item;
    item.votes.push(vote);
    this._emitDebate(task);
    return item;
  }

  addCritique(taskId, critique) {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.debate ||= { status: 'critiquing', proposals: [], critiques: [], decision: null };
    task.debate.critiques ||= [];
    task.debate.critiques.push(critique);
    this._emitDebate(task);
    return critique;
  }

  setDecision(taskId, decision, status = 'decided') {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.debate ||= { proposals: [], critiques: [] };
    task.debate.decision = decision;
    task.debate.status = status;
    this._emitDebate(task);
    return decision;
  }

  /* ---------- workspace events / changes ---------- */
  addTaskEvent(taskId, event = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (!Array.isArray(task.events)) task.events = [];
    const serializedData = JSON.stringify(event.data ?? {});
    const spilledData = Buffer.byteLength(serializedData) > MAX_INLINE_EVENT_BYTES
      ? spillValue({
          taskId,
          name: `event-${event.type || 'event'}`,
          value: event.data ?? {},
          mime: 'application/json',
        })
      : null;
    const at = Number(event.at) || Date.now();
    const type = String(event.type || 'event').slice(0, 120);
    const runId = String(event.runId || task.runId || '') || null;
    const spanId = safeSpanId(event.spanId) || randomUUID();
    const trace = ensureTaskTrace(task, runId, spanId, at);
    const stepId = String(event.stepId || '');
    const executionId = String(event.executionId || '');
    const step = stepId ? (task.plan || []).find((item) => item.id === stepId) : null;
    const resolved = resolveParentSpanId({
      event,
      type,
      spanId,
      trace,
      step,
      createId: () => randomUUID(),
    });
    if (step && resolved.stepPatch) Object.assign(step, resolved.stepPatch);
    const parentSpanId = resolved.parentSpanId;
    const saved = {
      id: randomUUID(),
      ...event,
      ...(spilledData
        ? {
            data: {
              preview: spilledData.text,
              spill: spilledData.spill,
            },
          }
        : {}),
      at,
      runId,
      traceId: String(event.traceId || trace.traceId),
      spanId,
      parentSpanId,
      kind: String(event.kind || traceKindFor(type)),
      agentId: '',
      stepId,
      executionId,
      type,
    };
    saved.agentId = String(event.agentId || '');
    task.events.push(saved);
    if (task.events.length > MAX_TASK_EVENTS) {
      task.events.splice(0, task.events.length - MAX_TASK_EVENTS);
    }
    if (type === 'run.end' || type === 'run.error') {
      trace.endedAt = at;
      trace.updatedAt = at;
    }
    this.broadcast({
      type: 'task.event',
      taskId,
      runId: saved.runId || null,
      event: { ...saved },
    });
    this.broadcast({
      type: 'trace.span',
      taskId,
      task: {
        id: task.id,
        title: task.title,
        tenantId: task.tenantId,
        runId: task.runId,
        trace: task.trace ? { ...task.trace } : null,
      },
      span: { ...saved },
    });
    this.save({ tasks: [taskId] });
    return saved;
  }

  addFileChange(taskId, change = {}) {
    const task = this.getTask(taskId);
    if (!task || !change.path) return null;
    if (!Array.isArray(task.fileChanges)) task.fileChanges = [];
    const existing = task.fileChanges.find((item) => item.path === change.path);
    const now = Date.now();
    const saved = {
      id: randomUUID(),
      path: change.path,
      status: change.status || 'M',
      previousPath: change.previousPath || '',
      beforeVersion: change.beforeVersion || '',
      afterVersion: change.afterVersion || '',
      bytes: Number(change.bytes) || 0,
      lang: change.lang || '',
      agentId: change.agentId || '',
      stepId: change.stepId || '',
      executionId: change.executionId || '',
      runId: change.runId || task.runId || null,
      source: change.source || 'workspace',
      trashPath: change.trashPath || '',
      at: now,
    };
    if (existing) {
      Object.assign(existing, saved, {
        id: existing.id,
        createdAt: existing.createdAt || existing.at || now,
      });
    } else {
      task.fileChanges.push(saved);
    }
    if (task.fileChanges.length > MAX_FILE_CHANGES) {
      task.fileChanges.splice(0, task.fileChanges.length - MAX_FILE_CHANGES);
    }
    this.broadcast({
      type: 'file.changed',
      taskId,
      runId: saved.runId || null,
      change: { ...saved },
    });
    this.addTaskEvent(taskId, {
      type: 'file.changed',
      runId: saved.runId || null,
      agentId: saved.agentId,
      stepId: saved.stepId,
      executionId: saved.executionId,
      data: { ...saved },
    });
    this.save({ tasks: [taskId] });
    return saved;
  }

  /* ---------- artifacts ---------- */
  addArtifact(taskId, file) {
    const task = this.getTask(taskId);
    if (!task) return;
    const existing = task.artifacts.find((f) => f.path === file.path);
    const beforeVersion = existing?.version || file.beforeVersion || '';
    const afterVersion = file.version || '';
    const status = file.status || (existing ? 'M' : 'A');
    let saved;
    if (existing) {
      Object.assign(existing, {
        bytes: file.bytes,
        mtimeMs: file.mtimeMs || Date.now(),
        version: file.version || existing.version || '',
        lang: file.lang || existing.lang,
        agentId: file.agentId || existing.agentId,
        stepId: file.stepId || existing.stepId || '',
        updatedAt: Date.now(),
        deletedAt: null,
        status: '',
        executionId: file.executionId || existing.executionId || '',
      });
      saved = existing;
    } else {
      saved = {
        path: file.path,
        bytes: file.bytes,
        mtimeMs: file.mtimeMs || Date.now(),
        version: file.version || '',
        lang: file.lang || '',
        agentId: file.agentId || '',
        stepId: file.stepId || '',
        executionId: file.executionId || '',
        createdAt: Date.now(),
        status: '',
      };
      task.artifacts.push(saved);
    }
    task.stats.files = task.artifacts.length;
    this.broadcast({ type: 'artifact.added', taskId, runId: task.runId || null, file: { ...saved } });
    if (!existing || beforeVersion !== afterVersion || file.status) {
      this.addFileChange(taskId, {
        path: file.path,
        status,
        beforeVersion,
        afterVersion,
        bytes: file.bytes,
        lang: file.lang,
        agentId: file.agentId,
        stepId: file.stepId,
        executionId: file.executionId || existing?.executionId || '',
        source: file.source || 'artifact',
      });
    }
    this.save({ tasks: [taskId] });
  }

  markArtifactDeleted(taskId, relPath, meta = {}) {
    const task = this.getTask(taskId);
    if (!task) return false;
    let found = false;
    for (const artifact of task.artifacts || []) {
      if (artifact.path !== relPath) continue;
      artifact.deletedAt = Date.now();
      artifact.status = 'D';
      artifact.updatedAt = Date.now();
      found = true;
      this.broadcast({
        type: 'artifact.removed',
        taskId,
        runId: task.runId || null,
        file: { ...artifact },
      });
    }
    this.addFileChange(taskId, {
      path: relPath,
      status: 'D',
      agentId: meta.agentId || '',
      stepId: meta.stepId || '',
      trashPath: meta.trashPath || '',
      source: 'workspace',
    });
    this.save({ tasks: [taskId] });
    return found;
  }
}

export function redactTranscriptText(value) {
  return String(value ?? '')
    .replace(
      /(\b(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|secret)\b\s*[:=]\s*)(["']?)([^\s"'`,;}]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]');
}

function transcriptTime(value) {
  if (!value) return '—';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function transcriptJson(value) {
  return redactTranscriptText(JSON.stringify(value ?? null, null, 2));
}

function transcriptEvent(event) {
  return {
    at: event.at,
    type: event.type,
    kind: event.kind,
    runId: event.runId,
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    agentId: event.agentId,
    stepId: event.stepId,
    data: event.data ?? null,
  };
}

function transcriptHtmlEscape(value) {
  return redactTranscriptText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function transcriptMarkdownBody(task) {
  const quality = task.quality || { status: 'pending' };
  const plan = Array.isArray(task.plan) ? task.plan : [];
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const events = Array.isArray(task.events) ? task.events : [];
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const changes = Array.isArray(task.fileChanges) ? task.fileChanges : [];
  const skillActivations = Array.isArray(task.skillActivations) ? task.skillActivations : [];
  const lines = [
    `# ${task.title || 'AgentForge 运行记录'}`,
    '',
    `- 任务 ID: \`${task.id}\``,
    `- 目标: ${task.goal || '—'}`,
    `- 状态: \`${task.status || 'unknown'}\``,
    `- 模式: \`${task.mode || 'unknown'}\` / \`${task.flowMode || 'auto'}\``,
    `- Run ID: \`${task.runId || '—'}\``,
    `- Trace ID: \`${task.trace?.traceId || task.runId || '—'}\``,
    `- 工作区: \`${task.workspace || '—'}\``,
    `- 创建: ${transcriptTime(task.createdAt)}`,
    `- 结束: ${transcriptTime(task.finishedAt || task.endedAt)}`,
    '',
    '## 质量门',
    '',
    `- 状态: \`${quality.status || 'pending'}\``,
    `- 命令: \`${quality.command || '—'}\``,
    `- 退出码: \`${quality.code ?? '—'}\``,
    `- 耗时: \`${quality.elapsed ?? '—'} ms\``,
    `- 来源: ${quality.source || '—'}`,
    `- 评审身份: ${quality.reviewerName || quality.reviewerId || '—'} → ${quality.implementerName || quality.implementerId || '—'}`,
    `- 自审: ${quality.selfReview ? '是' : '否'}`,
    quality.reason ? `- 说明: ${quality.reason}` : '',
    '',
    quality.stdout ? '### stdout\n\n```text\n' + redactTranscriptText(quality.stdout) + '\n```\n' : '',
    quality.stderr ? '### stderr\n\n```text\n' + redactTranscriptText(quality.stderr) + '\n```\n' : '',
    '## 执行计划',
    '',
    plan.length
      ? [
          '| 工序 | 角色 | 状态 | 负责人 | 轮次 | 结论 |',
          '| --- | --- | --- | --- | --- | --- |',
          ...plan.map((step) => {
            const verdict = step.verdictDetails
              ? `${String(step.verdictDetails.decision || 'unknown').toUpperCase()} · B${step.verdictDetails.blockers ?? '?'} / S${step.verdictDetails.should ?? '?'}`
              : step.verdict || '—';
            return `| ${redactTranscriptText(step.title || step.id)} | ${step.role || '—'} | ${step.status || '—'} | ${step.agentId || '—'} | ${step.round || 0} | ${verdict} |`;
          }),
        ].join('\n')
      : '暂无计划。',
    '',
    '## 技能激活',
    '',
    skillActivations.length
      ? skillActivations
          .map((activation) => {
            const names = (activation.skills || [])
              .map((skill) => `${skill.name || skill.id} (${skill.id}, ${skill.source || 'unknown'})`)
              .join('、');
            return `- ${activation.stepTitle || activation.stepId || activation.phase || '调用'}: ${names || '—'}`;
          })
          .join('\n')
      : '未激活技能。',
    '',
    '## 协作消息',
    '',
    messages.length
      ? messages
          .map((message) => {
            const header = `### ${transcriptTime(message.createdAt)} · ${message.name || message.role || 'AI'} · ${message.kind || 'text'}`;
            return `${header}\n\n${redactTranscriptText(message.text || '')}`;
          })
          .join('\n\n---\n\n')
      : '暂无消息。',
    '',
    '## 事件',
    '',
    events.length
      ? events
          .slice(-240)
          .map(
            (event) =>
              `### ${transcriptTime(event.at)} · ${event.type || 'event'}\n\n\`\`\`json\n${transcriptJson(transcriptEvent(event))}\n\`\`\``,
          )
          .join('\n\n')
      : '暂无事件。',
    '',
    '## 产物',
    '',
    artifacts.length
      ? artifacts
          .map(
            (artifact) =>
              `- \`${artifact.path}\` · ${artifact.bytes || 0} bytes · ${artifact.agentId || '—'}`,
          )
          .join('\n')
      : '暂无产物。',
    '',
    '## 文件变更',
    '',
    changes.length
      ? changes
          .map(
            (change) =>
              `- \`${change.status || 'M'} ${change.path}\` · ${change.agentId || '—'} · ${transcriptTime(change.at)}`,
          )
          .join('\n')
      : '暂无文件变更。',
    '',
    '## 方案讨论',
    '',
    task.debate?.decision
      ? `- 采纳: ${task.debate.decision.winnerName || task.debate.decision.winnerId || '—'}\n- 状态: ${task.debate.status || '—'}\n- 降级: ${task.debate.decision.degraded ? '是' : '否'}`
      : '本轮没有可记录的方案裁决。',
  ];
  return redactTranscriptText(lines.filter((line) => line !== null).join('\n'));
}

function transcriptHtmlBody(task) {
  const quality = task.quality || { status: 'pending' };
  const plan = Array.isArray(task.plan) ? task.plan : [];
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const events = Array.isArray(task.events) ? task.events : [];
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const changes = Array.isArray(task.fileChanges) ? task.fileChanges : [];
  const skillActivations = Array.isArray(task.skillActivations) ? task.skillActivations : [];
  const h = transcriptHtmlEscape;
  const planRows = plan
    .map(
      (step) =>
        `<tr><td>${h(step.title || step.id)}</td><td>${h(step.role || '—')}</td><td>${h(step.status || '—')}</td><td>${h(step.agentId || '—')}</td><td>${h(step.verdict || '—')}</td></tr>`,
    )
    .join('');
  const messageBlocks = messages
    .map(
      (message) =>
        `<article><h3>${h(transcriptTime(message.createdAt))} · ${h(message.name || message.role || 'AI')} · ${h(message.kind || 'text')}</h3><pre>${h(message.text || '')}</pre></article>`,
    )
    .join('');
  const eventBlocks = events
    .slice(-240)
    .map(
      (event) =>
        `<details><summary>${h(transcriptTime(event.at))} · ${h(event.type || 'event')}</summary><pre>${h(transcriptJson(transcriptEvent(event)))}</pre></details>`,
    )
    .join('');
  const skillItems = skillActivations
    .map((activation) => {
      const names = (activation.skills || [])
        .map((skill) => `${skill.name || skill.id} (${skill.id}, ${skill.source || 'unknown'})`)
        .join('、');
      return `<li>${h(activation.stepTitle || activation.stepId || activation.phase || '调用')}: ${h(names || '—')}</li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(task.title || 'AgentForge 运行记录')}</title>
<style>
body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:980px;margin:32px auto;padding:0 20px;color:#17202a;background:#fbfaf6}
h1,h2,h3{line-height:1.25}h1{border-bottom:3px solid #17202a;padding-bottom:12px}
section{border-top:1px solid #ccd3d9;padding:18px 0}pre{white-space:pre-wrap;word-break:break-word;background:#f0f2f4;padding:12px;border-radius:4px;overflow:auto}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3d9;padding:6px 8px;text-align:left}th{background:#edf0f2}
details{margin:8px 0}code{background:#edf0f2;padding:1px 4px}.meta{color:#5c6975}
</style>
</head>
<body>
<h1>${h(task.title || 'AgentForge 运行记录')}</h1>
<p class="meta">任务 ${h(task.id)} · 状态 ${h(task.status || 'unknown')} · Trace ${h(task.trace?.traceId || task.runId || '—')} · ${h(transcriptTime(task.createdAt))}</p>
<p><strong>目标：</strong>${h(task.goal || '—')}</p>
<section><h2>质量门</h2><p>状态 <code>${h(quality.status || 'pending')}</code> · 命令 <code>${h(quality.command || '—')}</code> · 退出码 <code>${h(quality.code ?? '—')}</code> · 耗时 ${h(quality.elapsed ?? '—')} ms</p>
<p>评审身份：${h(quality.reviewerName || quality.reviewerId || '—')} → ${h(quality.implementerName || quality.implementerId || '—')} · 自审：${quality.selfReview ? '是' : '否'}</p>
${quality.reason ? `<p>${h(quality.reason)}</p>` : ''}
${quality.stdout ? `<h3>stdout</h3><pre>${h(quality.stdout)}</pre>` : ''}
${quality.stderr ? `<h3>stderr</h3><pre>${h(quality.stderr)}</pre>` : ''}
</section>
<section><h2>执行计划</h2><table><thead><tr><th>工序</th><th>角色</th><th>状态</th><th>负责人</th><th>结论</th></tr></thead><tbody>${planRows || '<tr><td colspan="5">暂无计划。</td></tr>'}</tbody></table></section>
<section><h2>技能激活</h2><ul>${skillItems || '<li>未激活技能。</li>'}</ul></section>
<section><h2>协作消息</h2>${messageBlocks || '<p>暂无消息。</p>'}</section>
<section><h2>事件</h2>${eventBlocks || '<p>暂无事件。</p>'}</section>
<section><h2>产物与变更</h2><h3>产物</h3><ul>${artifacts.map((artifact) => `<li><code>${h(artifact.path)}</code> · ${h(artifact.bytes || 0)} bytes · ${h(artifact.agentId || '—')}</li>`).join('') || '<li>暂无产物。</li>'}</ul><h3>文件变更</h3><ul>${changes.map((change) => `<li><code>${h(change.status || 'M')} ${h(change.path)}</code> · ${h(change.agentId || '—')} · ${h(transcriptTime(change.at))}</li>`).join('') || '<li>暂无文件变更。</li>'}</ul></section>
</body>
</html>`;
}

export function taskTranscript(task, format = 'markdown') {
  if (!task?.id) throw new Error('任务不存在');
  const selected = String(format || '').toLowerCase() === 'html' ? 'html' : 'markdown';
  const body = selected === 'html' ? transcriptHtmlBody(task) : transcriptMarkdownBody(task);
  const spill = Buffer.byteLength(body) > MAX_INLINE_TRANSCRIPT_BYTES
    ? spillText({
        taskId: task.id,
        name: `transcript-${selected}`,
        content: body,
      })
    : null;
  return {
    format: selected,
    contentType: selected === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    filename: `agentforge-${task.id.slice(0, 8)}.${selected === 'html' ? 'html' : 'md'}`,
    body,
    spill: spill
      ? {
          locator: spill.locator,
          bytes: spill.bytes,
          sha256: spill.sha256,
          retrievalHint: spill.retrievalHint,
        }
      : null,
  };
}

export const store = new Store();
export { randomUUID };
