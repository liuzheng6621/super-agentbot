import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-state-page-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may hold a workspace handle briefly. */
  }
});

test('task order uses createdAt desc and id as the stable tie-breaker', async () => {
  const storeUrl = pathToFileURL(path.resolve('server/store.mjs')).href;
  const script = `
    import { store } from ${JSON.stringify(storeUrl)};
    store.createTask({ goal: 'same timestamp alpha' });
    store.createTask({ goal: 'same timestamp beta' });
    store.createTask({ goal: 'same timestamp gamma' });
    for (const task of store.tasks) store.updateTask(task.id, { createdAt: 9000 });
    store.flush();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, AGENTFORGE_DATA_DIR: temp },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let serverStderr = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverStderr += chunk;
  });
  try {
    await waitForHealth(baseUrl, server);
    const first = await fetch(`${baseUrl}/api/state?limit=2&fields=id,createdAt`).then((r) =>
      r.json(),
    );
    const second = await fetch(
      `${baseUrl}/api/state?limit=2&fields=id,createdAt&cursor=${encodeURIComponent(
        first.pagination.nextCursor,
      )}`,
    ).then((r) => r.json());
    const ids = [...first.tasks, ...second.tasks].map((task) => task.id);
    assert.deepEqual(ids, [...ids].sort(), 'equal timestamps are ordered by id asc');
    assert.equal(new Set(ids).size, 3);
  } catch (err) {
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${serverStderr}`);
  } finally {
    if (server.exitCode === null) server.kill('SIGTERM');
    await new Promise((resolve) => {
      if (server.exitCode !== null) resolve();
      else server.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

test('HTTP state pagination is stable, bounded and keeps the legacy shape', async () => {
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
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: `pagination task ${index}`,
          autoRun: false,
        }),
      });
      assert.equal(response.status, 201);
      created.push((await response.json()).task);
    }

    const firstResponse = await fetch(
      `${baseUrl}/api/state?limit=2&fields=id,title,status&includeActiveTask=0`,
    );
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.tasks.length, 2);
    assert.deepEqual(Object.keys(first.tasks[0]).sort(), ['id', 'status', 'title']);
    assert.equal(first.pagination.total, 5);
    assert.equal(first.pagination.limit, 2);
    assert.equal(first.pagination.hasMore, true);
    assert.ok(first.pagination.nextCursor);
    assert.equal(first.activeTaskId, created.at(-1).id);
    assert.equal(first.activeTask, null);

    const secondResponse = await fetch(
      `${baseUrl}/api/state?limit=2&fields=id,title,status&includeActiveTask=0&cursor=${encodeURIComponent(
        first.pagination.nextCursor,
      )}`,
    );
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.tasks.length, 2);
    assert.equal(
      new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size,
      4,
      'pages must not repeat a task',
    );

    const thirdResponse = await fetch(
      `${baseUrl}/api/state?limit=2&fields=id&includeActiveTask=0&cursor=${encodeURIComponent(
        second.pagination.nextCursor,
      )}`,
    );
    assert.equal(thirdResponse.status, 200);
    const third = await thirdResponse.json();
    assert.equal(third.tasks.length, 1);
    assert.equal(third.pagination.hasMore, false);
    assert.equal(third.pagination.nextCursor, null);
    assert.deepEqual(Object.keys(third.tasks[0]), ['id']);

    const invalidResponse = await fetch(
      `${baseUrl}/api/state?limit=2&cursor=not-a-cursor`,
    );
    assert.equal(invalidResponse.status, 400);
    const invalid = await invalidResponse.json();
    assert.equal(invalid.code, 'invalid-cursor');

    const legacyResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(legacyResponse.status, 200);
    const legacy = await legacyResponse.json();
    assert.equal(legacy.tasks.length, 5);
    assert.equal(legacy.pagination, null);
    assert.equal(legacy.activeTask.id, created.at(-1).id);
    assert.ok(Array.isArray(legacy.activeTask.messages));
  } catch (err) {
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    try {
      fs.rmSync(httpTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows may hold a workspace handle briefly. */
    }
  }
});
