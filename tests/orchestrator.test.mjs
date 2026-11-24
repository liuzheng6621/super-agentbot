import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-test-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { startTask, stopTask, isRunning, parseReviewVerdict } = await import('../server/orchestrator.mjs');

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
  assert.equal(done.plan.length, 8);
  assert.equal(done.plan.find((s) => s.id === 'implement').status, 'done');
  assert.equal(done.plan.find((s) => s.id === 'test-design').status, 'done');
  assert.equal(done.plan.find((s) => s.id === 'review').verdict, 'fail');
  assert.equal(done.plan.find((s) => s.id === 're-review-1').verdict, 'pass');

  const owners = new Set(done.plan.slice(0, 5).map((s) => s.agentId));
  assert.equal(owners.size, 5, '五道工序应由五个不同席位的成员执行');
  assert.ok(done.artifacts.some((f) => f.path.startsWith('src/')));
  assert.ok(done.artifacts.some((f) => f.path.startsWith('tests/')));
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
  assert.equal(failed.plan[0].status, 'error');
  assert.ok(failed.plan.slice(1).every((s) => s.status === 'blocked'));

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

  store.updateAgent(planner.id, { mode: before.mode, cli: before.cli, seat: before.seat });
});

test('评审结论解析不会把「不通过」误判为通过', () => {
  assert.equal(parseReviewVerdict('结论：不通过\nVERDICT: FAIL'), false);
  assert.equal(parseReviewVerdict('结论：通过\nVERDICT: PASS'), true);
  assert.equal(parseReviewVerdict('结论：有条件通过'), false);
  assert.equal(parseReviewVerdict('没有明确结论'), null);
});
