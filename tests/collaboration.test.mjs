import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-collaboration-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { toolGateway } = await import('../server/tool-gateway.mjs');
const { replanTask, startTask } = await import('../server/orchestrator.mjs');

after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows can hold a short-lived handle after the test process exits. */
  }
});

test('plan versions preserve completed work and record manual replans', () => {
  const task = store.createTask({ goal: 'verify plan version snapshots' });
  store.setPlan(task.id, [
    { id: 'design', title: 'Design', role: 'architect' },
    { id: 'build', title: 'Build', role: 'coder', needs: ['design'] },
  ], {
    reason: 'initial',
    source: 'test',
    runId: 'run-plan',
  });

  let current = store.getTask(task.id);
  assert.equal(current.planVersion, 1);
  assert.equal(current.planVersions.length, 1);
  assert.equal(current.planVersions[0].reason, 'initial');

  store.updateStep(task.id, 'design', { status: 'done', resultText: 'contract frozen' });
  store.updateStep(task.id, 'build', { status: 'error', note: 'compile failed' });
  const replanned = replanTask(task.id, { reason: 'retry incomplete work' });

  current = store.getTask(task.id);
  assert.deepEqual(replanned.preserved, ['design']);
  assert.deepEqual(replanned.reopened, ['build']);
  assert.equal(current.planVersion, 2);
  assert.equal(current.plan.find((step) => step.id === 'design').status, 'done');
  assert.equal(current.plan.find((step) => step.id === 'design').resultText, 'contract frozen');
  assert.equal(current.plan.find((step) => step.id === 'build').status, 'pending');
  assert.equal(current.planVersions.at(-1).source, 'manual');
  assert.ok(current.planVersions.at(-1).changed.includes('build'));

  const added = store.appendPlan(task.id, [
    { id: 'verify', title: 'Verify', role: 'tester', needs: ['build'] },
  ], {
    reason: 'verification added',
    source: 'test',
    runId: 'run-plan',
  });
  current = store.getTask(task.id);
  assert.equal(added.length, 1);
  assert.equal(current.planVersion, 3);
  assert.deepEqual(current.planVersions.at(-1).added, ['verify']);
});

test('message envelopes carry route, correlation, step and artifact references', () => {
  const task = store.createTask({ goal: 'verify routed messages' });
  task.runId = 'run-message';
  const agent = store.findAgentByRole('coder');
  const message = store.publishMessage(task.id, {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    kind: 'text',
    text: 'implementation ready',
  }, {
    to: { kind: 'owner', id: 'user', name: 'Owner' },
    parentMessageId: 'parent-message',
    causeBy: 'step:build',
    stepId: 'build',
    artifactRefs: ['src/app.js'],
  });

  assert.equal(message.protocolVersion, 1);
  assert.equal(message.from.id, agent.id);
  assert.equal(message.to[0].id, 'user');
  assert.equal(message.route.scope, 'direct');
  assert.equal(message.correlationId, 'run-message');
  assert.equal(message.parentMessageId, 'parent-message');
  assert.equal(message.stepId, 'build');
  assert.deepEqual(message.artifactRefs, ['src/app.js']);

  const audit = store.getTask(task.id).events.find(
    (event) => event.type === 'message.published' && event.data.messageId === message.id,
  );
  assert.ok(audit);
  assert.equal(audit.data.route.taskId, task.id);
});

test('tool gateway audits owner calls and rejects an unauthorized agent', async () => {
  const task = store.createTask({ goal: 'verify tool gateway' });
  const ownerWrite = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.write',
    operation: 'write',
    args: { op: 'write', path: 'src/gateway.js', content: 'export const ok = true;\n' },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    source: 'test.owner',
  });
  assert.equal(ownerWrite.ok, true);
  assert.equal(ownerWrite.result.path, 'src/gateway.js');

  const deniedAgent = store.addAgent({
    name: 'No Read Agent',
    role: 'reviewer',
    mode: 'sim',
    seat: false,
    tools: [],
  });
  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'workspace.read',
      operation: 'file',
      args: { op: 'file', path: 'src/gateway.js' },
      agentId: deniedAgent.id,
      source: 'test.agent',
    }),
    /没有 workspace\.read 权限/,
  );

  const events = store.getTask(task.id).events;
  const ownerEnd = events.find(
    (event) => event.type === 'tool.call.end' && event.data.tool === 'workspace.write',
  );
  const deniedEnd = events.find(
    (event) => event.type === 'tool.call.end' && event.data.tool === 'workspace.read',
  );
  assert.equal(ownerEnd.data.status, 'ok');
  assert.equal(ownerEnd.data.arguments.contentBytes, Buffer.byteLength('export const ok = true;\n'));
  assert.equal(deniedEnd.data.status, 'denied');
  assert.equal(deniedEnd.data.principal.id, deniedAgent.id);
  assert.ok(events.some((event) => event.type === 'tool.policy.denied'));

  const ownerRead = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.read',
    operation: 'file',
    args: { op: 'file', path: 'src/gateway.js' },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    source: 'test.owner',
  });
  assert.match(ownerRead.result.content, /ok = true/);

  const beforeQuietRead = store.getTask(task.id).events.length;
  const quietRead = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.read',
    operation: 'tree',
    args: { op: 'tree' },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    source: 'test.owner.read',
    audit: false,
  });
  assert.ok(quietRead.result.entries >= 1);
  assert.equal(store.getTask(task.id).events.length, beforeQuietRead);
});

test('history tools are read-only, scoped to the task by default and cursor-paginated', async () => {
  const task = store.createTask({ goal: 'history search primary task' });
  const other = store.createTask({ goal: 'history search other task' });
  for (let index = 0; index < 15; index += 1) {
    store.addMessage(task.id, {
      agentId: 'system',
      name: 'Historian',
      role: 'system',
      title: 'HIS',
      kind: 'text',
      done: true,
      text: `NEEDLE primary ${index}`,
    });
  }
  store.addMessage(other.id, {
    agentId: 'system',
    name: 'Historian',
    role: 'system',
    title: 'HIS',
    kind: 'text',
    done: true,
    text: 'NEEDLE other task',
  });

  const first = (await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'history_search',
    operation: 'search',
    args: { op: 'search', query: 'NEEDLE', limit: 5 },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    source: 'test.history',
  })).result;
  assert.equal(first.results.length, 5);
  assert.ok(first.results.every((item) => item.taskId === task.id));
  assert.ok(first.truncated);
  assert.ok(first.cursor);

  const second = (await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'history_search',
    operation: 'search',
    args: { op: 'search', query: 'NEEDLE', limit: 5, cursor: first.cursor },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    source: 'test.history',
  })).result;
  assert.equal(second.results.length, 5);
  assert.notEqual(second.results[0].id, first.results[0].id);

  const cross = (await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'history_search',
    operation: 'search',
    args: { op: 'search', query: 'NEEDLE', scope: 'all', limit: 50 },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    source: 'test.history',
  })).result;
  assert.ok(cross.results.some((item) => item.taskId === other.id));

  const messageHit = first.results.find(
    (item) => item.taskId === task.id && item.kind === 'message' && item.cursor,
  );
  assert.ok(messageHit);
  const read = (await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'history_read',
    operation: 'read',
    args: { op: 'read', cursor: messageHit.cursor, limit: 2 },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    source: 'test.history',
  })).result;
  assert.ok(read.items.length >= 1);
  assert.equal(read.items[0].kind, 'message');

  const before = store.getTask(task.id).messages.length;
  assert.equal(store.getTask(task.id).messages.length, before, 'history 工具不能改原始消息');
  const events = store.getTask(task.id).events;
  assert.ok(
    events.some(
      (event) => event.type === 'tool.call.end' && event.data.tool === 'history_search',
    ),
  );
});

test('a failed run performs at most one automatic replan', async () => {
  const planner = store.findAgentByRole('planner');
  const before = { mode: planner.mode, cli: { ...planner.cli } };
  const previousDebate = store.db.settings.debateEnabled;
  store.updateSettings({ debateEnabled: false, maxAutoReplans: 1 });
  store.updateAgent(planner.id, {
    mode: 'cli',
    cli: { command: process.execPath, args: ['-e', 'process.exit(9)'] },
  });

  try {
    const task = store.createTask({ goal: 'verify automatic replan limit', debate: 'direct' });
    const ok = await startTask(task.id, { speed: 1000 });
    const current = store.getTask(task.id);
    assert.equal(ok, false);
    assert.equal(current.status, 'error');
    assert.equal(current.autoReplans.length, 1);
    assert.ok(current.autoReplans[0].reopened.length > 0);
    assert.ok(current.planVersions.some((version) => version.source === 'auto'));
  } finally {
    store.updateAgent(planner.id, { mode: before.mode, cli: before.cli });
    store.updateSettings({ debateEnabled: previousDebate });
  }
});
