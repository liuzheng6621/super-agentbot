import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

function request({ port, method = 'GET', path: target = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers, timeout: 8000 },
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
          resolve({ status: res.statusCode, body: parsed, text });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await request({ port, path: '/api/health' });
      if (res.status === 200) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

test('hook token moves out of state, supports header auth, rotation and disable', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-hook-'));
  const port = await availablePort();
  const ownerToken = ['agentforge', 'hook', 'owner', '0123456789'].join('-');
  const operatorToken = ['agentforge', 'hook', 'operator', '0123456789'].join('-');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_API_TOKEN: ownerToken,
      AGENTFORGE_OPERATOR_TOKEN: operatorToken,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const owner = { Authorization: `Bearer ${ownerToken}` };
  const operator = { Authorization: `Bearer ${operatorToken}` };
  try {
    await waitForHealth(port);

    const state = await request({ port, path: '/api/state', headers: owner });
    assert.equal(state.status, 200);
    assert.equal('hookToken' in state.body.settings, false, 'state must not expose hookToken');
    assert.equal(state.text.includes('"hookToken":'), false);

    const hookTokenResponse = await request({ port, path: '/api/hook-token', headers: owner });
    assert.equal(hookTokenResponse.status, 200);
    const hookToken = hookTokenResponse.body.token;
    assert.equal(typeof hookToken, 'string');
    assert.ok(hookToken.length >= 16);
    assert.equal(hookTokenResponse.body.path, `/api/hooks/${hookToken}`);

    const operatorTokenResponse = await request({
      port,
      path: '/api/hook-token',
      headers: operator,
    });
    assert.equal(operatorTokenResponse.status, 403);

    const pathAuth = await request({
      port,
      method: 'POST',
      path: `/api/hooks/${hookToken}`,
      headers: jsonHeaders(),
      body: JSON.stringify({ goal: '兼容路径令牌' }),
    });
    assert.equal(pathAuth.status, 202);
    await request({
      port,
      method: 'POST',
      path: `/api/tasks/${pathAuth.body.taskId}/stop`,
      headers: owner,
    });

    const headerAuth = await request({
      port,
      method: 'POST',
      path: '/api/hooks/header-only',
      headers: jsonHeaders({ 'X-Hook-Token': hookToken }),
      body: JSON.stringify({ goal: '请求头令牌' }),
    });
    assert.equal(headerAuth.status, 202);
    await request({
      port,
      method: 'POST',
      path: `/api/tasks/${headerAuth.body.taskId}/stop`,
      headers: owner,
    });

    const wrongToken = await request({
      port,
      method: 'POST',
      path: '/api/hooks/header-only',
      headers: jsonHeaders({ 'X-Hook-Token': 'wrong-hook-token-value' }),
      body: JSON.stringify({ goal: '错误令牌' }),
    });
    assert.equal(wrongToken.status, 401);

    const summary = await request({ port, path: `/api/hooks/${hookToken}` });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.ok, true);
    assert.equal(typeof summary.body.taskCount, 'number');
    assert.equal('tasks' in summary.body, false);
    assert.equal(/兼容路径令牌|请求头令牌/.test(summary.text), false, 'GET 不应回显任务目标');

    const rotated = await request({ port, method: 'POST', path: '/api/hook-token/rotate', headers: owner });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.token, hookToken);

    const oldPathToken = await request({
      port,
      method: 'POST',
      path: `/api/hooks/${hookToken}`,
      headers: jsonHeaders(),
      body: JSON.stringify({ goal: '旧令牌' }),
    });
    assert.equal(oldPathToken.status, 401);

    const disabled = await request({
      port,
      method: 'PATCH',
      path: '/api/settings',
      headers: jsonHeaders(owner),
      body: JSON.stringify({ hookTokenEnabled: false }),
    });
    assert.equal(disabled.status, 200);

    const afterDisable = await request({
      port,
      method: 'POST',
      path: '/api/hooks/header-only',
      headers: jsonHeaders({ 'X-Hook-Token': rotated.body.token }),
      body: JSON.stringify({ goal: '禁用后' }),
    });
    assert.equal(afterDisable.status, 401);
  } catch (err) {
    throw new Error(`${err.message}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows may hold the data directory briefly. */
    }
  }
});
