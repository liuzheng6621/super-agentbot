import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspaces');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const MAX_MESSAGES = 400;

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
    mode: 'sim',
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
    tasks: [],
    settings: {
      hookToken: randomUUID().replace(/-/g, '').slice(0, 24),
      defaultMode: 'auto',
      simSpeed: 1,
    },
  };
}

class Store {
  constructor() {
    this.db = emptyDb();
    this.listeners = new Set();
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        this.db = {
          agents: Array.isArray(raw.agents) && raw.agents.length ? raw.agents : defaultAgents(),
          tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
          settings: { ...emptyDb().settings, ...(raw.settings || {}) },
        };
        // 运行状态不跨进程保留
        for (const a of this.db.agents) {
          a.status = 'idle';
          a.activity = '';
        }
        for (const t of this.db.tasks) {
          if (t.status === 'running') t.status = 'stopped';
          for (const m of t.messages || []) if (!m.done) m.done = true;
        }
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[store] 读取数据失败，使用默认数据:', err.message);
      this.db = emptyDb();
    }
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 400);
  }

  /** 先写临时文件，再原子替换，避免退出瞬间截断 db.json。 */
  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), 'utf8');
      fs.renameSync(tmp, DB_FILE);
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
  get agents() {
    return this.db.agents;
  }

  getAgent(id) {
    return this.db.agents.find((a) => a.id === id);
  }

  findAgentByRole(role) {
    return this.db.agents.find((a) => a.role === role);
  }

  addAgent(patch) {
    const agent = {
      id: randomUUID(),
      name: patch.name || 'Agent',
      role: patch.role || 'coder',
      title: patch.title || '自定义智能体',
      color: patch.color || '#818cf8',
      tagline: patch.tagline || '',
      skills: patch.skills || [],
      mode: patch.mode === 'cli' ? 'cli' : 'sim',
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
    this.db.agents.push(agent);
    this.save();
    this.broadcast({ type: 'agents.changed' });
    return agent;
  }

  updateAgent(id, patch) {
    const agent = this.getAgent(id);
    if (!agent) return null;
    const prevCli = { ...(agent.cli || {}) };
    Object.assign(agent, patch, { id: agent.id });
    // 先把旧 cli 存下来再合并，否则 Object.assign 已经把 agent.cli 覆盖成新对象了
    if (patch.cli) agent.cli = { ...prevCli, ...patch.cli };
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
    const before = this.db.agents.length;
    this.db.agents = this.db.agents.filter((a) => a.id !== id);
    if (this.db.agents.length !== before) {
      this.save();
      this.broadcast({ type: 'agents.changed' });
      return true;
    }
    return false;
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

  createTask({ goal, mode = 'auto', workspace = '' }) {
    const id = randomUUID();
    let root = path.join(WORKSPACE_DIR, id);
    let external = false;
    if (workspace) {
      const abs = path.resolve(String(workspace).trim());
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch {
        throw new Error(`目录不存在：${abs}`);
      }
      if (!st.isDirectory()) throw new Error(`不是目录：${abs}`);
      root = abs;
      external = true;
    }
    const task = {
      id,
      title: goal.length > 26 ? goal.slice(0, 26) + '…' : goal,
      goal,
      mode,
      status: 'idle',
      createdAt: Date.now(),
      endedAt: null,
      plan: [],
      messages: [],
      artifacts: [],
      stats: { tokens: 0, agentRuns: 0, files: 0, ms: 0 },
      workspace: root,
      // 用已有目录开工时，不替用户新建/改动它的目录结构
      external,
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
      status: task.status,
      createdAt: task.createdAt,
      endedAt: task.endedAt,
      stats: task.stats,
      steps: task.plan.length,
      doneSteps: task.plan.filter((s) => s.status === 'done').length,
      messages: task.messages.length,
      files: task.artifacts.length,
    };
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
  addMessage(taskId, msg) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const message = {
      id: randomUUID(),
      createdAt: Date.now(),
      done: false,
      text: '',
      kind: 'text',
      ...msg,
    };
    task.messages.push(message);
    if (task.messages.length > MAX_MESSAGES) task.messages.splice(0, task.messages.length - MAX_MESSAGES);
    // 已经写完的消息（如用户发言）必须带全量文本，否则前端会渲染成空气泡
    this.broadcast({
      type: 'message.start',
      taskId,
      message: { ...message, text: message.done ? message.text : '' },
    });
    this.save();
    return message;
  }

  appendMessage(taskId, messageId, delta) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.text += delta;
    if (msg.agentId) {
      const agent = this.getAgent(msg.agentId);
      if (agent) agent.stats.tokens += Math.ceil(delta.length / 2);
    }
    task.stats.tokens += Math.ceil(delta.length / 2);
    this.broadcast({ type: 'message.delta', taskId, id: messageId, delta });
  }

  /** 直接改写整条消息（用于撤掉「等待输出」这类临时提示） */
  replaceMessage(taskId, messageId, text) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.text = text;
    this.broadcast({ type: 'message.replace', taskId, id: messageId, text });
  }

  endMessage(taskId, messageId, meta = {}) {
    const task = this.getTask(taskId);
    if (!task) return;
    const msg = task.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.done = true;
    msg.meta = { ...msg.meta, ...meta };
    this.broadcast({ type: 'message.end', taskId, id: messageId, meta: msg.meta });
    this.save();
  }

  /* ---------- plan ---------- */
  setPlan(taskId, steps) {
    const task = this.getTask(taskId);
    if (!task) return;
    task.plan = steps.map((s, i) => ({
      id: `step-${i + 1}`,
      title: s.title,
      role: s.role,
      agentId: s.agentId || '',
      status: 'pending',
      note: '',
    }));
    this.broadcast({ type: 'plan.updated', taskId, plan: task.plan });
    this.save();
  }

  updateStep(taskId, stepId, patch) {
    const task = this.getTask(taskId);
    if (!task) return;
    const step = task.plan.find((s) => s.id === stepId);
    if (!step) return;
    Object.assign(step, patch);
    this.broadcast({ type: 'plan.updated', taskId, plan: task.plan });
    this.save();
  }

  /* ---------- artifacts ---------- */
  addArtifact(taskId, file) {
    const task = this.getTask(taskId);
    if (!task) return;
    const existing = task.artifacts.find((f) => f.path === file.path);
    if (existing) {
      Object.assign(existing, { bytes: file.bytes, updatedAt: Date.now(), agentId: file.agentId });
    } else {
      task.artifacts.push({
        path: file.path,
        bytes: file.bytes,
        lang: file.lang || '',
        agentId: file.agentId || '',
        createdAt: Date.now(),
      });
    }
    task.stats.files = task.artifacts.length;
    this.broadcast({ type: 'artifact.added', taskId, file });
    this.save();
  }
}

export const store = new Store();
export { randomUUID };
