import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { estimateTokens } from './tokens.mjs';
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

export const ROLE_ORDER = ['planner', 'architect', 'coder', 'tester', 'reviewer'];
export const ROLE_LABEL = {
  planner: '规划',
  architect: '架构',
  coder: '实现',
  tester: '测试',
  reviewer: '评审',
};

export const TOOL_CATALOG = [
  {
    id: 'workspace.read',
    label: '读取工作区',
    description: '读取工作树、文件、事件、变更和 Git diff。',
    risk: 'read',
    scope: 'workspace',
    audit: true,
    operations: ['tree', 'files', 'file', 'events', 'changes', 'diff'],
    inputSchema: {
      type: 'object',
      properties: {
        op: { enum: ['tree', 'files', 'file', 'events', 'changes', 'diff'] },
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
    description: '创建目录或原子写入工作区文件。',
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
];

export const ROLE_TOOLS = {
  planner: ['workspace.read', 'workspace.search'],
  architect: ['workspace.read', 'workspace.search'],
  coder: [
    'workspace.read',
    'workspace.search',
    'workspace.write',
    'workspace.move',
    'workspace.delete',
    'shell',
  ],
  tester: ['workspace.read', 'workspace.search', 'workspace.write', 'shell'],
  reviewer: ['workspace.read', 'workspace.search', 'shell'],
};

export function toolsForRole(role) {
  return [...(ROLE_TOOLS[role] || ROLE_TOOLS.coder)];
}

export function normalizeTools(value, role) {
  const allowed = new Set(TOOL_CATALOG.map((tool) => tool.id));
  const input = Array.isArray(value) ? value : toolsForRole(role);
  return [...new Set(input.filter((tool) => allowed.has(String(tool))))];
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
    mode: 'sim',
    providerId: DEFAULT_PROVIDER_ID,
    fallbackProviderIds: [],
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
    tasks: [],
    settings: {
      hookToken: randomUUID().replace(/-/g, '').slice(0, 24),
      defaultMode: 'auto',
      simSpeed: 1,
      maxConcurrency: 2,
      maxTaskConcurrency: 2,
      maxRepairRounds: 1,
      maxAutoReplans: 1,
      maxStepAttempts: 2,
      // 方案讨论：默认 5 位提案人（4 个执行席位 + 1 个工具池 CLI），决策后再实施。
      debateEnabled: true,
      debateParticipants: 5,
      debatePoolSeats: 1,
      debateConcurrency: 2,
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

class Store {
  constructor() {
    this.db = emptyDb();
    this.listeners = new Set();
    this._saveTimer = null;
    this._lastSerialized = null;
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
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
          tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
          settings: {
            ...emptyDb().settings,
            ...(raw.settings || {}),
            providerCapabilitiesMigrated: true,
          },
        };
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
        }
        for (const t of this.db.tasks) {
          if (t.status === 'running' || t.status === 'stopping' || t.status === 'queued') {
            t.status = 'stopped';
            t.endedAt ||= Date.now();
            t.queuePosition = null;
            t.waitingReason ||= '服务重启时排队任务已中断';
            recovered = true;
          }
          for (const s of t.plan || []) {
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
          if (t.events.length > MAX_TASK_EVENTS) t.events.splice(0, t.events.length - MAX_TASK_EVENTS);
          if (t.fileChanges.length > MAX_FILE_CHANGES) {
            t.fileChanges.splice(0, t.fileChanges.length - MAX_FILE_CHANGES);
          }
        }
        if (recovered) this.flush();
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[store] 读取数据失败，使用默认数据:', err.message);
      this.db = emptyDb();
    }
  }

  save() {
    // 流式输出期间持续调用 save()，不能被反复重置成永远不落盘。
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.flush(), 400);
  }

  /** 先写临时文件，再原子替换，避免退出瞬间截断 db.json。 */
  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try {
      const json = JSON.stringify(this.db, null, 2);
      // 内容没变就别重写：恢复流程会无条件 flush 一次
      if (json === this._lastSerialized) return;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, DB_FILE);
      this._lastSerialized = json;
    } catch (err) {
      console.error('[store] 持久化失败:', err.message);
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
    this.save();
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
    this.save();
    this.broadcast({ type: 'providers.changed', providers: this.db.providers.map(redactProvider) });
    return provider;
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
    this.save();
    this.broadcast({ type: 'providers.changed', providers: this.db.providers.map(redactProvider) });
    this.broadcast({ type: 'agents.changed' });
    return true;
  }

  get agents() {
    return this.db.agents;
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
    const hasSeat = this.db.agents.some((a) => a.role === role && a.seat !== false);
    const agent = {
      id: randomUUID(),
      name: patch.name || 'Agent',
      role,
      title: patch.title || '自定义智能体',
      color: patch.color || '#818cf8',
      tagline: patch.tagline || '',
      skills: patch.skills || [],
      tools: normalizeTools(patch.tools, role),
      mode: patch.mode === 'cli' ? 'cli' : 'sim',
      providerId: this.getProvider(String(patch.providerId || DEFAULT_PROVIDER_ID))
        ? String(patch.providerId || DEFAULT_PROVIDER_ID)
        : DEFAULT_PROVIDER_ID,
      fallbackProviderIds: normalizeProviderIds(
        patch.fallbackProviderIds,
        this.db.providers,
        this.getProvider(String(patch.providerId || DEFAULT_PROVIDER_ID))
          ? String(patch.providerId || DEFAULT_PROVIDER_ID)
          : DEFAULT_PROVIDER_ID,
      ),
      builtin: false,
      health: patch.health || null,
      // 同一角色默认只有一个主执行席位，额外接入的 CLI 进入工具池。
      seat: patch.seat === true ? true : !hasSeat,
      status: 'idle',
      activity: '',
      cli: {
        command: patch.cli?.command || '',
        args: Array.isArray(patch.cli?.args) ? patch.cli.args : [],
        cwd: patch.cli?.cwd || '',
      },
      createdAt: Date.now(),
      stats: { runs: 0, tokens: 0 },
    };
    if (agent.seat) this.demoteRolePeers(role, agent.id);
    this.db.agents.push(agent);
    this.save();
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
    // 先把旧 cli 存下来再合并，否则 Object.assign 已经把 agent.cli 覆盖成新对象了
    if (patch.cli) agent.cli = { ...prevCli, ...patch.cli };
    const role = agent.role;
    if (hasExplicitTools) agent.tools = normalizeTools(patch.tools, role);
    else if (patch.role && role !== prevRole) agent.tools = toolsForRole(role);
    else agent.tools = normalizeTools(agent.tools, role);
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
    this.save();
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
    this.save();
    this.broadcast({ type: 'agents.changed' });
    return true;
  }

  removeAgentReferences(id) {
    let changed = false;
    for (const task of this.db.tasks) {
      for (const step of task.plan || []) {
        if (step.agentId === id) {
          step.agentId = '';
          changed = true;
        }
      }
      for (const artifact of task.artifacts || []) {
        if (artifact.agentId === id) {
          artifact.agentId = '';
          changed = true;
        }
      }
    }
    if (changed) this.save();
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

  createTask({ goal, mode = 'auto', workspace = '', debate = null, isolation = 'direct' }) {
    const id = randomUUID();
    let root = path.join(WORKSPACE_DIR, id);
    let external = false;
    let worktree = null;
    if (workspace) {
      const abs = path.resolve(String(workspace).trim());
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
      title: goal.length > 26 ? goal.slice(0, 26) + '…' : goal,
      goal,
      mode,
      // 工作流模式：null 跟随全局设置，debate 先讨论后实施，direct 直接开工
      flowMode: debate === 'direct' || debate === 'debate' ? debate : null,
      status: 'idle',
      createdAt: Date.now(),
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
      artifacts: [],
      runId: null,
      repairRound: 0,
      planVersion: 0,
      planVersions: [],
      autoReplans: [],
      quality: { status: 'pending' },
      debate: { status: 'pending', proposals: [], critiques: [], decision: null },
      stats: { tokens: 0, tokensIn: 0, tokensOut: 0, agentRuns: 0, files: 0, ms: 0 },
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
    this.save();
    this.broadcast({ type: 'task.created', task: this.taskSummary(task) });
    return task;
  }

  taskSummary(task) {
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      mode: task.mode,
      flowMode: task.flowMode || null,
      sourceWorkspace: task.sourceWorkspace || task.workspace,
      worktree: task.worktree ? { ...task.worktree } : null,
      status: task.status,
      createdAt: task.createdAt,
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
      repairRound: task.repairRound || 0,
      planVersion: task.planVersion || 0,
      planVersions: (task.planVersions || []).length,
      quality: task.quality || { status: 'pending' },
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
    if (patch.simSpeed !== undefined)
      s.simSpeed = clamp(patch.simSpeed, 1, 20, s.simSpeed);
    if (patch.defaultMode !== undefined && ['auto', 'cli', 'sim'].includes(patch.defaultMode))
      s.defaultMode = patch.defaultMode;
    this.flush();
    this.broadcast({ type: 'settings.changed', settings: { ...s } });
    return { ...s };
  }

  updateTask(id, patch, event = 'task.updated') {
    const task = this.getTask(id);
    if (!task) return null;
    Object.assign(task, patch);
    this.save();
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
    this.save();
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
    const draft = {
      id: randomUUID(),
      createdAt: Date.now(),
      done: false,
      text: '',
      kind: 'text',
      ...msg,
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
      data: {
        messageId: message.id,
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
    this.save();
    return message;
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
    this.save();
    return n;
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
  }

  /** 直接改写整条消息（用于撤掉「等待输出」这类临时提示） */
  replaceMessage(taskId, messageId, text) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.text = text;
    this.broadcast({ type: 'message.replace', taskId, runId: task.runId || null, id: messageId, text });
  }

  endMessage(taskId, messageId, meta = {}) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.done = true;
    msg.meta = { ...msg.meta, ...meta };
    this.broadcast({ type: 'message.end', taskId, runId: task.runId || null, id: messageId, meta: msg.meta });
    this.save();
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
    this.save();
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
    this.save();
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
    this.save();
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
    this.save();
  }

  /* ---------- debate ---------- */
  _emitDebate(task) {
    this.broadcast({
      type: 'debate.updated',
      taskId: task.id,
      runId: task.runId || null,
      debate: task.debate,
    });
    this.save();
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
    const saved = {
      id: randomUUID(),
      at: Date.now(),
      runId: task.runId || null,
      agentId: '',
      stepId: '',
      type: 'event',
      ...event,
    };
    task.events.push(saved);
    if (task.events.length > MAX_TASK_EVENTS) {
      task.events.splice(0, task.events.length - MAX_TASK_EVENTS);
    }
    this.broadcast({
      type: 'task.event',
      taskId,
      runId: saved.runId || null,
      event: { ...saved },
    });
    this.save();
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
      data: { ...saved },
    });
    this.save();
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
        source: file.source || 'artifact',
      });
    }
    this.save();
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
    this.save();
    return found;
  }
}

export const store = new Store();
export { randomUUID };
