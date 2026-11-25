import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-flow-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { debateConfig, startTask, runDebate } = await import('../server/orchestrator.mjs');

test('工作流设置只接受白名单字段并夹紧范围', () => {
  const token = store.db.settings.hookToken;
  const s = store.updateSettings({
    debateEnabled: false,
    debateParticipants: 99,
    debateConcurrency: -5,
    maxConcurrency: 3,
    maxRepairRounds: 2,
    maxStepAttempts: 0,
    hookToken: 'attacker',
    nonsense: 1,
  });
  assert.equal(s.debateEnabled, false);
  assert.equal(s.debateParticipants, 6, '讨论人数上限 6');
  assert.equal(s.debateConcurrency, 1, '讨论并发下限 1');
  assert.equal(s.maxConcurrency, 3);
  assert.equal(s.maxRepairRounds, 2);
  assert.equal(s.maxStepAttempts, 1, '单步重试下限 1');
  assert.equal(s.hookToken, token, 'hookToken 不允许被设置接口改写');
  assert.equal(s.nonsense, undefined, '未知字段被忽略');
  assert.equal(store.db.settings.maxConcurrency, 3, '设置已落库');
});

test('任务级流程模式优先于全局设置', () => {
  store.updateSettings({ debateEnabled: false, debateParticipants: 4 });

  assert.equal(debateConfig().enabled, false, '未指定时跟随全局关闭');
  assert.equal(debateConfig({ flowMode: 'debate' }).enabled, true, '任务选先讨论可覆盖全局');
  assert.equal(debateConfig({ flowMode: 'direct' }).enabled, false, '任务选直接开工跳过讨论');
  assert.equal(debateConfig({ flowMode: null }).enabled, false);
  assert.equal(debateConfig({}).enabled, false);

  store.updateSettings({ debateEnabled: true });
  assert.equal(debateConfig().enabled, true);
  assert.equal(debateConfig({ flowMode: 'direct' }).enabled, false, '全局开启时直接开工仍能跳过');
});

test('新建任务保存流程模式，且会出现在任务摘要里', () => {
  const a = store.createTask({ goal: '验证直接开工', debate: 'direct' });
  const b = store.createTask({ goal: '验证先讨论', debate: 'debate' });
  const c = store.createTask({ goal: '验证跟随全局' });
  assert.equal(a.flowMode, 'direct');
  assert.equal(b.flowMode, 'debate');
  assert.equal(c.flowMode, null);
  assert.equal(store.taskSummary(a).flowMode, 'direct');
  assert.equal(store.taskSummary(c).flowMode, null);
  assert.equal(store.createTask({ goal: '非法值', debate: 'hack' }).flowMode, null);
});

test('直接开工：跳过讨论但仍走完实施、质量门与交付', async () => {
  store.updateSettings({ debateEnabled: true, maxRepairRounds: 1 });
  const task = store.createTask({ goal: '做一个直接开工的待办 API', debate: 'direct' });
  const ok = await startTask(task.id, { speed: 1000 });
  const done = store.getTask(task.id);

  assert.equal(ok, true);
  assert.equal(done.status, 'done');
  assert.equal(done.debate.status, 'skipped');
  assert.match(done.debate.reason, /直接开工/);
  assert.equal(done.plan.find((s) => s.id === 'debate').status, 'skipped');
  assert.equal(done.plan.find((s) => s.id === 'plan').status, 'done', '讨论跳过不能阻断下游');
  assert.equal(done.quality.status, 'passed');
  assert.ok(done.artifacts.some((f) => f.path.startsWith('src/')));
});

test('一次 @ 多位成员会覆盖直接开工，仍先讨论', async () => {
  store.updateSettings({ debateEnabled: true });
  const task = store.createTask({ goal: '验证多 @ 强制讨论', debate: 'direct' });
  const roster = [store.findAgentByRole('architect'), store.findAgentByRole('tester')];
  const debate = await runDebate(task, { speed: 1000, forced: roster.map((a) => a.id) });
  assert.ok(debate, '明确 @ 多位成员时不能因为任务选了直接开工就跳过讨论');

  // 提案/裁决落在任务状态里，runDebate 返回的只是 { decision, ranking, participants }
  const saved = store.getTask(task.id).debate;
  assert.equal(saved.forced, true, '这轮讨论应标记为「多 @ 强制」');
  assert.ok(saved.proposals.length >= 2, '强制讨论应产生至少 2 份方案');
  assert.ok(saved.proposals.every((p) => p.status === 'done'), '提案都应正常完成');
  assert.equal(saved.status, 'decided');
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 上偶发占用，交给系统清理 */
  }
});
