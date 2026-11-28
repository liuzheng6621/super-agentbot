import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { store, randomUUID, ROLE_LABEL, TOOL_CATALOG } from './store.mjs';
import * as sim from './sim.mjs';
import { streamText, spawnCli, sleep, classifyCliExit, describeCliResult } from './adapters.mjs';
import { runDag, throwIfAborted } from './dag.mjs';
import { versionOf, spillText } from './fs.mjs';
import { workspacePoolPath } from './workspace.mjs';
import {
  clearWorkspaceIndexInvalidation,
  rememberWorkspaceIndexAdd,
  takeWorkspaceIndexAdds,
  takeWorkspaceIndexMoves,
  workspaceIndexRevision,
} from './workspace-index.mjs';
import { estimateTokens } from './tokens.mjs';
import { toolGateway } from './tool-gateway.mjs';
import { providerRoute, withProviderProfile } from './providers.mjs';
import { policySummary, resolveCliPolicy } from './cli-policy.mjs';
import { commandKey } from './command-key.mjs';
import { timeoutFor, timeoutSummary } from './timeouts.mjs';
import { attachmentAbsolutePath, imageDataUrl } from './attachments.mjs';
import { commandText, detectTestCommand, testEvidence, testScope } from './test-entry.mjs';
export { detectTestCommand } from './test-entry.mjs';
import { isPlannerPlanComplete, parsePlannerPlan } from './plan-schema.mjs';
import { buildContextPack as buildContextPackFromFiles } from './context-budget.mjs';
import { stableBlock, volatileBlock } from './context-budget.mjs';
export {
  compactTaskContext,
  listTaskCompactions,
  replayTaskCompaction,
  stableBlock,
  volatileBlock,
} from './context-budget.mjs';
import {
  isSelfReview,
  recordReviewIndependence,
  reviewIndependenceFor,
} from './review-independence.mjs';
export { isSelfReview, recordReviewIndependence, reviewIndependenceFor } from './review-independence.mjs';
import {
  isCompleteCritiqueText,
  isCompleteDecisionText,
  isCompleteProposalText,
  isCompleteStepText,
  isCompleteSummaryText,
  isUsableProposalText,
  parseProposalScores,
  proposalDiversity,
  rankProposals,
} from './debate-analysis.mjs';
export {
  isCompleteCritiqueText,
  isCompleteDecisionText,
  isCompleteProposalText,
  isCompleteStepText,
  isCompleteSummaryText,
  isUsableProposalText,
  parseProposalScores,
  proposalDiversity,
  rankProposals,
} from './debate-analysis.mjs';
import { parseReviewVerdictDetails, parseReviewVerdict } from './review-analysis.mjs';
export { parseReviewVerdictDetails, parseReviewVerdict } from './review-analysis.mjs';
import {
  cancelQueuedTask,
  configureScheduler,
  ensureTaskLease,
  enqueueTask,
  isQueued,
  isScheduled,
  schedulerSnapshot,
  withAgentLease,
} from './scheduler.mjs';

/** taskId -> { runId, controller, stopping } */
const running = new Map();
/** agentId -> 正在执行的任务数，避免并行任务把状态互相改回 idle */
const activeAgents = new Map();
/** taskId -> { root, generation, complete, scannedAt, scanMs, files } */
const fileIndex = new Map();
let fileIndexGeneration = 0;

const STEP_KIND = {
  planner: 'plan',
  architect: 'architect',
  coder: 'coder',
  tester: 'tester',
  reviewer: 'reviewer',
};

/** Persisted agents only carry providerId; resolve secrets into a child copy. */
export function agentForExecution(agent) {
  return withProviderProfile(agent, store.providerForAgent(agent));
}

/** Return the ordered execution copies for an agent's primary and fallback providers. */
export function agentRouteForExecution(agent) {
  const route = providerRoute(agent, store.providers);
  if (!route.length) return [agentForExecution(agent)];
  return route.map((provider) => withProviderProfile(agent, provider));
}

/** Resolve phase budgets through settings → Provider → Agent/Profile. */
export function timeoutsForAgent(agent) {
  const provider = agent?.provider || (agent ? store.providerForAgent(agent) : null);
  const sources = { provider, settings: store.db.settings };
  return {
    proposal: timeoutFor(agent, 'proposal', sources),
    critique: timeoutFor(agent, 'critique', sources),
    decision: timeoutFor(agent, 'decision', sources),
    step: timeoutFor(agent, 'step', sources),
    qualityGate: timeoutFor(agent, 'qualityGate', sources),
  };
}

export function timeoutAuditFor(agent) {
  const resolved = timeoutsForAgent(agent);
  return { ...resolved, summary: timeoutSummary(resolved) };
}

function timeoutMeta(agent, kind) {
  return {
    timeoutKind: kind,
    timeoutMs: timeoutFor(agent, kind, {
      provider: agent?.provider || (agent ? store.providerForAgent(agent) : null),
      settings: store.db.settings,
    }),
  };
}

/**
 * 席位缺席时的兜底顺序按角色分别排：评审员永远不落到实现者身上，
 * 否则「评审与实现分离」会静默失效——自己写、自己审、还显示质量门通过。
 */
const PICK_ORDER = {
  planner: ['planner', 'architect', 'reviewer', 'coder', 'tester'],
  architect: ['architect', 'planner', 'coder', 'reviewer', 'tester'],
  coder: ['coder', 'tester', 'architect', 'planner', 'reviewer'],
  tester: ['tester', 'coder', 'architect', 'planner', 'reviewer'],
  reviewer: ['reviewer', 'tester', 'architect'],
};

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
  // 评审没有 tester / architect 兜底时必须显式失败，不能悄悄落回实现者。
  if (role === 'reviewer') return null;
  const seats = store.agents.filter((a) => a.seat !== false);
  return seats.find((a) => a.role !== 'coder') || seats[0] || store.agents[0] || null;
}

export async function writeWorkspaceFile(task, relPath, content, meta = {}) {
  const invocation = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.write',
    operation: 'write',
    args: { op: 'write', path: relPath, content },
    // The system principal authorizes the write; agentId keeps the producing
    // agent in the audit trail without impersonating it for permission checks.
    agentId: meta.agentId || '',
    principal: { kind: 'system', id: 'orchestrator', name: 'Orchestrator' },
    stepId: meta.stepId || '',
    executionId: meta.executionId || '',
    source: 'orchestrator',
  });
  const executionAgent = meta.agentId ? store.getAgent(meta.agentId) : null;
  const abs = executionAgent?.workspacePolicy?.crossTask
    ? workspacePoolPath(task, relPath, executionAgent)
    : path.join(task.workspace, invocation.result.path);
  if (!executionAgent?.workspacePolicy?.crossTask) {
    rememberWorkspaceIndexAdd(task, invocation.result.path);
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
const MAX_SCAN_DEPTH = 12;

/** 只为测试与观测：全量目录扫描次数、耗时与索引状态。 */
export const scanStats = {
  calls: 0,
  files: 0,
  elapsedMs: 0,
  complete: true,
  truncated: false,
  lastScanAt: null,
};

export function listWorkspaceFiles(
  task,
  { maxFiles = MAX_SCAN_FILES, maxDepth = MAX_SCAN_DEPTH } = {},
) {
  const startedAt = Date.now();
  scanStats.calls += 1;
  const out = [];
  let truncated = maxFiles <= 0;
  if (truncated) {
    scanStats.files = 0;
    scanStats.elapsedMs = 0;
    scanStats.complete = false;
    scanStats.truncated = true;
    scanStats.lastScanAt = Date.now();
    out.complete = false;
    return out;
  }
  const walk = (dir, prefix = '', depth = 0) => {
    if (out.length >= maxFiles || depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel, depth + 1);
        if (out.length >= maxFiles) {
          truncated = true;
          return;
        }
      } else {
        if (out.length >= maxFiles) {
          truncated = true;
          return;
        }
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
          truncated = true;
        }
      }
    }
  };
  walk(task.workspace);
  const elapsedMs = Date.now() - startedAt;
  scanStats.files = out.length;
  scanStats.elapsedMs = elapsedMs;
  scanStats.complete = !truncated;
  scanStats.truncated = truncated;
  scanStats.lastScanAt = Date.now();
  out.complete = !truncated;
  return out;
}

function fileIndexKey(task) {
  return `${task?.id || ''}:${path.resolve(task?.workspace || '')}`;
}

/** 权威扫描：CLI 前后与删除判断只能使用这份结果。 */
export function snapshotFiles(task, options = {}) {
  const files = listWorkspaceFiles(task, options);
  const complete = files.complete !== false;
  const cached = {
    root: path.resolve(task.workspace),
    generation: ++fileIndexGeneration,
    complete,
    scannedAt: Date.now(),
    scanMs: scanStats.elapsedMs,
    files: new Map(files.map((file) => [file.path, file])),
  };
  fileIndex.set(fileIndexKey(task), cached);
  clearWorkspaceIndexInvalidation(task);
  takeWorkspaceIndexAdds(task);
  takeWorkspaceIndexMoves(task);
  return files;
}

function indexedFile(task, relPath) {
  try {
    const stat = fs.statSync(path.join(task.workspace, relPath), { bigint: true });
    if (!stat.isFile()) return null;
    return {
      path: relPath,
      bytes: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      mtimeNs: stat.mtimeNs.toString(),
    };
  } catch {
    return null;
  }
}

function knownFiles(task) {
  const key = fileIndexKey(task);
  const cached = fileIndex.get(key);
  const revision = workspaceIndexRevision(task);
  if (!cached?.complete) return snapshotFiles(task);
  if (revision.invalidated === null) return snapshotFiles(task);
  const moves = takeWorkspaceIndexMoves(task);
  const adds = takeWorkspaceIndexAdds(task);
  if (!revision.invalidated?.size && !moves.length && !adds.length) {
    return [...cached.files.values()];
  }

  // 移动记录必须在失效删除前建立候选，否则目录源条目已从缓存消失。
  const moveSource = new Map(cached.files);
  const movedPaths = new Set();
  for (const relPath of adds) {
    // 新增路径即使已被同一批移动带走，也要保留占位以便沿移动链映射到最终路径。
    if (!moveSource.has(relPath)) {
      moveSource.set(relPath, {
        path: relPath,
        bytes: 0,
        mtimeMs: 0,
        mtimeNs: '0',
      });
    }
  }
  for (const { from, to } of moves) {
    for (const [filePath, file] of [...moveSource.entries()]) {
      if (filePath !== from && !filePath.startsWith(`${from}/`)) continue;
      const nextPath = filePath === from ? to : `${to}${filePath.slice(from.length)}`;
      moveSource.delete(filePath);
      moveSource.set(nextPath, { ...file, path: nextPath });
      movedPaths.add(nextPath);
    }
  }

  for (const relPath of revision.invalidated) {
    for (const filePath of cached.files.keys()) {
      if (filePath === relPath || filePath.startsWith(`${relPath}/`)) {
        cached.files.delete(filePath);
      }
    }
  }
  clearWorkspaceIndexInvalidation(task);
  cached.generation = ++fileIndexGeneration;
  // 最终 stat 既能刷新元数据，也能排除移动后又被删除或覆盖的路径。
  for (const relPath of movedPaths) {
    const file = indexedFile(task, relPath);
    if (file) cached.files.set(relPath, file);
  }
  for (const relPath of adds) {
    const file = indexedFile(task, relPath);
    if (file) cached.files.set(relPath, file);
  }
  cached.scannedAt = Date.now();
  return [...cached.files.values()];
}

export function fileIndexStatus(task) {
  const cached = fileIndex.get(fileIndexKey(task));
  if (!cached) return null;
  return {
    generation: cached.generation,
    complete: cached.complete,
    lastScanAt: cached.scannedAt,
    scanMs: cached.scanMs,
    indexedFiles: cached.files.size,
  };
}

export function buildContextPack(task, options = {}) {
  return buildContextPackFromFiles(task, {
    ...options,
    listFiles: options.listFiles || knownFiles,
  });
}

export function refreshContextFileIndex(task) {
  snapshotFiles(task);
  return fileIndexStatus(task);
}

/* ------------------------------------------------------------------ */
/* Skills：项目级与用户级 SKILL.md                                      */
/* ------------------------------------------------------------------ */

const SKILL_FILE_NAME = 'SKILL.md';
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILL_CONTENT_CHARS = 6000;
const MAX_SKILLS = 50;
const MAX_ACTIVE_SKILLS = 4;
const MAX_SKILL_PROMPT_CHARS = 12000;
const SKILL_CACHE_MS = 1500;
const skillCache = new Map();

export function clearSkillCache() {
  skillCache.clear();
}

function skillId(value, fallback = 'skill') {
  const id = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || fallback;
}

function parseSkillList(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      /* 兼容不带引号的 [a, b] 写法 */
    }
  }
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[,，]/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function parseSkillDocument(raw, fallbackId) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const data = {};
  let body = text;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      let currentKey = '';
      for (const line of lines.slice(1, end)) {
        const item = line.match(/^\s*-\s+(.+?)\s*$/);
        if (item && currentKey) {
          if (!Array.isArray(data[currentKey])) data[currentKey] = [];
          data[currentKey].push(item[1].replace(/^["']|["']$/g, ''));
          continue;
        }
        const pair = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (!pair) continue;
        currentKey = pair[1].toLowerCase();
        data[currentKey] = pair[2].trim() ? parseSkillList(pair[2]) : [];
      }
      body = lines.slice(end + 1).join('\n').trim();
    }
  }
  const first = (key) => {
    const value = data[key];
    return Array.isArray(value) ? value[0] || '' : String(value || '');
  };
  const list = (key) =>
    Array.isArray(data[key])
      ? data[key].map((item) => String(item).trim()).filter(Boolean)
      : parseSkillList(data[key]);
  return {
    id: skillId(first('id') || fallbackId),
    name: first('name') || fallbackId,
    description: first('description'),
    triggers: list('triggers').map((item) => item.toLowerCase()),
    roles: list('roles').map((item) => item.toLowerCase()),
    always: first('always').toLowerCase() === 'true',
    enabled: first('enabled').toLowerCase() !== 'false',
    content: body.slice(0, MAX_SKILL_CONTENT_CHARS),
  };
}

function skillRoots(task) {
  const roots = [];
  const seen = new Set();
  const add = (root, source) => {
    if (!root) return;
    const abs = path.resolve(String(root));
    if (seen.has(abs)) return;
    seen.add(abs);
    roots.push({ root: abs, source });
  };
  add(task?.workspace, 'workspace');
  if (task?.sourceWorkspace && task.sourceWorkspace !== task.workspace) {
    add(task.sourceWorkspace, 'source-workspace');
  }
  add(
    process.env.AGENTFORGE_USER_SKILLS_DIR ||
      path.join(os.homedir(), '.agents', 'skills'),
    'user',
  );
  return roots;
}

function readSkillFile(abs, fallbackId, source) {
  try {
    const stat = fs.lstatSync(abs);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return null;
    const parsed = parseSkillDocument(fs.readFileSync(abs, 'utf8'), fallbackId);
    return {
      ...parsed,
      source,
      file: path.basename(path.dirname(abs)) + '/' + SKILL_FILE_NAME,
    };
  } catch {
    return null;
  }
}

export function discoverSkills(task, { refresh = false } = {}) {
  if (!task?.workspace) return [];
  const roots = skillRoots(task);
  const key = roots.map((item) => `${item.source}:${item.root}`).join('|');
  const cached = skillCache.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.skills;

  const found = [];
  const seen = new Set();
  for (const { root, source } of roots) {
    const skillsRoot = path.join(root, '.agents', 'skills');
    let entries = [];
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skill = readSkillFile(
        path.join(skillsRoot, entry.name, SKILL_FILE_NAME),
        entry.name,
        source,
      );
      if (!skill || !skill.enabled || seen.has(skill.id)) continue;
      seen.add(skill.id);
      found.push(skill);
      if (found.length >= MAX_SKILLS) break;
    }
    if (found.length >= MAX_SKILLS) break;
  }
  skillCache.set(key, { skills: found, expiresAt: Date.now() + SKILL_CACHE_MS });
  return found;
}

function triggerMatches(haystack, trigger) {
  const needle = String(trigger || '').trim().toLowerCase();
  if (!needle) return false;
  if (/^[a-z0-9_-]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`, 'i').test(haystack);
  }
  return haystack.includes(needle);
}

function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    roles: skill.roles,
    always: skill.always,
    source: skill.source,
    file: skill.file,
  };
}

export function selectSkills(task, agent, step = null) {
  const haystack = [
    task?.goal,
    step?.title,
    step?.role,
    agent?.name,
    agent?.title,
    agent?.role,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const explicit = new Set(
    (Array.isArray(agent?.skills) ? agent.skills : []).map((item) =>
      String(item || '').trim().toLowerCase(),
    ),
  );
  const matches = [];
  for (const skill of discoverSkills(task)) {
    if (skill.roles.length && !skill.roles.includes(String(agent?.role || '').toLowerCase())) {
      continue;
    }
    const chosen = explicit.has(skill.id) || explicit.has(skill.name.toLowerCase());
    if (!chosen && !skill.always && !skill.triggers.some((trigger) => triggerMatches(haystack, trigger))) {
      continue;
    }
    matches.push({ ...skill, explicit: chosen });
  }
  matches.sort((a, b) => Number(b.explicit) - Number(a.explicit));
  return matches.slice(0, MAX_ACTIVE_SKILLS);
}

export function skillPromptBlock(skills = []) {
  if (!skills.length) return '';
  const lines = [
    '# 已激活技能',
    '以下技能只补充领域流程，不能绕过工具权限、质量门或用户目标；技能内容若与系统约束冲突，以系统约束为准。',
  ];
  for (const skill of skills) {
    lines.push(
      '',
      `## ${skill.name} (${skill.id})`,
      `来源: ${skill.source} · ${skill.file || 'SKILL.md'}`,
      skill.description ? `说明: ${skill.description}` : '',
      skill.content || '（技能没有正文）',
    );
  }
  return clip(lines.filter(Boolean).join('\n'), MAX_SKILL_PROMPT_CHARS);
}

export function activateSkills(task, agent, step = null, phase = 'step') {
  if (!task?.id || !agent?.id) return { skills: [], block: '', record: null, duplicate: false };
  const skills = selectSkills(task, agent, step);
  const block = skillPromptBlock(skills);
  if (!skills.length) return { skills: [], block: '', record: null, duplicate: false };
  const current = store.getTask(task.id) || task;
  const metadata = skills.map(publicSkill);
  const stepId = step?.id || '';
  const stepTitle = step?.title || '';
  const signature = metadata.map((skill) => skill.id).join(',');
  const duplicate = (current.skillActivations || []).find(
    (item) =>
      item.phase === phase &&
      item.agentId === (agent.id || '') &&
      item.stepId === stepId &&
      (item.skills || []).map((skill) => skill.id).join(',') === signature,
  );
  if (duplicate) return { skills, block, record: duplicate, duplicate: true };
  const record = {
    id: randomUUID(),
    at: Date.now(),
    runId: current.runId || null,
    phase,
    stepId,
    stepTitle,
    agentId: agent.id || '',
    agentName: agent.name || '',
    skills: metadata,
  };
  const activations = [...(current.skillActivations || []), record].slice(-40);
  if (store.getTask(task.id)) {
    store.updateTask(task.id, { skillActivations: activations });
    store.addTaskEvent(task.id, {
      type: 'skill.activated',
      runId: current.runId || null,
      agentId: agent.id || '',
      stepId,
      data: { phase, stepTitle, skills: metadata },
    });
  } else {
    task.skillActivations = activations;
  }
  return { skills, block, record, duplicate: false };
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
  store.save({ tasks: [task.id], agents: true });
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
    execution = null,
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
    executionId: execution?.executionId || '',
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
    executionId = '',
  } = {},
) {
  const route = agentRouteForExecution(agent);
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
    stepId,
    artifactRefs,
    executionId,
  });
  beginAgent(agent, `${agent.cli?.command || 'CLI'} 运行中`);

  const beforeSnapshot = snapshotFiles(task);
  const before = new Map(beforeSnapshot.map((f) => [f.path, f]));
  const beforeComplete = beforeSnapshot.complete !== false;
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

  // 重试和 Provider 回退分别记账，避免只统计最后一次尝试。
  let promptTokens = 0;
  let responseTokens = 0;
  let res = { code: -1, stdout: '', stderr: '没有可执行的 Provider', elapsed: 0 };
  let finalExecAgent = route[0] || agentForExecution(agent);
  let finalAttempts = 0;
  let finalRouteIndex = 0;

  for (let routeIndex = 0; routeIndex < route.length; routeIndex += 1) {
    const execAgent = route[routeIndex];
    const provider = execAgent.provider || store.providerForAgent(agent);
    const providerName = provider?.name || provider?.id || '本机 CLI';
    const cliPolicy = resolveCliPolicy(execAgent);
    const cliPolicyData = policySummary(cliPolicy);
    const callId = randomUUID();
    const toolCall = store.addTaskEvent(task.id, {
      type: 'tool.call.start',
      agentId: agent.id,
      stepId,
      executionId,
      data: {
        callId,
        tool: 'cli',
        command: execAgent.cli?.command || '',
        args: execAgent.cli?.args || [],
        cwd: task.workspace,
        timeout,
        providerId: provider?.id || '',
        providerName,
        routeIndex,
        policy: cliPolicyData,
        principal: { kind: 'agent', id: agent.id, name: agent.name, role: agent.role },
        messageId: msg.id,
      },
    });
    store.addTaskEvent(task.id, {
      type: 'cli.policy.start',
      agentId: agent.id,
      stepId,
      executionId,
      data: {
        callId,
        command: cliPolicy.command,
        providerId: provider?.id || '',
        providerName,
        routeIndex,
        ...cliPolicyData,
      },
    });

    let routeResult = null;
    let routeAttempts = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      routeAttempts = attempt;
      finalAttempts += 1;
      const attemptTokens = estimateTokens(prompt);
      if (!cliPolicy.ok) {
        routeResult = {
          code: -6,
          stdout: '',
          stderr: cliPolicy.reason,
          elapsed: 0,
          policyDenied: true,
          policy: cliPolicy,
        };
      } else {
        promptTokens += attemptTokens;
        store.countPrompt(task.id, agent.id, attemptTokens);
        try {
          routeResult = await spawnCli(execAgent, prompt, {
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
        } catch (err) {
          routeResult = { code: -1, stdout: '', stderr: err.message, elapsed: 0 };
        }
        const attemptTokensOut = estimateTokens(routeResult.stdout || '');
        responseTokens += attemptTokensOut;
        store.recordProviderUsage(task.id, {
          providerId: provider?.id || '',
          model: execAgent.provider?.model || provider?.model || execAgent.cli?.model || '',
          runId: task.runId,
          agentId: agent.id,
          tokensIn: attemptTokens,
          tokensOut: attemptTokensOut,
          cost: null,
          source: 'cli',
          usageSource: 'estimate',
          attempt,
          routeIndex,
          code: routeResult.code,
          elapsedMs: routeResult.elapsed,
        });
      }
      const combined = `${routeResult.stdout || ''}\n${routeResult.stderr || ''}`;
      if (
        routeResult.code === 0 ||
        attempt === 2 ||
        signal?.aborted ||
        !shouldRetryCliResult(routeResult)
      ) {
        break;
      }
      const failure = classifyCliExit(routeResult);
      store.appendMessage(
        task.id,
        msg.id,
        `\n\n> ⚠️ ${providerName}：${
          failure.kind === 'windows-init'
            ? failure.label
            : `上游连接抖动（${combined.match(TRANSIENT_CLI_ERROR)?.[0] || failure.label}）`
        }，2 秒后重试一次。\n\n`,
      );
      try {
        await sleep(2000, signal);
      } catch {
        break;
      }
    }

    res = routeResult || { code: -1, stdout: '', stderr: 'Provider 没有返回结果', elapsed: 0 };
    finalExecAgent = execAgent;
    finalRouteIndex = routeIndex;
    const effectivePolicy = res.policy || cliPolicy;
    const effectivePolicyData = policySummary(effectivePolicy);
    const policyStatus = res.policyDenied ? 'denied' : effectivePolicyData.status;
    store.addTaskEvent(task.id, {
      type: res.policyDenied ? 'cli.policy.denied' : 'cli.policy.end',
      agentId: agent.id,
      stepId,
      executionId,
      data: {
        ...effectivePolicyData,
        callId,
        providerId: provider?.id || '',
        providerName,
        routeIndex,
        attempts: routeAttempts,
        status: policyStatus,
        code: res.code,
        elapsed: res.elapsed,
      },
    });
    store.addTaskEvent(task.id, {
      type: 'tool.call.end',
      agentId: agent.id,
      stepId,
      executionId,
      data: {
        callId: toolCall?.data?.callId || callId,
        tool: 'cli',
        command: execAgent.cli?.command || '',
        providerId: provider?.id || '',
        providerName,
        routeIndex,
        attempts: routeAttempts,
        code: res.code,
        elapsed: res.elapsed,
        timedOut: !!res.timedOut,
        status: res.policyDenied ? 'denied' : res.code === 0 ? 'ok' : 'error',
        denied: !!res.policyDenied,
        policy: effectivePolicyData,
        error: res.policyDenied ? effectivePolicy.reason : '',
        stdout: clip(res.stdout || '', 1600),
        stderr: clip(res.stderr || '', 1600),
      },
    });

    if (
      res.code === 0 ||
      res.policyDenied ||
      signal?.aborted ||
      routeIndex >= route.length - 1
    ) {
      break;
    }
    const next = route[routeIndex + 1];
    const failure = classifyCliExit(res);
    const nextProvider = next.provider || store.providerForAgent(agent);
    store.addTaskEvent(task.id, {
      type: 'provider.fallback',
      agentId: agent.id,
      stepId,
      executionId,
      data: {
        fromProviderId: provider?.id || '',
        fromProviderName: providerName,
        toProviderId: nextProvider?.id || '',
        toProviderName: nextProvider?.name || nextProvider?.id || '本机 CLI',
        reason: failure.label,
        code: res.code,
        routeIndex,
      },
    });
    // 失败尝试的临时输出不应和下一家 Provider 的正文拼在一起。
    store.replaceMessage(task.id, msg.id, '');
    store.appendMessage(
      task.id,
      msg.id,
      `> ⚠️ Provider「${providerName}」失败（${failure.label}），已切换到「${
        nextProvider?.name || nextProvider?.id || '本机 CLI'
      }」。\n\n`,
    );
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
  const finalPolicy = res.policy || resolveCliPolicy(finalExecAgent);
  const finalPolicyData = policySummary(finalPolicy);
  store.endMessage(task.id, msg.id, {
    tokens: responseTokens || estimateTokens(res.stdout),
    tokensIn: promptTokens,
    ms: res.elapsed,
    exitCode: res.code,
    exitLabel: failure.label,
    timedOut: !!res.timedOut,
    partial: !!res.partial,
    settledEarly: !!res.settledEarly,
    providerId: finalExecAgent.provider?.id || '',
    providerName: finalExecAgent.provider?.name || '',
    usageSource: 'estimate',
    cost: null,
    providerRoute: route.map((item) => ({
      id: item.provider?.id || '',
      name: item.provider?.name || '',
    })),
    providerFallback: finalRouteIndex > 0,
    attempts: finalAttempts,
    executionPolicy: finalPolicyData.policy,
    policyStatus: res.policyDenied ? 'denied' : finalPolicyData.status,
    policySandbox: finalPolicyData.sandbox,
    policyBoundary: finalPolicyData.boundary,
    policyReason: finalPolicyData.reason,
    timeoutKind: timeoutMeta(agent, kind).timeoutKind,
    timeoutMs: timeout,
  });

  // 并行的 CLI 会改同一批文件。只把相对本工序开始前新出现/改过的路径归给本工序，
  // 避免后完成的工序把另一个 Agent 刚写的文件误记成自己的产物。
  const after = snapshotFiles(task);
  const changed = [];
  for (const f of after) {
    const prev = before.get(f.path);
    const touched = !prev || prev.bytes !== f.bytes || prev.mtimeNs !== f.mtimeNs;
    if (!touched) continue;
    changed.push({ ...f, prev });
  }
  const ownerOf = (relPath) =>
    store.getTask(task.id)?.artifacts?.find((artifact) => artifact.path === relPath)?.stepId || '';
  for (const f of changed) {
    const current = store.getTask(task.id);
    const ownedByOtherRunningStep = (current?.plan || []).some(
      (item) =>
        item.id !== stepId &&
        item.status === 'running' &&
        (item.outputPaths || []).includes(f.path),
    );
    if (ownedByOtherRunningStep) continue;
    const existingOwner = ownerOf(f.path);
    if (existingOwner && existingOwner !== stepId) continue;
    store.addArtifact(task.id, {
      path: f.path,
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
      version: versionOf(path.join(task.workspace, f.path)) || '',
      lang: path.extname(f.path).slice(1),
      agentId: agent.id,
      stepId,
      beforeVersion: f.prev?.version || '',
      source: 'cli',
      executionId,
    });
  }
  // 截断扫描不能证明文件真的被删除，不能据此写删除审计。
  if (beforeComplete && after.complete !== false) {
    const afterPaths = new Set(after.map((f) => f.path));
    for (const [relPath] of before) {
      if (afterPaths.has(relPath)) continue;
      store.markArtifactDeleted(task.id, relPath, {
        agentId: agent.id,
        stepId,
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
  const imagePaths = (context?.images || []).map(
    (image) =>
      `- ${image.mime} ${image.width}×${image.height}，只读路径：${attachmentAbsolutePath(image)}`,
  );
  const lines = [
    stableBlock(context),
    `你是「${agent.name}」，团队中的${agent.title}。`,
    toolPolicyBlock(agent),
    extra.skills?.length ? skillPromptBlock(extra.skills) : '',
    '',
    '# 项目目标',
    task.goal,
    '',
    `STEP_ID: ${step?.id || 'summary'}`,
    '',
    '# 你当前负责的工序',
    step ? `${step.title}（角色：${ROLE_LABEL[role] || role}）` : '协作讨论',
    '',
    '# 依赖工序的真实产物',
    depsText || '无',
    '',
    imagePaths.length
      ? `# 图片附件\n${imagePaths.join('\n')}\n需要细节时用文件工具读取上面的只读路径。`
      : '',
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
      '5. 最后一行必须单独输出 `VERDICT: {"decision":"PASS|FAIL","blockers":0,"should":0}`，不能省略。',
      '6. 只有没有 Blocker 且质量门通过时才能 PASS。',
    );
  } else {
    lines.push('4. 结尾用一行「下一步建议：…」收口。');
  }
  // 易变内容永远放最后：前面越稳定，提供方的前缀缓存命中越长
  lines.push('', volatileBlock(context, step?.title || '', { inlineImages: agent.mode !== 'cli' }));
  return lines.filter((line) => line !== '').join('\n');
}

function buildPlanPrompt(agent, task, step, context = null, extra = {}) {
  return [
    stableBlock(context),
    `你是「${agent.name}」，团队里的${agent.title}。`,
    toolPolicyBlock(agent),
    extra.skills?.length ? skillPromptBlock(extra.skills) : '',
    '',
    '# 项目目标',
    task.goal,
    '',
    `STEP_ID: ${step?.id || 'summary'}`,
    '',
    '# 你的任务',
    '把目标拆成可验收的工序，确认每道工序的负责人角色、依赖关系、产出物与验收标准。',
    '团队已有规划、架构、实现、测试、评审五个执行席位，不要把所有工作都分给实现工程师。',
    '',
    '不要写业务代码，不要客套。先用中文 Markdown 说明拆解依据，再输出唯一的正式计划 JSON，最后一行用「下一步建议：…」收口。',
    '',
    '# PLAN CONTRACT v1',
    '# 正式计划 JSON 契约',
    '```json',
    '{"steps":[',
    '  {"id":"design","title":"技术方案","role":"architect","needs":["plan"],"outputPaths":["docs/design.md"]},',
    '  {"id":"impl-core","title":"实现核心","role":"coder","needs":["design"],"outputPaths":["src/core.js"]},',
    '  {"id":"impl-api","title":"实现 API","role":"coder","needs":["design"],"outputPaths":["src/api.js"]},',
    '  {"id":"tests","title":"测试编写","role":"tester","needs":["design"],"outputPaths":["tests/core.test.js"]},',
    '  {"id":"final-review","title":"评审与质量门","role":"reviewer","needs":["impl-core","impl-api","tests"],"outputPaths":[]}',
    ']}',
    '```',
    '',
    '契约要求：',
    '1. 工序数量 2 到 12，id 使用小写字母、数字和连字符。',
    '2. role 只能是 architect、coder、tester、reviewer；不要输出 planner 工序。',
    '3. needs 只能引用 plan 或列表中更早出现的工序；禁止循环依赖。',
    '4. 至少包含一个 coder 和一个 tester，且恰好包含一个 reviewer。',
    '5. reviewer 必须是最后一个终端工序，并直接或间接覆盖其余全部工序。',
    '6. outputPaths 每道工序最多 8 个，只能使用工作区相对路径，禁止绝对路径、反斜杠和 ..。',
    '7. 正式 JSON 必须放在最后一条「下一步建议：」之前；JSON 之后只能保留这一行收口。',
    '8. 如果无法给出合法计划，说明原因，平台会回退到稳定的默认流水线。',
    '',
    volatileBlock(context, '需求拆解', { inlineImages: agent.mode !== 'cli' }),
  ].join('\n');
}

function buildSummaryPrompt(agent, task, outputs, context, extra = {}) {
  return [
    stableBlock(context),
    `你是「${agent.name}」，团队里的${agent.title}。本轮协作已结束，由你做交付收口。`,
    toolPolicyBlock(agent),
    extra.skills?.length ? skillPromptBlock(extra.skills) : '',
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
    volatileBlock(context, '交付收口', { inlineImages: agent.mode !== 'cli' }),
  ]
    .filter(Boolean)
    .join('\n');
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

function buildProposalPrompt(task, agent, angle, context, extra = {}) {
  return [
    stableBlock(context),
    `你是「${agent.name}」，团队里的${agent.title || ROLE_LABEL[agent.role] || '成员'}。`,
    toolPolicyBlock(agent),
    extra.skills?.length ? skillPromptBlock(extra.skills) : '',
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
    volatileBlock(context, `方案提案 · ${angle.label}`, { inlineImages: agent.mode !== 'cli' }),
  ]
    .filter(Boolean)
    .join('\n');
}

function buildCritiquePrompt(task, agent, own, others, extra = {}) {
  return [
    `你是「${agent.name}」，团队里的${agent.title || ROLE_LABEL[agent.role] || '成员'}。现在进入交叉质询。`,
    toolPolicyBlock(agent),
    extra.skills?.length ? skillPromptBlock(extra.skills) : '',
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

function buildDecisionPrompt(task, judge, ranking, winner, extra = {}) {
  return [
    `你是「${judge.name}」，本轮方案讨论的主持人。成员已经完成提案与交叉评分，现在由你宣布裁决。`,
    toolPolicyBlock(judge),
    extra.skills?.length ? skillPromptBlock(extra.skills) : '',
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

async function runProposal(task, agent, { id, index, speed, signal, timeout = timeoutFor(agent, 'proposal') }) {
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
      const skillContext = activateSkills(task, agent, null, 'proposal');
      const res = await cliMessage(
        task,
        agent,
        buildProposalPrompt(task, agent, angle, buildContextPack(task), {
          skills: skillContext.skills,
        }),
        {
          kind: 'proposal',
          signal,
          timeout,
          completeWhen: isCompleteProposalText,
          settleMs: 4000,
          message: { debate: { phase: 'proposal', proposalId: id } },
        },
      );
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

async function runCritique(task, agent, { index, proposals, speed, signal, timeout = timeoutFor(agent, 'critique') }) {
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
      const skillContext = activateSkills(task, agent, null, 'critique');
      const res = await cliMessage(
        task,
        agent,
        buildCritiquePrompt(task, agent, own, others, { skills: skillContext.skills }),
        {
          kind: 'critique',
          signal,
          timeout,
          completeWhen: (value) => isCompleteCritiqueText(value, expectedIds),
          settleMs: 3000,
          message: { debate: { phase: 'critique', selfId: own?.id || '' } },
        },
      );
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
    return withAgentLease(task.id, agent.id, signal, () =>
      runProposal(task, agent, {
        id,
        index,
        speed,
        signal,
        timeout: timeoutFor(agent, 'proposal', {
          provider: store.providerForAgent(agent),
          settings: store.db.settings,
        }),
      }),
    );
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
    withAgentLease(task.id, agent.id, signal, () =>
      runCritique(task, agent, {
        index,
        proposals: valid,
        speed,
        signal,
        timeout: timeoutFor(agent, 'critique', {
          provider: store.providerForAgent(agent),
          settings: store.db.settings,
        }),
      }),
    ),
  );
  throwIfAborted(signal);

  const latest = store.getTask(task.id).debate;
  const ranking = rankProposals(latest.proposals);
  const diversity = proposalDiversity(latest.proposals);
  recordDebateDiversity(task.id, diversity);
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
    diversity,
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
      const skillContext = activateSkills(task, judge, null, 'decision');
      const res = await withAgentLease(task.id, judge.id, signal, () =>
        cliMessage(
          task,
          judge,
          buildDecisionPrompt(task, judge, ranking, winner, { skills: skillContext.skills }),
          {
            kind: 'decision',
            signal,
            timeout: timeoutFor(judge, 'decision', {
              provider: store.providerForAgent(judge),
              settings: store.db.settings,
            }),
            completeWhen: isCompleteDecisionText,
            settleMs: 5000,
            message: { debate: { phase: 'decision', winnerId: winner.id } },
          },
        ),
      );
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

async function runStep(
  task,
  agent,
  { step, kind, prompt, signal, speed, simOutputs, execution = null },
) {
  if (!agent) throw new Error('没有可用的智能体');
  if (agent.mode === 'cli') {
    const res = await cliMessage(task, agent, prompt, {
      kind,
      signal,
      timeout: timeoutFor(agent, 'step', {
        provider: store.providerForAgent(agent),
        settings: store.db.settings,
      }),
      causeBy: step?.id ? `step:${step.id}` : 'summary',
      stepId: step?.id || '',
      executionId: execution?.executionId || '',
      completeWhen: step
        ? step.id === 'plan' && step.role === 'planner'
          ? isPlannerPlanComplete
          : (value) => isCompleteStepText(value, step.role)
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
    executionId: execution?.executionId || '',
  });
  throwIfAborted(signal);
  for (const file of out.artifacts || []) {
    await writeWorkspaceFile(task, file.path, file.content, {
      agentId: agent.id,
      stepId: step?.id || '',
      executionId: execution?.executionId || '',
    });
  }
  if (step?.role === 'architect') {
    const mod = sim.pickModule(task.goal);
    await writeWorkspaceFile(task, `docs/${mod.name}-design.md`, sim.designDoc({ goal: task.goal }), {
      agentId: agent.id,
      stepId: step.id,
      executionId: execution?.executionId || '',
    });
  }
  if (step?.role === 'tester') {
    await writeWorkspaceFile(task, 'README.md', readmeFor(task), {
      agentId: agent.id,
      stepId: step.id,
      executionId: execution?.executionId || '',
    });
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
    last = await withAgentLease(task.id, agent.id, options.signal, () =>
      runStep(task, agent, options),
    );
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
  const reviewerRoles = new Set(['reviewer', 'tester', 'architect']);
  const eligible = (agent) => {
    if (!agent) return false;
    if (role !== 'reviewer') return true;
    return agent.seat !== false && reviewerRoles.has(agent.role);
  };
  const commandKeyOf = (agent) => commandKey(agent?.cli?.command);
  const push = (agent) => {
    if (!eligible(agent) || ordered.some((item) => item.id === agent.id)) return;
    if (agent.mode === 'cli') {
      const key = commandKeyOf(agent);
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
  if (role !== 'reviewer') {
    for (const agent of store.agents) {
      if (agent.seat !== false) push(agent);
    }
    for (const agent of store.agents) push(agent);
  }

  if (preferred?.mode === 'cli') {
    // 真实 CLI 任务不能在故障后偷偷落到内置模拟成员；
    // 没有可执行的 CLI 时返回空列表，让上层明确报错。
    return ordered.filter((agent) => agent.mode === 'cli' && agent.cli?.command);
  }
  return ordered;
}

/** 把角度覆盖 / 重复提案告警写进任务事件，UI 靠 decision.diversity 同步展示。 */
export function recordDebateDiversity(taskId, diversity) {
  if (!taskId || !diversity?.issues?.length) return null;
  return store.addTaskEvent(taskId, {
    type: 'debate.diversity',
    stepId: 'debate',
    data: {
      issues: diversity.issues,
      angleKeys: diversity.angleKeys,
      angleCoverage: diversity.angleCoverage,
      duplicateIds: diversity.duplicateIds,
      maxSimilarity: diversity.maxSimilarity,
    },
  });
}

export async function runQualityGate(task, step, signal) {
  const round = step?.round || 0;
  const current = store.getTask(task.id) || task;
  const plan = current.plan || [];
  const implementation = [...plan].reverse().find((s) => s.role === 'coder' && s.status === 'done');
  const testDesign = [...plan].reverse().find((s) => s.role === 'tester' && s.status === 'done');
  const coder = implementation && store.getAgent(implementation.agentId);
  const tester = testDesign && store.getAgent(testDesign.agentId);
  const cliMode = !!current.external || coder?.mode === 'cli' || tester?.mode === 'cli';
  const timeoutAgent = coder || tester || pickAgent('tester') || pickAgent('reviewer');
  const timeout = timeoutFor(timeoutAgent, 'qualityGate', {
    provider: timeoutAgent ? store.providerForAgent(timeoutAgent) : null,
    settings: store.db.settings,
  });

  // 真实 CLI 任务同样要跑工作区里真实存在的测试入口，不再一律 skipped
  const detected = detectTestCommand(current);
  if (!detected) {
    const quality = {
      status: 'no-test-entry',
      reason:
        '工作区里没找到可执行的测试入口（package.json scripts.test / Makefile / pytest 配置 / tests/），不能把本轮质量门判为通过',
      cli: cliMode,
      timeout,
      checkedAt: Date.now(),
      round,
    };
    store.updateTask(current.id, { quality });
    return quality;
  }

  const command = commandText(detected.command, detected.args);
  store.updateTask(current.id, {
    quality: {
      status: 'running',
      command,
      label: detected.label,
      source: detected.source,
      timeout,
      round,
    },
  });
  const startedAt = Date.now();
  const res = await spawnCli({ cli: { command: detected.command, args: detected.args } }, '', {
    cwd: current.workspace,
    timeout,
    signal,
    // 质量门只跑测试命令，不能继承 Provider 密钥（F7）。
    sanitizeEnv: true,
  });
  throwIfAborted(signal);

  const timedOut = !!res.timedOut || res.code === -3;
  const evidence = testEvidence(`${res.stdout || ''}\n${res.stderr || ''}`);
  const scope = testScope(current);
  let status = 'passed';
  let reason = '';
  if (timedOut) {
    status = 'timeout';
    reason = '测试超时被终止';
  } else if (res.code !== 0) {
    status = 'failed';
    reason = `测试退出码 ${res.code}`;
  } else if (!evidence.hasEvidence) {
    // 退出码 0 但没有 pass/fail 证据：空测试、exit 0、崩在断言前——一律 fail closed。
    status = 'failed';
    reason = '退出码为 0，但测试输出没有任何 pass/fail 证据，质量门 fail closed';
  } else if (evidence.failed > 0) {
    status = 'failed';
    reason = `测试报告 ${evidence.failed} 项失败，但进程退出码为 0`;
  }
  const quality = {
    status,
    reason,
    command,
    label: detected.label,
    args: detected.args,
    source: detected.source,
    timeout,
    cli: cliMode,
    code: res.code,
    timedOut,
    evidence,
    scope,
    elapsed: Number.isFinite(Number(res.elapsed)) ? Number(res.elapsed) : Date.now() - startedAt,
    stdout: clip(String(res.stdout || '').trim(), 3000),
    stderr: clip(String(res.stderr || '').trim(), 3000),
    log: clip(`${res.stdout}\n${res.stderr}`.trim(), 4000),
    checkedAt: Date.now(),
    round,
  };
  store.updateTask(current.id, { quality });
  store.addTaskEvent(current.id, {
    type: status === 'timeout' ? 'quality.gate.timeout' : `quality.gate.${status}`,
    stepId: step?.id || '',
    data: {
      status,
      reason: quality.reason,
      command,
      source: detected.source,
      code: quality.code,
      timedOut: quality.timedOut,
      evidence: quality.evidence,
      scope: quality.scope,
      elapsed: quality.elapsed,
      timeout: quality.timeout,
      stdout: quality.stdout,
      stderr: quality.stderr,
    },
  });

  const msg = store.addMessage(current.id, {
    agentId: 'system',
    name: '质量门',
    role: 'system',
    title: 'GATE',
    color: status === 'passed' ? '#34d399' : '#ff5538',
    kind: 'quality',
    done: true,
    text: `**自动化质量门 · ${status === 'passed' ? '通过' : timedOut ? '超时' : '未通过'}**\n\n- 命令：\`${command}\`\n- 来源：${detected.source}\n- 退出码：\`${res.code}\`\n- 通过/失败：${evidence.passed}/${evidence.failed}（证据：${evidence.hasEvidence ? evidence.source : '缺失'}）\n- 改动范围：${scope.status}${scope.changedFiles.length ? `（${scope.changedFiles.slice(0, 5).join('、')}）` : ''}\n- 耗时：${quality.elapsed}ms${
      quality.stdout ? `\n\n\`\`\`stdout\n${clip(quality.stdout, 1400)}\n\`\`\`` : ''
    }${quality.stderr ? `\n\n\`\`\`stderr\n${clip(quality.stderr, 1400)}\n\`\`\`` : ''
    }`,
  });
  store.endMessage(current.id, msg.id, {});
  return quality;
}

export function qualityGateAllowsDelivery(quality) {
  return quality?.status === 'passed';
}

async function executeSteps(task, steps, { outputs, speed, signal, runId = '' }) {
  return runDag(steps, {
    completed: [...outputs.keys()],
    maxConcurrency: Math.max(1, Number(store.db.settings.maxConcurrency) || 2),
    runId,
    resourceKey: (step) => step.agentId || '',
    signal,
    onUpdate: (stepId, patch) => store.updateStep(task.id, stepId, patch),
    run: async (step, execution) => {
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
        const reviewRecord =
          step.role === 'reviewer' ? recordReviewIndependence(current, step, agent) : null;
        const extra = {
          ...baseExtra,
          // 自审按真实实现者 ID 判定，不能只看成员角色。
          selfReview: reviewRecord?.identity.selfReview || false,
          ...(reviewRecord ? { quality: reviewRecord.quality } : {}),
        };
        const context = buildContextPack(current, { files: knownFiles(current) });
        const depsText = dependencyText(current, step, outputs);
        const skillContext = activateSkills(current, agent, step, 'step');
        const prompt =
          step.id === 'plan' && step.role === 'planner'
            ? buildPlanPrompt(agent, current, step, context, {
                ...extra,
                skills: skillContext.skills,
              })
            : buildPrompt(current, agent, step, depsText, context, {
                ...extra,
                skills: skillContext.skills,
              });
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
          execution,
          // 首选成员允许按设置重试；切换成员后只给它一次机会，避免整条流水线被拖死。
          maxAttempts: index === 0 ? undefined : 1,
        });
        if (out.ok && step.role === 'reviewer') {
          const verdict = parseReviewVerdictDetails(out.text);
          out.verdict = verdict.decision;
          out.verdictDetails = verdict;
          out.selfReview = extra.selfReview;
          const gateStatus = extra.quality?.status || 'not-run';
          const gatePassed = qualityGateAllowsDelivery(extra.quality);
          out.passed = verdict.decision === 'pass' && gatePassed;
          out.note = out.passed
            ? extra.selfReview
              ? '质量门通过（自审：没有独立评审席位）'
              : '质量门通过'
            : verdict.decision === 'unknown'
              ? `结构化评审结论无效：${verdict.reason}`
              : !gatePassed
                ? `评审${verdict.decision === 'pass' ? '通过' : '未通过'}，但质量门状态为 ${gateStatus}，不能交付`
                : '未通过，进入返工';
          store.updateStep(task.id, step.id, { verdictDetails: verdict });
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
            verdictDetails: out.verdictDetails,
            selfReview: out.selfReview,
            reviewerId: extra.quality?.reviewerId || agent.id,
            implementerId: extra.quality?.implementerId || '',
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

function plannerCandidates(role) {
  const primary = pickAgent(role);
  const ordered = [];
  const push = (agent) => {
    if (!agent || ordered.some((item) => item.id === agent.id)) return;
    ordered.push(agent);
  };
  push(primary);
  for (const agent of store.agents) {
    if (agent.role === role && agent.seat !== false) push(agent);
  }
  // 同角色工具池也是可分配执行者，尤其是多 coder DAG 不能全压在一个席位。
  for (const agent of store.agents) {
    if (agent.role === role) push(agent);
  }
  if (role !== 'reviewer') {
    for (const agent of store.agents) {
      if (agent.seat !== false) push(agent);
    }
  }
  return ordered;
}

function bindPlannerAgents(steps) {
  const coderAgents = plannerCandidates('coder');
  let coderIndex = 0;
  return steps.map((step) => {
    const candidates = plannerCandidates(step.role);
    const agent =
      step.role === 'coder' && coderAgents.length
        ? coderAgents[coderIndex++ % coderAgents.length]
        : candidates[0] || null;
    return {
      ...step,
      agentId: agent?.id || '',
      maxAttempts:
        agent?.mode === 'cli' ? Number(store.db.settings.maxStepAttempts) || 2 : 1,
    };
  });
}

function plannerFallbackReason(value) {
  return clip(String(value || '规划结果未通过契约校验'), 1000);
}

function applyPlannerPlan(taskId, plannerOutput, { runId } = {}) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const parsed = parsePlannerPlan(plannerOutput?.text || '');
  if (!parsed.ok) {
    const reason = plannerFallbackReason(parsed.reason);
    store.addTaskEvent(taskId, {
      type: 'plan.fallback',
      runId,
      stepId: 'plan',
      data: { reason, source: 'planner' },
    });
    store.updateStep(taskId, 'plan', {
      note: `规划 JSON 未通过校验，沿用模板计划：${reason}`,
    });
    return { applied: false, reason, steps: [] };
  }

  const maxPlanSteps = Math.max(
    2,
    Math.min(12, Number(store.db.settings.maxPlanSteps) || 12),
  );
  if (parsed.steps.length > maxPlanSteps) {
    const reason = `动态计划包含 ${parsed.steps.length} 个工序，超过上限 ${maxPlanSteps}`;
    store.addTaskEvent(taskId, {
      type: 'plan.fallback',
      runId,
      stepId: 'plan',
      data: { reason, source: 'planner' },
    });
    store.updateStep(taskId, 'plan', {
      note: `规划 JSON 未通过校验，沿用模板计划：${reason}`,
    });
    return { applied: false, reason, steps: [] };
  }

  const bound = bindPlannerAgents(parsed.steps);
  const result = store.replanUnfinished(taskId, {
    steps: bound,
    reason: '规划师生成的动态工序图',
    source: 'planner',
    runId,
  });
  const current = store.getTask(taskId);
  store.addTaskEvent(taskId, {
    type: 'plan.generated',
    runId,
    stepId: 'plan',
    data: {
      steps: bound.map((step) => ({
        id: step.id,
        role: step.role,
        agentId: step.agentId,
        needs: step.needs,
        outputPaths: step.outputPaths,
      })),
      planVersion: current?.planVersion || 0,
      preserved: result?.preserved || [],
      reopened: result?.reopened || [],
    },
  });
  return {
    applied: true,
    reason: '',
    steps: (current?.plan || []).filter(
      (step) => step.status === 'pending' && !['debate', 'plan'].includes(step.id),
    ),
  };
}

const REPAIR_PATH_LIMIT = 12;

/**
 * Repair prompts must be based on actual workspace artifacts, not a guessed
 * single module. Keep this validation in sync with the planner path contract.
 */
export function normalizeRepairPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('\\')) return '';
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return '';
  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return '';
  }
  if (segments.some((segment) => segment === '.git' || segment === '.agentforge')) {
    return '';
  }
  return raw;
}

function addRepairPath(output, seen, value) {
  if (output.length >= REPAIR_PATH_LIMIT) return;
  const relPath = normalizeRepairPath(value);
  if (!relPath || seen.has(relPath)) return;
  seen.add(relPath);
  output.push(relPath);
}

function reviewPathHints(review) {
  const values = [
    review?.text,
    ...(Array.isArray(review?.files) ? review.files : []),
    ...(Array.isArray(review?.paths) ? review.paths : []),
    ...(Array.isArray(review?.blockerFiles) ? review.blockerFiles : []),
    ...(Array.isArray(review?.verdictDetails?.files) ? review.verdictDetails.files : []),
    ...(Array.isArray(review?.verdictDetails?.paths) ? review.verdictDetails.paths : []),
  ];
  const output = [];
  for (const value of values) {
    const text = String(value || '');
    const matches = text.match(
      /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+/g,
    );
    if (matches) output.push(...matches);
  }
  return output;
}

/**
 * Collect every likely repair target in priority order. Planned output paths
 * are declarations; artifact ledger entries are the evidence that a file was
 * actually touched. The sim fallback is intentionally last.
 */
export function repairPathsFor(task, review = null) {
  const plan = Array.isArray(task?.plan) ? task.plan : [];
  const coderSteps = plan.filter(
    (step) => step.role === 'coder' && ['done', 'running'].includes(step.status),
  );
  const testerSteps = plan.filter(
    (step) => step.role === 'tester' && ['done', 'running'].includes(step.status),
  );
  const coderStepIds = new Set(coderSteps.map((step) => step.id));
  const testerStepIds = new Set(testerSteps.map((step) => step.id));
  const coderAgentIds = new Set(coderSteps.map((step) => step.agentId).filter(Boolean));
  const testerAgentIds = new Set(testerSteps.map((step) => step.agentId).filter(Boolean));
  const output = [];
  const seen = new Set();

  for (const hint of reviewPathHints(review)) addRepairPath(output, seen, hint);

  for (const step of coderSteps) {
    for (const relPath of step.outputPaths || []) addRepairPath(output, seen, relPath);
  }

  for (const artifact of task?.artifacts || []) {
    if (!['A', 'M', ''].includes(String(artifact.status || ''))) continue;
    if (
      coderStepIds.has(artifact.stepId) ||
      coderAgentIds.has(artifact.agentId)
    ) {
      addRepairPath(output, seen, artifact.path);
    }
  }

  for (const step of testerSteps) {
    for (const relPath of step.outputPaths || []) addRepairPath(output, seen, relPath);
  }
  for (const artifact of task?.artifacts || []) {
    if (!['A', 'M', ''].includes(String(artifact.status || ''))) continue;
    if (
      testerStepIds.has(artifact.stepId) ||
      testerAgentIds.has(artifact.agentId)
    ) {
      addRepairPath(output, seen, artifact.path);
    }
  }

  if (!output.length) {
    addRepairPath(output, seen, `src/${sim.pickModule(task?.goal || '').name}.js`);
  }
  return output;
}

function testerRepairPathsFor(task, review = null) {
  const paths = repairPathsFor(task, review);
  const plan = Array.isArray(task?.plan) ? task.plan : [];
  const testerSteps = plan.filter(
    (step) => step.role === 'tester' && ['done', 'running'].includes(step.status),
  );
  const testerStepIds = new Set(testerSteps.map((step) => step.id));
  const testerAgentIds = new Set(testerSteps.map((step) => step.agentId).filter(Boolean));
  const output = [];
  const seen = new Set();
  for (const step of testerSteps) {
    for (const relPath of step.outputPaths || []) addRepairPath(output, seen, relPath);
  }
  for (const artifact of task?.artifacts || []) {
    if (!['A', 'M', ''].includes(String(artifact.status || ''))) continue;
    if (
      testerStepIds.has(artifact.stepId) ||
      testerAgentIds.has(artifact.agentId)
    ) {
      addRepairPath(output, seen, artifact.path);
    }
  }
  if (!output.length) {
    for (const relPath of paths) {
      if (/^tests\//.test(relPath)) addRepairPath(output, seen, relPath);
    }
  }
  if (!output.length) {
    addRepairPath(output, seen, `tests/${sim.pickModule(task?.goal || '').name}.test.js`);
  }
  return output;
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
  if (isScheduled(taskId)) {
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
  if (cancelQueuedTask(taskId)) return true;
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
  let ownsLease = false;
  try {
    ensureTaskLease(taskId);
    ownsLease = true;
  } catch (err) {
    if (err?.code !== 'TASK_LEASE_UNAVAILABLE') throw err;
    store.updateTask(
      taskId,
      {
        status: 'queued',
        waitingReason: '任务已被其他实例占用',
        queuePosition: null,
      },
      'task.status',
    );
    return false;
  }

  const runId = randomUUID();
  const controller = new AbortController();
  const state = { runId, controller, stopping: false };
  running.set(taskId, state);
  const signal = controller.signal;
  const startedAt = Date.now();
  const queuedAt = Number(task.queuedAt) || null;
  const queueMs = queuedAt ? Math.max(0, startedAt - queuedAt) : 0;

  store.updateTask(taskId, {
    status: 'running',
    endedAt: null,
    startedAt,
    finishedAt: null,
    queuePosition: null,
    waitingReason: '',
    queueMs,
    executionMs: 0,
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

    const planStep = store.getTask(taskId).plan.find((step) => step.id === 'plan');
    if (!planStep) throw new Error('模板计划缺少 plan 工序');
    const planRun = await executeSteps(task, [planStep], {
      outputs,
      speed,
      signal,
      runId,
    });
    if (!planRun.ok && !signal.aborted) {
      const replanned = replanFailure(taskId, planRun, { runId });
      if (replanned?.steps.length) {
        const retryPlan = await executeSteps(task, replanned.steps, {
          outputs,
          speed,
          signal,
          runId,
        });
        if (!retryPlan.ok) {
          throw new Error(describeFailure(retryPlan, store.getTask(taskId).plan));
        }
      } else {
        throw new Error(describeFailure(planRun, store.getTask(taskId).plan));
      }
    } else if (!planRun.ok) {
      throw new Error(describeFailure(planRun, store.getTask(taskId).plan));
    }
    if (store.db.settings.dynamicPlanEnabled !== false) {
      const applied = applyPlannerPlan(taskId, outputs.get('plan'), { runId });
      if (applied?.applied) {
        store.updateStep(taskId, 'plan', { note: `已生成 ${applied.steps.length} 个动态工序` });
      }
    }

    const workPlan = store
      .getTask(taskId)
      .plan.filter((step) => !['debate', 'plan'].includes(step.id));
    let first = await executeSteps(task, workPlan, { outputs, speed, signal, runId });
    if (!first.ok && !signal.aborted) {
      const replanned = replanFailure(taskId, first, { runId });
      if (replanned?.steps.length) {
        first = await executeSteps(task, replanned.steps, { outputs, speed, signal, runId });
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
      const repairTask = store.getTask(taskId);
      const repairOutputPaths = repairPathsFor(repairTask, review);
      const retestOutputPaths = testerRepairPathsFor(repairTask, review);
      const repairSteps = [
        {
          id: `fix-${repairRound}`,
          title: `第 ${repairRound} 轮阻塞项修复`,
          role: 'coder',
          needs: [previousReviewId],
          round: repairRound,
          outputPaths: repairOutputPaths,
          ...roleAgent('coder'),
        },
        {
          id: `retest-${repairRound}`,
          title: `第 ${repairRound} 轮回归验证`,
          role: 'tester',
          needs: [`fix-${repairRound}`],
          round: repairRound,
          outputPaths: retestOutputPaths,
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
        { outputs, speed, signal, runId },
      );
      if (!retry.ok) throw new Error(describeFailure(retry, store.getTask(taskId).plan));
      review = outputs.get(`re-review-${repairRound}`);
    }

    if (signal.aborted) throw new Error('aborted');

    const planner = pickAgent('planner');
    const summarySkills = activateSkills(task, planner, null, 'summary');
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
          skills: summarySkills.skills,
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
        finishedAt: Date.now(),
        executionMs: Date.now() - startedAt,
        queueMs,
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
        finishedAt: Date.now(),
        executionMs: Date.now() - startedAt,
        queueMs,
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
    if (ownsLease) store.releaseTaskLease(taskId);
    const current = running.get(taskId);
    if (current?.runId === runId) running.delete(taskId);
  }
}

/** All external entry points use this wrapper; direct startTask remains the executor. */
export function scheduleTask(taskId, options = {}) {
  return enqueueTask(taskId, options);
}

export { isQueued, isScheduled, schedulerSnapshot };

configureScheduler({ execute: startTask });

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

export async function chat(taskId, text, { speed = 1, image = null } = {}) {
  const task = store.getTask(taskId);
  if (!task) return false;
  const mentioned = parseMentions(text);
  const agent = mentioned[0] || pickAgent('planner');
  if (!agent) throw new Error('团队里还没有任何智能体');
  const imageProvider = image ? store.providerForAgent(agent) : null;
  if (image) {
    if (!imageProvider?.capabilities?.includes('vision')) {
      const error = new Error('当前模型不支持图片输入，请切换到声明了 vision 能力的 Provider');
      error.code = 'IMAGE_UNSUPPORTED_MODEL';
      error.status = 422;
      throw error;
    }
  }

  const userMessage = image
    ? store.addImageMessage(
        taskId,
        {
          agentId: 'user',
          name: '你',
          role: 'user',
          title: 'Owner',
          color: '#94a3b8',
          text,
          done: true,
          to: mentioned.length ? mentioned : null,
        },
        image,
        { provider: imageProvider },
      )
    : store.addMessage(taskId, {
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
      const busy =
        task.status === 'running' ||
        task.status === 'stopping' ||
        task.status === 'queued' ||
        isScheduled(taskId);

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
        scheduleTask(taskId, { speed, participants: mentioned.map((a) => a.id) });
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

    const ctx = store.getTask(taskId);
    const context = buildContextPack(ctx);
    const transcript = context.messages.map((m) => `${m.name}: ${m.text}`).join('\n');
    const signal = running.get(taskId)?.controller.signal;
    const skillContext = activateSkills(ctx, agent, null, 'chat');

    if (agent.mode === 'cli') {
      const res = await withAgentLease(taskId, agent.id, signal, () =>
        cliMessage(
          task,
          agent,
          `${buildPrompt(task, agent, null, transcript, context, {
            skills: skillContext.skills,
          })}\n\n# 用户说\n${text}`,
          {
            kind: 'text',
            signal,
            to: { kind: 'owner', id: 'user', name: '你' },
            parentMessageId: userMessage.id,
            causeBy: userMessage.id,
          },
        ),
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
    if (
      /^(开始|开工|继续|动手|跑起来|go|start)/i.test(text.trim()) &&
      !['running', 'stopping', 'queued'].includes(fresh.status)
    ) {
      await sleep(400);
      scheduleTask(taskId, { speed });
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
