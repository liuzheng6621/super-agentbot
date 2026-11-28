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

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && !item.internal && item.family === 'IPv4') return item.address;
    }
  }
  return '';
}

function rawRequest({ port, host = '127.0.0.1', method = 'GET', path: target = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, method, path: target, headers, timeout: 5000 },
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

async function waitForHealth(port, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await rawRequest({ port, host, path: '/api/health' });
      if (res.status === 200) return res.body;
    } catch {
      /* retry while the process starts */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

async function stop(child) {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', resolve);
    setTimeout(resolve, 2000).unref();
  });
}

function startServer(port, env = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-hardening-'));
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
      ...env,
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
  return {
    temp,
    child,
    output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
    cleanup: async () => {
      await stop(child);
      try {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      } catch {
        /* Windows can hold the data directory briefly. */
      }
    },
  };
}

test('loopback without token rejects DNS rebinding, cross-site and null-origin writes', async () => {
  const port = await availablePort();
  const server = startServer(port);
  const settingsBody = JSON.stringify({ simSpeed: 1 });
  try {
    await waitForHealth(port);

    const rebound = await rawRequest({
      port,
      method: 'PATCH',
      path: '/api/settings',
      headers: {
        Host: `evil.example:${port}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(settingsBody),
      },
      body: settingsBody,
    });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.body.code, 'host-not-allowed');

    const crossSite = await rawRequest({
      port,
      method: 'PATCH',
      path: '/api/settings',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(settingsBody),
        'Sec-Fetch-Site': 'cross-site',
      },
      body: settingsBody,
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.code, 'cross-site-blocked');

    const nullOrigin = await rawRequest({
      port,
      method: 'PATCH',
      path: '/api/settings',
      headers: {
        Origin: 'null',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(settingsBody),
      },
      body: settingsBody,
    });
    assert.equal(nullOrigin.status, 403);

    const sameOrigin = await rawRequest({
      port,
      method: 'PATCH',
      path: '/api/settings',
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(settingsBody),
      },
      body: settingsBody,
    });
    assert.equal(sameOrigin.status, 200);

    const scripted = await rawRequest({
      port,
      method: 'PATCH',
      path: '/api/settings',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(settingsBody),
      },
      body: settingsBody,
    });
    assert.equal(scripted.status, 200, 'non-browser clients without fetch metadata keep working');

    const reboundHealth = await rawRequest({
      port,
      path: '/api/health',
      headers: { Host: `evil.example:${port}` },
    });
    assert.equal(reboundHealth.status, 403);
  } catch (err) {
    throw new Error(`${err.message}\n${server.output()}`);
  } finally {
    await server.cleanup();
  }
});

test('workspace allowlist and external workspace principal gate answer 403', async () => {
  const port = await availablePort();
  const ownerToken = ['agentforge', 'owner', 'hardening', '0123456789'].join('-');
  const operatorToken = ['agentforge', 'operator', 'hardening', '0123456789'].join('-');
  const server = startServer(port, {
    AGENTFORGE_API_TOKEN: ownerToken,
    AGENTFORGE_OPERATOR_TOKEN: operatorToken,
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-ws-roots-'));
  const inside = path.join(scratch, 'inside');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const owner = { Authorization: `Bearer ${ownerToken}` };
  const operator = { Authorization: `Bearer ${operatorToken}` };
  try {
    await waitForHealth(port);

    const patch = JSON.stringify({ workspaceRoots: [inside], fsBrowseRoots: [inside] });
    const updated = await rawRequest({
      port,
      method: 'PATCH',
      path: '/api/settings',
      headers: { ...owner, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(patch) },
      body: patch,
    });
    assert.equal(updated.status, 200);

    const ownerBody = JSON.stringify({ goal: '越界工作区', workspace: outside });
    const ownerOutside = await rawRequest({
      port,
      method: 'POST',
      path: '/api/tasks',
      headers: {
        ...owner,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(ownerBody),
      },
      body: ownerBody,
    });
    assert.equal(ownerOutside.status, 403);
    assert.equal(ownerOutside.body.code, 'workspace-not-allowed');

    const operatorBody = JSON.stringify({ goal: 'operator 越权', workspace: inside });
    const operatorInside = await rawRequest({
      port,
      method: 'POST',
      path: '/api/tasks',
      headers: {
        ...operator,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(operatorBody),
      },
      body: operatorBody,
    });
    assert.equal(operatorInside.status, 403);
    assert.equal(operatorInside.body.code, 'external-workspace-forbidden');

    const browseOutside = await rawRequest({
      port,
      path: `/api/fs?path=${encodeURIComponent(outside)}`,
      headers: owner,
    });
    assert.equal(browseOutside.status, 403);
    assert.equal(browseOutside.body.code, 'fs-root-not-allowed');

    const roots = await rawRequest({ port, path: '/api/fs', headers: owner });
    assert.equal(roots.status, 200);
    assert.equal(roots.body.restricted, true);
    assert.equal(roots.body.dirs.length, 1);

    const browseInside = await rawRequest({
      port,
      path: `/api/fs?path=${encodeURIComponent(inside)}`,
      headers: owner,
    });
    assert.equal(browseInside.status, 200);
  } catch (err) {
    throw new Error(`${err.message}\n${server.output()}`);
  } finally {
    await server.cleanup();
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows may hold the directory briefly. */
    }
  }
});

test('insecure remote never grants owner or operator:admin', async (t) => {
  const lan = lanAddress();
  if (!lan) {
    t.diagnostic('no non-internal IPv4 address, skipping insecure remote case');
    return;
  }
  const port = await availablePort();
  const server = startServer(port, {
    HOST: '0.0.0.0',
    AGENTFORGE_ALLOW_INSECURE_REMOTE: '1',
  });
  try {
    await waitForHealth(port);
    const state = await rawRequest({ port, host: lan, path: '/api/state' });
    assert.equal(state.status, 200);
    assert.notEqual(state.body.security.principal.kind, 'owner');

    const settingsBody = JSON.stringify({ simSpeed: 1 });
    const settings = await rawRequest({
      port,
      host: lan,
      method: 'PATCH',
      path: '/api/settings',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(settingsBody),
      },
      body: settingsBody,
    });
    assert.equal(settings.status, 403);
    assert.equal(settings.body.code, 'api-scope-required');
    assert.equal(settings.body.requiredScope, 'operator:admin');
  } catch (err) {
    throw new Error(`${err.message}\n${server.output()}`);
  } finally {
    await server.cleanup();
  }
});
