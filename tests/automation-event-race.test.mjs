import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-event-race-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { store, Store } = await import('../server/store.mjs');
const {
  createAutomation,
  waitForAutomationEvent,
  wakeAutomationEvent,
  cancelAutomationWait,
  getAutomation,
} = await import('../server/automation.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

function dependencies() {
  return {
    createTask(input) {
      return store.createTask(input);
    },
    scheduleTask() {
      return { accepted: true };
    },
  };
}

function clearAutomations() {
  store.db.settings.automations.splice(0);
}

test('a second instance cannot steal a live event wake, and can after release', () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Cross instance event',
    goal: 'Handle one event exactly once',
    enabled: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  waitForAutomationEvent(automation.id, { eventId: 'evt-race', now: 1000 });

  const other = new Store({ instanceId: 'other-instance' });
  const claim = other.claimAutomation(automation.id, { ttlMs: 60_000, runKey: 'event:evt-race' });
  assert.equal(claim?.owned, true);

  const blocked = wakeAutomationEvent(automation.id, {
    eventId: 'evt-race',
    now: 2000,
    dependencies: dependencies(),
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /其他实例/);
  assert.equal(getAutomation(automation.id).eventWait.status, 'waiting', '被拒绝时状态不能被改写');
  assert.equal(blocked.task ?? null, null);

  other.releaseAutomationClaim(automation.id);
  const woken = wakeAutomationEvent(automation.id, {
    eventId: 'evt-race',
    now: 3000,
    dependencies: dependencies(),
  });
  assert.equal(woken.ok, true);
  assert.equal(getAutomation(automation.id).eventWait.status, 'woken');
  assert.deepEqual(getAutomation(automation.id).eventWait.processedEventIds, ['evt-race']);
});

test('an expired foreign claim is recoverable instead of wedging the event', async () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Expired claim',
    goal: 'Recover after crash',
    enabled: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  waitForAutomationEvent(automation.id, { eventId: 'evt-crash', now: 1000 });

  const crashed = new Store({ instanceId: 'crashed-instance' });
  crashed.claimAutomation(automation.id, { ttlMs: 1000, runKey: 'event:evt-crash' });
  const blocked = wakeAutomationEvent(automation.id, {
    eventId: 'evt-crash',
    now: 1100,
    dependencies: dependencies(),
  });
  assert.equal(blocked.ok, false);

  await sleep(1250);
  const recovered = wakeAutomationEvent(automation.id, {
    eventId: 'evt-crash',
    now: Date.now(),
    dependencies: dependencies(),
  });
  assert.equal(recovered.ok, true, 'claim 过期后必须能恢复');
  assert.equal(getAutomation(automation.id).eventWait.status, 'woken');
});

test('replayed event ids never create a second task and cancel is idempotent', () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Replay guard',
    goal: 'Only once',
    enabled: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  waitForAutomationEvent(automation.id, { eventId: 'evt-twice', now: 1000 });
  let creates = 0;
  const deps = {
    createTask(input) {
      creates += 1;
      return store.createTask(input);
    },
    scheduleTask() {
      return { accepted: true };
    },
  };
  const first = wakeAutomationEvent(automation.id, { eventId: 'evt-twice', now: 2000, dependencies: deps });
  const replay = wakeAutomationEvent(automation.id, { eventId: 'evt-twice', now: 2100, dependencies: deps });
  assert.equal(first.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(creates, 1, '重放事件不能创建第二个任务');

  const second = createAutomation({
    name: 'Cancel twice',
    goal: 'Idempotent cancel',
    enabled: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  waitForAutomationEvent(second.id, { eventId: 'evt-cancel', now: 3000 });
  const cancelled = cancelAutomationWait(second.id, { now: 3100 });
  assert.equal(cancelled.ok, true);
  const again = cancelAutomationWait(second.id, { now: 3200 });
  assert.equal(again.ok, false);
  assert.match(again.reason, /已取消|不存在|没有可取消/);
  const lateWake = wakeAutomationEvent(second.id, {
    eventId: 'evt-cancel',
    now: 3300,
    dependencies: deps,
  });
  assert.equal(lateWake.ok, false, '取消后的等待不能被事件唤醒');
  assert.equal(getAutomation(second.id).eventWait.status, 'cancelled');
});
