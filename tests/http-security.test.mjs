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

test('HTTP API rejects agent tokens from operator endpoints and audits the principal', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-scope-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const agentToken = ['agentforge', 'scope', 'agent', '0123456789'].join('-');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_OPERATOR_TOKEN: TOKEN,
      AGENTFORGE_AGENT_TOKENS: JSON.stringify([
        { token: agentToken, id: 'worker-1', name: 'Worker One' },
      ]),
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
    const allowed = await fetch(`${baseUrl}/api/state`, {
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'X-Request-Id': 'scope-read-1',
      },
    });
    assert.equal(allowed.status, 200);

    const denied = await fetch(`${baseUrl}/api/probe`, {
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'X-Request-Id': 'scope-probe-1',
      },
    });
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.code, 'api-scope-required');
    assert.equal(deniedBody.requiredScope, 'operator:admin');

    const state = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json());
    const audit = state.security.audit.find((entry) => entry.requestId === 'scope-probe-1');
    assert.ok(audit);
    assert.equal(audit.actorId, 'worker-1');
    assert.equal(audit.actorKind, 'agent');
    assert.equal(audit.tokenScope, 'operator:admin');
    assert.equal(audit.remoteAddress, '127.0.0.1');
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

test('HTTP task creation returns the same task for a repeated clientMessageId', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-idempotency-'));
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
    await waitForHealth(baseUrl, child);
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    };
    const body = JSON.stringify({
      goal: 'idempotent HTTP task',
      autoRun: false,
      clientMessageId: 'http-message-1',
    });
    const first = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers, body });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    const second = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers, body });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.idempotentReplay, true);
    assert.equal(secondBody.task.id, firstBody.task.id);

    const state = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json());
    assert.equal(state.tasks.filter((task) => task.clientMessageId === 'http-message-1').length, 1);
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

test('HTTP MCP endpoints keep env references redacted and allow only read calls', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-http-mcp-'));
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
      MCP_FIXTURE_SECRET: 'http-mcp-secret',
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
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    };
    const fixture = path.resolve('tests/fixtures/mcp-readonly-server.mjs');
    const created = await fetch(`${baseUrl}/api/mcp/servers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'http-fixture',
        label: 'HTTP Fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        envRefs: { MCP_FIXTURE_SECRET: 'env:MCP_FIXTURE_SECRET' },
        startTimeoutMs: 3000,
        callTimeoutMs: 3000,
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.deepEqual(createdBody.server.envRefs, {
      MCP_FIXTURE_SECRET: 'env:MCP_FIXTURE_SECRET',
    });

    const state = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json());
    assert.equal(JSON.stringify(state).includes('http-mcp-secret'), false);

    const task = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ goal: 'HTTP MCP call', autoRun: false }),
    }).then((response) => response.json());
    const called = await fetch(`${baseUrl}/api/tasks/${task.task.id}/mcp/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serverId: 'http-fixture',
        tool: 'read_doc',
        arguments: {},
      }),
    });
    assert.equal(called.status, 200);
    const calledBody = await called.json();
    assert.equal(calledBody.ok, true);
    assert.match(JSON.stringify(calledBody.result), /fixture:read_doc:http-mcp-secret/);

    const rejected = await fetch(`${baseUrl}/api/tasks/${task.task.id}/mcp/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serverId: 'http-fixture',
        tool: 'write_doc',
        arguments: {},
      }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /不是只读工具/);
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

test('HTTP command approvals keep agents request-only and execute approved commands once', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-http-approval-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const agentToken = ['agentforge', 'approval', 'agent', '0123456789'].join('-');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_API_TOKEN: TOKEN,
      AGENTFORGE_AGENT_TOKENS: JSON.stringify([
        { token: agentToken, id: 'tester-1', name: 'Tester One' },
      ]),
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
    const ownerHeaders = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    };
    const createdTester = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        id: 'tester-1',
        name: 'Tester One',
        role: 'tester',
        mode: 'sim',
      }),
    });
    assert.equal(createdTester.status, 201);
    assert.equal((await createdTester.json()).agent.id, 'tester-1');

    const fixture = path.resolve('tests/fixtures/command-fixture.mjs');
    const configured = await fetch(`${baseUrl}/api/commands`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({
        commands: [
          {
            id: 'fixture-ok',
            label: 'Fixture OK',
            command: process.execPath,
            args: [fixture, 'ok'],
            requireApproval: false,
            maxPerMinute: 30,
          },
          {
            id: 'fixture-gated',
            label: 'Fixture Gated',
            command: process.execPath,
            args: [fixture, 'ok'],
            requireApproval: true,
            maxPerMinute: 30,
          },
        ],
      }),
    });
    assert.equal(configured.status, 200);

    const task = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ goal: 'HTTP approval task', autoRun: false }),
    }).then((response) => response.json());
    const taskId = task.task.id;

    const directAgent = await fetch(`${baseUrl}/api/commands/fixture-ok/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ taskId }),
    });
    assert.equal(directAgent.status, 403);
    assert.match((await directAgent.json()).error, /command:execute/);

    const requested = await fetch(`${baseUrl}/api/approvals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        taskId,
        agentId: 'tester-1',
        commandId: 'fixture-gated',
      }),
    });
    assert.equal(requested.status, 201);
    const approval = (await requested.json()).approval;
    assert.equal(approval.status, 'pending');

    const crossAgentRequest = await fetch(`${baseUrl}/api/approvals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        taskId,
        agentId: 'other-agent',
        commandId: 'fixture-gated',
      }),
    });
    assert.equal(crossAgentRequest.status, 403);

    const selfApprove = await fetch(`${baseUrl}/api/approvals/${approval.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(selfApprove.status, 403);
    assert.match((await selfApprove.json()).error, /command:approve/);

    const approved = await fetch(`${baseUrl}/api/approvals/${approval.id}`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(approved.status, 200);

    const executed = await fetch(`${baseUrl}/api/approvals/${approval.id}/execute`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(executed.status, 200);
    const executedBody = await executed.json();
    assert.equal(executedBody.ok, true);
    assert.equal(executedBody.result.code, 0);
    assert.match(executedBody.result.stdout, /fixture:ok/);

    const replay = await fetch(`${baseUrl}/api/approvals/${approval.id}/execute`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(replay.status, 409);

    const state = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json());
    const record = state.approvals.find((item) => item.id === approval.id);
    assert.equal(record.status, 'executed');
    assert.ok(record.result);
    const event = state.activeTask?.events?.find((item) => item.type === 'command.end');
    assert.ok(event);
    assert.equal(event.data.code, 0);
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
