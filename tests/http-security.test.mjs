import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOKEN = ['agentforge', 'http', 'test', 'token', '0123456789'].join('-');

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
      /* retry while the process starts */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

test('HTTP API enforces token, CORS and persisted automation routes end to end', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-http-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_API_TOKEN: TOKEN,
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
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.security.apiTokenConfigured, true);
    assert.equal(health.security.loopbackOnly, true);

    const anonymous = await fetch(`${baseUrl}/api/state`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).authRequired, true);

    const authorized = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorized.status, 200);
    const state = await authorized.json();
    assert.equal(state.security.apiTokenConfigured, true);
    assert.deepEqual(state.automations, []);

    const deniedCors = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(deniedCors.status, 403);

    const created = await fetch(`${baseUrl}/api/automations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'integration automation',
        goal: 'persist across restart',
        enabled: false,
        schedule: { kind: 'interval', everyMinutes: 30 },
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.ok(createdBody.automation.id);

    const listed = await fetch(`${baseUrl}/api/automations`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const listedBody = await listed.json();
    assert.equal(listedBody.automations.length, 1);
    assert.equal(listedBody.automations[0].enabled, false);

    const streamController = new AbortController();
    const stream = await fetch(`${baseUrl}/api/stream?token=${encodeURIComponent(TOKEN)}`, {
      signal: streamController.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
    streamController.abort();

    const shutdown = await fetch(`${baseUrl}/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(shutdown.status, 200);
    await new Promise((resolve) => child.once('exit', resolve));

    const saved = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
    assert.equal(saved.settings.automations[0].name, 'integration automation');
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
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows can hold the data directory briefly. */
    }
  }
});
