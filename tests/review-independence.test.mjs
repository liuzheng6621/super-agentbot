import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-review-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { store } = await import('../server/store.mjs');
const { reviewIndependenceFor, recordReviewIndependence } = await import(
  '../server/review-independence.mjs'
);

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

function configure(agent, { providerId, model, command }) {
  agent.providerId = providerId;
  agent.model = model;
  agent.cli = { ...(agent.cli || {}), command };
  return agent;
}

test('same provider and model across different agents counts as self review', () => {
  const coder = store.findAgentByRole('coder');
  const tester = store.findAgentByRole('tester');
  configure(coder, { providerId: 'team-gateway', model: 'gpt-5-codex', command: 'codex' });
  configure(tester, { providerId: 'team-gateway', model: 'gpt-5-codex', command: 'codex' });

  const task = store.createTask({ goal: '同模型评审' });
  store.setPlan(task.id, [{ id: 'impl', title: '实现', role: 'coder', agentId: coder.id }]);
  store.updateStep(task.id, 'impl', { status: 'done' });

  const identity = reviewIndependenceFor(store.getTask(task.id), tester);
  assert.equal(identity.selfReview, true);
  assert.equal(identity.sameModel, true);
  assert.equal(identity.reviewerModel, 'gpt-5-codex');
  assert.equal(identity.implementerModel, 'gpt-5-codex');
  assert.equal(identity.reviewerProviderId, 'team-gateway');
  assert.equal(identity.reviewerCli, 'codex');

  const recorded = recordReviewIndependence(store.getTask(task.id), task.id ? store.getTask(task.id).plan[0] : null, tester);
  assert.equal(recorded.quality.selfReview, true);
  const saved = store.getTask(task.id);
  assert.ok(
    saved.events.some((event) => event.type === 'self-review' && event.data.sameModel),
    '同模型自审必须写 self-review 事件',
  );
});

test('different models or providers stay independent even on the same CLI', () => {
  const coder = store.findAgentByRole('coder');
  const reviewer = store.findAgentByRole('reviewer');
  configure(coder, { providerId: 'team-gateway', model: 'gpt-5-codex', command: 'codex' });
  configure(reviewer, { providerId: 'team-gateway', model: 'claude-sonnet', command: 'codex' });

  const task = store.createTask({ goal: '不同模型评审' });
  store.setPlan(task.id, [{ id: 'impl', title: '实现', role: 'coder', agentId: coder.id }]);
  store.updateStep(task.id, 'impl', { status: 'done' });
  const identity = reviewIndependenceFor(store.getTask(task.id), reviewer);
  assert.equal(identity.selfReview, false);
  assert.equal(identity.sameModel, false);
  assert.equal(identity.reviewerCli, 'codex');

  configure(reviewer, { providerId: 'other-gateway', model: 'gpt-5-codex', command: 'codex' });
  const crossProvider = reviewIndependenceFor(store.getTask(task.id), reviewer);
  assert.equal(crossProvider.selfReview, false, '不同 Provider 的同名模型不算同模型');
});

test('unconfigured seats keep the legacy id-only comparison', () => {
  const coder = store.findAgentByRole('coder');
  const tester = store.findAgentByRole('tester');
  configure(coder, { providerId: '', model: '', command: '' });
  configure(tester, { providerId: '', model: '', command: '' });

  const task = store.createTask({ goal: '未配置 Provider' });
  store.setPlan(task.id, [{ id: 'impl', title: '实现', role: 'coder', agentId: coder.id }]);
  store.updateStep(task.id, 'impl', { status: 'done' });
  const identity = reviewIndependenceFor(store.getTask(task.id), tester);
  assert.equal(identity.selfReview, false);
  assert.equal(identity.sameModel, false);
});
