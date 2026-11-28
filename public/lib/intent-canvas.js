/* =========================================================
   AGENTFORGE · 意图画布（纯函数，浏览器与 Node 共用）
   不新增后端字段：把「目标 / 子目标 / 约束 / 分工」编排成结构化文本，
   复用现有 POST /api/tasks 的 goal 字段；分工推导只依赖已有成员席位。
   ========================================================= */

import { ROLE_META } from "./status.js";

/** 主执行席位的固定顺序，与 server/store.mjs ROLE_ORDER 保持一致。 */
export const ROLE_ORDER = ["planner", "architect", "coder", "tester", "reviewer"];

/**
 * 预置约束库。每条约束带 tone（硬/软）与 roleHints（主要影响哪些角色），
 * 用于「实时映射成员分工」——这是画布的核心推导依据，不是装饰标签。
 */
export const CONSTRAINT_LIBRARY = [
  { id: "test-first", label: "先写测试", tone: "hard", roleHints: ["tester"], detail: "测试先行，实现前先补边界用例" },
  { id: "no-api-break", label: "不改现有 API", tone: "hard", roleHints: ["architect"], detail: "保持对外契约与数据结构兼容" },
  { id: "security", label: "安全与鉴权", tone: "hard", roleHints: ["architect", "reviewer"], detail: "输入校验、权限边界与敏感信息要明确" },
  { id: "node20", label: "兼容 Node 20", tone: "hard", roleHints: ["coder"], detail: "不使用更高版本运行时专属 API" },
  { id: "perf-first", label: "性能优先", tone: "hard", roleHints: ["architect", "coder"], detail: "关键路径需给出复杂度与缓存策略" },
  { id: "human-review", label: "需要人工评审", tone: "hard", roleHints: ["reviewer"], detail: "交付前留出人工复核结论" },
  { id: "zh-docs", label: "中文技术文档", tone: "soft", roleHints: ["coder"], detail: "交付需包含中文说明与示例" },
  { id: "minimal-diff", label: "最小改动", tone: "soft", roleHints: ["coder"], detail: "不重构无关模块，控制 diff 范围" },
  { id: "no-new-dep", label: "不引入新依赖", tone: "soft", roleHints: ["architect", "coder"], detail: "优先用项目现有能力实现" },
  { id: "a11y", label: "无障碍与响应式", tone: "soft", roleHints: ["coder", "tester"], detail: "键盘可达、对比度达标、窄屏可用" },
];

/** 子目标文本的关键词 → 推荐角色；命中第一个即用，未命中给通用组合。 */
const KEYWORD_ROLES = [
  [/(test|测试|用例|coverage|覆盖率|边界)/i, ["tester"]],
  [/(文档|doc|readme|说明|注释)/i, ["coder"]],
  [/(api|接口|契约|schema|架构|设计|协议)/i, ["architect"]],
  [/(安全|鉴权|权限|auth|security|加密)/i, ["architect", "reviewer"]],
  [/(性能|perf|优化|缓存|并发|吞吐)/i, ["architect", "coder"]],
  [/(评审|review|复核|审计)/i, ["reviewer"]],
  [/(ui|界面|样式|组件|交互|响应式)/i, ["coder"]],
];

export const constraintById = (id) => CONSTRAINT_LIBRARY.find((item) => item.id === id) || null;

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const isRole = (role) => ROLE_ORDER.includes(role);

function inferRoleHints(text) {
  const value = normalize(text);
  for (const [pattern, hints] of KEYWORD_ROLES) {
    if (pattern.test(value)) return [...hints];
  }
  return ["planner", "coder"];
}

/** 初始画布状态；seq 保证新增卡片 id 在纯函数下也确定可测。 */
export function createCanvasState() {
  return {
    goal: "",
    subgoals: [],
    constraints: [],
    customConstraints: [],
    assignments: {},
    seq: 0,
  };
}

export function withGoal(state, goal) {
  return { ...state, goal: String(goal ?? "") };
}

export function addSubgoal(state, text) {
  const clean = normalize(text);
  if (!clean) return state;
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    subgoals: [...state.subgoals, { id: `sub-${seq}`, text: clean }],
  };
}

export function removeSubgoal(state, id) {
  const assignments = { ...state.assignments };
  delete assignments[id];
  return {
    ...state,
    subgoals: state.subgoals.filter((item) => item.id !== id),
    assignments,
  };
}

/** 点击约束库 chip：已选则移除，未选则加入；同一 id 不会重复。 */
export function toggleConstraint(state, id) {
  const def = constraintById(id);
  if (!def) return state;
  const exists = state.constraints.includes(id);
  const assignments = { ...state.assignments };
  const cardId = `cst-${id}`;
  if (exists) delete assignments[cardId];
  return {
    ...state,
    constraints: exists
      ? state.constraints.filter((item) => item !== id)
      : [...state.constraints, id],
    assignments,
  };
}

export function addCustomConstraint(state, text, tone = "hard") {
  const clean = normalize(text);
  if (!clean) return state;
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    customConstraints: [
      ...state.customConstraints,
      { id: `own-${seq}`, text: clean, tone: tone === "soft" ? "soft" : "hard" },
    ],
  };
}

export function removeCustomConstraint(state, id) {
  const assignments = { ...state.assignments };
  delete assignments[id];
  return {
    ...state,
    customConstraints: state.customConstraints.filter((item) => item.id !== id),
    assignments,
  };
}

/** role 传 null 表示取消显式指派，回落到自动推导。 */
export function assignCard(state, cardId, role) {
  const assignments = { ...state.assignments };
  if (role === null || !isRole(role)) delete assignments[cardId];
  else assignments[cardId] = role;
  return { ...state, assignments };
}

/**
 * 画布上所有可指派卡片。id 前缀区分来源，roleHints 是自动落位的依据。
 * 主目标是全局标题，不参与拖拽指派。
 */
export function canvasCards(state) {
  const cards = state.subgoals.map((item) => ({
    id: item.id,
    type: "subgoal",
    title: item.text,
    tone: "goal",
    roleHints: inferRoleHints(item.text),
  }));
  for (const id of state.constraints) {
    const def = constraintById(id);
    if (!def) continue;
    cards.push({
      id: `cst-${id}`,
      type: "constraint",
      title: def.label,
      detail: def.detail,
      tone: def.tone,
      roleHints: [...def.roleHints],
    });
  }
  for (const item of state.customConstraints) {
    cards.push({
      id: item.id,
      type: "constraint",
      title: item.text,
      tone: item.tone,
      roleHints: inferRoleHints(item.text),
    });
  }
  return cards;
}

/** 从成员列表里取每个角色的主执行席位（seat !== false）。 */
function seatByRole(agents) {
  const seats = new Map();
  for (const agent of agents || []) {
    if (!agent || agent.seat === false || !isRole(agent.role)) continue;
    if (!seats.has(agent.role)) {
      seats.set(agent.role, {
        agentId: agent.id || "",
        agentName: agent.name || ROLE_META[agent.role]?.short || agent.role,
        agentColor: agent.color || "",
      });
    }
  }
  return seats;
}

/**
 * 核心：把每张卡映射到具体成员工位。
 * 显式指派优先；否则取 roleHints 中第一个「实际存在席位」的角色；
 * 都不命中则落到 planner（无 planner 时取第一个存在的席位）。
 * 返回全部 5 个工位（含空工位），让画布呈现完整的团队编排图。
 */
export function deriveAssignments(state, agents = []) {
  const seats = seatByRole(agents);
  const available = ROLE_ORDER.filter((role) => seats.has(role));
  const fallback = available.includes("planner") ? "planner" : available[0] || "planner";
  const cards = canvasCards(state);

  const rows = ROLE_ORDER.map((role) => ({
    role,
    short: ROLE_META[role]?.short || role,
    agentId: seats.get(role)?.agentId || "",
    agentName: seats.get(role)?.agentName || ROLE_META[role]?.short || role,
    agentColor: seats.get(role)?.agentColor || "",
    present: seats.has(role),
    cards: [],
  }));
  const byRole = new Map(rows.map((row) => [row.role, row]));

  for (const card of cards) {
    const explicitRole = state.assignments?.[card.id];
    let role = null;
    let explicit = false;
    if (isRole(explicitRole) && seats.has(explicitRole)) {
      role = explicitRole;
      explicit = true;
    } else {
      role = (card.roleHints || []).find((hint) => seats.has(hint)) || null;
      if (!role) role = fallback;
    }
    const row = byRole.get(role);
    if (row) row.cards.push({ ...card, explicit, assignedRole: role });
  }
  return rows;
}

/** 生成将发给后端的 goal 文本：首行恒为自然语言主目标，避免 title 截断成标题片段。 */
export function serializeCanvas(state, agents = []) {
  const goal = normalize(state.goal);
  if (!goal) return "";
  const subgoals = state.subgoals.map((item) => normalize(item.text)).filter(Boolean);
  const hard = [];
  const soft = [];
  for (const id of state.constraints) {
    const def = constraintById(id);
    if (!def) continue;
    (def.tone === "soft" ? soft : hard).push(def.label);
  }
  for (const item of state.customConstraints) {
    const text = normalize(item.text);
    if (text) (item.tone === "soft" ? soft : hard).push(text);
  }

  const blocks = [goal];
  if (subgoals.length) {
    blocks.push(`目标拆解：\n${subgoals.map((text) => `- ${text}`).join("\n")}`);
  }
  if (hard.length) blocks.push(`硬约束（必须满足）：\n${hard.map((text) => `- ${text}`).join("\n")}`);
  if (soft.length) blocks.push(`软约束（尽量满足）：\n${soft.map((text) => `- ${text}`).join("\n")}`);

  const rows = deriveAssignments(state, agents).filter((row) => row.cards.length);
  if (rows.length) {
    const lines = rows.map((row) => {
      const cardText = row.cards
        .map((card) => (card.type === "subgoal" ? card.title : `[约束] ${card.title}`))
        .join("、");
      return `- ${row.agentName}（${row.short}）：${cardText}`;
    });
    blocks.push(`建议分工（供规划师参考，实际以动态编排为准）：\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/** 开工前的就绪校验，同时给出画布摘要指标，供底部状态条实时展示。 */
export function canvasReadiness(state, agents = []) {
  const goal = normalize(state.goal);
  if (goal.length < 2) {
    return { ok: false, reason: "先写下主目标", cards: 0, hard: 0, soft: 0, roles: 0 };
  }
  const cards = canvasCards(state);
  const hard = cards.filter((card) => card.tone === "hard").length;
  const soft = cards.filter((card) => card.tone === "soft").length;
  const roles = deriveAssignments(state, agents).filter((row) => row.cards.length).length;
  return { ok: true, reason: "", cards: cards.length, hard, soft, roles };
}
