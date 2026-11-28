import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlannerPlanComplete, parsePlannerPlan } from '../server/plan-schema.mjs';

function plan(steps, suffix = '下一步建议：执行该计划。') {
  return `规划说明\n\n\`\`\`json\n${JSON.stringify({ steps })}\n\`\`\`\n${suffix}`;
}

function validSteps(overrides = {}) {
  return [
    { id: 'design', title: '设计', role: 'architect', needs: ['plan'], outputPaths: ['docs/design.md'] },
    { id: 'impl', title: '实现', role: 'coder', needs: ['design'], outputPaths: ['src/core.js'] },
    { id: 'tests', title: '测试', role: 'tester', needs: ['design'], outputPaths: ['tests/core.test.js'] },
    { id: 'final-review', title: '评审', role: 'reviewer', needs: ['impl', 'tests'], outputPaths: [] },
    ...(overrides.extra || []),
  ];
}

test('解析最后一个 JSON 块，reviewer 归一化为 review', () => {
  const text = [
    '示例：',
    '```json',
    '{"steps":[]}',
    '```',
    '正式计划：',
    '```json',
    JSON.stringify({ steps: validSteps() }),
    '```',
    '下一步建议：开始实现。',
  ].join('\n');
  const result = parsePlannerPlan(text);
  assert.equal(result.ok, true);
  assert.equal(result.steps.at(-1).id, 'review');
  assert.deepEqual(result.steps.at(-1).needs, ['impl', 'tests']);
  assert.equal(isPlannerPlanComplete(text), true);
});

test('拒绝缺失、损坏、裸数组和顺序错误的 JSON', () => {
  assert.equal(parsePlannerPlan('只有 Markdown\n下一步建议：没有 JSON').ok, false);
  assert.match(parsePlannerPlan('```json\n{broken}\n```\n下一步建议：继续').reason, /JSON 解析失败/);
  assert.match(
    parsePlannerPlan('```json\n[]\n```\n下一步建议：继续').reason,
    /顶层必须是包含 steps 数组的对象/,
  );
  assert.match(
    parsePlannerPlan('下一步建议：先说明\n```json\n{"steps":[]}\n```').reason,
    /缺少最终的/,
  );
  assert.match(
    parsePlannerPlan('```json\n{"steps":[]}\n```\n下一步建议：继续\n还有尾注').reason,
    /最后内容/,
  );
});

test('拒绝工序数量、id、角色和依赖违规', () => {
  assert.match(parsePlannerPlan(plan([])).reason, /2 到 12/);
  assert.match(parsePlannerPlan(plan(validSteps({ extra: Array.from({ length: 9 }, (_, i) => ({
    id: `extra-${i}`,
    role: 'coder',
    needs: ['plan'],
  })) }))).reason, /2 到 12/);
  assert.match(parsePlannerPlan(plan([
    { id: 'Bad', role: 'coder', needs: [] },
    { id: 'tests', role: 'tester', needs: [] },
    { id: 'review', role: 'reviewer', needs: ['Bad', 'tests'] },
  ])).reason, /id 不合法/);
  assert.match(parsePlannerPlan(plan([
    { id: 'plan', role: 'coder', needs: [] },
    { id: 'tests', role: 'tester', needs: [] },
    { id: 'review', role: 'reviewer', needs: ['plan', 'tests'] },
  ])).reason, /保留值/);
  assert.match(
    parsePlannerPlan(plan([
      { id: 'impl', role: 'coder', needs: [] },
      { id: 'impl', role: 'tester', needs: [] },
    ])).reason,
    /重复/,
  );
  assert.match(parsePlannerPlan(plan([
    { id: 'impl', role: 'planner', needs: [] },
    { id: 'tests', role: 'tester', needs: [] },
    { id: 'review', role: 'reviewer', needs: ['impl', 'tests'] },
  ])).reason, /角色不合法/);
  assert.match(
    parsePlannerPlan(plan([
      { id: 'impl', role: 'coder', needs: ['later'] },
      { id: 'later', role: 'tester', needs: [] },
    ])).reason,
    /更早出现/,
  );
});

test('拒绝越界输出路径和超量 outputPaths', () => {
  for (const bad of ['/tmp/a.js', 'C:/a.js', '../a.js', 'src//a.js', 'src\\a.js', '.git/a.js', '.agentforge/a.js']) {
    const result = parsePlannerPlan(
      plan(validSteps({ extra: [{ id: 'path-check', role: 'coder', needs: ['plan'], outputPaths: [bad] }] })),
    );
    assert.equal(result.ok, false, bad);
  }
  const tooMany = Array.from({ length: 9 }, (_, i) => `src/${i}.js`);
  assert.match(
    parsePlannerPlan(
      plan(validSteps({ extra: [{ id: 'many', role: 'coder', needs: ['plan'], outputPaths: tooMany }] })),
    ).reason,
    /最多 8 个/,
  );
});

test('reviewer 必须唯一、终端、最后且覆盖全部工序', () => {
  assert.match(parsePlannerPlan(plan([
    { id: 'impl', role: 'coder', needs: ['plan'] },
    { id: 'tests', role: 'tester', needs: ['plan'] },
  ])).reason, /恰好包含一个 reviewer/);
  assert.match(parsePlannerPlan(plan([
    ...validSteps(),
    { id: 'extra-review', role: 'reviewer', needs: ['impl'], outputPaths: [] },
  ])).reason, /恰好包含一个 reviewer/);
  assert.match(parsePlannerPlan(plan([
    { id: 'impl', role: 'coder', needs: ['plan'] },
    { id: 'review', role: 'reviewer', needs: ['impl'], outputPaths: [] },
    { id: 'tests', role: 'tester', needs: ['review'], outputPaths: [] },
    ])).reason, /终端节点|最后一个工序/);
  assert.match(parsePlannerPlan(plan([
    { id: 'impl', role: 'coder', needs: ['plan'] },
    { id: 'tests', role: 'tester', needs: ['plan'] },
    { id: 'review', role: 'reviewer', needs: ['impl'], outputPaths: [] },
  ])).reason, /覆盖其余全部工序/);
  assert.match(parsePlannerPlan(plan([
    { id: 'impl', role: 'coder', needs: ['plan'] },
    { id: 'tests', role: 'tester', needs: ['plan'] },
    { id: 'review', role: 'reviewer', needs: [], outputPaths: [] },
  ])).reason, /覆盖其余全部工序/);
  assert.match(parsePlannerPlan(plan([
    { id: 'design', role: 'architect', needs: ['plan'] },
    { id: 'impl', role: 'coder', needs: ['plan'] },
    { id: 'tests', role: 'tester', needs: ['impl'] },
    { id: 'review', role: 'reviewer', needs: ['tests'], outputPaths: [] },
  ])).reason, /覆盖其余全部工序/);
  assert.match(parsePlannerPlan(plan([
    { id: 'impl', role: 'coder', needs: ['plan'] },
    { id: 'tests', role: 'tester', needs: ['plan'] },
    { id: 'review', role: 'coder', needs: ['impl'], outputPaths: [] },
  ])).reason, /保留 id/);
});

test('合法计划必须有 coder、tester 和可完成的收口顺序', () => {
  assert.match(parsePlannerPlan(plan([
    { id: 'impl', role: 'coder', needs: ['plan'] },
    { id: 'review', role: 'reviewer', needs: ['impl'], outputPaths: [] },
  ])).reason, /tester/);
  const text = plan(validSteps());
  assert.equal(parsePlannerPlan(text).ok, true);
  assert.equal(isPlannerPlanComplete(text), true);
  assert.equal(isPlannerPlanComplete(text.replace('下一步建议：执行该计划。', '')), false);
});
