import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  authenticateApi,
  resolveSecurityConfig,
  tenantFilterForPrincipal,
} from '../server/security.mjs';

const OWNER_TOKEN = ['agentforge', 'tenant', 'owner', '0123456789'].join('-');
const ALPHA_TOKEN = ['agentforge', 'tenant', 'alpha', '0123456789'].join('-');
const BETA_TOKEN = ['agentforge', 'tenant', 'beta', '0123456789'].join('-');

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
      /* retry while the process starts */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

test('tenant principals carry scope and owner is the only cross-tenant default', () => {
  const config = resolveSecurityConfig({
    AGENTFORGE_API_TOKEN: OWNER_TOKEN,
    AGENTFORGE_OPERATOR_TOKEN: ALPHA_TOKEN,
    AGENTFORGE_OPERATOR_TENANT: 'alpha',
    AGENTFORGE_OPERATOR_ID: 'alpha-operator',
    AGENTFORGE_AGENT_TOKENS: JSON.stringify([
      { token: BETA_TOKEN, id: 'beta-agent', tenantId: 'beta' },
    ]),
  });
  const operator = authenticateApi(
    { headers: { authorization: `Bearer ${ALPHA_TOKEN}` } },
    new URL('http://localhost/api/state'),
    config,
  ).principal;
  const agent = authenticateApi(
    { headers: { authorization: `Bearer ${BETA_TOKEN}` } },
    new URL('http://localhost/api/state'),
    config,
  ).principal;
  const owner = authenticateApi(
    { headers: { authorization: `Bearer ${OWNER_TOKEN}` } },
    new URL('http://localhost/api/state'),
    config,
  ).principal;
  assert.equal(operator.tenantId, 'alpha');
  assert.equal(agent.tenantId, 'beta');
  assert.equal(owner.tenantId, '*');
  assert.deepEqual(tenantFilterForPrincipal(operator), { tenantId: 'alpha' });
  assert.deepEqual(tenantFilterForPrincipal(owner), { tenantId: null });
});

test('HTTP API isolates tasks, automations, approvals and quotas by tenant', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-tenant-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_API_TOKEN: OWNER_TOKEN,
      AGENTFORGE_OPERATOR_TOKEN: ALPHA_TOKEN,
      AGENTFORGE_OPERATOR_ID: 'alpha-operator',
      AGENTFORGE_OPERATOR_TENANT: 'alpha',
      AGENTFORGE_OPERATOR_TASK_LIMIT: '1',
      AGENTFORGE_AGENT_TOKENS: JSON.stringify([
        {
          token: BETA_TOKEN,
          id: 'beta-agent',
          tenantId: 'beta',
          scopes: ['read', 'tool:execute', 'command:request', 'automation:write'],
        },
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

  const headersFor = (token) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  try {
    await waitForHealth(baseUrl, child);
    const alphaHeaders = headersFor(ALPHA_TOKEN);
    const betaHeaders = headersFor(BETA_TOKEN);
    const ownerHeaders = headersFor(OWNER_TOKEN);

    const alphaTask = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: alphaHeaders,
      body: JSON.stringify({ goal: 'alpha private task', autoRun: false }),
    });
    assert.equal(alphaTask.status, 201);
    const alphaBody = await alphaTask.json();
    assert.equal(alphaBody.task.tenantId, 'alpha');

    const alphaForgedTenant = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: alphaHeaders,
      body: JSON.stringify({
        goal: 'alpha forged tenant',
        tenantId: 'beta',
        autoRun: false,
      }),
    });
    assert.equal(alphaForgedTenant.status, 429);

    const overQuota = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: alphaHeaders,
      body: JSON.stringify({ goal: 'alpha second task', autoRun: false }),
    });
    assert.equal(overQuota.status, 429);
    assert.match((await overQuota.json()).error, /配额/);

    const alphaState = await fetch(`${baseUrl}/api/state`, { headers: alphaHeaders }).then((r) =>
      r.json(),
    );
    assert.equal(alphaState.tasks.length, 1);
    assert.equal(alphaState.tasks[0].tenantId, 'alpha');

    const betaState = await fetch(`${baseUrl}/api/state`, { headers: betaHeaders }).then((r) =>
      r.json(),
    );
    assert.equal(betaState.tasks.length, 0);
    assert.equal(betaState.activeTask, null);

    const crossTenantRead = await fetch(`${baseUrl}/api/tasks/${alphaBody.task.id}`, {
      headers: betaHeaders,
    });
    assert.equal(crossTenantRead.status, 404);

    const ownerDefaultTask = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ goal: 'owner default task', autoRun: false }),
    });
    assert.equal(ownerDefaultTask.status, 201);
    assert.equal((await ownerDefaultTask.json()).task.tenantId, 'default');

    const ownerBetaTask = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        goal: 'owner selected beta task',
        tenantId: 'beta',
        autoRun: false,
      }),
    });
    assert.equal(ownerBetaTask.status, 201);
    const ownerBetaBody = await ownerBetaTask.json();
    assert.equal(ownerBetaBody.task.tenantId, 'beta');

    const betaStateAfterOwner = await fetch(`${baseUrl}/api/state`, {
      headers: betaHeaders,
    }).then((r) => r.json());
    assert.equal(betaStateAfterOwner.tasks.length, 1);
    assert.equal(betaStateAfterOwner.tasks[0].id, ownerBetaBody.task.id);

    const alphaAutomation = await fetch(`${baseUrl}/api/automations`, {
      method: 'POST',
      headers: alphaHeaders,
      body: JSON.stringify({
        name: 'alpha automation',
        goal: 'alpha private automation',
        enabled: false,
      }),
    });
    assert.equal(alphaAutomation.status, 201);
    assert.equal((await alphaAutomation.json()).automation.tenantId, 'alpha');

    const betaAutomations = await fetch(`${baseUrl}/api/automations`, {
      headers: betaHeaders,
    }).then((r) => r.json());
    assert.equal(betaAutomations.automations.length, 0);

    const ownerAutomations = await fetch(`${baseUrl}/api/automations`, {
      headers: ownerHeaders,
    }).then((r) => r.json());
    assert.equal(ownerAutomations.automations.length, 1);

    const crossTenantApproval = await fetch(`${baseUrl}/api/approvals`, {
      method: 'POST',
      headers: betaHeaders,
      body: JSON.stringify({
        taskId: alphaBody.task.id,
        agentId: 'beta-agent',
        commandId: 'fixture-ok',
      }),
    });
    assert.equal(crossTenantApproval.status, 404);

    const betaAutomation = await fetch(`${baseUrl}/api/automations`, {
      method: 'POST',
      headers: betaHeaders,
      body: JSON.stringify({
        name: 'beta quota automation',
        goal: 'beta scheduled task',
        enabled: false,
      }),
    });
    assert.equal(betaAutomation.status, 201);
    const betaAutomationBody = await betaAutomation.json();
    assert.equal(betaAutomationBody.automation.tenantId, 'beta');
    assert.equal(betaAutomationBody.automation.taskLimit, 0);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const saved = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
    assert.ok(saved.tasks.some((task) => task.tenantId === 'alpha'));
    assert.ok(saved.tasks.some((task) => task.tenantId === 'default'));
    assert.ok(saved.tasks.some((task) => task.tenantId === 'beta'));
    assert.deepEqual(
      saved.settings.automations.map((automation) => automation.tenantId),
      ['alpha', 'beta'],
    );
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
