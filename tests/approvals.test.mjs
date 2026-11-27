import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-command-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { CommandRunner } = await import('../server/command-runner.mjs');
const {
  createApprovalRequest,
  decideApproval,
  executeApproval,
  recoverInterruptedApprovals,
} = await import('../server/approvals.mjs');

const fixture = path.resolve('tests/fixtures/command-fixture.mjs');
const runner = new CommandRunner({ workspaceRoot: temp, dataRoot: temp });

runner.configure([
  {
    id: 'fixture-ok',
    label: 'Fixture OK',
    command: process.execPath,
    args: [fixture, 'ok'],
    requireApproval: false,
    maxPerMinute: 30,
  },
  {
    id: 'fixture-write',
    label: 'Fixture Write',
    command: process.execPath,
    args: [fixture, 'write'],
    requireApproval: false,
    maxPerMinute: 30,
  },
  {
    id: 'fixture-fail',
    label: 'Fixture Fail',
    command: process.execPath,
    args: [fixture, 'fail'],
    requireApproval: false,
    maxPerMinute: 30,
  },
  {
    id: 'fixture-hang',
    label: 'Fixture Hang',
    command: process.execPath,
    args: [fixture, 'hang'],
    timeoutMs: 200,
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
]);

function taskWithCoder(goal = 'controlled command') {
  const task = store.createTask({ goal });
  const coder = store.agents.find((agent) => agent.role === 'coder');
  const tester = store.agents.find((agent) => agent.role === 'tester');
  task.plan = [
    { id: 'code-1', role: 'coder', agentId: coder.id, status: 'done' },
    { id: 'test-1', role: 'tester', agentId: tester.id, status: 'done' },
  ];
  store.updateTask(task.id, { plan: task.plan });
  return { task: store.getTask(task.id), coder, tester };
}

test('fixed command runner records real exit code, output and elapsed time', async () => {
  const { task } = taskWithCoder();
  const result = await runner.execute({
    task,
    request: { commandId: 'fixture-ok', workingDirectory: '' },
    principal: { kind: 'operator', id: 'op-1', name: 'Operator' },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /fixture:ok/);
  assert.ok(result.elapsed >= 0);
  const event = store
    .getTask(task.id)
    .events.findLast((item) => item.type === 'command.end');
  assert.ok(event);
  assert.equal(event.data.commandId, 'fixture-ok');
  assert.equal(event.data.code, 0);
  assert.match(event.data.stdout, /fixture:ok/);
});

test('fixed command runner rejects unknown commands, arbitrary args and directory escape', async () => {
  const { task } = taskWithCoder();
  assert.throws(
    () => runner.normalizeRequest({ commandId: 'not-listed' }),
    /不在固定白名单中/,
  );
  assert.throws(
    () => runner.normalizeRequest({ commandId: 'fixture-ok', args: ['--danger'] }),
    /不接受自定义参数/,
  );
  assert.throws(
    () =>
      runner.resolveWorkingDirectory(
        task,
        runner.get('fixture-ok'),
        '../outside',
      ),
    /不能越出任务工作区/,
  );
});

test('non-zero exit and timeout are explicit, not swallowed', async () => {
  const { task } = taskWithCoder();
  const failed = await runner.execute({
    task,
    request: { commandId: 'fixture-fail', workingDirectory: '' },
    principal: { kind: 'operator', id: 'op-1', name: 'Operator' },
  });
  assert.equal(failed.code, 7);
  assert.match(failed.stderr, /fixture command failed/);
  const timedOut = await runner.execute({
    task,
    request: { commandId: 'fixture-hang', workingDirectory: '' },
    principal: { kind: 'operator', id: 'op-1', name: 'Operator' },
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.code, -3);
});

test('command-created files enter the task artifact and change ledger', async () => {
  const { task } = taskWithCoder('command file ledger');
  const result = await runner.execute({
    task,
    request: { commandId: 'fixture-write', workingDirectory: '' },
    principal: { kind: 'operator', id: 'op-1', name: 'Operator' },
  });
  assert.equal(result.code, 0);
  assert.ok(result.fileChanges.some((item) => item.path === 'command-output.txt'));
  assert.ok(store.getTask(task.id).artifacts.some((item) => item.path === 'command-output.txt'));
});

test('approval flow lets implementers request but blocks self-approval and replay', async () => {
  const { task, coder, tester } = taskWithCoder('approval flow');
  const coderApproval = createApprovalRequest({
    taskId: task.id,
    agentId: coder.id,
    commandId: 'fixture-gated',
    requestedBy: { kind: 'agent', id: coder.id, name: coder.name },
    runner,
  });
  assert.equal(coderApproval.requesterIsImplementer, true);
  assert.throws(
    () =>
      createApprovalRequest({
        taskId: task.id,
        agentId: tester.id,
        commandId: 'fixture-gated',
        requestedBy: { kind: 'agent', id: coder.id, name: coder.name },
        runner,
      }),
    /只能为自己的身份申请/,
  );

  const approval = createApprovalRequest({
    taskId: task.id,
    agentId: tester.id,
    commandId: 'fixture-gated',
    requestedBy: { kind: 'agent', id: tester.id, name: tester.name },
    runner,
  });
  assert.equal(approval.status, 'pending');
  assert.throws(
    () =>
      decideApproval(approval.id, {
        decision: 'approved',
        principal: { kind: 'agent', id: tester.id, name: tester.name },
        runner,
      }),
    /不能处理自己的审批/,
  );
  const approved = decideApproval(approval.id, {
    decision: 'approved',
    principal: { kind: 'operator', id: 'op-1', name: 'Operator' },
    runner,
  });
  assert.equal(approved.status, 'approved');
  assert.throws(
    () =>
      decideApproval(approval.id, {
        decision: 'approved',
        principal: { kind: 'operator', id: 'op-2', name: 'Other Operator' },
        runner,
      }),
    /不能重复处理/,
  );
  const executed = await executeApproval(approval.id, {
    principal: { kind: 'operator', id: 'op-1', name: 'Operator' },
    runner,
  });
  assert.equal(executed.result.code, 0);
  assert.equal(executed.approval.status, 'executed');
  await assert.rejects(
    executeApproval(approval.id, {
      principal: { kind: 'operator', id: 'op-1', name: 'Operator' },
      runner,
    }),
    /不能执行/,
  );
  store.flush();
  const persisted = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
  assert.ok(persisted.settings.approvals.some((item) => item.id === approval.id));
});

test('interrupted approvals are failed closed after restart', () => {
  const { task, tester } = taskWithCoder('approval recovery');
  const approval = createApprovalRequest({
    taskId: task.id,
    agentId: tester.id,
    commandId: 'fixture-gated',
    requestedBy: { kind: 'agent', id: tester.id, name: tester.name },
    runner,
  });
  const record = store.db.settings.approvals.find((item) => item.id === approval.id);
  record.status = 'executing';
  assert.equal(recoverInterruptedApprovals(), true);
  assert.equal(
    store.db.settings.approvals.find((item) => item.id === approval.id).status,
    'failed',
  );
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a fixture child briefly. */
  }
});
