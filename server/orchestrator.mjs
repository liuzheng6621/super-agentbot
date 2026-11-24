import fs from 'node:fs';
import path from 'node:path';
import { store, randomUUID, ROLE_LABEL } from './store.mjs';
import * as sim from './sim.mjs';
import { streamText, spawnCli, sleep } from './adapters.mjs';
import { runDag, throwIfAborted } from './dag.mjs';

/** taskId -> { runId, controller, stopping } */
const running = new Map();
/** agentId -> 正在执行的任务数，避免并行任务把状态互相改回 idle */
const activeAgents = new Map();

const STEP_KIND = {
  planner: 'plan',
  architect: 'architect',
  coder: 'coder',
  tester: 'tester',
  reviewer: 'reviewer',
};

function pickAgent(role, fallback = 'coder') {
  return (
    store.findAgentByRole(role) ||
    store.findAgentByRole(fallback) ||
    store.agents.find((a) => a.seat !== false) ||
    store.agents[0]
  );
}

function safeJoin(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`非法路径: ${rel}`);
  return target;
}

export function writeWorkspaceFile(task, relPath, content, meta = {}) {
  const abs = safeJoin(task.workspace, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  const stat = fs.statSync(abs);
  store.addArtifact(task.id, {
    path: relPath,
    bytes: Buffer.byteLength(content),
    mtimeMs: stat.mtimeMs,
    lang: path.extname(relPath).slice(1) || 'text',
    agentId: meta.agentId || '',
    stepId: meta.stepId || '',
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
          const stat = fs.statSync(path.join(dir, e.name));
          out.push({ path: rel, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* 单个文件读不到就算了 */
        }
      }
    }
  };
  walk(task.workspace);
  return out;
}

export function buildContextPack(task, { maxMessages = 8, maxFiles = 80 } = {}) {
  return {
    goal: task.goal,
    workspace: task.workspace,
    status: task.status,
    mode: task.mode,
    plan: (task.plan || []).map((s) => ({
      id: s.id,
      title: s.title,
      role: s.role,
      status: s.status,
      round: s.round || 0,
    })),
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
        text: String(m.text).replace(/\s+/g, ' ').slice(0, 300),
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
    '# 工序账本',
    context.plan?.length
      ? context.plan.map((s) => `- [${s.status}] ${ROLE_LABEL[s.role] || s.role} · ${s.title}`).join('\n')
      : '- 暂无',
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
/* 成员状态                                                             */
/* ------------------------------------------------------------------ */

function beginAgent(agent, activity = '') {
  const count = (activeAgents.get(agent.id) || 0) + 1;
  activeAgents.set(agent.id, count);
  store.setAgentStatus(agent.id, 'working', activity || `${ROLE_LABEL[agent.role] || agent.role}工序执行中`);
}

function endAgent(agent, { failed = false, activity = '' } = {}) {
  const count = Math.max(0, (activeAgents.get(agent.id) || 1) - 1);
  if (count > 0) {
    activeAgents.set(agent.id, count);
    store.setAgentStatus(agent.id, 'working', '并行任务执行中');
  } else {
    activeAgents.delete(agent.id);
    store.setAgentStatus(agent.id, failed ? 'error' : 'idle', failed ? activity : '');
  }
}

function recordRun(task, agent) {
  // 主持人可能是不存在的兜底对象，统计只对真实成员生效
  if (!agent?.stats) return;
  agent.stats.runs = (agent.stats.runs || 0) + 1;
  task.stats.agentRuns = (task.stats.agentRuns || 0) + 1;
  store.save();
}

/* ------------------------------------------------------------------ */
/* 消息流                                                              */
/* ------------------------------------------------------------------ */

async function streamMessage(task, agent, text, { kind = 'text', signal, speed = 1, meta = {}, message = {} } = {}) {
  const msg = store.addMessage(task.id, {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    color: agent.color,
    kind,
    ...message,
  });
  beginAgent(agent, `${ROLE_LABEL[agent.role] || agent.role}发言中`);
  try {
    for await (const chunk of streamText(text, { signal, speed })) {
      store.appendMessage(task.id, msg.id, chunk);
    }
  } finally {
    store.endMessage(task.id, msg.id, meta);
    endAgent(agent);
    recordRun(task, agent);
  }
  return msg;
}

async function cliMessage(task, agent, prompt, { kind = 'text', signal, timeout = 300000, message = {} } = {}) {
  const msg = store.addMessage(task.id, {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    color: agent.color,
    kind,
    engine: 'cli',
    ...message,
  });
  beginAgent(agent, `${agent.cli?.command || 'CLI'} 运行中`);

  const before = new Map(listWorkspaceFiles(task).map((f) => [f.path, f]));
  let hintShown = false;
  let hintTimer = setTimeout(() => {
    hintShown = true;
    store.appendMessage(task.id, msg.id, `> ⏳ 正在执行 \`${agent.cli?.command}\`，等待输出…\n\n`);
  }, 1200);
  const clearHint = () => {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
  };

  let res;
  try {
    res = await spawnCli(agent, prompt, {
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
  } catch (err) {
    res = { code: -1, stdout: '', stderr: err.message, elapsed: 0 };
  }
  clearHint();

  // 很多 CLI 会把版本横幅写到 stderr，成功时别把它当正文塞进回答
  const stderrText = (res.stderr || '').trim();
  if (stderrText && (res.code !== 0 || !res.stdout.trim())) {
    store.appendMessage(task.id, msg.id, `\n\n\`\`\`log\n${stderrText.slice(-1600)}\n\`\`\``);
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

  // 收集 CLI 新增/修改的文件；mtime + size 能识别等长改写
  const after = listWorkspaceFiles(task);
  for (const f of after) {
    const prev = before.get(f.path);
    if (!prev || prev.bytes !== f.bytes || prev.mtimeMs !== f.mtimeMs) {
      store.addArtifact(task.id, {
        path: f.path,
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
        lang: path.extname(f.path).slice(1),
        agentId: agent.id,
        stepId: agent.currentStepId || '',
      });
    }
  }

  const failed = res.code !== 0 && res.code !== -4;
  endAgent(agent, { failed, activity: failed ? `退出码 ${res.code}` : '' });
  recordRun(task, agent);
  return { ...res, messageId: msg.id };
}

/* ------------------------------------------------------------------ */
/* 提示词                                                               */
/* ------------------------------------------------------------------ */

function clip(text, max = 6000) {
  const value = String(text || '');
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.75);
  const tail = Math.floor(max * 0.2);
  return `${value.slice(0, head)}\n\n…（中间省略 ${value.length - head - tail} 字）…\n\n${value.slice(-tail)}`;
}

function dependencyText(step, outputs) {
  if (!step?.needs?.length) return '无（可以从项目上下文开始）';
  return step.needs
    .map((id) => {
      const out = outputs.get(id);
      if (!out) return `## ${id}\n（上游未产出）`;
      return `## ${ROLE_LABEL[out.role] || out.role} · ${out.name}\n工序：${out.title}\n\n${clip(out.text)}`;
    })
    .join('\n\n---\n\n');
}

function buildPrompt(task, agent, step, depsText, context, extra = {}) {
  const role = step?.role || agent.role;
  const lines = [
    buildContextBlock(context, step?.title || ''),
    `你是「${agent.name}」，团队中的${agent.title}。`,
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 你当前负责的工序',
    step ? `${step.title}（角色：${ROLE_LABEL[role] || role}）` : '协作讨论',
    '',
    '# 依赖工序的真实产物',
    depsText || '无',
    '',
    extra.repairRound ? `# 返工轮次\n这是第 ${extra.repairRound} 轮修复。只处理评审阻塞项，不要扩大改动范围。` : '',
    extra.decision
      ? [
          '# 已裁决的方案（必须遵循）',
          `方案 ${extra.decision.winnerId} · ${extra.decision.winnerName} 提出 · 平均 ${extra.decision.average} 分 · ${extra.decision.votes} 票`,
          '',
          clip(extra.decision.brief, 2400),
          '',
          '这是团队讨论后的裁决结果。不要擅自更换技术路线；如果你认为方案有硬伤，写在结尾并说明，但不要自行改道。',
        ].join('\n')
      : '',
    extra.quality
      ? `# 自动化质量门\n状态：${extra.quality.status}\n${extra.quality.log ? `\n\`\`\`log\n${clip(extra.quality.log, 3000)}\n\`\`\`` : ''}`
      : '',
    '',
    '# 输出要求',
    '1. 全程中文，使用 Markdown，结构清晰，不要客套话。',
    '2. 只做你职责范围内的事。实现工程师改业务代码，测试工程师只改测试，不要互相覆盖。',
    '3. 需要产出文件的，直接在当前工作目录创建真实文件。',
  ];
  if (role === 'reviewer') {
    lines.push(
      '4. 必须先检查质量门结果，再按严重程度列 Blocker / Should。',
      '5. 最后一行必须单独输出 `VERDICT: PASS` 或 `VERDICT: FAIL`，不能省略。',
      '6. 只有没有 Blocker 且质量门通过时才能 PASS。',
    );
  } else {
    lines.push('4. 结尾用一行「下一步建议：…」收口。');
  }
  return lines.filter((line) => line !== '').join('\n');
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
    '把目标拆成可验收的工序，确认每道工序的负责人角色、依赖关系、产出物与验收标准。',
    '团队已有规划、架构、实现、测试、评审五个执行席位，不要把所有工作都分给实现工程师。',
    '',
    '不要写业务代码，不要客套。中文 Markdown，结尾用一行「下一步建议：…」收口。',
  ].join('\n');
}

function buildSummaryPrompt(agent, task, outputs, context, extra = {}) {
  return [
    buildContextBlock(context, '交付收口'),
    `你是「${agent.name}」，团队里的${agent.title}。本轮协作已结束，由你做交付收口。`,
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 各成员产出',
    outputs
      .map((o) => `## ${ROLE_LABEL[o.role] || o.role} · ${o.name}\n${clip(o.text, 1800)}`)
      .join('\n\n'),
    '',
    '# 质量结论',
    `- 评审：${extra.passed ? '通过' : '未通过'}`,
    `- 返工轮次：${extra.repairRound || 0}`,
    `- 自动化质量门：${extra.quality?.status || 'skipped'}`,
    '',
    '# 你的任务',
    '给出交付结论、遗留风险，以及需要用户拍板的 3 件事。不要宣称未通过的工序已经完成。中文 Markdown。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseReviewVerdict(text) {
  const value = String(text || '');
  const marker = value.match(/(?:VERDICT|质量门结论)\s*[:：]\s*(PASS|FAIL|不通过|通过)/i);
  if (marker) {
    const normalized = marker[1].toUpperCase();
    return normalized === 'PASS' || normalized === '通过';
  }
  const conclusion = value.match(/结论\s*[:：]\s*\**\s*(有条件通过|不通过|未通过|通过)/);
  if (conclusion) return conclusion[1] === '通过';
  return null;
}

/* ------------------------------------------------------------------ */
/* 方案讨论：独立提案 → 交叉质询 → 主持人裁决                          */
/* ------------------------------------------------------------------ */

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function debateConfig() {
  return {
    enabled: store.db.settings.debateEnabled !== false,
    size: clampNum(store.db.settings.debateParticipants, 2, 6, 4),
    poolSeats: clampNum(store.db.settings.debatePoolSeats, 0, 3, 1),
    concurrency: clampNum(store.db.settings.debateConcurrency, 1, 4, 2),
  };
}

/**
 * 讨论组：优先不同执行席位，再补工具池里的 CLI 作为外部视角。
 * 主持人（规划席位）不参与提案，避免既当运动员又当裁判。
 */
export function selectDebateRoster(judge, { size = 4, poolSeats = 1 } = {}, forced = []) {
  const picked = [];
  const push = (agent) => {
    if (!agent || agent.id === judge?.id) return;
    if (picked.some((a) => a.id === agent.id)) return;
    picked.push(agent);
  };

  const limit = Math.max(2, size);
  if (forced.length >= 2) {
    for (const id of forced) {
      if (picked.length >= limit) break;
      push(store.getAgent(id));
    }
  }

  for (const role of ['architect', 'coder', 'tester', 'reviewer']) {
    if (picked.length >= limit) break;
    push(store.findAgentByRole(role));
  }

  if (picked.length < limit) {
    const pool = store.agents.filter((a) => a.seat === false && a.id !== judge?.id);
    // CLI 成员优先：它们代表团队之外的第二意见。
    const ordered = [...pool.filter((a) => a.mode === 'cli'), ...pool.filter((a) => a.mode !== 'cli')];
    for (const agent of ordered.slice(0, poolSeats)) {
      if (picked.length >= limit) break;
      push(agent);
    }
  }

  return picked;
}

export function parseProposalScores(text, { selfId = '' } = {}) {
  const scores = {};
  const value = String(text || '');
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    const id = cells[0].replace(/[*`]/g, '').trim();
    if (!/^[A-F]$/.test(id) || id === selfId) continue;
    const score = Number(String(cells[1]).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(score) || score < 1 || score > 10) continue;
    scores[id] = Math.round(score * 10) / 10;
  }
  for (const match of value.matchAll(/方案\s*([A-F])\s*[:：]\s*(\d{1,2}(?:\.\d)?)/g)) {
    const id = match[1];
    const score = Number(match[2]);
    if (id === selfId || scores[id] != null) continue;
    if (score >= 1 && score <= 10) scores[id] = score;
  }
  return scores;
}

export function rankProposals(proposals = []) {
  const list = proposals
    .filter((p) => p.status !== 'failed')
    .map((p) => {
      const votes = p.votes || [];
      const average = votes.length
        ? votes.reduce((sum, v) => sum + Number(v.score || 0), 0) / votes.length
        : null;
      return {
        id: p.id,
        name: p.name,
        agentId: p.agentId,
        angleKey: p.angleKey,
        angleLabel: sim.angleByKey(p.angleKey).label,
        average,
        votes: votes.length,
        text: p.text || '',
      };
    });

  list.sort((a, b) => {
    if (a.average == null && b.average == null) return a.id.localeCompare(b.id);
    if (a.average == null) return 1;
    if (b.average == null) return -1;
    if (Math.abs(b.average - a.average) > 1e-9) return b.average - a.average;
    if (b.votes !== a.votes) return b.votes - a.votes;
    return a.id.localeCompare(b.id);
  });
  return list;
}

function buildProposalPrompt(task, agent, angle, context) {
  return [
    buildContextBlock(context, `方案提案 · ${angle.label}`),
    `你是「${agent.name}」，团队里的${agent.title || ROLE_LABEL[agent.role] || '成员'}。`,
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 本轮是方案评审会，不是执行',
    `你被分配的主张是「${angle.label}」：${angle.tag}。请站在这个立场，给出一个能落地的完整方案。`,
    '',
    '# 必须包含',
    '1. 核心主张：为什么这条路适合当前目标',
    '2. 技术路线：模块划分、关键数据结构、存储与错误处理',
    '3. 落地工序：表格，列 工序 / 负责角色 / 产出 / 依赖',
    '4. 代价与风险：至少 2 条，必须写清自己方案的短板',
    '5. 工作量估计',
    '',
    '# 硬约束',
    '- 只输出方案文本，不要创建、修改、删除任何文件。',
    '- 不要写完整代码，不要客套话，中文 Markdown，800 字以内。',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildCritiquePrompt(task, agent, own, others) {
  return [
    `你是「${agent.name}」，团队里的${agent.title || ROLE_LABEL[agent.role] || '成员'}。现在进入交叉质询。`,
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 待评审方案（匿名，按编号）',
    others.map((p) => `## 方案 ${p.id} · ${p.angle.label}\n${clip(p.text, 2200)}`).join('\n\n---\n\n'),
    '',
    '# 你的任务',
    '1. 给每一份方案打 1-10 分，必须给出关键理由和一个硬伤。',
    `2. 不要给自己方案打分${own ? `（你的方案是 ${own.id}）` : ''}。`,
    '3. 输出表格，格式严格为：| 方案 | 评分 | 关键理由 | 硬伤 |',
    '4. 最后一段说明你会选哪一个，以及为什么。',
    '',
    '只输出评审文本，不要修改任何文件。',
  ].join('\n');
}

function buildDecisionPrompt(task, judge, ranking, winner) {
  return [
    `你是「${judge.name}」，本轮方案讨论的主持人。成员已经完成提案与交叉评分，现在由你宣布裁决。`,
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 评分汇总',
    ranking
      .map(
        (p) =>
          `- 方案 ${p.id}（${p.name}，${p.angleLabel}）：${
            p.average == null ? '无有效评分' : `${p.average.toFixed(1)} 分 / ${p.votes} 票`
          }`,
      )
      .join('\n'),
    '',
    `评分最高的是方案 ${winner.id}。`,
    '',
    '# 你的任务',
    '写一段裁决说明：为什么采纳它、从其他方案里吸收什么、实施时的 3 条硬约束。',
    '不要修改评分结果，不要客套，中文 Markdown。',
  ].join('\n');
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runProposal(task, agent, { id, index, speed, signal }) {
  const angle = sim.angleByIndex(index);
  store.addProposal(task.id, {
    id,
    agentId: agent.id,
    name: agent.name,
    color: agent.color,
    role: agent.role,
    mode: agent.mode,
    angleKey: angle.key,
    angleLabel: angle.label,
  });

  try {
    if (agent.mode === 'cli') {
      const res = await cliMessage(task, agent, buildProposalPrompt(task, agent, angle, buildContextPack(task)), {
        kind: 'proposal',
        signal,
        timeout: 150000,
        message: { debate: { phase: 'proposal', proposalId: id } },
      });
      const text = (res.stdout || '').trim();
      const ok = res.code === 0 && text.length >= 40;
      const note = ok ? `CLI · ${(res.elapsed / 1000).toFixed(1)}s` : `提案失败 · 退出码 ${res.code}`;
      store.updateProposal(task.id, id, {
        status: ok ? 'done' : 'failed',
        text: ok ? clip(text, 5000) : clip((res.stderr || '').trim(), 600),
        messageId: res.messageId,
        note,
      });
      return { id, agent, angle, ok, text: ok ? text : '', note, messageId: res.messageId };
    }

    const out = sim.proposalFor({ goal: task.goal, agent, index, id });
    const msg = await streamMessage(task, agent, out.text, {
      kind: 'proposal',
      signal,
      speed,
      message: { debate: { phase: 'proposal', proposalId: id } },
    });
    store.updateProposal(task.id, id, {
      status: 'done',
      text: out.text,
      messageId: msg.id,
      note: `内置提案 · ${angle.label}`,
    });
    return { id, agent, angle, ok: true, text: out.text, messageId: msg.id };
  } catch (err) {
    if (signal?.aborted) throw err;
    store.updateProposal(task.id, id, { status: 'failed', note: err.message });
    return { id, agent, angle, ok: false, text: '', error: err.message };
  }
}

async function runCritique(task, agent, { index, proposals, speed, signal }) {
  const own = proposals.find((p) => p.agent.id === agent.id);
  const others = proposals.filter((p) => p.agent.id !== agent.id);
  if (!others.length) {
    store.addCritique(task.id, {
      agentId: agent.id,
      name: agent.name,
      color: agent.color,
      ok: false,
      note: '没有可评审的其他方案',
    });
    return { ok: false, agent, scores: [] };
  }

  const view = proposals.map((p) => ({
    id: p.id,
    angleKey: p.angle.key,
    own: p.agent.id === agent.id,
  }));

  try {
    let text = '';
    let scores = {};
    let reasons = {};
    if (agent.mode === 'cli') {
      const res = await cliMessage(task, agent, buildCritiquePrompt(task, agent, own, others), {
        kind: 'critique',
        signal,
        timeout: 150000,
        message: { debate: { phase: 'critique', selfId: own?.id || '' } },
      });
      text = (res.stdout || '').trim();
      scores = parseProposalScores(text, { selfId: own?.id || '' });
      if (res.code !== 0 || !text) throw new Error(`质询失败 · 退出码 ${res.code}`);
    } else {
      const out = sim.critiqueFor({ goal: task.goal, agent, index, proposals: view });
      await streamMessage(task, agent, out.text, {
        kind: 'critique',
        signal,
        speed,
        message: { debate: { phase: 'critique', selfId: own?.id || '' } },
      });
      text = out.text;
      scores = Object.fromEntries(out.scores.map((s) => [s.id, s.score]));
      reasons = Object.fromEntries(out.scores.map((s) => [s.id, s.reason || '']));
    }

    const valid = proposals.filter((p) => p.id !== own?.id && scores[p.id] != null);
    for (const p of valid) {
      store.addVote(task.id, p.id, {
        byId: agent.id,
        byName: agent.name,
        score: scores[p.id],
        reason: reasons?.[p.id] || '',
      });
    }
    store.addCritique(task.id, {
      agentId: agent.id,
      name: agent.name,
      color: agent.color,
      ok: true,
      count: valid.length,
      note: valid.length ? `已评 ${valid.length} 份方案` : '未解析到有效评分',
    });
    return { ok: valid.length > 0, agent, scores };
  } catch (err) {
    if (signal?.aborted) throw err;
    store.addCritique(task.id, {
      agentId: agent.id,
      name: agent.name,
      color: agent.color,
      ok: false,
      note: err.message,
    });
    return { ok: false, agent, scores: [] };
  }
}

/**
 * 跑完整方案讨论。返回 { decision, ranking, participants }；没有有效提案时抛错。
 */
export async function runDebate(task, { speed = 1, signal, forced = [] } = {}) {
  const cfg = debateConfig();
  const judge = pickAgent('planner') || pickAgent('reviewer');
  if (!cfg.enabled) {
    store.setDebate(task.id, { status: 'skipped', reason: '方案讨论已关闭' });
    return null;
  }

  const roster = selectDebateRoster(judge, cfg, forced);
  if (roster.length < 2) {
    store.setDebate(task.id, {
      status: 'skipped',
      reason: `可用成员不足（${roster.length} 位），跳过讨论直接实施`,
    });
    return null;
  }

  store.setDebate(task.id, {
    status: 'proposing',
    judgeId: judge?.id || '',
    judgeName: judge?.name || '主持人',
    participants: roster.map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      role: a.role,
      mode: a.mode,
      seat: a.seat !== false,
    })),
    proposals: [],
    critiques: [],
    decision: null,
    forced: forced.length >= 2,
  });

  const intro = store.addMessage(task.id, {
    agentId: 'system',
    name: '编排器',
    role: 'system',
    title: 'ORCHESTRATOR',
    color: '#a78bfa',
    kind: 'debate-intro',
    done: true,
    text: `**进入方案讨论**\n\n本轮由 ${roster.length} 位成员独立提案：${roster
      .map((a) => `**${a.name}**`)
      .join('、')}。\n\n规则：各自出方案 → 互相匿名评分 → **${judge?.name || '规划席位'}** 主持裁决 → 按最优方案实施。\n提案阶段不写业务代码，避免互相覆盖；讨论结果会写进执行链路。`,
  });
  store.endMessage(task.id, intro.id, {});
  await sleep(240, signal);

  const proposals = await mapPool(roster, cfg.concurrency, async (agent, index) => {
    const id = String.fromCharCode(65 + index);
    return runProposal(task, agent, { id, index, speed, signal });
  });
  throwIfAborted(signal);

  const valid = proposals.filter((p) => p.ok);
  if (!valid.length) {
    const reasons = proposals.map((p) => `${p.agent.name}: ${p.note || p.error || '无输出'}`).join('；');
    store.setDebate(task.id, { status: 'failed', reason: `没有有效提案：${reasons}` });
    const msg = store.addMessage(task.id, {
      agentId: 'system',
      name: '编排器',
      role: 'system',
      title: 'ORCHESTRATOR',
      color: '#ff5538',
      kind: 'debate-intro',
      done: true,
      text: `**方案讨论没有产生有效提案**\n\n${reasons}\n\n本轮跳过裁决，按默认路线继续实施。请检查这些成员的命令模板、API 地址或凭据（例如网关返回 405 时，提案和实现都会失败）。`,
    });
    store.endMessage(task.id, msg.id, {});
    return null;
  }

  store.setDebate(task.id, { status: 'critiquing' });
  const critiques = await mapPool(roster, cfg.concurrency, async (agent, index) =>
    runCritique(task, agent, { index, proposals: valid, speed, signal }),
  );
  throwIfAborted(signal);

  const latest = store.getTask(task.id).debate;
  const ranking = rankProposals(latest.proposals);
  const winner = ranking[0];
  const voteCount = ranking.reduce((sum, p) => sum + p.votes, 0);
  const confidence = winner.average == null ? 'low' : voteCount >= ranking.length ? 'high' : 'medium';

  const decision = {
    winnerId: winner.id,
    winnerName: winner.name,
    winnerAgentId: winner.agentId,
    angleKey: winner.angleKey,
    angleLabel: winner.angleLabel,
    average: winner.average == null ? null : Math.round(winner.average * 10) / 10,
    votes: winner.votes,
    judgeId: judge?.id || '',
    judgeName: judge?.name || '编排器',
    confidence,
    brief: clip(winner.text, 2000),
    ranking: ranking.map(({ text, ...rest }) => rest),
    critiqueCount: critiques.filter((c) => c.ok).length,
    decidedAt: Date.now(),
  };

  const decisionText =
    winner.average == null
      ? `**裁决：方案 ${winner.id} · ${winner.angleLabel}**\n\n本轮交叉评分不足，无法比较，按风险最小的顺序临时采纳方案 ${winner.id}（${winner.name}）。建议下一轮补齐质询。`
      : sim.decisionFor({
          goal: task.goal,
          ranking,
          winner,
          judge,
          participants: roster.length,
        });

  try {
    if (judge?.mode === 'cli') {
      const res = await cliMessage(task, judge, buildDecisionPrompt(task, judge, ranking, winner), {
        kind: 'decision',
        signal,
        timeout: 120000,
        message: { debate: { phase: 'decision', winnerId: winner.id } },
      });
      if (res.code !== 0 || !res.stdout.trim()) throw new Error('裁决说明生成失败');
    } else {
      await streamMessage(task, judge || { id: 'system', name: '编排器', role: 'planner', title: 'ORCHESTRATOR', color: '#a78bfa' }, decisionText, {
        kind: 'decision',
        signal,
        speed,
        message: { debate: { phase: 'decision', winnerId: winner.id } },
      });
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = store.addMessage(task.id, {
      agentId: 'system',
      name: '编排器',
      role: 'system',
      title: 'DECISION',
      color: '#a78bfa',
      kind: 'decision',
      done: true,
      text: `${decisionText}\n\n> 主持人 CLI 未能生成裁决说明（${err.message}），以上结论由评分结果自动生成。`,
    });
    store.endMessage(task.id, msg.id, {});
  }

  store.setDecision(task.id, decision);
  return { decision, ranking, participants: roster };
}

/* ------------------------------------------------------------------ */
/* 工序执行                                                             */
/* ------------------------------------------------------------------ */

async function runStep(task, agent, { step, kind, prompt, signal, speed, simOutputs }) {
  if (!agent) throw new Error('没有可用的智能体');
  if (agent.mode === 'cli') {
    agent.currentStepId = step?.id || '';
    const res = await cliMessage(task, agent, prompt, { kind, signal, timeout: 300000 });
    const msg = store.getTask(task.id).messages.find((m) => m.id === res.messageId);
    return {
      ok: res.code === 0,
      code: res.code,
      text: (res.stdout || '').trim() || msg?.text || '',
      note:
        res.code === 0
          ? `CLI · ${(res.elapsed / 1000).toFixed(1)}s`
          : res.code === -3
            ? 'CLI 超时'
            : `CLI 失败 · 退出码 ${res.code}`,
    };
  }

  const out = sim.compose({
    kind,
    goal: task.goal,
    agent,
    outputs: simOutputs || {},
  });
  await streamMessage(task, agent, out.text, {
    kind,
    signal,
    speed,
    meta: step ? { step: step.title } : {},
  });
  throwIfAborted(signal);
  for (const file of out.artifacts || []) {
    writeWorkspaceFile(task, file.path, file.content, {
      agentId: agent.id,
      stepId: step?.id || '',
    });
  }
  if (step?.role === 'architect') {
    const mod = sim.pickModule(task.goal);
    writeWorkspaceFile(task, `docs/${mod.name}-design.md`, sim.designDoc({ goal: task.goal }), {
      agentId: agent.id,
      stepId: step.id,
    });
  }
  if (step?.role === 'tester') {
    writeWorkspaceFile(task, 'README.md', readmeFor(task), { agentId: agent.id, stepId: step.id });
  }
  return {
    ok: true,
    text: out.text,
    note: out.artifacts?.length ? `产出 ${out.artifacts.length} 个文件` : '已完成',
  };
}

async function runStepWithRetry(task, agent, options) {
  const configured = agent.mode === 'cli' ? Number(store.db.settings.maxStepAttempts) || 2 : 1;
  const maxAttempts = Math.max(1, configured);
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.step) {
      store.updateStep(task.id, options.step.id, {
        attempt,
        maxAttempts,
        status: 'running',
        startedAt: Date.now(),
      });
    }
    last = await runStep(task, agent, options);
    if (last.ok || last.code !== -3 || attempt >= maxAttempts || options.signal?.aborted) {
      return { ...last, attempt };
    }
    if (options.step) {
      store.updateStep(task.id, options.step.id, {
        status: 'retrying',
        note: `超时，准备第 ${attempt + 1} 次尝试`,
      });
    }
    await sleep(400 * attempt, options.signal);
  }
  return { ...last, attempt: maxAttempts };
}

function testFileForTask(task) {
  return `tests/${sim.pickModule(task.goal).name}.test.js`;
}

async function runQualityGate(task, step, signal) {
  const plan = store.getTask(task.id).plan;
  const implementation = [...plan].reverse().find((s) => s.role === 'coder' && s.status === 'done');
  const testDesign = [...plan].reverse().find((s) => s.role === 'tester' && s.status === 'done');
  const coder = implementation && store.getAgent(implementation.agentId);
  const tester = testDesign && store.getAgent(testDesign.agentId);
  const rel = testFileForTask(task);
  const abs = path.join(task.workspace, rel);

  if (task.external || coder?.mode === 'cli' || tester?.mode === 'cli') {
    const quality = {
      status: 'skipped',
      reason: '真实 CLI 任务不自动执行生成代码，以评审 VERDICT 作为质量门',
      checkedAt: Date.now(),
      round: step?.round || 0,
    };
    store.updateTask(task.id, { quality });
    return quality;
  }
  if (!fs.existsSync(abs)) {
    const quality = {
      status: 'failed',
      reason: `未找到测试文件 ${rel}`,
      code: -1,
      log: '',
      checkedAt: Date.now(),
      round: step?.round || 0,
    };
    store.updateTask(task.id, { quality });
    return quality;
  }

  store.updateTask(task.id, {
    quality: { status: 'running', command: `node ${rel}`, round: step?.round || 0 },
  });
  const res = await spawnCli(
    { cli: { command: process.execPath, args: [rel] } },
    '',
    { cwd: task.workspace, timeout: 30000, signal },
  );
  throwIfAborted(signal);

  const status = res.code === 0 ? 'passed' : 'failed';
  const quality = {
    status,
    command: `node ${rel}`,
    code: res.code,
    log: clip(`${res.stdout}\n${res.stderr}`.trim(), 4000),
    checkedAt: Date.now(),
    round: step?.round || 0,
  };
  store.updateTask(task.id, { quality });

  const msg = store.addMessage(task.id, {
    agentId: 'system',
    name: '质量门',
    role: 'system',
    title: 'GATE',
    color: status === 'passed' ? '#34d399' : '#ff5538',
    kind: 'quality',
    done: true,
    text: `**自动化质量门 · ${status === 'passed' ? '通过' : '未通过'}**\n\n- 命令：\`${quality.command}\`\n- 退出码：\`${res.code}\`${
      quality.log ? `\n\n\`\`\`log\n${clip(quality.log, 1800)}\n\`\`\`` : ''
    }`,
  });
  store.endMessage(task.id, msg.id, {});
  return quality;
}

async function executeSteps(task, steps, { outputs, speed, signal }) {
  return runDag(steps, {
    completed: [...outputs.keys()],
    maxConcurrency: Math.max(1, Number(store.db.settings.maxConcurrency) || 2),
    signal,
    onUpdate: (stepId, patch) => store.updateStep(task.id, stepId, patch),
    run: async (step) => {
      const latest = store.getTask(task.id);
      const agent = store.getAgent(step.agentId) || pickAgent(step.role);
      if (!agent) return { ok: false, note: `没有可用的${ROLE_LABEL[step.role] || step.role}成员` };
      store.updateStep(task.id, step.id, { agentId: agent.id });
      agent.currentStepId = step.id;

      const extra = { repairRound: step.round || 0, decision: latest.debate?.decision || null };
      if (step.role === 'reviewer') {
        extra.quality = await runQualityGate(latest, step, signal);
      }
      const context = buildContextPack(latest);
      const depsText = dependencyText(step, outputs);
      const prompt = buildPrompt(latest, agent, step, depsText, context, extra);
      const simOutputs = {
        ...Object.fromEntries([...outputs].map(([id, value]) => [id, value.text])),
        steps: Object.fromEntries([...outputs]),
        repairRound: extra.repairRound,
        quality: extra.quality,
        decision: extra.decision,
      };

      const out = await runStepWithRetry(latest, agent, {
        step,
        kind: STEP_KIND[step.role] || 'text',
        prompt,
        signal,
        speed,
        simOutputs,
      });
      if (out.ok && step.role === 'reviewer') {
        const verdict = parseReviewVerdict(out.text);
        out.verdict = verdict === true ? 'pass' : verdict === false ? 'fail' : 'unknown';
        out.passed = verdict === true && extra.quality?.status !== 'failed';
        out.note = out.passed
          ? '质量门通过'
          : verdict === null
            ? '缺少明确评审结论'
            : '未通过，进入返工';
      }
      if (out.ok) {
        outputs.set(step.id, {
          stepId: step.id,
          title: step.title,
          role: step.role,
          name: agent.name,
          text: out.text,
          passed: out.passed,
          verdict: out.verdict,
        });
      }
      return out;
    },
  });
}

function roleAgent(role) {
  const agent = pickAgent(role);
  return { agent, maxAttempts: agent?.mode === 'cli' ? Number(store.db.settings.maxStepAttempts) || 2 : 1 };
}

function planWithSeats(goal) {
  return sim.planFor(goal).map((step) => {
    const { agent, maxAttempts } = roleAgent(step.role);
    return { ...step, agentId: agent?.id || '', maxAttempts };
  });
}

function describeFailure(result, plan) {
  const failedId = [...result.results.entries()].find(([, value]) => value?.ok === false)?.[0];
  const step = plan.find((s) => s.id === failedId);
  return step ? `${step.title}：${step.note || '执行失败'}` : '有工序执行失败';
}

export function isRunning(taskId) {
  return running.has(taskId);
}

export function stopTask(taskId) {
  const ctx = running.get(taskId);
  if (!ctx || ctx.stopping) return false;
  ctx.stopping = true;
  ctx.controller.abort();
  store.updateTask(taskId, { status: 'stopping' }, 'task.status');
  return true;
}

/**
 * 启动一次协作：
 * 规划 → 架构 → 实现 / 测试设计并行 → 测试质量门 → 评审 →（按需返工）→ 收口
 */
export async function startTask(taskId, { speed = 1, participants = [] } = {}) {
  const task = store.getTask(taskId);
  if (!task || running.has(taskId)) return false;

  const runId = randomUUID();
  const controller = new AbortController();
  const state = { runId, controller, stopping: false };
  running.set(taskId, state);
  const signal = controller.signal;
  const startedAt = Date.now();

  store.updateTask(taskId, {
    status: 'running',
    endedAt: null,
    error: null,
    runId,
    repairRound: 0,
    quality: { status: 'pending' },
    stats: { ...task.stats, ms: 0 },
  });

  try {
    const judge = pickAgent('planner');
    const initial = [
      {
        id: 'debate',
        title: '多智能体方案讨论与裁决',
        role: 'planner',
        needs: [],
        agentId: judge?.id || '',
        outputPaths: [],
      },
      ...planWithSeats(task.goal).map((step) => (step.id === 'plan' ? { ...step, needs: ['debate'] } : step)),
    ];
    store.setPlan(taskId, initial);
    const outputs = new Map();

    // 先讨论、后动手：多个成员各出一版方案，交叉评分，裁决后再实施。
    let debate = null;
    store.updateStep(taskId, 'debate', { status: 'running', startedAt: Date.now(), note: '提案中' });
    try {
      debate = await runDebate(task, { speed, signal, forced: participants });
    } catch (err) {
      if (signal.aborted) throw err;
      store.updateStep(taskId, 'debate', { status: 'error', note: err.message, endedAt: Date.now() });
      throw err;
    }

    const decision = debate?.decision;
    if (decision) {
      store.updateStep(taskId, 'debate', {
        status: 'done',
        agentId: decision.judgeId || judge?.id || '',
        title: `方案讨论与裁决 · 采纳方案 ${decision.winnerId}`,
        note: `采纳方案 ${decision.winnerId} · ${
          decision.average == null ? '无评分' : `${decision.average} 分`
        } · ${decision.votes} 票`,
        endedAt: Date.now(),
      });
      outputs.set('debate', {
        stepId: 'debate',
        title: '多智能体方案讨论与裁决',
        role: 'planner',
        name: decision.judgeName,
        text: [
          `# 采纳方案 ${decision.winnerId} · ${decision.angleLabel}`,
          `提案人：${decision.winnerName} · 平均 ${decision.average} 分 · ${decision.votes} 票`,
          '',
          decision.brief,
        ].join('\n'),
        passed: true,
      });
    } else {
      const latest = store.getTask(taskId).debate;
      const reason = latest?.reason || '本轮未进行方案讨论';
      store.updateStep(taskId, 'debate', { status: 'skipped', note: reason, endedAt: Date.now() });
      outputs.set('debate', {
        stepId: 'debate',
        title: '方案讨论',
        role: 'planner',
        name: '编排器',
        text: `本轮未进行方案讨论：${reason}`,
        passed: true,
      });
    }

    const workPlan = store.getTask(taskId).plan.filter((step) => step.id !== 'debate');
    const first = await executeSteps(task, workPlan, { outputs, speed, signal });
    if (!first.ok) throw new Error(describeFailure(first, store.getTask(taskId).plan));

    let review = outputs.get('review');
    let repairRound = 0;
    const maxRepair = Math.max(0, Number(store.db.settings.maxRepairRounds) || 0);

    while (review?.passed === false && repairRound < maxRepair) {
      if (signal.aborted) throw new Error('aborted');
      repairRound += 1;
      store.updateTask(taskId, { repairRound });

      const previousReviewId = review.stepId;
      const repairSteps = [
        {
          id: `fix-${repairRound}`,
          title: `第 ${repairRound} 轮阻塞项修复`,
          role: 'coder',
          needs: [previousReviewId],
          round: repairRound,
          outputPaths: [`src/${sim.pickModule(task.goal).name}.js`],
          ...roleAgent('coder'),
        },
        {
          id: `retest-${repairRound}`,
          title: `第 ${repairRound} 轮回归验证`,
          role: 'tester',
          needs: [`fix-${repairRound}`],
          round: repairRound,
          outputPaths: [`tests/${sim.pickModule(task.goal).name}.test.js`],
          ...roleAgent('tester'),
        },
        {
          id: `re-review-${repairRound}`,
          title: `第 ${repairRound} 轮复评`,
          role: 'reviewer',
          needs: [`fix-${repairRound}`, `retest-${repairRound}`],
          round: repairRound,
          outputPaths: [],
          ...roleAgent('reviewer'),
        },
      ].map(({ agent, ...step }) => ({ ...step, agentId: agent?.id || '' }));

      store.appendPlan(taskId, repairSteps);
      const retry = await executeSteps(
        task,
        store.getTask(taskId).plan.filter((s) => s.round === repairRound),
        { outputs, speed, signal },
      );
      if (!retry.ok) throw new Error(describeFailure(retry, store.getTask(taskId).plan));
      review = outputs.get(`re-review-${repairRound}`);
    }

    if (signal.aborted) throw new Error('aborted');

    const planner = pickAgent('planner');
    const summary = await runStepWithRetry(task, planner, {
      step: null,
      kind: 'summary',
      prompt: buildSummaryPrompt(
        planner,
        task,
        [...outputs.values()],
        buildContextPack(store.getTask(taskId)),
        {
          passed: !!review?.passed,
          repairRound,
          quality: store.getTask(taskId).quality,
        },
      ),
      signal,
      speed,
      simOutputs: {
        repairRound,
        passed: !!review?.passed,
        quality: store.getTask(taskId).quality,
        steps: Object.fromEntries([...outputs]),
        decision: store.getTask(taskId).debate?.decision || null,
      },
    });
    if (!summary.ok) throw new Error(`交付收口失败：${summary.note}`);

    const finalStatus = review?.passed ? 'done' : 'needs_attention';
    const quality = store.getTask(taskId).quality || { status: 'pending' };
    store.updateTask(
      taskId,
      {
        status: finalStatus,
        endedAt: Date.now(),
        quality,
        stats: { ...store.getTask(taskId).stats, ms: Date.now() - startedAt },
      },
      'task.status',
    );
    return finalStatus === 'done';
  } catch (err) {
    const aborted = signal.aborted || err?.name === 'AbortError' || /aborted/.test(err.message);
    const current = running.get(taskId);
    if (current?.runId === runId) {
      for (const step of store.getTask(taskId)?.plan || []) {
        if (['pending', 'running', 'retrying', 'queued'].includes(step.status)) {
          store.updateStep(taskId, step.id, {
            status: aborted ? 'stopped' : 'blocked',
            note: aborted ? '已停止' : '任务中断',
          });
        }
      }
      // 讨论进行中被停止时，别让提案卡片永远停在「提案中」
      const debate = store.getTask(taskId)?.debate;
      if (debate && ['proposing', 'critiquing', 'deciding'].includes(debate.status)) {
        for (const proposal of debate.proposals || []) {
          if (proposal.status === 'running') proposal.status = aborted ? 'stopped' : 'failed';
        }
        store.setDebate(taskId, { status: aborted ? 'stopped' : 'failed' });
      }
      store.updateTask(
        taskId,
        {
          status: aborted ? 'stopped' : 'error',
          endedAt: Date.now(),
          error: aborted ? '已停止' : err.message,
        },
        'task.status',
      );
    }
    return false;
  } finally {
    const current = running.get(taskId);
    if (current?.runId === runId) running.delete(taskId);
  }
}

function readmeFor(task) {
  const mod = sim.pickModule(task.goal);
  return `# ${task.title}\n\n> 由 AgentForge 多智能体协作生成\n\n**目标**：${task.goal}\n\n## 目录\n\n\`\`\`\n.\n├─ src/${mod.name}.js          核心领域模块\n├─ tests/${mod.name}.test.js   自动化测试\n└─ docs/${mod.name}-design.md  技术方案\n\`\`\`\n\n## 运行\n\n\`\`\`bash\nnode tests/${mod.name}.test.js\n\`\`\`\n\n## 成员分工\n\n- **规划师** —— 需求拆解、依赖编排与交付收口\n- **架构师** —— 技术方案与接口契约\n- **实现工程师** —— 代码落地\n- **测试工程师** —— 用例设计与回归验证\n- **代码评审** —— 评审与质量门\n`;
}

/* ------------------------------------------------------------------ */
/* 群聊：@ 某位或多位成员                                              */
/* ------------------------------------------------------------------ */

function parseMentions(text) {
  const found = [];
  for (const match of String(text || '').matchAll(/@([\w\u4e00-\u9fa5-]+)/g)) {
    const agent = store.findAgentByNameOrRole(match[1]);
    if (agent && !found.some((a) => a.id === agent.id)) found.push(agent);
  }
  return found;
}

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
    const mentioned = parseMentions(text);
    const shouldStart = /^(开始|开工|继续|动手|跑起来|go|start)/i.test(text.trim());
    const wantsWork = /(优化|实现|开发|修复|重构|新增|添加|完成|开工|开始|讨论|方案|选型|评审|build|fix|optimi[sz]e|implement|discuss)/i.test(
      text,
    );

    // 一次 @ 多位成员：组成讨论组，各自出方案 → 交叉评分 → 裁决后实施。
    if (mentioned.length > 1) {
      const names = mentioned.map((a) => `**${a.name}**`).join('、');
      const busy = task.status === 'running' || task.status === 'stopping';

      if ((shouldStart || wantsWork) && !busy) {
        const kickoff = store.addMessage(taskId, {
          agentId: 'system',
          name: '编排器',
          role: 'system',
          title: 'ORCHESTRATOR',
          color: '#a78bfa',
          kind: 'debate-intro',
          done: true,
          text: `**已组成讨论组**\n\n${names} 会先各自出一版方案，然后互相匿名评分；评分最高的方案由规划席位裁决后直接进入实施。\n\n未被点到的成员仍可能作为工具池视角加入讨论，席位成员负责落地。`,
        });
        store.endMessage(taskId, kickoff.id, {});
        await sleep(300);
        startTask(taskId, { speed, participants: mentioned.map((a) => a.id) }).catch((e) =>
          console.error('[startTask]', e),
        );
        return true;
      }

      if (busy) {
        const msg = store.addMessage(taskId, {
          agentId: 'system',
          name: '编排器',
          role: 'system',
          title: 'ORCHESTRATOR',
          color: '#a78bfa',
          kind: 'text',
          done: true,
          text: `本轮正在执行，${names} 的讨论请求先排队。等这一轮结束后回复「讨论」即可重新组队出方案。`,
        });
        store.endMessage(taskId, msg.id, {});
        return true;
      }

      const briefing = store.addMessage(taskId, {
        agentId: 'system',
        name: '编排器',
        role: 'system',
        title: 'ORCHESTRATOR',
        color: '#a78bfa',
        kind: 'text',
        done: true,
        text: `**讨论组已就位**\n\n${names} 会就当前目标各出一版方案、互相评分，再按最优方案实施。\n\n回复「开工」或直接说「讨论一下这个方案」即可开始。`,
      });
      store.endMessage(taskId, briefing.id, {});
      return true;
    }

    const agent = mentioned[0] || pickAgent('planner');
    if (!agent) throw new Error('团队里还没有任何智能体');

    const ctx = store.getTask(taskId);
    const context = buildContextPack(ctx);
    const transcript = context.messages.map((m) => `${m.name}: ${m.text}`).join('\n');
    const signal = running.get(taskId)?.controller.signal;

    if (agent.mode === 'cli') {
      const res = await cliMessage(
        task,
        agent,
        `${buildPrompt(task, agent, null, transcript, context)}\n\n# 用户说\n${text}`,
        { kind: 'text', signal },
      );
      if (res.code !== 0) throw new Error(`CLI 退出码 ${res.code}`);
    } else {
      const out = sim.compose({ kind: 'chat', goal: task.goal, agent, outputs: { userText: text } });
      await streamMessage(task, agent, out.text, { kind: 'text', speed, signal });
    }

    // 冷启动提示：任务还没跑过编排，用户说「开始」就直接开工
    const fresh = store.getTask(taskId);
    if (/^(开始|开工|继续|动手|跑起来|go|start)/i.test(text.trim()) && fresh.status !== 'running') {
      await sleep(400);
      startTask(taskId, { speed }).catch((e) => console.error('[startTask]', e));
    }
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') return false;
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
    return false;
  }
}
