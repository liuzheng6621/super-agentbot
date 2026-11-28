import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-cost-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { store } = await import('../server/store.mjs');

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

test('token estimate comes from real usage of the same mode', () => {
  for (const total of [1000, 2000, 3000, 4000]) {
    const task = store.createTask({ goal: `历史用量 ${total}`, mode: 'auto' });
    store.recordProviderUsage(task.id, {
      providerId: 'builtin',
      model: 'history-model',
      tokensIn: Math.round(total * 0.7),
      tokensOut: Math.round(total * 0.3),
      source: 'cli',
      usageSource: 'provider',
    });
    store.updateTask(task.id, { status: 'done' });
  }
  const manual = store.createTask({ goal: '手动模式历史', mode: 'manual' });
  store.recordProviderUsage(manual.id, {
    providerId: 'builtin',
    model: 'history-model',
    tokensIn: 90000,
    tokensOut: 10000,
    source: 'cli',
  });

  const estimate = store.estimateTaskTokens({ mode: 'auto' });
  assert.equal(estimate.ready, true);
  assert.equal(estimate.samples, 4);
  assert.equal(estimate.low, 1000);
  assert.equal(estimate.high, 4000);
  assert.equal(estimate.median >= 2000 && estimate.median <= 3000, true);
  assert.equal(estimate.cost, null, '没有价格来源时不能伪造费用');

  const thin = store.estimateTaskTokens({ mode: 'manual' });
  assert.equal(thin.ready, false, '样本不足时不给区间');
  assert.equal(thin.high, null);
});

test('cost gate holds a task until confirmed and UI state is observable', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address();
      server.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
  const token = ['agentforge', 'cost', 'gate', '0123456789'].join('-');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_API_TOKEN: token,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const call = (method, target, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: target,
          timeout: 8000,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        const health = await call('GET', '/api/health');
        if (health.status === 200) break;
      } catch {
        /* retry */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const patched = await call('PATCH', '/api/settings', { costGateTokens: 2500 });
    assert.equal(patched.status, 200);

    const created = await call('POST', '/api/tasks', { goal: '超预算任务', flowMode: 'direct' });
    assert.equal(created.status, 202);
    assert.equal(created.body.requiresConfirmation, true);
    assert.equal(created.body.task.pendingConfirmation, true);
    assert.equal(created.body.task.status, 'idle');
    assert.equal(created.body.estimate.ready, true);
    assert.equal(created.body.estimate.high >= 3000, true);
    assert.equal(created.body.task.costEstimate.high, created.body.estimate.high);

    const listed = await call('GET', '/api/state');
    const held = listed.body.tasks.find((t) => t.id === created.body.task.id);
    assert.equal(held.pendingConfirmation, true, '/api/state 必须能看出待确认');
    assert.equal(held.costEstimate.high, created.body.estimate.high);

    const confirmed = await call('POST', `/api/tasks/${created.body.task.id}/confirm`, {});
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.task.pendingConfirmation, false);
    assert.notEqual(confirmed.body.task.status, 'idle');
    await call('POST', `/api/tasks/${created.body.task.id}/stop`, {});
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
});
