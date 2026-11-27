import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-test-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const {
  startTask,
  stopTask,
  isRunning,
  parseReviewVerdict,
  parseReviewVerdictDetails,
} = await import('../server/orchestrator.mjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seat(role) {
  return store.findAgentByRole(role);
}

after(async () => {
  store.flush();
  await wait(300);
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    // Windows 上子进程刚退出时目录偶尔仍被占用，留给系统临时目录清理。
  }
});

test('五个执行席位角色唯一，重复 CLI 留在工具池', () => {
  const seats = store.agents.filter((a) => a.seat !== false);
  assert.deepEqual(
    seats.map((a) => a.role).sort(),
    ['architect', 'coder', 'planner', 'reviewer', 'tester'],
  );
  assert.equal(store.agents.filter((a) => a.role === 'coder' && a.seat !== false).length, 1);
});

test('模拟团队完成并行协作、质量门和一轮返工', async () => {
  const task = store.createTask({ goal: '做一个并发安全的待办 API' });
  const ok = await startTask(task.id, { speed: 1000 });
  const done = store.getTask(task.id);

  assert.equal(ok, true);
  assert.equal(done.status, 'done');
  assert.equal(done.repairRound, 1);
  assert.equal(done.quality.status, 'passed');
  assert.equal(done.plan.length, 9);
  assert.equal(done.plan.find((s) => s.id === 'implement').status, 'done');
  assert.equal(done.plan.find((s) => s.id === 'test-design').status, 'done');
  assert.equal(done.plan.find((s) => s.id === 'review').verdict, 'fail');
  assert.equal(done.plan.find((s) => s.id === 're-review-1').verdict, 'pass');

  const owners = new Set(
    ['plan', 'design', 'implement', 'test-design', 'review'].map((id) =>
      done.plan.find((s) => s.id === id).agentId,
    ),
  );
  assert.equal(owners.size, 5, '五道执行工序应由五个不同席位的成员执行');
  assert.ok(done.artifacts.some((f) => f.path.startsWith('src/')));
  assert.ok(done.artifacts.some((f) => f.path.startsWith('tests/')));
});

test('实施前先多方案讨论，按交叉评分选出唯一方案', async () => {
  const task = store.createTask({ goal: '做一个并发安全的待办 API' });
  const ok = await startTask(task.id, { speed: 1000 });
  const done = store.getTask(task.id);
  const debate = done.debate;

  assert.equal(ok, true);
  assert.equal(debate.status, 'decided');
  assert.ok(debate.participants.length >= 3, '至少 3 位成员参与讨论');
  assert.ok(debate.proposals.length >= 3, '至少产生 3 份方案');
  assert.ok(debate.proposals.every((p) => p.status === 'done'));
  assert.ok(debate.proposals.every((p) => p.angleKey), '每份方案应有不同主张');

  // 每位成员评审其他所有方案，不给自己打分
  for (const p of debate.proposals) {
    assert.equal(p.votes.length, debate.participants.length - 1);
    assert.ok(p.votes.every((v) => v.byId !== p.agentId));
  }

  const decided = debate.decision;
  const averages = debate.proposals.map(
    (p) => p.votes.reduce((sum, v) => sum + v.score, 0) / p.votes.length,
  );
  const best = Math.round(Math.max(...averages) * 10) / 10;
  assert.equal(decided.average, best, '采纳的方案必须平均分最高');
  assert.ok(debate.proposals.some((p) => p.id === decided.winnerId));

  // 讨论成为正式工序，后续实施依赖裁决结果
  const debateStep = done.plan.find((s) => s.id === 'debate');
  assert.equal(debateStep.status, 'done');
  assert.match(debateStep.title, new RegExp(`采纳方案 ${decided.winnerId}`));
  assert.deepEqual(done.plan.find((s) => s.id === 'plan').needs, ['debate']);
});

test('CLI 失败会阻断下游，任务不会被标成已交付', async () => {
  const planner = seat('planner');
  const before = { mode: planner.mode, cli: { ...planner.cli }, seat: planner.seat };
  store.updateAgent(planner.id, {
    mode: 'cli',
    command: undefined,
    cli: { command: process.execPath, args: ['-e', 'process.exit(7)'] },
  });

  const task = store.createTask({ goal: '验证失败传播' });
  const ok = await startTask(task.id, { speed: 1000 });
  const failed = store.getTask(task.id);
  assert.equal(ok, false);
  assert.equal(failed.status, 'error');
  // 讨论阶段可以靠评分完成裁决，但实施阶段一旦失败必须阻断下游
  assert.equal(failed.plan.find((s) => s.id === 'debate').status, 'done');
  assert.equal(failed.plan.find((s) => s.id === 'plan').status, 'error');
  assert.ok(
    ['design', 'implement', 'test-design', 'review'].every(
      (id) => failed.plan.find((s) => s.id === id).status === 'blocked',
    ),
  );

  store.updateAgent(planner.id, { mode: before.mode, cli: before.cli, seat: before.seat });
});

test('停止后不会被旧执行覆盖，也不会留下运行锁', async () => {
  const planner = seat('planner');
  const before = { mode: planner.mode, cli: { ...planner.cli }, seat: planner.seat };
  store.updateAgent(planner.id, {
    mode: 'cli',
    cli: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 15000)'] },
  });

  const task = store.createTask({ goal: '验证停止语义' });
  const pending = startTask(task.id, { speed: 1000 });
  await wait(80);
  assert.equal(stopTask(task.id), true);
  assert.equal(isRunning(task.id), true, '停止过程中仍应占用运行锁');
  await pending;
  const stopped = store.getTask(task.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(isRunning(task.id), false);
  assert.equal(stopped.plan[0].status, 'stopped');
  assert.equal(stopped.debate.status, 'stopped', '中途停止时讨论状态也要收口');
  assert.ok(
    (stopped.debate.proposals || []).every((p) => p.status !== 'running'),
    '停止后不应留下永远“提案中”的卡片',
  );

  store.updateAgent(planner.id, { mode: before.mode, cli: before.cli, seat: before.seat });
});

test('评审结论只接受结构化 VERDICT，缺失或矛盾都 fail closed', () => {
  const pass = parseReviewVerdictDetails(
    '评审完成。\nVERDICT: {"decision":"PASS","blockers":0,"should":2}',
  );
  assert.equal(pass.decision, 'pass');
  assert.equal(pass.structured, true);
  assert.equal(pass.blockers, 0);
  assert.equal(pass.should, 2);
  assert.equal(parseReviewVerdict('VERDICT: {"decision":"PASS","blockers":0,"should":2}'), true);

  const fail = parseReviewVerdictDetails(
    '发现两个阻塞项。\nVERDICT: {"decision":"FAIL","blockers":2,"should":1}',
  );
  assert.equal(fail.decision, 'fail');
  assert.equal(parseReviewVerdict('VERDICT: {"decision":"FAIL","blockers":2,"should":1}'), false);

  assert.equal(parseReviewVerdict('结论：不通过\nVERDICT: FAIL'), null, '旧自然语言不能放行');
  assert.equal(parseReviewVerdict('结论：通过\nVERDICT: PASS'), null, '旧自然语言不能放行');
  assert.equal(parseReviewVerdict('VERDICT: {"decision":"PASS","blockers":1,"should":0}'), null);
  assert.equal(parseReviewVerdict('VERDICT: {"decision":"PASS"}'), null, '缺少计数字段不能放行');
  assert.equal(
    parseReviewVerdict('VERDICT: {"decision":"FAIL","blockers":null,"should":0}'),
    null,
    'null 计数字段不能放行',
  );
  assert.equal(
    parseReviewVerdict('VERDICT: {"decision":"PASS","blockers":true,"should":0}'),
    null,
    '布尔值不能被 Number() 当成计数放行',
  );
  assert.equal(
    parseReviewVerdict('VERDICT: {"decision":"PASS","blockers":[],"should":0}'),
    null,
    '数组不能被 Number() 当成计数放行',
  );
  assert.equal(parseReviewVerdict('VERDICT: {"decision":"PASS", broken json}'), null);
  assert.equal(parseReviewVerdict('没有明确结论'), null);
});

test('重规划会清掉旧评审结论和身份字段', () => {
  const task = store.createTask({ goal: '重规划清理评审字段' });
  store.setPlan(task.id, [{ id: 'review', title: '旧评审', role: 'reviewer' }]);
  store.updateStep(task.id, 'review', {
    verdict: 'pass',
    verdictDetails: { decision: 'pass', blockers: 0, should: 0 },
    selfReview: true,
    reviewerId: 'old-reviewer',
    implementerId: 'old-coder',
  });
  store.setPlan(task.id, [{ id: 'review', title: '新评审', role: 'reviewer' }]);
  const step = store.getTask(task.id).plan[0];
  assert.equal(step.verdict, undefined);
  assert.equal(step.verdictDetails, undefined);
  assert.equal(step.selfReview, undefined);
  assert.equal(step.reviewerId, undefined);
  assert.equal(step.implementerId, undefined);
});
