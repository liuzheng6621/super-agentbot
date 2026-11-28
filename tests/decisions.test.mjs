import test from "node:test";
import assert from "node:assert/strict";
import {
  decisionItems,
  ddClip,
  isDegradedDecision,
  approvalCommandText,
} from "../public/lib/decisions.js";

test("无任务或纯运行态不产生决策卡", () => {
  assert.deepEqual(decisionItems(null), []);
  assert.equal(decisionItems({ status: "running" }).length, 0);
  assert.equal(decisionItems({ status: "done", quality: { status: "passed" } }).length, 0);
});

test("成本待确认排在首位且给出确认动作", () => {
  const items = decisionItems({
    status: "queued",
    pendingConfirmation: true,
    costEstimate: { low: 1200, high: 4820 },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].tone, "warn");
  assert.match(items[0].title, /4820/);
  assert.equal(items[0].actions[0].action, "confirm");
  assert.equal(items[0].actions[1].action, "detail");
});

test("成本估算缺失时仍给出可读文案", () => {
  const items = decisionItems({ status: "queued", pendingConfirmation: true });
  assert.match(items[0].title, /成本超阈值/);
});

test("仅待审批项浮出，且带批准/拒绝动作", () => {
  const approvals = [
    { id: "a1", status: "pending", command: "npm", args: ["test"], agentName: "Tester" },
    { id: "a2", status: "approved", command: "ls" },
  ];
  const items = decisionItems({ status: "running" }, approvals);
  assert.equal(items.length, 1);
  assert.equal(items[0].tone, "info");
  assert.match(items[0].title, /npm test/);
  assert.equal(items[0].actions[0].decision, "approved");
  assert.equal(items[0].actions[0].approvalId, "a1");
  assert.equal(items[0].actions[1].decision, "rejected");
});

test("质量门失败给出错误卡与详情入口", () => {
  const items = decisionItems({
    status: "done",
    quality: { status: "failed", reason: "2 个用例失败" },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].tone, "err");
  assert.match(items[0].detail, /2 个用例失败/);
  assert.equal(items[0].actions[0].action, "detail");
});

test("无测试入口与同模型自审都被感知", () => {
  const items = decisionItems({
    status: "done",
    quality: { status: "no-test-entry", selfReview: true, reviewerModel: "gpt-x" },
  });
  assert.equal(items.length, 2);
  assert.match(items[1].detail, /gpt-x/);
});

test("降级裁决与多样性不足都指向方案对比", () => {
  const degraded = decisionItems({
    status: "done",
    debate: { status: "decided", decision: { votes: 0, winnerId: "A" } },
  });
  assert.equal(degraded.length, 1);
  assert.match(degraded[0].title, /降级裁决/);
  assert.equal(degraded[0].actions[0].action, "debate");

  const diversity = decisionItems({
    status: "done",
    debate: {
      status: "decided",
      decision: { votes: 3, diversity: { sufficient: false, issues: [{ message: "同模型提案" }] } },
    },
  });
  assert.equal(diversity.length, 1);
  assert.match(diversity[0].detail, /同模型提案/);
});

test("等待原因浮出为信息卡", () => {
  const items = decisionItems({ status: "running", waitingReason: "等待工作区锁" });
  assert.equal(items[0].tone, "info");
  assert.match(items[0].detail, /工作区锁/);
});

test("最多三张，且成本确认始终优先", () => {
  const t = {
    status: "done",
    pendingConfirmation: true,
    quality: { status: "failed", selfReview: true },
    debate: { status: "decided", decision: { votes: 0 } },
    waitingReason: "等待锁",
  };
  const items = decisionItems(t, [{ id: "a", status: "pending", command: "npm" }]);
  assert.equal(items.length, 3);
  assert.equal(items[0].actions[0].action, "confirm");
  assert.equal(items[1].actions[0].action, "approval");
});

test("辅助函数：截断、降级判定、命令文案", () => {
  assert.equal(ddClip("abcdef", 3), "abc…");
  assert.equal(ddClip(null), "");
  assert.equal(isDegradedDecision({ votes: 0 }), true);
  assert.equal(isDegradedDecision({ votes: 2 }), false);
  assert.equal(isDegradedDecision(null, "fallback"), true);
  assert.equal(approvalCommandText({ command: "npm", args: ["test"] }), "npm test");
});
