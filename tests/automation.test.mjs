import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-automation-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const {
  automationSnapshot,
  createAutomation,
  getAutomation,
  cancelAutomationWait,
  normalizeSchedule,
  reconcileAutomationRuns,
  removeAutomation,
  runAutomationNow,
  tickAutomations,
  updateAutomation,
  waitForAutomationEvent,
  wakeAutomationEvent,
} = await import('../server/automation.mjs');

function clearAutomations() {
  store.db.settings.automations.splice(0);
}

test('automation definitions persist through the existing settings subtree', () => {
  clearAutomations();
  assert.deepEqual(normalizeSchedule({ kind: 'interval', everyMinutes: 30 }), {
    kind: 'interval',
    everyMinutes: 30,
  });
  assert.deepEqual(normalizeSchedule({ kind: 'daily', time: '23:15' }), {
    kind: 'daily',
    time: '23:15',
  });
  assert.deepEqual(normalizeSchedule({ kind: 'daily', time: '99:99' }), {
    kind: 'daily',
    time: '09:00',
  });

  const automation = createAutomation({
    name: 'Nightly regression',
    goal: 'Run the repository regression suite',
    schedule: { kind: 'interval', everyMinutes: 15 },
    retryLimit: 2,
    retryDelayMinutes: 3,
  });
  assert.ok(automation.id);
  assert.ok(automation.nextRunAt > Date.now());
  assert.equal(getAutomation(automation.id).retryLimit, 2);

  const paused = updateAutomation(automation.id, { enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  assert.equal(automationSnapshot()[0].scheduleText, '每 15 分钟');

  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
  assert.equal(saved.settings.automations[0].name, 'Nightly regression');
  assert.equal(removeAutomation(automation.id), true);
  assert.equal(removeAutomation(automation.id), false);
});

test('manual run records history and a rejected schedule cannot leave a queued phantom task', () => {
  clearAutomations();
  const acceptedAutomation = createAutomation({
    name: 'Manual run',
    goal: 'Create a task',
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  let createdInput = null;
  let scheduledInput = null;
  const accepted = runAutomationNow(acceptedAutomation.id, {
    createTask(input) {
      createdInput = input;
      return { id: 'external-task-accepted' };
    },
    scheduleTask(taskId, options) {
      scheduledInput = { taskId, options };
      return { accepted: true, position: 1 };
    },
  });
  assert.equal(accepted.ok, true);
  assert.equal(createdInput.goal, 'Create a task');
  assert.equal(scheduledInput.taskId, 'external-task-accepted');
  assert.equal(scheduledInput.options.source, 'automation');
  assert.equal(getAutomation(acceptedAutomation.id).lastStatus, 'scheduled');
  assert.equal(getAutomation(acceptedAutomation.id).history[0].status, 'scheduled');

  const rejectedAutomation = createAutomation({
    name: 'Rejected run',
    goal: 'Rejected scheduling probe',
    schedule: { kind: 'interval', everyMinutes: 60 },
    retryLimit: 0,
  });
  let rejectedTask = null;
  const rejected = runAutomationNow(rejectedAutomation.id, {
    createTask(input) {
      rejectedTask = store.createTask({ goal: input.goal });
      return rejectedTask;
    },
    scheduleTask() {
      return { accepted: false, reason: 'provider quota unavailable' };
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(store.getTask(rejectedTask.id).status, 'stopped');
  assert.match(store.getTask(rejectedTask.id).error, /provider quota unavailable/);
  assert.equal(getAutomation(rejectedAutomation.id).lastStatus, 'failed');
  assert.ok(
    store
      .getTask(rejectedTask.id)
      .events.some((event) => event.type === 'automation.schedule.failed'),
  );
});

test('failed automation runs enter retry-waiting and are re-scheduled by the runner', async () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Retry probe',
    goal: 'Retry after failure',
    schedule: { kind: 'interval', everyMinutes: 60 },
    retryLimit: 1,
    retryDelayMinutes: 5,
  });
  const failedTask = store.createTask({ goal: 'Failed scheduled task' });
  store.updateTask(failedTask.id, {
    status: 'error',
    finishedAt: 1000,
    error: 'test failure',
  });
  automation.lastTaskId = failedTask.id;
  automation.lastStatus = 'scheduled';
  automation.lastRunAt = 1000;

  const now = 10 * 60_000;
  assert.equal(reconcileAutomationRuns({ now }), true);
  assert.equal(getAutomation(automation.id).lastStatus, 'retry-waiting');
  assert.equal(getAutomation(automation.id).retryDueAt, now + 5 * 60_000);
  assert.equal(getAutomation(automation.id).history.at(-1).status, 'failed');

  let retriedTaskId = '';
  const result = await tickAutomations({
    now: now + 5 * 60_000,
    dependencies: {
      createTask() {
        retriedTaskId = `retry-${Date.now()}`;
        return { id: retriedTaskId };
      },
      scheduleTask(taskId) {
        assert.equal(taskId, retriedTaskId);
        return { accepted: true };
      },
    },
  });
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].trigger, 'retry');
  assert.equal(getAutomation(automation.id).history.at(-1).status, 'scheduled');
});

test('automation manual runs reuse a task for the same clientMessageId inside 24 hours', () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Idempotent run',
    goal: 'Only create one task',
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  let creates = 0;
  let schedules = 0;
  const dependencies = {
    clientMessageId: 'manual-message-1',
    createTask(input) {
      creates += 1;
      return store.createTask({
        goal: input.goal,
        clientMessageId: input.clientMessageId,
        clientMessageScope: input.clientMessageScope,
      });
    },
    scheduleTask() {
      schedules += 1;
      return { accepted: true };
    },
  };
  const first = runAutomationNow(automation.id, dependencies);
  const second = runAutomationNow(automation.id, dependencies);
  assert.equal(first.ok, true);
  assert.equal(first.idempotentReplay, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.task.id, first.task.id);
  assert.equal(creates, 1);
  assert.equal(schedules, 1);
  assert.equal(getAutomation(automation.id).runCount, 1);

  const otherAutomation = createAutomation({
    name: 'Another idempotent run',
    goal: 'Different automation scope',
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  const scoped = runAutomationNow(otherAutomation.id, dependencies);
  assert.equal(scoped.ok, true);
  assert.equal(scoped.idempotentReplay, undefined);
  assert.notEqual(scoped.task.id, first.task.id);
});

test('automation idempotency and task quotas stay inside the automation tenant', () => {
  clearAutomations();
  const alpha = createAutomation({
    name: 'Alpha scoped automation',
    goal: 'alpha automation quota',
    tenantId: 'alpha',
    ownerId: 'alpha-operator',
    taskLimit: 1,
    enabled: false,
  });
  const beta = createAutomation({
    name: 'Beta scoped automation',
    goal: 'beta automation idempotency',
    tenantId: 'beta',
    ownerId: 'beta-operator',
    taskLimit: 0,
    enabled: false,
  });
  store.createTask({ goal: 'existing alpha task', tenantId: 'alpha' });

  const quotaResult = runAutomationNow(alpha.id, {
    createTask(input) {
      return store.createTask(input);
    },
    scheduleTask() {
      return { accepted: true };
    },
  });
  assert.equal(quotaResult.ok, false);
  assert.match(quotaResult.reason, /配额/);
  assert.equal(store.tasks.filter((task) => task.tenantId === 'alpha').length, 1);

  let betaTask = null;
  const dependencies = {
    clientMessageId: 'shared-automation-message',
    createTask(input) {
      betaTask = store.createTask(input);
      return betaTask;
    },
    scheduleTask() {
      return { accepted: true };
    },
  };
  const first = runAutomationNow(beta.id, dependencies);
  const replay = runAutomationNow(beta.id, dependencies);
  assert.equal(first.ok, true);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(betaTask.tenantId, 'beta');
});

test('idempotency expires after the 24 hour window', () => {
  const first = store.createTask({
    goal: 'expiring idempotency key',
    clientMessageId: 'expiring-message',
    clientMessageScope: 'task:create',
  });
  const inside = store.findIdempotentTask(
    'expiring-message',
    'task:create',
    first.createdAt + 23 * 60 * 60 * 1000,
  );
  const expired = store.findIdempotentTask(
    'expiring-message',
    'task:create',
    first.createdAt + 24 * 60 * 60 * 1000 + 1,
  );
  assert.equal(inside.id, first.id);
  assert.equal(expired, null);
});

test('durable await_event survives reload and deduplicates a wake event', () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Durable event wait',
    goal: 'Handle one external event',
    enabled: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  const waiting = waitForAutomationEvent(automation.id, {
    eventId: 'evt-1',
    now: 1000,
  });
  assert.equal(waiting.ok, true);
  assert.equal(getAutomation(automation.id).eventWait.status, 'waiting');
  assert.equal(getAutomation(automation.id).eventWait.eventId, 'evt-1');

  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
  assert.equal(saved.settings.automations[0].eventWait.status, 'waiting');

  let creates = 0;
  let schedules = 0;
  const dependencies = {
    createTask(input) {
      creates += 1;
      return store.createTask(input);
    },
    scheduleTask() {
      schedules += 1;
      return { accepted: true };
    },
  };
  const first = wakeAutomationEvent(automation.id, {
    eventId: 'evt-1',
    now: 2000,
    dependencies,
  });
  const replay = wakeAutomationEvent(automation.id, {
    eventId: 'evt-1',
    now: 2100,
    dependencies,
  });
  assert.equal(first.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(creates, 1);
  assert.equal(schedules, 1);
  assert.equal(getAutomation(automation.id).eventWait.status, 'woken');
  assert.equal(getAutomation(automation.id).history.at(-1).trigger, 'event');
  assert.equal(getAutomation(automation.id).eventWait.runKey, 'event:evt-1');
});

test('cancelled waits ignore later events and waiting automations do not schedule periodically', async () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Cancelled event wait',
    goal: 'Must not run after cancellation',
    schedule: { kind: 'interval', everyMinutes: 1 },
  });
  automation.nextRunAt = 0;
  waitForAutomationEvent(automation.id, { eventId: 'evt-cancel', now: 1000 });
  const cancelled = cancelAutomationWait(automation.id, { now: 1100 });
  assert.equal(cancelled.ok, true);
  assert.equal(getAutomation(automation.id).eventWait.status, 'cancelled');

  const tick = await tickAutomations({
    now: 1200,
    dependencies: {
      createTask() {
        throw new Error('cancelled wait must not create a task');
      },
      scheduleTask() {
        throw new Error('cancelled wait must not schedule a task');
      },
    },
  });
  assert.equal(tick.started.length, 0);
  const wake = wakeAutomationEvent(automation.id, {
    eventId: 'evt-cancel',
    now: 1300,
    dependencies: {
      createTask() {
        throw new Error('cancelled event must not create a task');
      },
      scheduleTask() {
        throw new Error('cancelled event must not schedule a task');
      },
    },
  });
  assert.equal(wake.ok, false);
  assert.match(wake.reason, /取消/);
});

test('woken event task completion reconciles the durable wait to completed', () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Event completion',
    goal: 'Complete an event run',
    enabled: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  waitForAutomationEvent(automation.id, { eventId: 'evt-complete', now: 1000 });
  const result = wakeAutomationEvent(automation.id, {
    eventId: 'evt-complete',
    now: 2000,
    dependencies: {
      createTask(input) {
        return store.createTask(input);
      },
      scheduleTask() {
        return { accepted: true };
      },
    },
  });
  assert.equal(result.ok, true);
  store.updateTask(result.task.id, {
    status: 'done',
    finishedAt: 3000,
  });
  assert.equal(reconcileAutomationRuns({ now: 3100 }), true);
  assert.equal(getAutomation(automation.id).eventWait.status, 'completed');
  assert.equal(getAutomation(automation.id).eventWait.completedAt, 3000);
});

test('event wait rejects mismatched events and remains visible after reload', () => {
  clearAutomations();
  const automation = createAutomation({
    name: 'Visible event wait',
    goal: 'Expose event wait state',
    enabled: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  waitForAutomationEvent(automation.id, { eventId: 'expected-event', now: 1000 });
  const mismatch = wakeAutomationEvent(automation.id, {
    eventId: 'other-event',
    now: 1100,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /不匹配/);
  store.flush();

  const summary = automationSnapshot().find((item) => item.id === automation.id);
  assert.equal(summary.eventWait.status, 'waiting');
  assert.equal(summary.eventWait.eventId, 'expected-event');
});

test('task creation checks the persisted idempotency key before allocating a workspace', () => {
  const first = store.createTask({
    goal: 'dedupe before workspace allocation',
    clientMessageId: 'dedupe-before-allocate',
    clientMessageScope: 'task:create',
  });
  const second = store.createTask({
    goal: 'dedupe before workspace allocation',
    clientMessageId: 'dedupe-before-allocate',
    clientMessageScope: 'task:create',
  });
  assert.equal(second.id, first.id);
  assert.equal(store.tasks.filter((task) => task.clientMessageId === 'dedupe-before-allocate').length, 1);
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows can keep workspace handles briefly. */
  }
});
