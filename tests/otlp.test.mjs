import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  OtlpExporter,
  otlpPayload,
  otlpSpanFromEvent,
  resolveOtlpConfig,
} from '../server/otlp.mjs';

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

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
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

test('resolveOtlpConfig parses endpoint, headers and bounded timeout', () => {
  const config = resolveOtlpConfig({
    AGENTFORGE_OTLP_ENDPOINT: 'http://collector.local/v1/traces',
    AGENTFORGE_OTLP_HEADERS: JSON.stringify({ Authorization: 'Bearer probe' }),
    AGENTFORGE_OTLP_TIMEOUT_MS: '25',
  });
  assert.equal(config.endpoint, 'http://collector.local/v1/traces');
  assert.deepEqual(config.headers, { Authorization: 'Bearer probe' });
  assert.equal(config.timeoutMs, 100);
});

test('otlp span preserves trace identity and redacts nested secrets', () => {
  const span = otlpSpanFromEvent(
    {
      type: 'tool.call.start',
      at: 1000,
      traceId: 'run-otlp-probe',
      spanId: 'span-otlp-probe',
      parentSpanId: 'parent-otlp-probe',
      data: {
        tool: 'workspace.write',
        nested: {
          apiKey: 'sk-live-secret',
          password: 'p@ss',
          safe: 'visible',
        },
      },
    },
    { id: 'task-1', title: 'OTLP probe', tenantId: 'alpha' },
  );
  assert.equal(span.traceId.length, 32);
  assert.equal(span.spanId.length, 16);
  assert.equal(span.parentSpanId.length, 16);
  assert.equal(span.name, 'tool.call.start');
  const serialized = JSON.stringify(otlpPayload([span]));
  assert.doesNotMatch(serialized, /sk-live-secret|p@ss/);
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /visible/);
  assert.match(serialized, /alpha/);
});

test('OtlpExporter posts a real OTLP JSON batch to an HTTP receiver', async () => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const { port } = receiver.address();
  const exporter = new OtlpExporter({
    endpoint: `http://127.0.0.1:${port}/v1/traces`,
    headers: { Authorization: 'Bearer otlp-probe' },
  });
  try {
    exporter.enqueue(
      otlpSpanFromEvent(
        { type: 'run.start', at: 2000, data: { token: 'secret-token' } },
        { id: 'task-http', tenantId: 'beta' },
      ),
    );
    await waitFor(() => received.length === 1, 'OTLP receiver POST');
    await exporter.flush();
    assert.equal(received[0].url, '/v1/traces');
    assert.equal(received[0].headers.authorization, 'Bearer otlp-probe');
    assert.equal(
      received[0].body.resourceSpans[0].scopeSpans[0].spans[0].name,
      'run.start',
    );
    assert.doesNotMatch(JSON.stringify(received[0].body), /secret-token/);
    assert.equal(exporter.snapshot().exported, 1);
    assert.equal(exporter.snapshot().failed, 0);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test('OtlpExporter records receiver failures without throwing', async () => {
  const receiver = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500);
      res.end('failed');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const { port } = receiver.address();
  const exporter = new OtlpExporter({ endpoint: `http://127.0.0.1:${port}/v1/traces` });
  try {
    exporter.enqueue(otlpSpanFromEvent({ type: 'run.error', data: { status: 'error' } }));
    const snapshot = await exporter.flush();
    assert.equal(snapshot.failed, 1);
    assert.match(snapshot.lastError, /HTTP 500/);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test('HTTP task events reach OTLP while local trace and exporter status stay visible', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-otlp-http-'));
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = receiver.address().port;
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
      AGENTFORGE_OTLP_ENDPOINT: `http://127.0.0.1:${receiverPort}/v1/traces`,
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
      body: JSON.stringify({
        goal: 'OTLP real HTTP path probe',
        autoRun: false,
      }),
    });
    assert.equal(created.status, 201);
    const { task } = await created.json();
    const replanned = await fetch(`${baseUrl}/api/tasks/${task.id}/replan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'emit a real task event',
        steps: [{ id: 'probe', title: 'OTLP probe', role: 'coder', needs: [] }],
      }),
    });
    assert.equal(replanned.status, 200);

    await waitFor(() => received.length > 0, 'OTLP HTTP batch');
    const exported = received.flatMap((payload) =>
      payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    assert.ok(exported.length > 0);
    assert.ok(exported.every((span) => span.traceId.length === 32 && span.spanId.length === 16));

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.otlp.enabled, true);
    assert.ok(state.otlp.exported > 0);
    const detailResponse = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    const detail = await detailResponse.json();
    assert.ok(detail.task.events.length > 0);
    assert.equal(detail.task.trace.traceId, detail.task.runId || detail.task.trace.traceId);
  } catch (err) {
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    await new Promise((resolve) => receiver.close(resolve));
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows can hold the data directory briefly. */
    }
  }
});
