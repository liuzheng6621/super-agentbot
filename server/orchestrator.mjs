import fs from 'node:fs';
import path from 'node:path';
import { store } from './store.mjs';
import * as sim from './sim.mjs';
import { streamText, spawnCli, sleep } from './adapters.mjs';

/** 正在运行的任务：taskId -> {controller} */
const running = new Map();

const STEP_KIND = {
  planner: 'plan',
  architect: 'architect',
  coder: 'coder',
  tester: 'tester',
  reviewer: 'reviewer',
};

function pickAgent(role, fallback = 'coder') {
  return store.findAgentByRole(role) || store.findAgentByRole(fallback) || store.agents[0];
}

function safeJoin(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`非法路径: ${rel}`);
  return target;
}

export function writeWorkspaceFile(task, relPath, content) {
  const abs = safeJoin(task.workspace, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  const lang = path.extname(relPath).slice(1) || 'text';
  store.addArtifact(task.id, {
    path: relPath,
    bytes: Buffer.byteLength(content),
    lang,
    agentId: '',
  });
  return abs;
}

// 用已有仓库开工时，node_modules 这类目录会让扫描爆掉：直接跳过并设上限
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);
const MAX_SCAN_FILES = 20000;

export function listWorkspaceFiles(task) {
  const out = [];
  const walk = (dir, prefix = '', depth = 0) => {
    if (out.length >= MAX_SCAN_FILES || depth > 12) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel, depth + 1);
        if (out.length >= MAX_SCAN_FILES) return;
      } else {
        try {
          out.push({ path: rel, bytes: fs.statSync(path.join(dir, e.name)).size });
        } catch {
          /* 单个文件读不到就算了 */
        }
      }
    }
  };
  walk(task.workspace);
  return out;
}

export function buildContextPack(task, { maxMessages = 6, maxFiles = 80 } = {}) {
  return {
    goal: task.goal,
    workspace: task.workspace,
    status: task.status,
    mode: task.mode,
    files: listWorkspaceFiles(task)
      .filter((f) => f.bytes > 0)
      .slice(0, maxFiles),
    messages: task.messages
      .filter((m) => m.text)
      .slice(-maxMessages)
      .map((m) => ({
        name: m.name || m.role || 'AI',
        role: m.role || '',
        kind: m.kind || 'text',
        text: String(m.text).replace(/\s+/g, ' ').slice(0, 240),
      })),
  };
}

export function buildContextBlock(context, step = '') {
  if (!context) return '';
  return [
    '# 项目上下文',
    `- 目标: ${context.goal}`,
    `- 工作区: ${context.workspace}`,
    `- 状态: ${context.status}`,
    step ? `- 当前工序: ${step}` : '',
    '',
    '# 最近协作摘要',
    context.messages.length
      ? context.messages.map((m) => `- ${m.name}: ${m.text}`).join('\n')
      : '- 暂无',
    '',
    '# 已知文件',
    context.files.length
      ? context.files.map((f) => `- ${f.path} (${f.bytes}B)`).join('\n')
      : '- 暂无',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* 消息流                                                              */
/* ------------------------------------------------------------------ */

async function streamMessage(task, agent, text, { kind = 'text', signal, speed = 1, meta = {} } = {}) {
  const msg = store.addMessage(task.id, {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    color: agent.color,
    kind,
  });
  store.setAgentStatus(agent.id, 'working', agent.title);
  try {
    for await (const chunk of streamText(text, { signal, speed })) {
      store.appendMessage(task.id, msg.id, chunk);
    }
  } finally {
    // 中断 / 异常也要收口，避免消息永远处于 streaming、成员永远显示"工作中"
    store.endMessage(task.id, msg.id, meta);
    store.setAgentStatus(agent.id, 'idle', '');
    const a = store.getAgent(agent.id);
    if (a) {
      a.stats.runs += 1;
      a.stats.tokens += Math.ceil(text.length / 2);
    }
  }
  return msg;
}

async function cliMessage(task, agent, prompt, { kind = 'text', signal, timeout = 180000 } = {}) {
  const msg = store.addMessage(task.id, {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    color: agent.color,
    kind,
    engine: 'cli',
  });
  store.setAgentStatus(agent.id, 'working', `${agent.cli.command} 运行中`);

  const before = new Map(listWorkspaceFiles(task).map((f) => [f.path, f.bytes]));

  // 慢 CLI 也要有反馈：1.2s 内没吐字就先挂一条状态说明，出字后再撤掉
  let hintShown = false;
  let hintTimer = setTimeout(() => {
    hintShown = true;
    store.appendMessage(task.id, msg.id, `> ⏳ 正在执行 \`${agent.cli.command}\`，等待输出…\n\n`);
  }, 1200);
  const clearHint = () => {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
  };

  const res = await spawnCli(agent, prompt, {
    cwd: task.workspace,
    signal,
    timeout,
    onChunk: (d) => {
      clearHint();
      if (hintShown) {
        hintShown = false;
        store.replaceMessage(task.id, msg.id, '');
      }
      store.appendMessage(task.id, msg.id, d);
    },
  });
  clearHint();

  // 很多 CLI 会把版本横幅写到 stderr，成功时别把它当正文塞进回答
  const stderrText = (res.stderr || '').trim();
  if (stderrText && (res.code !== 0 || !res.stdout.trim())) {
    store.appendMessage(task.id, msg.id, `\n\n\`\`\`log\n${stderrText.slice(-1200)}\n\`\`\``);
  }
  if (res.code !== 0 && !res.stdout.trim()) {
    store.appendMessage(
      task.id,
      msg.id,
      `\n\n> ⚠️ CLI 退出码 ${res.code}，没有产生输出。请检查命令模板与环境变量。`,
    );
  }
  store.endMessage(task.id, msg.id, {
    tokens: Math.ceil((res.stdout || '').length / 3),
    ms: res.elapsed,
    exitCode: res.code,
  });

  // 收集 CLI 新增/修改的文件
  const after = listWorkspaceFiles(task);
  for (const f of after) {
    if (f.bytes > 0 && before.get(f.path) !== f.bytes) {
      store.addArtifact(task.id, { path: f.path, bytes: f.bytes, lang: path.extname(f.path).slice(1), agentId: agent.id });
    }
  }

  store.setAgentStatus(agent.id, res.code === 0 ? 'idle' : 'error', res.code === 0 ? '' : `退出码 ${res.code}`);
  const a = store.getAgent(agent.id);
  if (a) a.stats.runs += 1;
  return res;
}

/* ------------------------------------------------------------------ */
/* 编排主流程                                                          */
/* ------------------------------------------------------------------ */

function buildPrompt(task, agent, step, prevText, context = null) {
  return [
    buildContextBlock(context, step?.title || ''),
    `你是「${agent.name}」，团队中的${agent.title}。`,
    '',
    `# 项目目标`,
    task.goal,
    '',
    `# 你当前负责的工序`,
    step ? `${step.title}（角色：${agent.title}）` : '协作讨论',
    '',
    prevText ? `# 前序成员结论摘要\n${prevText}` : '',
    '',
    `# 输出要求`,
    '1. 全程中文，使用 Markdown，结构清晰，不要客套话。',
    '2. 只做你职责范围内的事，不要重复其他人的工作。',
    '3. 需要产出文件的，直接在当前工作目录创建真实文件。',
    '4. 结尾用一行「下一步建议：…」收口。',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPlanPrompt(agent, task, context = null) {
  return [
    buildContextBlock(context, '需求拆解'),
    `你是「${agent.name}」，团队里的${agent.title}。`,
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 你的任务',
    '把目标拆成 3-5 道可执行的工序，说明：',
    '1. 每道工序的负责人角色与产出物',
    '2. 工序之间的依赖顺序',
    '3. 验收标准与主要风险',
    '',
    '不要写代码，不要客套。中文 Markdown，结尾用一行「下一步建议：…」收口。',
  ].join('\n');
}

function buildSummaryPrompt(agent, task, outputs, context = null) {
  return [
    buildContextBlock(context, '交付收口'),
    `你是「${agent.name}」，团队里的${agent.title}。本轮协作已结束，由你做交付收口。`,
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 各成员产出摘要',
    outputs.map((o) => `## ${o.name}\n${o.text.slice(0, 600)}`).join('\n\n'),
    '',
    '# 你的任务',
    '给出交付结论、遗留风险，以及需要用户拍板的 3 件事。中文 Markdown，不要重复成员的原文。',
  ].join('\n');
}

/**
 * 跑一道工序：真实 CLI 或内置模拟，由成员自身的 mode 决定。
 * @returns {Promise<{ok:boolean, text:string, note:string}>}
 */
async function runStep(task, agent, { step, kind, prompt, outputs, signal, speed }) {
  if (!agent) throw new Error('没有可用的智能体');

  if (agent.mode === 'cli') {
    const res = await cliMessage(task, agent, prompt, { kind, signal, timeout: 300000 });
    const last = store.getTask(task.id).messages.at(-1);
    return {
      ok: res.code === 0,
      // 优先用 stdout：消息里可能还夹着 stderr 日志块
      text: (res.stdout || '').trim() || last?.text || '',
      note:
        res.code === 0
          ? `CLI · ${(res.elapsed / 1000).toFixed(1)}s`
          : `CLI 失败 · 退出码 ${res.code}`,
    };
  }

  const out = sim.compose({ kind, goal: task.goal, agent, outputs });
  await streamMessage(task, agent, out.text, { kind, signal, speed, meta: step ? { step: step.title } : {} });
  for (const file of out.artifacts || []) writeWorkspaceFile(task, file.path, file.content);
  if (step?.role === 'architect') {
    writeWorkspaceFile(task, `docs/${sim.pickModule(task.goal).name}-design.md`, sim.designDoc({ goal: task.goal }));
  }
  if (step?.role === 'tester') {
    writeWorkspaceFile(task, 'README.md', readmeFor(task));
  }
  return {
    ok: true,
    text: out.text,
    note: out.artifacts?.length ? `产出 ${out.artifacts.length} 个文件` : '已完成',
  };
}

export function isRunning(taskId) {
  return running.has(taskId);
}

export function stopTask(taskId) {
  const ctx = running.get(taskId);
  if (!ctx) return false;
  ctx.controller.abort();
  running.delete(taskId);
  store.updateTask(taskId, { status: 'stopped', endedAt: Date.now() });
  for (const a of store.agents) if (a.status !== 'idle') store.setAgentStatus(a.id, 'idle', '');
  return true;
}

/**
 * 启动一次完整协作：规划 → 架构 → 实现 → 测试 → 评审 → 收口
 */
export async function startTask(taskId, { speed = 1 } = {}) {
  const task = store.getTask(taskId);
  if (!task || running.has(taskId)) return false;

  const controller = new AbortController();
  const signal = controller.signal;
  running.set(taskId, { controller });
  const startedAt = Date.now();

  store.updateTask(taskId, { status: 'running', endedAt: null });

  try {
    const plan = sim.planFor(task.goal);
    store.setPlan(
      taskId,
      plan.map((s) => ({ ...s, agentId: pickAgent(s.role)?.id })),
    );

    // 规划师先发言并确认编排（CLI 模式下也是真实调用，不再走内置文案）
    const planner = pickAgent('planner');
    if (!planner) throw new Error('团队里还没有任何智能体，请先添加一位规划师');
    const step1 = store.getTask(taskId).plan[0];
    store.updateStep(taskId, step1.id, { status: 'running', agentId: planner.id });

    const outputs = [];
    const context = buildContextPack(task);
    const planRes = await runStep(task, planner, {
      step: step1,
      kind: 'plan',
      prompt: buildPlanPrompt(planner, task, context),
      outputs,
      signal,
      speed,
    });
    outputs.push({ name: planner.name, text: planRes.text });
    store.updateStep(taskId, step1.id, {
      status: planRes.ok ? 'done' : 'error',
      note: planRes.ok && planner.mode !== 'cli' ? '工序已排定，共 4 道下游工序' : planRes.note,
    });
    if (signal.aborted) throw new Error('aborted');
    for (let i = 1; i < store.getTask(taskId).plan.length; i++) {
      if (signal.aborted) throw new Error('aborted');
      const step = store.getTask(taskId).plan[i];
      const agent = store.getAgent(step.agentId) || pickAgent(step.role);
      if (!agent) throw new Error('没有可用的智能体');
      store.updateStep(taskId, step.id, { status: 'running', agentId: agent.id });
      await sleep(320 / speed);

      const prev = outputs.map((o) => `${o.name}: ${o.text.slice(0, 400)}`).join('\n---\n');
      const out = await runStep(task, agent, {
        step,
        kind: STEP_KIND[step.role] || 'text',
        prompt: buildPrompt(task, agent, step, prev, context),
        outputs,
        signal,
        speed,
      });
      outputs.push({ name: agent.name, text: out.text });
      store.updateStep(taskId, step.id, { status: out.ok ? 'done' : 'error', note: out.note });
      await sleep(260 / speed);
    }

    if (signal.aborted) throw new Error('aborted');

    const plannerAgain = pickAgent('planner');
    if (!plannerAgain) throw new Error('没有可用的智能体');
    await runStep(task, plannerAgain, {
      kind: 'summary',
      prompt: buildSummaryPrompt(plannerAgain, task, outputs, context),
      outputs,
      signal,
      speed,
    });

    const ms = Date.now() - startedAt;
    store.updateTask(
      taskId,
      { status: 'done', endedAt: Date.now(), ['stats']: { ...store.getTask(taskId).stats, ms } },
      'task.status',
    );
    running.delete(taskId);
    return true;
  } catch (err) {
    running.delete(taskId);
    const aborted = signal.aborted || /aborted/.test(err.message);
    store.updateTask(
      taskId,
      { status: aborted ? 'stopped' : 'error', endedAt: Date.now(), error: String(err.message) },
      'task.status',
    );
    for (const a of store.agents) if (a.status !== 'idle') store.setAgentStatus(a.id, 'idle', '');
    return false;
  }
}

function readmeFor(task) {
  const mod = sim.pickModule(task.goal);
  return `# ${task.title}\n\n> 由 AgentForge 多智能体协作生成\n\n**目标**：${task.goal}\n\n## 目录\n\n\`\`\`\n.\n├─ src/${mod.name}.js          核心领域模块\n├─ tests/${mod.name}.test.js   自动化测试\n└─ docs/${mod.name}-design.md  技术方案\n\`\`\`\n\n## 运行\n\n\`\`\`bash\nnode tests/${mod.name}.test.js\n\`\`\`\n\n## 成员分工\n\n- **Nova** 规划师 —— 需求拆解与编排\n- **Forge** 架构师 —— 技术方案与契约\n- **Kilo** 实现工程师 —— 代码落地\n- **Probe** 测试工程师 —— 用例与边界\n- **Lens** 代码评审 —— 质量门\n`;
}

/* ------------------------------------------------------------------ */
/* 群聊：@ 某位成员                                                    */
/* ------------------------------------------------------------------ */

export async function chat(taskId, text, { speed = 1 } = {}) {
  const task = store.getTask(taskId);
  if (!task) return false;

  store.addMessage(taskId, {
    agentId: 'user',
    name: '你',
    role: 'user',
    title: 'Owner',
    color: '#94a3b8',
    kind: 'user',
    text,
    done: true,
  });

  try {
    let agent = null;
    const mention = text.match(/@([\w\u4e00-\u9fa5-]+)/);
    if (mention) {
      const key = mention[1].toLowerCase();
      agent = store.agents.find(
        (a) => a.name.toLowerCase() === key || a.role.toLowerCase() === key || a.title === mention[1],
      );
    }
    if (!agent) agent = pickAgent('planner');
    if (!agent) throw new Error('团队里还没有任何智能体');

    const ctx = store.getTask(taskId);
    const context = buildContextPack(ctx);
    const prev = context.messages
      .map((m) => `${m.name}: ${m.text}`)
      .join('\n');

    if (agent.mode === 'cli') {
      const res = await cliMessage(task, agent, buildPrompt(task, agent, null, prev, context) + `\n\n# 用户说\n${text}`, {
        kind: 'text',
      });
      if (res.code !== 0) throw new Error(`CLI 退出码 ${res.code}`);
    } else {
      const out = sim.compose({ kind: 'chat', goal: task.goal, agent, outputs: { userText: text } });
      await streamMessage(task, agent, out.text, { kind: 'text', speed });
    }

    // 冷启动提示：任务还没跑过编排，用户说「开始」就直接开工
    const fresh = store.getTask(taskId);
    if (/^(开始|开工|继续|动手|跑起来|go|start)/i.test(text.trim()) && fresh.status !== 'running') {
      await sleep(400);
      await startTask(taskId, { speed });
    }
    return true;
  } catch (err) {
    const msg = store.addMessage(taskId, {
      agentId: 'system',
      name: '系统',
      role: 'system',
      title: 'ERROR',
      color: '#ff5538',
      kind: 'text',
    });
    store.appendMessage(
      taskId,
      msg.id,
      `> ⚠️ 本轮对话失败：${err.message}\n\n检查该成员的 CLI 命令与参数模板，或先切回「模拟」模式。`,
    );
    store.endMessage(taskId, msg.id, {});
    for (const a of store.agents) if (a.status !== 'idle') store.setAgentStatus(a.id, 'idle', '');
    return false;
  }
}
