import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-scheduler-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const {
  providerEnv,
  providerRoute,
  redactProvider,
  withProviderProfile,
} = await import('../server/providers.mjs');
const {
  cancelQueuedTask,
  configureScheduler,
  enqueueTask,
  resetScheduler,
  schedulerSnapshot,
  withAgentLease,
} = await import('../server/scheduler.mjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  resetScheduler();
  store.flush();
  await wait(100);
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may still hold a workspace directory briefly. */
  }
});

test('provider profile persists, resolves environment and migrates agent binding', () => {
  const provider = store.addProvider({
    id: 'local-test',
    name: 'Local Test',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9999/v1',
    model: 'test-model',
    apiKeyRef: 'AGENTFORGE_TEST_KEY',
    maxConcurrency: 1,
    capabilities: ['chat', 'tools'],
    env: {
      PLAIN_SETTING: 'visible',
      EXTRA_SECRET: 'plain-test-value',
    },
    cliBindings: {
      codex: {
        args: ['exec', '-c', 'model={{model}}', '{{prompt}}'],
        env: {
          OPENAI_API_KEY: '{{apiKey}}',
          OPENAI_BASE_URL: '{{baseUrl}}',
          EXTRA_SECRET: 'plain-test-value',
          RESOLVED_FROM_ENV: '{{env:AGENTFORGE_TEST_KEY}}',
        },
      },
    },
  });
  assert.equal(provider.id, 'local-test');
  assert.equal(store.getProvider('local-test').maxConcurrency, 1);
  assert.deepEqual(store.getProvider('local-test').capabilities, ['chat', 'tools']);

  const agent = store.findAgentByRole('coder');
  store.updateAgent(agent.id, {
    providerId: 'local-test',
    cli: { command: 'codex', args: ['-p', '{{prompt}}'] },
  });
  assert.equal(store.getAgent(agent.id).providerId, 'local-test');
  assert.equal(store.providerForAgent(store.getAgent(agent.id)).name, 'Local Test');
  const resolved = withProviderProfile(store.getAgent(agent.id), store.getProvider('local-test'), {
    AGENTFORGE_TEST_KEY: 'not-a-real-secret',
  });
  assert.equal(resolved.cli.env.OPENAI_API_KEY, 'not-a-real-secret');
  assert.equal(resolved.cli.env.OPENAI_BASE_URL, 'http://127.0.0.1:9999/v1');
  assert.equal(resolved.cli.env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:9999/v1');
  assert.equal(resolved.cli.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999/v1');
  assert.equal(resolved.cli.env.GEMINI_API_KEY, 'not-a-real-secret');
  assert.equal(resolved.cli.env.ANTHROPIC_API_KEY, 'not-a-real-secret');
  assert.equal(resolved.cli.env.AGENTFORGE_MODEL, 'test-model');
  assert.equal(resolved.cli.env.RESOLVED_FROM_ENV, 'not-a-real-secret');
  assert.deepEqual(resolved.cli.args, ['exec', '-c', 'model=test-model', '{{prompt}}']);
  const redacted = redactProvider(store.getProvider('local-test'));
  assert.equal(redacted.cliBindings.codex.env.OPENAI_API_KEY, '{{apiKey}}');
  assert.equal(redacted.cliBindings.codex.env.EXTRA_SECRET, '••••••');
  assert.equal(redacted.env.EXTRA_SECRET, '••••••');
  assert.equal(redacted.env.PLAIN_SETTING, 'visible');
  store.updateProvider('local-test', {
    cliBindings: {
      codex: {
        args: ['exec', '-c', 'model={{model}}', '{{prompt}}'],
        env: {
          ...redacted.cliBindings.codex.env,
          EXTRA_SECRET: redacted.cliBindings.codex.env.EXTRA_SECRET,
        },
      },
    },
  });
  assert.equal(
    store.getProvider('local-test').cliBindings.codex.env.EXTRA_SECRET,
    'plain-test-value',
  );
  assert.equal(
    providerEnv(store.getProvider('local-test'), { AGENTFORGE_TEST_KEY: 'not-a-real-secret' })
      .OPENAI_API_KEY,
    'not-a-real-secret',
  );

  store.removeProvider('local-test');
  assert.equal(store.getAgent(agent.id).providerId, 'local-default');
  assert.equal(store.getProvider('local-test'), undefined);
});

test('provider route follows fallback order and skips disabled primary', () => {
  const backup = store.addProvider({
    id: 'route-backup',
    name: 'Route Backup',
    kind: 'openai-compatible',
  });
  const disabled = store.addProvider({
    id: 'route-disabled',
    name: 'Route Disabled',
    kind: 'openai-compatible',
    enabled: false,
  });
  const agent = store.findAgentByRole('coder');
  store.updateAgent(agent.id, {
    providerId: disabled.id,
    fallbackProviderIds: [backup.id, 'missing-provider'],
  });

  assert.deepEqual(
    providerRoute(store.getAgent(agent.id), store.providers).map((provider) => provider.id),
    ['route-backup'],
  );

  store.removeProvider(backup.id);
  store.removeProvider(disabled.id);
  assert.equal(store.getAgent(agent.id).providerId, 'local-default');
  assert.deepEqual(store.getAgent(agent.id).fallbackProviderIds, []);
});

test('scheduler enforces global task concurrency and reports queue position', async () => {
  resetScheduler();
  store.updateSettings({ maxTaskConcurrency: 1 });
  store.updateProvider('local-default', { maxConcurrency: 2 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const started = [];
  configureScheduler({
    execute: async (taskId) => {
      started.push(taskId);
      if (started.length === 1) await firstGate;
      store.updateTask(taskId, { status: 'done' }, 'task.status');
    },
  });

  const first = store.createTask({ goal: 'scheduler first task' });
  const second = store.createTask({ goal: 'scheduler second task' });
  enqueueTask(first.id);
  enqueueTask(second.id);
  await wait(20);

  assert.deepEqual(started, [first.id]);
  assert.equal(store.getTask(first.id).status, 'queued');
  assert.equal(store.getTask(second.id).status, 'queued');
  assert.equal(store.getTask(second.id).queuePosition, 1);
  assert.match(store.getTask(second.id).waitingReason, /全局并发槽/);
  assert.equal(schedulerSnapshot().activeCount, 1);
  assert.equal(schedulerSnapshot().queuedCount, 1);

  releaseFirst();
  await wait(20);
  assert.deepEqual(started, [first.id, second.id]);
  assert.equal(store.getTask(second.id).status, 'done');
});

test('provider quota and explicit agent leases block tasks until resources release', async () => {
  resetScheduler();
  store.updateSettings({ maxTaskConcurrency: 4 });
  store.updateProvider('local-default', { maxConcurrency: 1 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const started = [];
  configureScheduler({
    execute: async (taskId) => {
      started.push(taskId);
      if (started.length === 1) await firstGate;
      store.updateTask(taskId, { status: 'done' }, 'task.status');
    },
  });

  const first = store.createTask({ goal: 'provider first task' });
  const second = store.createTask({ goal: 'provider second task' });
  first.resources = { providerIds: ['local-default'], agentIds: [store.agents[0].id] };
  second.resources = { providerIds: ['local-default'], agentIds: [store.agents[0].id] };
  enqueueTask(first.id);
  enqueueTask(second.id);
  await wait(20);

  assert.deepEqual(started, [first.id]);
  assert.match(store.getTask(second.id).waitingReason, /Provider/);
  releaseFirst();
  await wait(20);
  assert.deepEqual(started, [first.id, second.id]);
});

test('cancelling a queued task releases its queue slot without starting it', async () => {
  resetScheduler();
  store.updateSettings({ maxTaskConcurrency: 1 });
  store.updateProvider('local-default', { maxConcurrency: 2 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const started = [];
  configureScheduler({
    execute: async (taskId) => {
      started.push(taskId);
      if (started.length === 1) await firstGate;
      store.updateTask(taskId, { status: 'done' }, 'task.status');
    },
  });

  const first = store.createTask({ goal: 'cancel first task' });
  const second = store.createTask({ goal: 'cancel second task' });
  enqueueTask(first.id);
  enqueueTask(second.id);
  await wait(20);
  assert.equal(cancelQueuedTask(second.id), true);
  assert.equal(store.getTask(second.id).status, 'stopped');
  releaseFirst();
  await wait(20);
  assert.deepEqual(started, [first.id]);
});

test('agent lease is exclusive across tasks and wakes the waiter on release', async () => {
  resetScheduler();
  const a = store.createTask({ goal: 'lease a' });
  const b = store.createTask({ goal: 'lease b' });
  const agentId = store.agents[0].id;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let secondEntered = false;

  const first = withAgentLease(a.id, agentId, null, async () => {
    await firstGate;
  });
  const second = withAgentLease(b.id, agentId, null, async () => {
    secondEntered = true;
  });
  await wait(20);
  assert.equal(secondEntered, false);
  assert.match(store.getTask(b.id).waitingReason, /等待 Agent/);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
  assert.equal(schedulerSnapshot().agentLeases.length, 0);
});
