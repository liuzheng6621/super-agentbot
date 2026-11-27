import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-overview-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { crossTaskOverview, taskGraph, taskReplay } = await import('../server/overview.mjs');

after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may hold a workspace handle briefly. */
  }
});

test('taskGraph exposes dependency edges, parallel layers and node status', () => {
  const task = store.createTask({ goal: 'DAG overview probe' });
  store.setPlan(task.id, [
    { id: 'architect', title: '架构', role: 'architect', needs: [] },
    { id: 'implement', title: '实现', role: 'coder', needs: ['architect'] },
    { id: 'test', title: '测试', role: 'tester', needs: ['architect'] },
    { id: 'review', title: '评审', role: 'reviewer', needs: ['implement', 'test'] },
  ]);
  store.updateStep(task.id, 'architect', { status: 'done' });
  store.updateStep(task.id, 'implement', { status: 'running' });
  store.updateStep(task.id, 'test', { status: 'blocked' });
  store.addTaskEvent(task.id, {
    type: 'tool.call.start',
    stepId: 'implement',
    data: { tool: 'workspace.write', path: 'src/app.js' },
  });

  const graph = taskGraph(store.getTask(task.id));
  assert.deepEqual(graph.edges, [
    { from: 'architect', to: 'implement', kind: 'dependency' },
    { from: 'architect', to: 'test', kind: 'dependency' },
    { from: 'implement', to: 'review', kind: 'dependency' },
    { from: 'test', to: 'review', kind: 'dependency' },
  ]);
  assert.deepEqual(graph.layers, [
    ['architect'],
    ['implement', 'test'],
    ['review'],
  ]);
  assert.equal(graph.summary.parallel, true);
  assert.equal(graph.summary.running, 1);
  assert.equal(graph.summary.blocked, 1);
  const implement = graph.nodes.find((node) => node.id === 'implement');
  assert.equal(implement.eventCount, 1);
  assert.equal(implement.lastEvent.type, 'tool.call.start');
  assert.equal(implement.lastEvent.summary, 'src/app.js');
});

test('taskReplay merges messages, events and file changes in chronological order', () => {
  const replay = taskReplay({
    id: 'replay-task',
    messages: [
      { id: 'message-1', createdAt: 300, kind: 'text', text: 'middle' },
    ],
    events: [
      { id: 'event-1', at: 500, type: 'run.end', data: { summary: 'done' } },
      { id: 'event-2', at: 200, type: 'run.start', data: { summary: 'start' } },
    ],
    fileChanges: [
      {
        id: 'change-1',
        path: 'src/replay.js',
        status: 'A',
        createdAt: 400,
      },
    ],
  });
  assert.equal(replay.total, 4);
  assert.equal(replay.truncated, false);
  assert.deepEqual(
    replay.frames.map((frame) => frame.kind),
    ['event', 'message', 'file', 'event'],
  );
  assert.deepEqual(
    replay.frames.map((frame) => frame.at),
    [200, 300, 400, 500],
  );
  assert.equal(replay.frames[1].refs.messageId, 'message-1');
});

test('crossTaskOverview reports active work, blockers and projects', () => {
  const first = store.createTask({ goal: 'Overview first' });
  store.setPlan(first.id, [
    { id: 'build', title: '构建', role: 'coder', needs: [] },
    { id: 'verify', title: '验证', role: 'tester', needs: ['build'] },
  ]);
  store.updateStep(first.id, 'build', { status: 'running', agentId: store.findAgentByRole('coder').id });
  store.updateStep(first.id, 'verify', { status: 'blocked', note: '等待构建' });
  store.updateTask(first.id, { status: 'running' });
  const second = store.createTask({ goal: 'Overview second' });
  store.updateTask(second.id, { status: 'done' });

  const overview = crossTaskOverview();
  assert.equal(overview.summary.total >= 2, true);
  assert.equal(overview.summary.active >= 1, true);
  assert.equal(overview.summary.blocked >= 1, true);
  assert.equal(overview.summary.projects >= 1, true);
  const row = overview.tasks.find((task) => task.id === first.id);
  assert.equal(row.currentStep.id, 'build');
  assert.equal(row.blockers[0].id, 'verify');
  assert.equal(row.terminal, false);
});

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      /* retry while the child starts */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

test('HTTP overview, graph and replay routes expose the read-only projections', async () => {
  const httpTemp = fs.mkdtempSync(path.join(temp, 'http-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: httpTemp,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForHealth(baseUrl, child);
    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'HTTP overview probe', autoRun: false }),
    });
    assert.equal(created.status, 201);
    const { task } = await created.json();

    const overviewResponse = await fetch(`${baseUrl}/api/overview`);
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    assert.ok(overview.tasks.some((item) => item.id === task.id));

    const graphResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/graph`);
    assert.equal(graphResponse.status, 200);
    const graph = await graphResponse.json();
    assert.equal(graph.taskId, task.id);
    assert.ok(Array.isArray(graph.layers));

    const replayResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/replay`);
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.taskId, task.id);
    assert.ok(Array.isArray(replay.frames));

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.ok(state.overview.tasks.some((item) => item.id === task.id));
  } catch (err) {
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
});
