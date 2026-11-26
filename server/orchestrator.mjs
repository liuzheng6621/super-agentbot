import fs from 'node:fs';
import path from 'node:path';
import { store, randomUUID, ROLE_LABEL, TOOL_CATALOG } from './store.mjs';
import * as sim from './sim.mjs';
import { streamText, spawnCli, sleep, classifyCliExit, describeCliResult } from './adapters.mjs';
import { runDag, throwIfAborted } from './dag.mjs';
import { versionOf, spillText } from './fs.mjs';
import { estimateTokens } from './tokens.mjs';
import { toolGateway } from './tool-gateway.mjs';

/** taskId -> { runId, controller, stopping } */
const running = new Map();
/** agentId -> 正在执行的任务数，避免并行任务把状态互相改回 idle */
const activeAgents = new Map();
/** taskId -> 最近一次目录快照，一道工序只扫一遍磁盘 */
const fileIndex = new Map();

const STEP_KIND = {
  planner: 'plan',
  architect: 'architect',
  coder: 'coder',
  tester: 'tester',
  reviewer: 'reviewer',
};

/**
 * 真实 CLI 的耗时由模型推理、工具调用和网关排队共同决定。
 * 讨论阶段过去固定 150 秒，长提案交叉质询时会稳定触发假超时。
 */
export const CLI_TIMEOUTS = Object.freeze({
  proposal: 360000,
  critique: 360000,
  decision: 240000,
  step: 900000,
  qualityGate: 300000,
});

/**
 * 席位缺席时的兜底顺序按角色分别排：评审员永远不落到实现者身上，
 * 否则「评审与实现分离」会静默失效——自己写、自己审、还显示质量门通过。
 */
const PICK_ORDER = {
  planner: ['planner', 'architect', 'reviewer', 'coder', 'tester'],
  architect: ['architect', 'planner', 'coder', 'reviewer', 'tester'],
  coder: ['coder', 'tester', 'architect', 'planner', 'reviewer'],
  tester: ['tester', 'coder', 'architect', 'planner', 'reviewer'],
  reviewer: ['reviewer', 'tester', 'architect', 'planner'],
};

export function isSelfReview(role, agent) {
  return role === 'reviewer' && agent?.role === 'coder';
}

/** 真实工时：所有工序实际耗时之和，不含排队、重试等待与人工空闲。 */
export function workMsOf(task) {
  return (task?.plan || []).reduce((sum, step) => {
    if (!step.startedAt) return sum;
    const end = step.endedAt || (step.status === 'running' ? Date.now() : 0);
    return end > step.startedAt ? sum + (end - step.startedAt) : sum;
  }, 0);
}

export function pickAgent(role) {
  const order = PICK_ORDER[role] || [role];
  for (const name of order) {
    const found = store.findAgentByRole(name);
    if (found) return found;
  }
  // 一个席位都没有时只能退到任意成员，调用方用 isSelfReview 如实标注
  const seats = store.agents.filter((a) => a.seat !== false);
  return seats.find((a) => a.role !== 'coder') || seats[0] || store.agents[0] || null;
}

export function writeWorkspaceFile(task, relPath, content, meta = {}) {
  const invocation = toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.write',
    operation: 'write',
    args: { op: 'write', path: relPath, content },
    agentId: meta.agentId || '',
    principal: { kind: 'system', id: 'orchestrator', name: 'Orchestrator' },
    stepId: meta.stepId || '',
    source: 'orchestrator',
  });
  const abs = path.join(task.workspace, invocation.result.path);
  const stat = fs.statSync(abs, { bigint: true });
  const bytes = Buffer.byteLength(content);
  // 自己写的文件立刻记进本任务的目录快照，下一步就不用再全量扫一遍
  const cached = fileIndex.get(task.id);
  if (cached) {
    cached.set(relPath, {
      path: relPath,
      bytes,
      mtimeMs: Number(stat.mtimeMs),
      mtimeNs: stat.mtimeNs.toString(),
    });
  }
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

/** 只为测试与观测：全量目录扫描次数 */
export const scanStats = { calls: 0 };

export function listWorkspaceFiles(task) {
  scanStats.calls += 1;
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
          // bigint 才能拿到纳秒级 mtime：同毫秒内的等长改写也能识别
          const stat = fs.statSync(path.join(dir, e.name), { bigint: true });
          out.push({
            path: rel,
            bytes: Number(stat.size),
            mtimeMs: Number(stat.mtimeMs),
            mtimeNs: stat.mtimeNs.toString(),
          });
        } catch {
          /* 单个文件读不到就算了 */
        }
      }
    }
  };
  walk(task.workspace);
  return out;
}

/** 扫一次并记住：下一步直接拿它当 before，不用再走一遍磁盘。 */
export function snapshotFiles(task) {
  const files = listWorkspaceFiles(task);
  fileIndex.set(task.id, new Map(files.map((f) => [f.path, f])));
  return files;
}

function knownFiles(task) {
  const cached = fileIndex.get(task.id);
  return cached ? [...cached.values()] : snapshotFiles(task);
}

export function buildContextPack(task, { maxMessages = 8, maxFiles = 80, files } = {}) {
  const allFiles = files || listWorkspaceFiles(task);
  return {
    goal: task.goal,
    workspace: task.workspace,
    status: task.status,
    mode: task.mode,
    planVersion: task.planVersion || 0,
    planVersionReason: task.planVersions?.at(-1)?.reason || '',
    plan: (task.plan || []).map((s) => ({
      id: s.id,
      title: s.title,
      role: s.role,
      status: s.status,
      round: s.round || 0,
    })),
    files: allFiles
      .filter((f) => f.bytes > 0)
      .slice(0, maxFiles),
    messages: task.messages
      .filter((m) => m.text)
      .slice(-maxMessages)
      .map((m) => ({
        name: m.name || m.role || 'AI',
        role: m.role || '',
        kind: m.kind || 'text',
        from: m.from?.name || m.name || '',
        to: (m.to || []).map((recipient) => recipient.name || recipient.id).join(', '),
        correlationId: m.correlationId || '',
        stepId: m.stepId || '',
        text: String(m.text).replace(/\s+/g, ' ').slice(0, 300),
      })),
    budget: {
      maxMessages,
      maxFiles,
      messagesAvailable: task.messages.length,
      filesAvailable: allFiles.length,
    },
  };
}

/**
 * 稳定区：整个任务期间不变的部分（目标、工作区）。
 * 必须放在 prompt 最前面——提供方的前缀缓存按内容前缀命中，
 * 第一位就变等于每次调用都从零开始算。
 */
export function stableBlock(context) {
  if (!context) return '';
  return ['# 项目上下文', `- 目标: ${context.goal}`, `- 工作区: ${context.workspace}`].join('\n');
}

/**
 * 易变区：状态、工序账本、最近摘要、文件清单，每一步都会变。
 * 必须放在 prompt 末尾，否则它前面的所有内容都跟着失效。
 */
export function volatileBlock(context, step = '') {
  if (!context) return '';
  return [
    '# 项目上下文（实时）',
    `- 状态: ${context.status}`,
    `- 计划版本: v${context.planVersion || 0}${context.planVersionReason ? ` · ${context.planVersionReason}` : ''}`,
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

async function streamMessage(
  task,
  agent,
  text,
  {
    kind = 'text',
    signal,
    speed = 1,
    meta = {},
    message = {},
    to = null,
    parentMessageId = '',
    causeBy = '',
    stepId = '',
    artifactRefs = [],
  } = {},
) {
  const msg = store.addMessage(task.id, {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    color: agent.color,
    kind,
    ...message,
  }, {
    to,
    parentMessageId,
    causeBy,
    stepId,
    artifactRefs,
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

// 上游网关/网络层的瞬时故障特征。命中才算「抖动」，否则按真实失败上报。
const TRANSIENT_CLI_ERROR =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|429|rate limit|temporarily unavailable|model is unavailable|upstream request failed|\b50[234]\b/i;

export function isTransientCliError(text) {
  return TRANSIENT_CLI_ERROR.test(String(text || ''));
}

export function shouldRetryCliResult(res) {
  const info = classifyCliExit(res);
  if (info.retryable) return true;
  return isTransientCliError(`${res?.stdout || ''}\n${res?.stderr || ''}`);
}

async function cliMessage(
  task,
  agent,
  prompt,
  {
    kind = 'text',
    signal,
    timeout = 300000,
    message = {},
    completeWhen = null,
    settleMs = 0,
    to = null,
    parentMessageId = '',
    causeBy = '',
    stepId = '',
    artifactRefs = [],
  } = {},
) {
  const msg = store.addMessage(task.id, {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    color: agent.color,
    kind,
    engine: 'cli',
    ...message,
  }, {
    to,
    parentMessageId,
    causeBy,
    stepId: stepId || agent.currentStepId || '',
    artifactRefs,
  });
  beginAgent(agent, `${agent.cli?.command || 'CLI'} 运行中`);
  const toolCall = store.addTaskEvent(task.id, {
    type: 'tool.call.start',
    agentId: agent.id,
    stepId: agent.currentStepId || '',
    data: {
      tool: 'cli',
      command: agent.cli?.command || '',
      args: agent.cli?.args || [],
      cwd: task.workspace,
      timeout,
      principal: { kind: 'agent', id: agent.id, name: agent.name, role: agent.role },
      messageId: msg.id,
    },
  });

  const before = fileIndex.get(task.id) || new Map(snapshotFiles(task).map((f) => [f.path, f]));
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

  // 提示词是真金白银发出去的 token，先记账再执行
  const promptTokens = estimateTokens(prompt);
  store.countPrompt(task.id, agent.id, promptTokens);

  const runOnce = () =>
    spawnCli(agent, prompt, {
      cwd: task.workspace,
      signal,
      timeout,
      completeWhen,
      settleMs,
      onChunk: (d) => {
        clearHint();
        if (hintShown) {
          hintShown = false;
          store.replaceMessage(task.id, msg.id, '');
        }
        store.appendMessage(task.id, msg.id, d);
      },
    });

  // 上游网关抖一下（ECONNRESET / 429 / 握手超时）不该让整条流水线塌掉：
  // 只有明确的瞬时错误才重试一次，真实失败（退出码非 0 且无瞬时特征）照旧上报。
  let res;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      res = await runOnce();
    } catch (err) {
      res = { code: -1, stdout: '', stderr: err.message, elapsed: 0 };
    }
    const combined = `${res.stdout || ''}
${res.stderr || ''}`;
    if (res.code === 0 || attempt === 2 || signal?.aborted || !shouldRetryCliResult(res)) break;
    const failure = classifyCliExit(res);
    store.appendMessage(
      task.id,
      msg.id,
      `

> ⚠️ ${failure.kind === 'windows-init' ? failure.label : `上游连接抖动（${combined.match(TRANSIENT_CLI_ERROR)?.[0] || failure.label}）`}，2 秒后重试一次。

`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  clearHint();

  // 很多 CLI 会把版本横幅写到 stderr，成功时别把它当正文塞进回答
  const stderrText = (res.stderr || '').trim();
  if (stderrText && (res.code !== 0 || !res.stdout.trim())) {
    store.appendMessage(task.id, msg.id, `\n\n\`\`\`log\n${stderrText.slice(-1600)}\n\`\`\``);
  }
  if (res.code !== 0) {
    const failure = classifyCliExit(res);
    store.appendMessage(
      task.id,
      msg.id,
      `\n\n> ⚠️ ${failure.label}。${
        res.partial
          ? '已保留进程结束前的输出，但它可能不完整。'
          : '没有产生输出。请检查命令模板、运行时环境和凭据。'
      }`,
    );
  }
  const failure = classifyCliExit(res);
  store.endMessage(task.id, msg.id, {
    tokens: estimateTokens(res.stdout),
    tokensIn: promptTokens,
    ms: res.elapsed,
    exitCode: res.code,
    exitLabel: failure.label,
    timedOut: !!res.timedOut,
    partial: !!res.partial,
    settledEarly: !!res.settledEarly,
  });

  // 收集 CLI 新增/修改的文件：先按 size + 纳秒 mtime 粗筛，命中项再算内容版本。
  // 内容没变就不重复记 artifact——CLI 把同一个文件重写一遍不该算一次产出。
  store.addTaskEvent(task.id, {
    type: 'tool.call.end',
    agentId: agent.id,
    stepId: agent.currentStepId || '',
    data: {
      callId: toolCall?.id || '',
      tool: 'cli',
      command: agent.cli?.command || '',
      code: res.code,
      elapsed: res.elapsed,
      timedOut: !!res.timedOut,
      stdout: clip(res.stdout || '', 1600),
      stderr: clip(res.stderr || '', 1600),
    },
  });

  const after = snapshotFiles(task);
  for (const f of after) {
    const prev = before.get(f.path);
    const touched = !prev || prev.bytes !== f.bytes || prev.mtimeNs !== f.mtimeNs;
    if (!touched) continue;
    store.addArtifact(task.id, {
      path: f.path,
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
      version: versionOf(path.join(task.workspace, f.path)) || '',
      lang: path.extname(f.path).slice(1),
      agentId: agent.id,
      stepId: agent.currentStepId || '',
      beforeVersion: prev?.version || '',
      source: 'cli',
    });
  }
  const afterPaths = new Set(after.map((f) => f.path));
  for (const [relPath] of before) {
    if (afterPaths.has(relPath)) continue;
    store.markArtifactDeleted(task.id, relPath, {
      agentId: agent.id,
      stepId: agent.currentStepId || '',
    });
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

/** 超过这个长度就不再整段塞进 prompt，改为落盘 + 句柄。 */
const SPILL_AT = 8000;

/** 上游产物正文：短就全文，长就落盘，只给摘录 + 只读路径。 */
function dependencyBody(task, out) {
  const text = String(out.text || '');
  if (text.length <= SPILL_AT) return text;
  const ref = spillText({
    taskId: task.id,
    name: `${out.role || 'step'}-${out.id || out.title || 'out'}`,
    content: text,
  });
  return [
    `（上游产物共 ${text.length} 字，完整原文已存为文件，不要凭下面的摘录猜细节）`,
    `只读路径: ${ref.locator}`,
    '',
    clip(text, 1600),
  ].join('\n');
}

function dependencyText(task, step, outputs) {
  if (!step?.needs?.length) return '无（可以从项目上下文开始）';
  return step.needs
    .map((id) => {
      const out = outputs.get(id);
      if (!out) return `## ${id}\n（上游未产出）`;
      return `## ${ROLE_LABEL[out.role] || out.role} · ${out.name}\n工序：${out.title}\n\n${dependencyBody(task, out)}`;
    })
    .join('\n\n---\n\n');
}

function toolPolicyBlock(agent) {
  const allowed = new Set(Array.isArray(agent?.tools) ? agent.tools : []);
  const labels = TOOL_CATALOG.filter((tool) => allowed.has(tool.id)).map(
    (tool) => `${tool.label} (${tool.id})`,
  );
  return [
    '# 工具权限',
    labels.length ? `- 允许: ${labels.join('、')}` : '- 允许: 无',
    '- 未列出的平台能力不得调用；需要时说明阻塞，不要绕过权限边界。',
  ].join('\n');
}

export function buildPrompt(task, agent, step, depsText, context, extra = {}) {
  const role = step?.role || agent.role;
  const lines = [
    stableBlock(context),
    `你是「${agent.name}」，团队中的${agent.title}。`,
    toolPolicyBlock(agent),
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
          `# ${extra.decision.degraded ? '降级采用的方案（需复核）' : '已裁决的方案（必须遵循）'}`,
          `方案 ${extra.decision.winnerId} · ${extra.decision.winnerName} 提出 · ${
            extra.decision.average == null ? '无有效评分' : `平均 ${extra.decision.average} 分`
          } · ${extra.decision.votes} 票`,
          extra.decision.degraded
            ? '注意：本轮交叉质询没有形成有效评分，这是按顺序临时采用的方案，不能把“已采纳”写成事实。'
            : '',
          '',
          clip(extra.decision.brief, 2400),
          '',
          '这是团队讨论后的裁决结果。不要擅自更换技术路线；如果你认为方案有硬伤，写在结尾并说明，但不要自行改道。',
        ].join('\n')
      : '',
    extra.quality
      ? [
          '# 自动化质量门',
          `状态：${extra.quality.status}`,
          extra.quality.command ? `入口：${extra.quality.command}（退出码 ${extra.quality.code}）` : '',
          extra.quality.reason ? `说明：${extra.quality.reason}` : '',
          extra.quality.log ? `\n\`\`\`log\n${clip(extra.quality.log, 3000)}\n\`\`\`` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    extra.selfReview
      ? '注意：这一轮没有独立评审席位，由实现者本人复核，结论里要如实写明「自审」。'
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
  // 易变内容永远放最后：前面越稳定，提供方的前缀缓存命中越长
  lines.push('', volatileBlock(context, step?.title || ''));
  return lines.filter((line) => line !== '').join('\n');
}

function buildPlanPrompt(agent, task, context = null) {
  return [
    stableBlock(context),
    `你是「${agent.name}」，团队里的${agent.title}。`,
    toolPolicyBlock(agent),
    '',
    '# 项目目标',
    task.goal,
    '',
    '# 你的任务',
    '把目标拆成可验收的工序，确认每道工序的负责人角色、依赖关系、产出物与验收标准。',
    '团队已有规划、架构、实现、测试、评审五个执行席位，不要把所有工作都分给实现工程师。',
    '',
    '不要写业务代码，不要客套。中文 Markdown，结尾用一行「下一步建议：…」收口。',
    '',
    volatileBlock(context, '需求拆解'),
  ].join('\n');
}

function buildSummaryPrompt(agent, task, outputs, context, extra = {}) {
  return [
    stableBlock(context),
    `你是「${agent.name}」，团队里的${agent.title}。本轮协作已结束，由你做交付收口。`,
    toolPolicyBlock(agent),
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
    `- 方案讨论：${
      extra.degraded ? '无有效交叉评分，已降级采用，必须人工复核' : '已完成评分裁决'
    }`,
    '',
    '# 你的任务',
    '给出交付结论、遗留风险，以及需要用户拍板的 3 件事。不要宣称未通过的工序已经完成。中文 Markdown。',
    '',
    volatileBlock(context, '交付收口'),
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

export function debateConfig(task = null) {
  const globalEnabled = store.db.settings.debateEnabled !== false;
  // 任务级选择优先：direct 跳过讨论，debate 强制讨论，未选则跟随全局。
  const enabled =
    task?.flowMode === 'direct'
      ? false
      : task?.flowMode === 'debate'
        ? true
        : globalEnabled;
  return {
    enabled,
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
  const normalizeId = (raw) => {
    const cleaned = String(raw || '').replace(/[*`]/g, '').trim();
    const match = cleaned.match(/^(?:方案\s*)?([A-F])(?:\s*方案)?$/i);
    return match ? match[1].toUpperCase() : '';
  };
  const parseScore = (raw) => {
    const match = String(raw || '').match(/\d{1,2}(?:\.\d+)?/);
    if (!match) return null;
    const score = Number(match[0]);
    if (!Number.isFinite(score) || score < 1 || score > 10) return null;
    return Math.round(score * 10) / 10;
  };
  const setScore = (rawId, rawScore) => {
    const id = normalizeId(rawId);
    const score = parseScore(rawScore);
    if (!id || id === selfId || score == null || scores[id] != null) return;
    scores[id] = score;
  };

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    setScore(cells[0], cells[1]);
  }

  // CLI 经常省略“方案”和表格，直接写成 A=7、B：8分 或 方案 C 7/10。
  // 统一在去掉 Markdown 强调符后按行解析，已有分数不会被后出现的宽松格式覆盖。
  const inline = value.replace(/[*`]/g, '');
  const patterns = [
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*(?:评分|得分|分数)?\s*[:：=＝]\s*(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|分)?/gi,
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*(?:评分|得分|分数)?\s*[:：=＝]?\s*(\d{1,2}(?:\.\d+)?)\s*(?:分|\/\s*10)/gi,
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*[（(]\s*(\d{1,2}(?:\.\d+)?)\s*(?:分|\/\s*10)?\s*[)）]/gi,
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*[-—–]\s*(\d{1,2}(?:\.\d+)?)\s*(?:分|\/\s*10)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of inline.matchAll(pattern)) setScore(match[1], match[2]);
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
    stableBlock(context),
    `你是「${agent.name}」，团队里的${agent.title || ROLE_LABEL[agent.role] || '成员'}。`,
    toolPolicyBlock(agent),
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
    '',
    volatileBlock(context, `方案提案 · ${angle.label}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function proposalHeadingCount(text) {
  const value = String(text || '');
  const headings = value.matchAll(
    /^\s{0,3}(?:#{1,6}\s*)?(?:\d+[.\u3001]\s*)?(?:\*\*|__)?\s*(\u6838\u5fc3\u4e3b\u5f20|\u6280\u672f\u8def\u7ebf|\u843d\u5730\u5de5\u5e8f|\u4ee3\u4ef7\u4e0e\u98ce\u9669|\u5de5\u4f5c\u91cf(?:\u4f30\u8ba1)?)\s*(?:\*\*|__)?\s*(?:[:\uFF1A]|$)/gm,
  );
  const keys = new Set();
  for (const heading of headings) keys.add(heading[1]);
  return keys.size;
}

export function isUsableProposalText(text) {
  const value = String(text || '');
  return value.trim().length >= 200 && proposalHeadingCount(value) >= 3;
}

export function isCompleteProposalText(text) {
  return String(text || '').trim().length >= 400 && proposalHeadingCount(text) >= 5;
}

export function isCompleteCritiqueText(text, expectedIds = []) {
  const value = String(text || '');
  if (!/(?:\u9009\u62e9|\u63a8\u8350)\s*[:\uFF1A]/.test(value)) return false;
  const scores = parseProposalScores(value);
  return expectedIds.length > 0 && expectedIds.every((id) => scores[id] != null);
}

export function isCompleteStepText(text, role = '') {
  const value = String(text || '');
  if (value.trim().length < 20) return false;
  if (role === 'reviewer') {
    return /(?:VERDICT|\u8d28\u91cf\u95e8\u7ed3\u8bba)\s*[:\uFF1A]\s*(?:PASS|FAIL|\u901a\u8fc7|\u4e0d\u901a\u8fc7)/i.test(
      value,
    );
  }
  return /\u4e0b\u4e00\u6b65\u5efa\u8bae\s*[:\uFF1A]/.test(value);
}

export function isCompleteSummaryText(text) {
  const value = String(text || '');
  return (
    value.trim().length >= 200 &&
    /(?:\u4ea4\u4ed8\u7ed3\u8bba|\u4ea4\u4ed8\u6536\u53e3)/.test(value) &&
    /\u9700\u8981\u7528\u6237\u62cd\u677f/.test(value)
  );
}

export function isCompleteDecisionText(text) {
  const value = String(text || '');
  return (
    value.trim().length >= 120 &&
    /(?:\u91c7\u7eb3|\u88c1\u51b3)/.test(value) &&
    /\u786c\u7ea6\u675f/.test(value)
  );
}

function buildCritiquePrompt(task, agent, own, others) {
  return [
    `你是「${agent.name}」，团队里的${agent.title || ROLE_LABEL[agent.role] || '成员'}。现在进入交叉质询。`,
    toolPolicyBlock(agent),
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
    '4. 最后一行必须单独输出 `选择：<方案编号>。`，并简要说明理由。',
    '',
    '只输出评审文本，不要修改任何文件。',
  ].join('\n');
}

function buildDecisionPrompt(task, judge, ranking, winner) {
  return [
    `你是「${judge.name}」，本轮方案讨论的主持人。成员已经完成提案与交叉评分，现在由你宣布裁决。`,
    toolPolicyBlock(judge),
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

async function runProposal(task, agent, { id, index, speed, signal, timeout = CLI_TIMEOUTS.proposal }) {
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
        timeout,
        completeWhen: isCompleteProposalText,
        settleMs: 4000,
        message: { debate: { phase: 'proposal', proposalId: id } },
      });
      const text = (res.stdout || '').trim();
      const partial = res.code !== 0 && res.partial && isUsableProposalText(text);
      const ok = (res.code === 0 && isUsableProposalText(text)) || partial;
      const failure = classifyCliExit(res);
      const note = ok
        ? partial
          ? `${failure.label} · 已保留不完整方案`
          : `CLI · ${(res.elapsed / 1000).toFixed(1)}s`
        : `提案失败 · ${failure.label}`;
      store.updateProposal(task.id, id, {
        status: ok ? (partial ? 'partial' : 'done') : 'failed',
        text: ok ? clip(text, 5000) : clip((text || res.stderr || '').trim(), 600),
        messageId: res.messageId,
        note,
      });
      return {
        id,
        agent,
        angle,
        ok,
        partial,
        text: ok ? text : '',
        note,
        messageId: res.messageId,
      };
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

async function runCritique(task, agent, { index, proposals, speed, signal, timeout = CLI_TIMEOUTS.critique }) {
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
    let partialOutput = false;
    if (agent.mode === 'cli') {
      const expectedIds = others.map((p) => p.id);
      const res = await cliMessage(task, agent, buildCritiquePrompt(task, agent, own, others), {
        kind: 'critique',
        signal,
        timeout,
        completeWhen: (value) => isCompleteCritiqueText(value, expectedIds),
        settleMs: 3000,
        message: { debate: { phase: 'critique', selfId: own?.id || '' } },
      });
      text = (res.stdout || '').trim();
      scores = parseProposalScores(text, { selfId: own?.id || '' });
      partialOutput = res.code !== 0;
      const valid = proposals.filter((p) => p.id !== own?.id && scores[p.id] != null);
      if (!valid.length) {
        throw new Error(
          res.code === 0
            ? '质询没有解析到有效评分'
            : `质询失败 · ${classifyCliExit(res).label}${text ? '（输出中未找到评分表）' : ''}`,
        );
      }
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
      ok: valid.length > 0,
      count: valid.length,
      note: valid.length
        ? `已评 ${valid.length} 份方案${partialOutput ? ' · 来自不完整输出' : ''}`
        : '未解析到有效评分',
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
 * 跑完整方案讨论。成功返回 { decision, ranking, participants }；
 * 跳过讨论（直接开工 / 成员不足 / 无有效提案）时返回 null，并把原因写进 task.debate。
 */
export async function runDebate(task, { speed = 1, signal, forced = [] } = {}) {
  const cfg = debateConfig(task);
  const judge = pickAgent('planner') || pickAgent('reviewer');
  // 用户一次 @ 多位成员，是明确要讨论，优先于任务上的「直接开工」
  const forceDebate = forced.length >= 2;
  if (!cfg.enabled && !forceDebate) {
    store.setDebate(task.id, { status: 'skipped', reason: '本任务选择直接开工，跳过方案讨论' });
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
    return runProposal(task, agent, {
      id,
      index,
      speed,
      signal,
      timeout: CLI_TIMEOUTS.proposal,
    });
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
      text: `**方案讨论没有产生有效提案**\n\n${reasons}\n\n本轮不会假装裁决通过。请先修复这些成员的命令模板、运行时环境或凭据，再重新开工。`,
    });
    store.endMessage(task.id, msg.id, {});
    return null;
  }

  store.setDebate(task.id, { status: 'critiquing' });
  const critiques = await mapPool(roster, cfg.concurrency, async (agent, index) =>
    runCritique(task, agent, {
      index,
      proposals: valid,
      speed,
      signal,
      timeout: CLI_TIMEOUTS.critique,
    }),
  );
  throwIfAborted(signal);

  const latest = store.getTask(task.id).debate;
  const ranking = rankProposals(latest.proposals);
  const winner = ranking[0];
  const voteCount = ranking.reduce((sum, p) => sum + p.votes, 0);
  const degraded = voteCount === 0;
  const confidence = degraded ? 'none' : voteCount >= ranking.length ? 'high' : 'medium';
  const decisionReason = degraded
    ? '交叉质询没有产生有效评分，按提案顺序降级采用，需人工复核后再视为正式裁决。'
    : '';

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
    degraded,
    reason: decisionReason,
    brief: clip(winner.text, 2000),
    ranking: ranking.map(({ text, ...rest }) => rest),
    critiqueCount: critiques.filter((c) => c.ok).length,
    decidedAt: Date.now(),
  };

  const decisionText =
    degraded
      ? `**降级采用：方案 ${winner.id} · ${winner.angleLabel}**\n\n本轮交叉质询没有产生有效评分，不能把它称为“已采纳”。系统按提案顺序临时采用方案 ${winner.id}（${winner.name}），继续执行但会标记为待人工确认。建议下一轮补齐质询。`
      : sim.decisionFor({
          goal: task.goal,
          ranking,
          winner,
          judge,
          participants: roster.length,
        });

  try {
    if (degraded) {
      // 没有有效评分时，主持人 CLI 再跑一遍只会放大失败面；直接给出可审计的降级结论。
      const msg = store.addMessage(task.id, {
        agentId: 'system',
        name: '编排器',
        role: 'system',
        title: 'DECISION',
        color: '#fbbf24',
        kind: 'decision',
        done: true,
        text: decisionText,
      });
      store.endMessage(task.id, msg.id, {});
    } else if (judge?.mode === 'cli') {
      const res = await cliMessage(task, judge, buildDecisionPrompt(task, judge, ranking, winner), {
        kind: 'decision',
        signal,
        timeout: CLI_TIMEOUTS.decision,
        completeWhen: isCompleteDecisionText,
        settleMs: 5000,
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

  store.setDecision(task.id, decision, degraded ? 'fallback' : 'decided');
  return { decision, ranking, participants: roster };
}

/* ------------------------------------------------------------------ */
/* 工序执行                                                             */
/* ------------------------------------------------------------------ */

async function runStep(task, agent, { step, kind, prompt, signal, speed, simOutputs }) {
  if (!agent) throw new Error('没有可用的智能体');
  if (agent.mode === 'cli') {
    agent.currentStepId = step?.id || '';
    const res = await cliMessage(task, agent, prompt, {
      kind,
      signal,
      timeout: CLI_TIMEOUTS.step,
      causeBy: step?.id ? `step:${step.id}` : 'summary',
      stepId: step?.id || '',
      completeWhen: step
        ? (value) => isCompleteStepText(value, step.role)
        : isCompleteSummaryText,
      settleMs: 6000,
    });
    const msg = store.getTask(task.id).messages.find((m) => m.id === res.messageId);
    const stdoutText = (res.stdout || '').trim();
    const text = stdoutText || msg?.text || '';
    const failure = classifyCliExit(res);
    return {
      ok: res.code === 0 && !!stdoutText,
      code: res.code,
      text,
      note:
        res.code === 0 && stdoutText
          ? `CLI · ${(res.elapsed / 1000).toFixed(1)}s`
          : res.code === 0
            ? 'CLI 成功但没有产生可交付输出'
            : `CLI 失败 · ${failure.label}`,
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
    causeBy: step?.id ? `step:${step.id}` : 'summary',
    stepId: step?.id || '',
    artifactRefs: (out.artifacts || []).map((file) => file.path),
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
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || configured);
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
    if (last.ok || attempt >= maxAttempts || options.signal?.aborted || !shouldRetryCliResult(last)) {
      return { ...last, attempt };
    }
    if (options.step) {
      store.updateStep(task.id, options.step.id, {
        status: 'retrying',
        note: `${last.note || 'CLI 启动失败'}，准备第 ${attempt + 1} 次尝试`,
      });
    }
    await sleep(400 * attempt, options.signal);
  }
  return { ...last, attempt: maxAttempts };
}

/**
 * 工序失败时的同角色回退顺序。
 * 真实 CLI 任务只在 CLI 之间回退，避免用内置模拟结果掩盖真实进程故障；
 * 评审席优先避开实现者，保留“实现与评审分离”的边界。
 */
export function stepAgentCandidates(step, preferred = null) {
  const role = step?.role || preferred?.role || '';
  const ordered = [];
  const seenCommands = new Set();
  const commandKey = (agent) => {
    const command = String(agent?.cli?.command || '').trim().replace(/^["']|["']$/g, '');
    if (!command) return '';
    return path
      .basename(command)
      .replace(/\.(exe|cmd|bat|ps1)$/i, '')
      .toLowerCase();
  };
  const push = (agent) => {
    if (!agent || ordered.some((item) => item.id === agent.id)) return;
    if (agent.mode === 'cli') {
      const key = commandKey(agent);
      if (key && seenCommands.has(key)) return;
      if (key) seenCommands.add(key);
    }
    ordered.push(agent);
  };

  push(preferred);
  for (const name of PICK_ORDER[role] || [role]) {
    for (const agent of store.agents) {
      if (agent.role === name && agent.seat !== false) push(agent);
    }
  }
  for (const agent of store.agents) {
    if (agent.seat !== false) push(agent);
  }
  for (const agent of store.agents) push(agent);

  if (preferred?.mode === 'cli') {
    // 真实 CLI 任务不能在故障后偷偷落到内置模拟成员；
    // 没有可执行的 CLI 时返回空列表，让上层明确报错。
    return ordered.filter((agent) => agent.mode === 'cli' && agent.cli?.command);
  }
  return ordered;
}

const TEST_TIMEOUT = CLI_TIMEOUTS.qualityGate;
const PLACEHOLDER_TEST = /no test specified/i;

/**
 * 从工作区探测真实测试入口。找不到就返回 null——宁可显示「没有测试入口」，
 * 也不要像以前那样在 CLI 模式下直接 skipped，假装质量门跑过了。
 */
export function detectTestCommand(task) {
  const root = task.workspace;
  const abs = (rel) => path.join(root, rel);
  const exists = (rel) => {
    try {
      return fs.existsSync(abs(rel));
    } catch {
      return false;
    }
  };
  const read = (rel) => {
    try {
      return fs.readFileSync(abs(rel), 'utf8');
    } catch {
      return '';
    }
  };

  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(read('package.json'));
      const script = pkg?.scripts?.test;
      if (typeof script === 'string' && script.trim() && !PLACEHOLDER_TEST.test(script)) {
        return {
          command: 'npm',
          args: ['test', '--silent'],
          label: 'npm test',
          source: `package.json scripts.test: ${script.trim().slice(0, 80)}`,
        };
      }
    } catch {
      /* package.json 坏了就当没有 */
    }
  }
  if (exists('pyproject.toml') || exists('pytest.ini') || exists('tox.ini') || exists('setup.cfg')) {
    return { command: 'python', args: ['-m', 'pytest', '-q'], label: 'pytest', source: 'Python 测试配置' };
  }
  if (exists('Cargo.toml')) {
    return { command: 'cargo', args: ['test', '--quiet'], label: 'cargo test', source: 'Cargo.toml' };
  }
  if (exists('go.mod')) {
    return { command: 'go', args: ['test', './...'], label: 'go test ./...', source: 'go.mod' };
  }
  if (exists('Makefile') && /^test\s*:/m.test(read('Makefile'))) {
    return { command: 'make', args: ['test'], label: 'make test', source: 'Makefile' };
  }
  try {
    if (exists('tests')) {
      const names = fs.readdirSync(abs('tests'));
      if (names.some((n) => /\.(test|spec)\.(m?js|cjs)$/.test(n))) {
        return {
          command: process.execPath,
          args: ['--test', 'tests/'],
          label: 'node --test tests/',
          source: 'tests/ 目录',
        };
      }
    }
  } catch {
    /* 目录读不到就跳过这一条 */
  }
  // 最后才用关键词模板猜出的文件名，且必须真的存在
  const rel = `tests/${sim.pickModule(task.goal).name}.test.js`;
  if (exists(rel)) return { command: process.execPath, args: [rel], label: `node ${rel}`, source: '关键词模板' };
  return null;
}

export async function runQualityGate(task, step, signal) {
  const round = step?.round || 0;
  const plan = store.getTask(task.id).plan;
  const implementation = [...plan].reverse().find((s) => s.role === 'coder' && s.status === 'done');
  const testDesign = [...plan].reverse().find((s) => s.role === 'tester' && s.status === 'done');
  const coder = implementation && store.getAgent(implementation.agentId);
  const tester = testDesign && store.getAgent(testDesign.agentId);
  const cliMode = !!task.external || coder?.mode === 'cli' || tester?.mode === 'cli';

  // 真实 CLI 任务同样要跑工作区里真实存在的测试入口，不再一律 skipped
  const detected = detectTestCommand(task);
  if (!detected) {
    const quality = {
      status: 'missing',
      reason:
        '工作区里没找到可执行的测试入口（package.json scripts.test / pytest / Cargo / go.mod / Makefile / tests/），这一轮只能靠评审 VERDICT 判定',
      cli: cliMode,
      checkedAt: Date.now(),
      round,
    };
    store.updateTask(task.id, { quality });
    return quality;
  }

  store.updateTask(task.id, { quality: { status: 'running', command: detected.label, round } });
  const res = await spawnCli({ cli: { command: detected.command, args: detected.args } }, '', {
    cwd: task.workspace,
    timeout: TEST_TIMEOUT,
    signal,
  });
  throwIfAborted(signal);

  const status = res.code === 0 ? 'passed' : 'failed';
  const quality = {
    status,
    command: detected.label,
    source: detected.source,
    cli: cliMode,
    code: res.code,
    log: clip(`${res.stdout}\n${res.stderr}`.trim(), 4000),
    checkedAt: Date.now(),
    round,
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
    text: `**自动化质量门 · ${status === 'passed' ? '通过' : '未通过'}**\n\n- 入口：\`${detected.label}\`（${detected.source}）\n- 退出码：\`${res.code}\`${
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
      const preferred = store.getAgent(step.agentId) || pickAgent(step.role);
      const candidates = stepAgentCandidates(step, preferred);
      if (!candidates.length) {
        return { ok: false, note: `没有可用的${ROLE_LABEL[step.role] || step.role}成员` };
      }

      const baseExtra = {
        repairRound: step.round || 0,
        decision: latest.debate?.decision || null,
      };
      if (step.role === 'reviewer') {
        baseExtra.quality = await runQualityGate(latest, step, signal);
      }

      let last = null;
      for (let index = 0; index < candidates.length; index += 1) {
        const agent = candidates[index];
        const current = store.getTask(task.id);
        store.updateStep(task.id, step.id, {
          agentId: agent.id,
          status: 'running',
          note:
            index > 0
              ? `${preferred?.name || '原成员'} 失败，切换 ${agent.name} 重试`
              : step.note || '',
        });
        agent.currentStepId = step.id;

        const extra = {
          ...baseExtra,
          // 评审员落到实现者身上时如实标出来，别让自审看起来像独立评审
          selfReview: isSelfReview(step.role, agent),
        };
        const context = buildContextPack(current, { files: knownFiles(current) });
        const depsText = dependencyText(current, step, outputs);
        const prompt = buildPrompt(current, agent, step, depsText, context, extra);
        const simOutputs = {
          ...Object.fromEntries([...outputs].map(([id, value]) => [id, value.text])),
          steps: Object.fromEntries([...outputs]),
          repairRound: extra.repairRound,
          quality: extra.quality,
          decision: extra.decision,
        };

        const out = await runStepWithRetry(current, agent, {
          step,
          kind: STEP_KIND[step.role] || 'text',
          prompt,
          signal,
          speed,
          simOutputs,
          // 首选成员允许按设置重试；切换成员后只给它一次机会，避免整条流水线被拖死。
          maxAttempts: index === 0 ? undefined : 1,
        });
        if (out.ok && step.role === 'reviewer') {
          const verdict = parseReviewVerdict(out.text);
          out.verdict = verdict === true ? 'pass' : verdict === false ? 'fail' : 'unknown';
          out.passed = verdict === true && extra.quality?.status !== 'failed';
          // 没有测试入口时不能说「质量门通过」——那一轮根本没有自动化把关，只有评审结论。
          const gateMissing = extra.quality?.status === 'missing';
          out.note = out.passed
            ? extra.selfReview
              ? gateMissing
                ? '评审通过（没有测试入口，且是自审）'
                : '质量门通过（自审：没有独立评审席位）'
              : gateMissing
                ? '评审通过（没有测试入口，未经自动化质量门）'
                : '质量门通过'
            : verdict === null
              ? '缺少明确评审结论'
              : '未通过，进入返工';
        }
        if (out.ok) {
          if (index > 0) out.note = `${out.note || '已完成'} · 由 ${agent.name} 接替`;
          outputs.set(step.id, {
            stepId: step.id,
            title: step.title,
            role: step.role,
            name: agent.name,
            text: out.text,
            passed: out.passed,
            verdict: out.verdict,
          });
          store.updateStep(task.id, step.id, {
            resultText: String(out.text || '').slice(0, 12000),
            outputRole: step.role,
            outputName: agent.name,
          });
          return out;
        }

        last = out;
        if (signal?.aborted) return out;
        if (index < candidates.length - 1) {
          store.updateStep(task.id, step.id, {
            status: 'retrying',
            note: `${agent.name}：${out.note || '执行失败'}；准备切换 ${candidates[index + 1].name}`,
          });
        }
      }

      if (last && candidates.length > 1) {
        last.note = `${last.note || '执行失败'}；已尝试 ${candidates.map((agent) => agent.name).join('、')}`;
      }
      return last;
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

function replanFailure(taskId, result, { runId, reason = '' } = {}) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const maxAutoReplans = Math.max(0, Number(store.db.settings.maxAutoReplans) || 0);
  const used = (task.autoReplans || []).filter((item) => item.runId === runId).length;
  if (maxAutoReplans < 1 || used >= maxAutoReplans) return null;

  const unfinished = task.plan.filter((step) => !['done', 'skipped'].includes(step.status));
  if (!unfinished.length) return null;
  const failedId =
    [...result.results.entries()].find(([, value]) => value?.ok === false)?.[0] || '';
  const failedStep = task.plan.find((step) => step.id === failedId);
  const detail = reason || `${failedStep?.title || failedId || '工序'}失败后重开未完成步骤`;
  const replanned = store.replanUnfinished(taskId, {
    steps: unfinished,
    reason: `自动重规划：${detail}`,
    source: 'auto',
    runId,
  });
  const entry = {
    id: randomUUID(),
    at: Date.now(),
    runId,
    reason: detail,
    failedStepId: failedId,
    preserved: replanned?.preserved || [],
    reopened: replanned?.reopened || [],
  };
  const current = store.getTask(taskId);
  store.updateTask(
    taskId,
    { autoReplans: [...(current.autoReplans || []), entry] },
    'plan.replanned',
  );
  store.addTaskEvent(taskId, {
    type: 'plan.replanned',
    runId,
    stepId: failedId,
    data: entry,
  });
  return {
    entry,
    steps: store.getTask(taskId).plan.filter((step) => step.status === 'pending'),
  };
}

export function replanTask(taskId, { reason = '', steps = null } = {}) {
  const task = store.getTask(taskId);
  if (!task) return null;
  if (running.has(taskId)) {
    throw new Error('任务正在执行，停止后才能重规划');
  }
  const result = store.replanUnfinished(taskId, {
    reason: reason || '用户手动重规划未完成步骤',
    source: 'manual',
    steps: Array.isArray(steps) ? steps : undefined,
  });
  store.updateTask(
    taskId,
    {
      status: result?.reopened?.length ? 'idle' : task.status,
      endedAt: result?.reopened?.length ? null : task.endedAt,
      error: null,
      quality: result?.reopened?.length ? { status: 'pending' } : task.quality,
      manualReplanAt: Date.now(),
    },
    'plan.replanned',
  );
  store.addTaskEvent(taskId, {
    type: 'plan.replanned',
    runId: task.runId || null,
    data: {
      source: 'manual',
      reason: reason || '用户手动重规划未完成步骤',
      preserved: result?.preserved || [],
      reopened: result?.reopened || [],
      planVersion: store.getTask(taskId)?.planVersion || 0,
    },
  });
  return result;
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
    autoReplans: [],
    quality: { status: 'pending' },
    stats: { ...task.stats, ms: 0 },
  });
  store.addTaskEvent(taskId, {
    type: 'run.start',
    runId,
    data: { goal: task.goal, workspace: task.workspace, speed },
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
    store.setPlan(taskId, initial, {
      reason: '初版工序计划',
      source: 'orchestrator',
      runId,
    });
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
      const degraded = !!decision.degraded;
      store.updateStep(taskId, 'debate', {
        status: 'done',
        agentId: decision.judgeId || judge?.id || '',
        title: `方案讨论与裁决 · ${degraded ? '降级采用' : '采纳'}方案 ${decision.winnerId}`,
        note: `${degraded ? '降级采用' : '采纳'}方案 ${decision.winnerId} · ${
          decision.average == null ? '无有效评分' : `${decision.average} 分`
        } · ${decision.votes} 票`,
        degraded,
        endedAt: Date.now(),
      });
      outputs.set('debate', {
        stepId: 'debate',
        title: '多智能体方案讨论与裁决',
        role: 'planner',
        name: decision.judgeName,
        text: [
          `# ${degraded ? '降级采用' : '采纳'}方案 ${decision.winnerId} · ${decision.angleLabel}`,
          `提案人：${decision.winnerName} · ${
            decision.average == null ? '无有效评分' : `平均 ${decision.average} 分`
          } · ${decision.votes} 票`,
          degraded ? `\n> ${decision.reason}` : '',
          '',
          decision.brief,
        ].join('\n'),
        passed: true,
      });
    } else {
      const latest = store.getTask(taskId).debate;
      const reason = latest?.reason || '本轮未进行方案讨论';
      if (latest?.status === 'failed') {
        store.updateStep(taskId, 'debate', { status: 'error', note: reason, endedAt: Date.now() });
        throw new Error(`方案讨论失败：${reason}`);
      }
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
    let first = await executeSteps(task, workPlan, { outputs, speed, signal });
    if (!first.ok && !signal.aborted) {
      const replanned = replanFailure(taskId, first, { runId });
      if (replanned?.steps.length) {
        first = await executeSteps(task, replanned.steps, { outputs, speed, signal });
      }
    }
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

      store.appendPlan(taskId, repairSteps, {
        reason: `第 ${repairRound} 轮返工计划`,
        source: 'auto-repair',
        runId,
      });
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
          degraded: !!decision?.degraded,
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

    const finalStatus =
      review?.passed && !decision?.degraded ? 'done' : 'needs_attention';
    const finished = store.getTask(taskId);
    const quality = finished.quality || { status: 'pending' };
    store.updateTask(
      taskId,
      {
        status: finalStatus,
        endedAt: Date.now(),
        quality,
        // 真实工时＝各工序实际耗时之和；墙钟另记，含排队、重试与等待
        stats: { ...finished.stats, ms: workMsOf(finished), wallMs: Date.now() - startedAt },
      },
      'task.status',
    );
    store.addTaskEvent(taskId, {
      type: 'run.end',
      runId,
      data: {
        status: finalStatus,
        repairRound,
        quality: store.getTask(taskId)?.quality || null,
        ms: Date.now() - startedAt,
      },
    });
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
            // 中断也要落 endedAt，否则这一步的耗时算不进去，工时永远是 0
            ...(step.startedAt ? { endedAt: Date.now() } : {}),
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
      const broken = store.getTask(taskId);
      const gate = broken?.quality || { status: 'pending' };
      const patch = {
        status: aborted ? 'stopped' : 'error',
        endedAt: Date.now(),
        error: aborted ? '已停止' : err.message,
        // 中断时质量门确实没跑过，别让它永远停在「待执行」
        quality:
          gate.status === 'pending'
            ? { status: 'not-run', reason: aborted ? '已停止，质量门未执行' : '工序中断，质量门未执行' }
            : gate,
      };
      if (broken) patch.stats = { ...broken.stats, ms: workMsOf(broken), wallMs: Date.now() - startedAt };
      store.updateTask(taskId, patch, 'task.status');
      store.addTaskEvent(taskId, {
        type: 'run.error',
        runId,
        data: {
          aborted,
          error: patch.error,
          ms: Date.now() - startedAt,
        },
      });
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
  const mentioned = parseMentions(text);

  const userMessage = store.addMessage(taskId, {
    agentId: 'user',
    name: '你',
    role: 'user',
    title: 'Owner',
    color: '#94a3b8',
    kind: 'user',
    text,
    done: true,
  }, {
    to: mentioned.length ? mentioned : null,
  });

  try {
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
        }, {
          to: mentioned,
          parentMessageId: userMessage.id,
          causeBy: userMessage.id,
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
        }, {
          to: { kind: 'owner', id: 'user', name: '你' },
          parentMessageId: userMessage.id,
          causeBy: userMessage.id,
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
        }, {
          to: { kind: 'owner', id: 'user', name: '你' },
          parentMessageId: userMessage.id,
          causeBy: userMessage.id,
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
        {
          kind: 'text',
          signal,
          to: { kind: 'owner', id: 'user', name: '你' },
          parentMessageId: userMessage.id,
          causeBy: userMessage.id,
        },
      );
      if (res.code !== 0) throw new Error(describeCliResult(res));
    } else {
      const out = sim.compose({ kind: 'chat', goal: task.goal, agent, outputs: { userText: text } });
      await streamMessage(task, agent, out.text, {
        kind: 'text',
        speed,
        signal,
        to: { kind: 'owner', id: 'user', name: '你' },
        parentMessageId: userMessage.id,
        causeBy: userMessage.id,
      });
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
    }, {
      to: { kind: 'owner', id: 'user', name: '你' },
      parentMessageId: userMessage.id,
      causeBy: userMessage.id,
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
