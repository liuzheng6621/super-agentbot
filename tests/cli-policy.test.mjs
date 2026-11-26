import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-cli-policy-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const {
  normalizeExecutionPolicy,
  toolCapabilities,
  resolveCliPolicy,
  prepareCliExecution,
} = await import('../server/cli-policy.mjs');
const { spawnCli } = await import('../server/adapters.mjs');
const { store } = await import('../server/store.mjs');
const { startTask } = await import('../server/orchestrator.mjs');

const CODER_TOOLS = [
  'workspace.read',
  'workspace.search',
  'workspace.write',
  'workspace.move',
  'workspace.delete',
  'shell',
];
const READ_TOOLS = ['workspace.read', 'workspace.search'];

test('执行策略只接受 inherit / strict，非法值回落到兼容模式', () => {
  assert.equal(normalizeExecutionPolicy('strict'), 'strict');
  assert.equal(normalizeExecutionPolicy('INHERIT'), 'inherit');
  assert.equal(normalizeExecutionPolicy('bypass'), 'inherit');
  assert.equal(normalizeExecutionPolicy(undefined), 'inherit');
});

test('工具白名单能推导只读、可写、执行和删除能力', () => {
  const read = toolCapabilities(READ_TOOLS);
  assert.equal(read.read, true);
  assert.equal(read.write, false);
  assert.equal(read.execute, false);
  assert.equal(read.sandbox, 'read-only');

  const coder = toolCapabilities(CODER_TOOLS);
  assert.equal(coder.read, true);
  assert.equal(coder.write, true);
  assert.equal(coder.execute, true);
  assert.equal(coder.destructive, true);
  assert.equal(coder.sandbox, 'workspace-write');
});

test('Codex strict 会覆盖危险参数并映射 workspace-write 沙箱', () => {
  const agent = {
    executionPolicy: 'strict',
    tools: CODER_TOOLS,
    cli: {
      command: 'C:\\tools\\codex.exe',
      args: ['exec', '--sandbox', 'danger-full-access', '{{prompt}}'],
    },
  };
  const policy = resolveCliPolicy(agent);
  assert.equal(policy.status, 'enforced');
  assert.equal(policy.sandbox, 'workspace-write');
  assert.equal(policy.boundary, 'OS 沙箱');

  const prepared = prepareCliExecution(agent, { args: agent.cli.args });
  assert.deepEqual(prepared.agent.cli.args, [
    'exec',
    '--sandbox',
    'workspace-write',
    '{{prompt}}',
  ]);
});

test('Codex strict 的只读 shell 仍被限制在 read-only 沙箱', () => {
  const policy = resolveCliPolicy({
    executionPolicy: 'strict',
    tools: ['workspace.read', 'workspace.search', 'shell'],
    cli: { command: 'codex' },
  });
  assert.equal(policy.status, 'enforced');
  assert.equal(policy.sandbox, 'read-only');
});

test('Codex 与 DSH strict 不允许可写但未声明 shell 的组合', () => {
  const tools = ['workspace.read', 'workspace.write'];
  for (const command of ['codex', 'dsh']) {
    const policy = resolveCliPolicy({
      executionPolicy: 'strict',
      tools,
      cli: { command },
    });
    assert.equal(policy.status, 'unsupported');
    assert.match(policy.reason, /可写沙箱会同时开放命令执行/);
  }
});

test('DSH strict 会替换权限预设和审批策略', () => {
  const prepared = prepareCliExecution(
    {
      executionPolicy: 'strict',
      tools: CODER_TOOLS,
      cli: {
        command: 'dsh.cmd',
        args: [
          'headless',
          '--permission-mode',
          'danger-full-access',
          '--approval-policy',
          'ask',
          '-',
        ],
      },
    },
    {
      args: [
        'headless',
        '--permission-mode',
        'danger-full-access',
        '--approval-policy',
        'ask',
        '-',
      ],
    },
  );
  assert.equal(prepared.policy.status, 'enforced');
  assert.deepEqual(prepared.agent.cli.args, [
    'headless',
    '--permission-mode',
    'workspace-write',
    '--approval-policy',
    'never',
    '-',
  ]);
});

test('Claude strict 只接受无 shell 的只读组合', () => {
  const readOnly = resolveCliPolicy({
    executionPolicy: 'strict',
    tools: READ_TOOLS,
    cli: { command: 'claude' },
  });
  assert.equal(readOnly.status, 'enforced');
  assert.equal(readOnly.sandbox, 'read-only');
  assert.equal(readOnly.boundary, '内置工具白名单');

  const shell = resolveCliPolicy({
    executionPolicy: 'strict',
    tools: ['workspace.read', 'shell'],
    cli: { command: 'claude' },
  });
  assert.equal(shell.status, 'unsupported');
  assert.match(shell.reason, /开放 shell/);

  const write = resolveCliPolicy({
    executionPolicy: 'strict',
    tools: CODER_TOOLS,
    cli: { command: 'claude' },
  });
  assert.equal(write.status, 'unsupported');
  assert.match(write.reason, /限制在任务工作区/);
});

test('无法验证边界的命令和空工具白名单在 strict 下被拒绝', () => {
  const generic = resolveCliPolicy({
    executionPolicy: 'strict',
    tools: READ_TOOLS,
    cli: { command: 'node' },
  });
  assert.equal(generic.status, 'unsupported');
  assert.match(generic.reason, /没有可验证的严格策略映射/);

  const empty = resolveCliPolicy({
    executionPolicy: 'strict',
    tools: [],
    cli: { command: 'codex' },
  });
  assert.equal(empty.status, 'unsupported');
  assert.match(empty.reason, /至少声明一个工具/);
});

test('spawnCli 在 strict 预检失败时不会启动子进程', async () => {
  const marker = path.join(temp, 'policy-marker.txt');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`;
  const result = await spawnCli(
    {
      executionPolicy: 'strict',
      tools: READ_TOOLS,
      cli: { command: process.execPath, args: ['-e', script] },
    },
    '',
    { cwd: temp, timeout: 2000 },
  );
  assert.equal(result.code, -6);
  assert.equal(result.policyDenied, true);
  assert.equal(result.policy.status, 'unsupported');
  assert.equal(fs.existsSync(marker), false);
});

test('Agent 持久化会归一化执行策略', () => {
  const agent = store.addAgent({
    name: 'Policy Store',
    role: 'reviewer',
    mode: 'cli',
    cli: { command: 'codex' },
  });
  assert.equal(agent.executionPolicy, 'inherit');

  store.updateAgent(agent.id, { executionPolicy: 'strict' });
  assert.equal(store.getAgent(agent.id).executionPolicy, 'strict');

  store.updateAgent(agent.id, { executionPolicy: 'unsafe' });
  assert.equal(store.getAgent(agent.id).executionPolicy, 'inherit');
});

test('任务会记录 CLI 策略拒绝事件和消息元数据', async () => {
  const planner = store.findAgentByRole('planner');
  const before = {
    mode: planner.mode,
    tools: [...(planner.tools || [])],
    executionPolicy: planner.executionPolicy,
    cli: { ...(planner.cli || {}) },
    health: planner.health,
  };
  store.updateSettings({
    debateEnabled: false,
    maxAutoReplans: 0,
    maxStepAttempts: 1,
    maxRepairRounds: 0,
  });
  store.updateAgent(planner.id, {
    mode: 'cli',
    tools: READ_TOOLS,
    executionPolicy: 'strict',
    cli: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
  });

  try {
    const task = store.createTask({
      goal: '验证 CLI 严格策略拒绝事件',
      debate: 'direct',
    });
    await startTask(task.id, { speed: 1000 });
    const saved = store.getTask(task.id);
    const denied = saved.events.filter((event) => event.type === 'cli.policy.denied');
    assert.ok(denied.length >= 1);
    assert.equal(denied[0].data.status, 'denied');
    assert.match(denied[0].data.reason, /没有可验证的严格策略映射/);

    const toolEnd = saved.events.find(
      (event) => event.type === 'tool.call.end' && event.data.denied === true,
    );
    assert.ok(toolEnd);
    assert.equal(toolEnd.data.policy.status, 'unsupported');
    const deniedMessage = saved.messages.find(
      (message) => message.meta?.policyStatus === 'denied',
    );
    assert.ok(deniedMessage, '拒绝原因应写入消息元数据');
    assert.equal(deniedMessage.meta.tokensIn, 0, '未启动的提示词不应计入输入 token');
  } finally {
    store.updateAgent(planner.id, before);
  }
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 上偶发占用，交给系统清理 */
  }
});
