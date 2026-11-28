import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_ORDER,
  CONSTRAINT_LIBRARY,
  constraintById,
  createCanvasState,
  withGoal,
  addSubgoal,
  removeSubgoal,
  toggleConstraint,
  addCustomConstraint,
  removeCustomConstraint,
  assignCard,
  canvasCards,
  deriveAssignments,
  serializeCanvas,
  canvasReadiness,
} from "../public/lib/intent-canvas.js";

const AGENTS = [
  { id: "a1", name: "Nova", role: "planner", color: "#a78bfa" },
  { id: "a2", name: "Forge", role: "architect", color: "#fbbf24" },
  { id: "a3", name: "Kilo", role: "coder", color: "#38bdf8" },
  { id: "a4", name: "Probe", role: "tester", color: "#34d399" },
  { id: "a5", name: "Lens", role: "reviewer", color: "#f472b6" },
  { id: "a6", name: "Reserve", role: "coder", seat: false },
];

test("约束库：id 唯一、tone 合法、roleHints 都落在有效角色上", () => {
  const ids = CONSTRAINT_LIBRARY.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(constraintById("not-exist"), null);
  for (const item of CONSTRAINT_LIBRARY) {
    assert.ok(["hard", "soft"].includes(item.tone), item.id);
    assert.ok(item.roleHints.length > 0, item.id);
    for (const role of item.roleHints) assert.ok(ROLE_ORDER.includes(role), `${item.id}/${role}`);
  }
});

test("空画布不可开工；只有主目标即可开工", () => {
  assert.equal(canvasReadiness(createCanvasState(), AGENTS).ok, false);
  assert.match(canvasReadiness(createCanvasState(), AGENTS).reason, /主目标/);
  assert.equal(canvasReadiness(withGoal(createCanvasState(), "x"), AGENTS).ok, false);
  assert.equal(canvasReadiness(withGoal(createCanvasState(), "做一个待办清单 API"), AGENTS).ok, true);
});

test("序列化首行恒为自然语言主目标，换行被折叠", () => {
  let state = withGoal(createCanvasState(), "做一个  支持并发\n安全的待办清单 API");
  state = addSubgoal(state, "设计数据模型");
  const text = serializeCanvas(state, AGENTS);
  const firstLine = text.split("\n")[0];
  assert.equal(firstLine, "做一个 支持并发 安全的待办清单 API");
  assert.ok(!firstLine.includes("目标拆解"));
  assert.ok(firstLine.length > 2);
});

test("addSubgoal 空白不入库、id 确定、removeSubgoal 同步清掉指派", () => {
  let state = createCanvasState();
  assert.equal(addSubgoal(state, "   "), state);
  state = addSubgoal(state, "  设计  数据模型  ");
  state = addSubgoal(state, "提供 REST 接口");
  assert.equal(state.subgoals.length, 2);
  assert.equal(state.subgoals[0].id, "sub-1");
  assert.equal(state.subgoals[0].text, "设计 数据模型");
  assert.equal(state.subgoals[1].id, "sub-2");
  state = assignCard(state, "sub-1", "tester");
  assert.equal(state.assignments["sub-1"], "tester");
  state = removeSubgoal(state, "sub-1");
  assert.equal(state.subgoals.length, 1);
  assert.equal(state.assignments["sub-1"], undefined);
});

test("toggleConstraint 加入/移除幂等，未知 id 不改变状态", () => {
  let state = createCanvasState();
  assert.equal(toggleConstraint(state, "not-exist"), state);
  state = toggleConstraint(state, "test-first");
  assert.deepEqual(state.constraints, ["test-first"]);
  // 已选状态再点击即移除，不会产生重复项
  state = toggleConstraint(state, "test-first");
  assert.deepEqual(state.constraints, []);
  state = toggleConstraint(state, "test-first");
  state = assignCard(state, "cst-test-first", "reviewer");
  assert.equal(state.assignments["cst-test-first"], "reviewer");
  state = toggleConstraint(state, "test-first");
  assert.deepEqual(state.constraints, []);
  assert.equal(state.assignments["cst-test-first"], undefined);
});

test("自定义约束：tone 归一化、移除时清指派、空白忽略", () => {
  let state = createCanvasState();
  assert.equal(addCustomConstraint(state, "  "), state);
  state = addCustomConstraint(state, "  必须用 pnpm  ", "weird");
  state = addCustomConstraint(state, "尽量复用组件", "soft");
  assert.equal(state.customConstraints[0].tone, "hard");
  assert.equal(state.customConstraints[1].tone, "soft");
  assert.equal(state.customConstraints[0].text, "必须用 pnpm");
  const id = state.customConstraints[0].id;
  state = assignCard(state, id, "coder");
  state = removeCustomConstraint(state, id);
  assert.equal(state.customConstraints.length, 1);
  assert.equal(state.assignments[id], undefined);
});

test("assignCard 非法角色与 null 都回落到自动推导", () => {
  let state = withGoal(createCanvasState(), "做一个文件上传服务");
  state = addSubgoal(state, "补齐断点续传");
  const id = state.subgoals[0].id;
  state = assignCard(state, id, "ghost");
  assert.equal(state.assignments[id], undefined);
  state = assignCard(state, id, "tester");
  assert.equal(state.assignments[id], "tester");
  state = assignCard(state, id, null);
  assert.equal(state.assignments[id], undefined);
});

test("canvasCards 关键词推断推荐角色", () => {
  let state = createCanvasState();
  state = addSubgoal(state, "补测试用例和覆盖率");
  state = addSubgoal(state, "设计对外 API 契约");
  state = addSubgoal(state, "写中文技术文档");
  const cards = canvasCards(state);
  assert.deepEqual(cards[0].roleHints, ["tester"]);
  assert.deepEqual(cards[1].roleHints, ["architect"]);
  assert.deepEqual(cards[2].roleHints, ["coder"]);
});

test("deriveAssignments：显式指派优先于自动推导", () => {
  let state = withGoal(createCanvasState(), "做一个待办清单");
  state = toggleConstraint(state, "test-first");
  const cardId = "cst-test-first";
  const auto = deriveAssignments(state, AGENTS);
  const autoRow = auto.find((row) => row.cards.some((c) => c.id === cardId));
  assert.equal(autoRow.role, "tester");
  assert.equal(autoRow.cards[0].explicit, false);

  state = assignCard(state, cardId, "reviewer");
  const explicit = deriveAssignments(state, AGENTS);
  const row = explicit.find((r) => r.cards.some((c) => c.id === cardId));
  assert.equal(row.role, "reviewer");
  assert.equal(row.cards[0].explicit, true);
  assert.equal(explicit.find((r) => r.role === "tester").cards.length, 0);
});

test("deriveAssignments：席位缺失时兜底到 planner，且始终返回 5 个工位", () => {
  let state = withGoal(createCanvasState(), "做一个待办清单");
  state = toggleConstraint(state, "security"); // architect + reviewer，两者都不存在
  const sparse = [{ id: "x", name: "Nova", role: "planner" }];
  const rows = deriveAssignments(state, sparse);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.role === "planner" || row.present === false));
  assert.equal(rows[0].cards.length, 1);
  assert.equal(rows[0].cards[0].assignedRole, "planner");
});

test("deriveAssignments：无成员时用角色短名，不抛错", () => {
  let state = withGoal(createCanvasState(), "做一个待办清单");
  state = toggleConstraint(state, "test-first");
  const rows = deriveAssignments(state, []);
  assert.equal(rows.length, 5);
  assert.equal(rows[3].agentName, "测试");
  assert.ok(rows.some((row) => row.cards.length === 1));
});

test("serializeCanvas：无附加卡片时只返回主目标，不产生空段", () => {
  const state = withGoal(createCanvasState(), "做一个待办清单 API");
  assert.equal(serializeCanvas(state, AGENTS), "做一个待办清单 API");
});

test("serializeCanvas：硬/软约束与建议分工分段正确", () => {
  let state = withGoal(createCanvasState(), "做一个并发安全的待办清单 API");
  state = addSubgoal(state, "设计并发控制");
  state = toggleConstraint(state, "test-first"); // hard
  state = toggleConstraint(state, "zh-docs"); // soft
  state = addCustomConstraint(state, "必须用 pnpm", "hard");
  const text = serializeCanvas(state, AGENTS);
  assert.match(text, /目标拆解：\n- 设计并发控制/);
  assert.match(text, /硬约束（必须满足）：\n- 先写测试\n- 必须用 pnpm/);
  assert.match(text, /软约束（尽量满足）：\n- 中文技术文档/);
  assert.match(text, /建议分工（供规划师参考/);
  assert.match(text, /- Probe（测试）：\[约束\] 先写测试/);
  // 换行折叠后仍保持可解析的多行文本，没有残留裸 \r
  assert.ok(!text.includes("\r"));
});

test("canvasReadiness 统计卡片、硬/软约束与参与工位数", () => {
  let state = withGoal(createCanvasState(), "做一个待办清单 API");
  state = addSubgoal(state, "设计数据模型");
  state = toggleConstraint(state, "test-first"); // hard
  state = toggleConstraint(state, "minimal-diff"); // soft
  const r = canvasReadiness(state, AGENTS);
  assert.equal(r.ok, true);
  assert.equal(r.cards, 3);
  assert.equal(r.hard, 1);
  assert.equal(r.soft, 1);
  assert.ok(r.roles >= 1 && r.roles <= 5);
});
