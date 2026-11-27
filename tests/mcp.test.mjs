import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-mcp-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.MCP_FIXTURE_SECRET = 'fixture-secret-value';

const { store } = await import('../server/store.mjs');
const { toolGateway } = await import('../server/tool-gateway.mjs');
const {
  mcpWorkingDirectory,
  normalizeMcpServer,
  probeMcpServer,
  redactMcpServer,
} = await import('../server/mcp.mjs');

const fixture = path.resolve('tests/fixtures/mcp-readonly-server.mjs');

function addServer(overrides = {}) {
  const existing = store.getMcpServer(overrides.id || 'fixture');
  if (existing) return existing;
  return store.addMcpServer({
    id: 'fixture',
    label: 'Fixture MCP',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    envRefs: { MCP_FIXTURE_SECRET: 'env:MCP_FIXTURE_SECRET' },
    startTimeoutMs: 3000,
    callTimeoutMs: 3000,
    ...overrides,
  });
}

test('MCP config is persisted as env references and never exposes resolved secrets', async () => {
  const server = addServer();
  const redacted = redactMcpServer(server);
  assert.deepEqual(redacted.envRefs, { MCP_FIXTURE_SECRET: 'env:MCP_FIXTURE_SECRET' });
  assert.equal(JSON.stringify(redacted).includes('fixture-secret-value'), false);
  assert.equal(store.getMcpServer('fixture').id, 'fixture');

  const probe = await probeMcpServer(server, { cwd: temp });
  assert.equal(probe.ok, true);
  assert.ok(probe.tools.some((tool) => tool.name === 'read_doc' && tool.effect === 'read'));
  assert.ok(probe.tools.some((tool) => tool.name === 'write_doc' && tool.effect === 'write'));
  assert.ok(probe.tools.some((tool) => tool.name === 'unannotated' && tool.effect === 'unknown'));
  assert.ok(
    probe.tools.some((tool) => tool.name === 'hinted_read' && tool.readOnlyHint === true),
  );
});

test('Agent MCP whitelist defaults to deny and permits only listed servers', async () => {
  const task = store.createTask({ goal: 'MCP whitelist probe' });
  const agent = store.addAgent({
    name: 'MCP Reader',
    role: 'reviewer',
    tools: ['mcp.call'],
    mcpServers: [],
  });
  assert.deepEqual(store.getAgent(agent.id).mcpServers, []);
  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'mcp.call',
      operation: 'call',
      args: { op: 'call', serverId: 'fixture', tool: 'read_doc' },
      agentId: agent.id,
    }),
    /没有 MCP server fixture 权限/,
  );

  store.updateAgent(agent.id, { mcpServers: ['fixture'] });
  const call = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'mcp.call',
    operation: 'call',
    args: { op: 'call', serverId: 'fixture', tool: 'read_doc' },
    agentId: agent.id,
  });
  assert.equal(call.ok, true);
  assert.equal(call.result.serverId, 'fixture');
  assert.match(JSON.stringify(call.result), /fixture:read_doc:fixture-secret-value/);
  const audit = store
    .getTask(task.id)
    .events.findLast(
      (event) =>
        event.type === 'tool.call.end' &&
        event.data.tool === 'mcp.call' &&
        event.data.ok === true,
    );
  assert.ok(audit);
  assert.equal(audit.data.result.serverId, 'fixture');
  assert.equal(audit.data.result.tool, 'read_doc');
});

test('MCP write tools and startup timeouts fail closed', async () => {
  const task = store.createTask({ goal: 'MCP read-only boundary' });
  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'mcp.call',
      operation: 'call',
      args: { op: 'call', serverId: 'fixture', tool: 'write_doc' },
      principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    }),
    /不是只读工具/,
  );
  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'mcp.call',
      operation: 'call',
      args: { op: 'call', serverId: 'fixture', tool: 'unannotated' },
      principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
    }),
    /不是只读工具/,
  );

  const hinted = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'mcp.call',
    operation: 'call',
    args: { op: 'call', serverId: 'fixture', tool: 'hinted_read' },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
  });
  assert.equal(hinted.ok, true);

  const hanging = addServer({
    id: 'hanging',
    args: [fixture, '--hang'],
    startTimeoutMs: 200,
    callTimeoutMs: 200,
  });
  await assert.rejects(
    probeMcpServer(hanging, { cwd: temp }),
    /MCP 调用超时/,
  );
});

test('MCP call audit keeps bounded, redacted nested arguments', async () => {
  const task = store.createTask({ goal: 'MCP audit arguments' });
  await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'mcp.call',
    operation: 'call',
    args: {
      op: 'call',
      serverId: 'fixture',
      tool: 'read_doc',
      arguments: {
        query: 'fixture',
        apiKey: 'fixture-secret-value',
        payload: Array.from({ length: 30 }, () => 'x'.repeat(240)),
      },
    },
    principal: { kind: 'owner', id: 'owner', name: 'Owner UI' },
  });
  const event = store
    .getTask(task.id)
    .events.findLast(
      (item) => item.type === 'tool.call.start' && item.data.tool === 'mcp.call',
    );
  assert.ok(event);
  assert.match(JSON.stringify(event.data.arguments.arguments), /\[REDACTED\]/);
  assert.equal(event.data.arguments.argumentsTruncated, true);
  assert.ok(event.data.arguments.arguments.preview.length <= 1000);
});

test('MCP working directories cannot escape the task workspace', () => {
  assert.throws(
    () => mcpWorkingDirectory({ workingDirectory: '../outside' }, temp),
    /必须位于任务工作区内/,
  );
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a child process briefly. */
  }
});
