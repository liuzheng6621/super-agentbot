import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-observability-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store, taskTranscript } = await import('../server/store.mjs');

test('task events share a trace contract and step events nest under the step span', () => {
  const task = store.createTask({ goal: 'Trace contract probe' });
  const runId = 'run-trace-contract';
  const agent = store.findAgentByRole('coder');
  store.setPlan(task.id, [
    {
      id: 'implement',
      title: 'Implement',
      role: 'coder',
      agentId: agent.id,
    },
  ]);
  store.updateTask(task.id, { runId });

  const root = store.addTaskEvent(task.id, {
    type: 'run.start',
    runId,
    data: { goal: task.goal },
  });
  const toolStart = store.addTaskEvent(task.id, {
    type: 'tool.call.start',
    runId,
    agentId: agent.id,
    stepId: 'implement',
    data: { tool: 'workspace.write', callId: 'call-1' },
  });
  const toolEnd = store.addTaskEvent(task.id, {
    type: 'tool.call.end',
    runId,
    agentId: agent.id,
    stepId: 'implement',
    data: { tool: 'workspace.write', callId: 'call-1', status: 'ok' },
  });

  const current = store.getTask(task.id);
  const step = current.plan.find((item) => item.id === 'implement');
  assert.equal(current.trace.traceId, runId);
  assert.equal(current.trace.rootSpanId, root.spanId);
  assert.equal(root.parentSpanId, null);
  assert.equal(root.kind, 'run');
  assert.ok(step.traceSpanId);
  assert.equal(step.traceParentSpanId, root.spanId);
  assert.equal(toolStart.parentSpanId, step.traceSpanId);
  assert.equal(toolEnd.parentSpanId, step.traceSpanId);
  assert.equal(toolStart.kind, 'tool');
  assert.equal(store.taskSummary(current).trace.traceId, runId);

  const transcript = taskTranscript(current);
  assert.match(transcript.body, /Trace ID/);
  assert.match(transcript.body, new RegExp(root.spanId));

  const nextRunId = 'run-trace-contract-next';
  store.updateTask(task.id, { runId: nextRunId });
  const nextRoot = store.addTaskEvent(task.id, { type: 'run.start', runId: nextRunId });
  assert.notEqual(nextRoot.spanId, root.spanId);
  assert.equal(store.getTask(task.id).trace.traceId, nextRunId);
});

test('restart recovery marks stale running tasks and records an auditable recovery event', () => {
  const task = store.createTask({ goal: 'Restart recovery probe' });
  store.setPlan(task.id, [
    {
      id: 'run',
      title: 'Running step',
      role: 'coder',
      agentId: store.findAgentByRole('coder').id,
    },
  ]);
  store.updateTask(task.id, { status: 'running', runId: 'run-before-restart' });
  store.updateStep(task.id, 'run', { status: 'running', startedAt: Date.now() });
  store.addTaskEvent(task.id, {
    type: 'run.start',
    runId: 'run-before-restart',
    data: { recoveryProbe: true },
  });
  store.flush();

  const storeUrl = pathToFileURL(path.resolve('server/store.mjs')).href;
  const script = [
    `import { store } from ${JSON.stringify(storeUrl)};`,
    `const task = store.getTask(${JSON.stringify(task.id)});`,
    'console.log(JSON.stringify({ status: task.status, recovery: task.recovery, events: task.events }));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, AGENTFORGE_DATA_DIR: temp },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const recovered = JSON.parse(child.stdout.trim());
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.recovery.previousStatus, 'running');
  assert.equal(recovered.recovery.status, 'interrupted');
  assert.ok(recovered.events.some((event) => event.type === 'run.recovered'));
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows can keep workspace handles briefly. */
  }
});
