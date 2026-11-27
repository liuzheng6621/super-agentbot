import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-workspace-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store, toolsForRole } = await import('../server/store.mjs');
const {
  deleteWorkspaceEntry,
  makeWorkspaceDir,
  moveWorkspaceEntry,
  readWorkspaceFile,
  searchWorkspace,
  workspaceDiff,
  workspacePoolInfo,
  workspaceSnapshot,
  writeWorkspaceEntry,
} = await import('../server/workspace.mjs');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stderr || result.error?.message || 'git failed'));
  return String(result.stdout || '').trim();
}

after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows can briefly keep a workspace file handle open. */
  }
});

test('workspace tree, read, write, search and change tracking form a closed loop', () => {
  const task = store.createTask({ goal: '验证工作区工具闭环' });
  writeWorkspaceEntry(task, 'src/app.js', 'export const answer = 41;\n', {
    agentId: 'agent-a',
    stepId: 'implement',
  });

  let current = store.getTask(task.id);
  const first = workspaceSnapshot(current);
  assert.ok(first.entries >= 2);
  assert.equal(first.tree[0].type, 'dir');
  assert.equal(first.tree[0].name, 'src');
  assert.equal(first.tree[0].children[0].path, 'src/app.js');
  assert.equal(first.tree[0].children[0].status, 'A');
  assert.equal(first.summary.added, 1);

  const read = readWorkspaceFile(current, 'src/app.js');
  assert.equal(read.content, 'export const answer = 41;\n');
  assert.equal(read.binary, false);

  const found = searchWorkspace(current, 'answer');
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].path, 'src/app.js');

  writeWorkspaceEntry(task, 'src/app.js', 'export const answer = 42;\n', {
    expectedVersion: read.version,
  });
  current = store.getTask(task.id);
  const change = current.fileChanges.find((item) => item.path === 'src/app.js');
  assert.equal(change.status, 'M');
  assert.notEqual(change.beforeVersion, change.afterVersion);
  assert.equal(readWorkspaceFile(current, 'src/app.js').content, 'export const answer = 42;\n');
});

test('mkdir, move and delete-to-trash keep a recoverable workspace history', () => {
  const task = store.createTask({ goal: '验证目录和回收站' });
  makeWorkspaceDir(task, 'docs');
  writeWorkspaceEntry(task, 'docs/note.md', '# note\n', { stepId: 'design' });
  moveWorkspaceEntry(task, 'docs/note.md', 'docs/readme.md');

  let current = store.getTask(task.id);
  assert.equal(current.artifacts.find((item) => item.path === 'docs/readme.md')?.path, 'docs/readme.md');
  assert.equal(current.fileChanges.find((item) => item.path === 'docs/readme.md')?.status, 'R');

  const removed = deleteWorkspaceEntry(task, 'docs/readme.md');
  current = store.getTask(task.id);
  assert.ok(removed.trashPath.includes('.agentforge/trash/'));
  assert.equal(current.artifacts.find((item) => item.path === 'docs/readme.md')?.status, 'D');
  assert.equal(current.fileChanges.find((item) => item.path === 'docs/readme.md')?.status, 'D');
  assert.equal(fs.existsSync(path.join(task.workspace, 'docs/readme.md')), false);
  assert.equal(fs.existsSync(path.join(task.workspace, removed.trashPath)), true);
});

test('moving a file outside the artifact index still records a rename', () => {
  const task = store.createTask({ goal: '验证未登记文件移动' });
  fs.writeFileSync(path.join(task.workspace, 'legacy.txt'), 'legacy\n');

  moveWorkspaceEntry(task, 'legacy.txt', 'archive/legacy.txt');

  const current = store.getTask(task.id);
  assert.equal(
    current.fileChanges.find((item) => item.path === 'archive/legacy.txt')?.status,
    'R',
  );
  assert.equal(
    current.fileChanges.find((item) => item.path === 'archive/legacy.txt')?.previousPath,
    'legacy.txt',
  );
});

test('workspace tools reject traversal and sensitive previews', () => {
  const task = store.createTask({ goal: '验证工作区边界' });
  assert.throws(() => writeWorkspaceEntry(task, '../outside.txt', 'x'), /越出工作区/);
  assert.throws(() => writeWorkspaceEntry(task, '.git/config', 'x'), /内部目录/);
  assert.throws(() => readWorkspaceFile(task, '.agentforge/trash/note.txt'), /内部目录/);
  fs.writeFileSync(path.join(task.workspace, '.env'), 'SECRET=1');
  assert.throws(() => readWorkspaceFile(task, '.env'), /敏感文件/);
  fs.writeFileSync(path.join(task.workspace, '.npmrc'), 'token=secret');
  assert.throws(() => readWorkspaceFile(task, '.npmrc'), /敏感文件/);
});

test('agent tool policy follows role defaults and preserves explicit overrides', () => {
  const agent = store.addAgent({
    name: 'Policy Probe',
    role: 'reviewer',
    mode: 'sim',
    seat: false,
  });
  assert.deepEqual(agent.tools, toolsForRole('reviewer'));

  store.updateAgent(agent.id, { role: 'coder' });
  assert.deepEqual(store.getAgent(agent.id).tools, toolsForRole('coder'));

  store.updateAgent(agent.id, {
    tools: ['workspace.read', 'unknown.tool', 'workspace.read'],
  });
  assert.deepEqual(store.getAgent(agent.id).tools, ['workspace.read']);

  store.updateAgent(agent.id, { tools: [] });
  assert.deepEqual(store.getAgent(agent.id).tools, []);
});

test('git isolation creates a detached worktree and cleans it up with the task', () => {
  const repo = path.join(temp, 'repo-worktree');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'agentforge@example.test']);
  git(repo, ['config', 'user.name', 'AgentForge Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);

  const task = store.createTask({
    goal: '验证 Git 隔离工作树',
    workspace: repo,
    isolation: 'worktree',
  });
  const worktreePath = task.workspace;
  assert.notEqual(path.resolve(worktreePath), path.resolve(repo));
  assert.equal(task.external, false);
  assert.equal(task.worktree.source, path.resolve(repo));
  assert.equal(
    fs.readFileSync(path.join(worktreePath, 'README.md'), 'utf8').replace(/\r\n/g, '\n'),
    'base\n',
  );

  fs.writeFileSync(path.join(worktreePath, 'README.md'), 'worktree\n');
  assert.equal(
    fs.readFileSync(path.join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n'),
    'base\n',
  );
  assert.match(workspaceDiff(task, 'README.md').diff, /\+worktree/);

  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, 'src', 'new.js'), 'export const answer = 42;\n');
  const untracked = workspaceDiff(task, 'src/new.js');
  assert.equal(untracked.untracked, 1);
  assert.match(untracked.diff, /new file mode/);
  assert.match(untracked.diff, /\+export const answer = 42;/);

  assert.equal(store.removeTask(task.id), true);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(fs.existsSync(path.join(repo, 'README.md')), true);
});

test('git isolation rejects a directory that is not a repository', () => {
  const plain = path.join(temp, 'plain-directory');
  fs.mkdirSync(plain, { recursive: true });
  assert.throws(
    () => store.createTask({ goal: '拒绝非 Git 工作区', workspace: plain, isolation: 'worktree' }),
    /不是 Git 工作区/,
  );
});

test('git isolation falls back to a shared clone when worktree metadata is unavailable', () => {
  const repo = path.join(temp, 'repo-clone-fallback');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'agentforge@example.test']);
  git(repo, ['config', 'user.name', 'AgentForge Test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  fs.writeFileSync(path.join(repo, '.git', 'worktrees'), 'not-a-directory');

  const task = store.createTask({
    goal: '验证 worktree 不可用时自动回退',
    workspace: repo,
    isolation: 'worktree',
  });
  assert.equal(task.worktree.mode, 'clone');
  assert.match(task.worktree.fallbackReason, /worktree/i);
  assert.equal(
    fs.readFileSync(path.join(task.workspace, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'tracked\n',
  );

  const isolatedPath = task.workspace;
  fs.writeFileSync(path.join(isolatedPath, 'tracked.txt'), 'isolated\n');
  assert.equal(
    fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'tracked\n',
  );
  store.removeTask(task.id);
  assert.equal(fs.existsSync(isolatedPath), false);
});

test('cross-task workspace pools are opt-in, project-rooted, and survive task deletion', () => {
  const project = path.join(temp, 'shared-project');
  fs.mkdirSync(project, { recursive: true });
  const agent = store.addAgent({
    name: 'Shared Pool Agent',
    role: 'coder',
    mode: 'sim',
    seat: false,
    workspacePolicy: { mode: 'shared', crossTask: true, sharedDir: 'Shared' },
  });
  const first = store.createTask({ goal: 'shared pool first', workspace: project });
  const second = store.createTask({ goal: 'shared pool second', workspace: project });

  const before = workspacePoolInfo(first, agent);
  assert.equal(before.enabled, true);
  assert.equal(before.initialized, false);
  assert.equal(fs.existsSync(path.join(project, 'Shared')), false);

  writeWorkspaceEntry(first, 'notes.txt', 'from first\n', { agentId: agent.id }, agent);
  assert.equal(readWorkspaceFile(second, 'notes.txt', { agent }).content, 'from first\n');
  assert.equal(fs.readFileSync(path.join(project, 'Shared', 'notes.txt'), 'utf8'), 'from first\n');

  const leases = JSON.parse(
    fs.readFileSync(path.join(project, '.agentforge', 'pool', 'leases.json'), 'utf8'),
  );
  assert.ok(leases.some((lease) => lease.taskId === first.id && lease.agentId === agent.id));
  assert.ok(leases.some((lease) => lease.taskId === second.id && lease.agentId === agent.id));

  assert.equal(store.removeTask(first.id), true);
  assert.equal(fs.existsSync(path.join(project, 'Shared', 'notes.txt')), true);
  assert.equal(readWorkspaceFile(second, 'notes.txt', { agent }).content, 'from first\n');
  store.removeTask(second.id);
});

test('private workspace pools isolate agents and managed tasks cannot reuse their own directory', () => {
  const project = path.join(temp, 'private-pool-project');
  fs.mkdirSync(project, { recursive: true });
  const left = store.addAgent({
    name: 'Private Left',
    role: 'coder',
    mode: 'sim',
    seat: false,
    workspacePolicy: { mode: 'private', crossTask: true, privateDir: 'Agents' },
  });
  const right = store.addAgent({
    name: 'Private Right',
    role: 'tester',
    mode: 'sim',
    seat: false,
    workspacePolicy: { mode: 'private', crossTask: true, privateDir: 'Agents' },
  });
  const task = store.createTask({ goal: 'private pool', workspace: project });
  writeWorkspaceEntry(task, 'state.txt', 'left\n', { agentId: left.id }, left);
  writeWorkspaceEntry(task, 'state.txt', 'right\n', { agentId: right.id }, right);
  assert.equal(readWorkspaceFile(task, 'state.txt', { agent: left }).content, 'left\n');
  assert.equal(readWorkspaceFile(task, 'state.txt', { agent: right }).content, 'right\n');
  assert.equal(
    fs.readFileSync(path.join(project, 'Agents', left.id, 'state.txt'), 'utf8'),
    'left\n',
  );
  assert.equal(
    fs.readFileSync(path.join(project, 'Agents', right.id, 'state.txt'), 'utf8'),
    'right\n',
  );
  store.removeTask(task.id);

  const managed = store.createTask({ goal: 'managed pool must stay disabled' });
  const info = workspacePoolInfo(managed, left);
  assert.equal(info.enabled, false);
  assert.match(info.reason, /源项目/);
  assert.equal(fs.existsSync(path.join(managed.workspace, 'Agents')), false);
  store.removeTask(managed.id);
});

test('workspace pool policy rejects traversal and reserved directories', () => {
  const project = path.join(temp, 'pool-policy-project');
  fs.mkdirSync(project, { recursive: true });
  const task = store.createTask({ goal: 'pool policy', workspace: project });
  const traversal = store.addAgent({
    name: 'Traversal Pool',
    role: 'coder',
    mode: 'sim',
    seat: false,
    workspacePolicy: { mode: 'shared', crossTask: true, sharedDir: '../outside' },
  });
  const reserved = store.addAgent({
    name: 'Reserved Pool',
    role: 'coder',
    mode: 'sim',
    seat: false,
    workspacePolicy: { mode: 'shared', crossTask: true, sharedDir: '.agentforge/hidden' },
  });
  assert.throws(() => writeWorkspaceEntry(task, 'x.txt', 'x', {}, traversal), /越出工作区/);
  assert.throws(() => writeWorkspaceEntry(task, 'x.txt', 'x', {}, reserved), /内部目录/);
  store.removeTask(task.id);
});

test('read-after-write guard rejects stale owner and agent writes with an audit trail', async () => {
  const { toolGateway } = await import('../server/tool-gateway.mjs');
  const task = store.createTask({ goal: 'read after write guard' });
  const agent = store.addAgent({
    name: 'Guard Writer',
    role: 'coder',
    mode: 'sim',
    seat: false,
    tools: ['workspace.read', 'workspace.write'],
  });
  const owner = { kind: 'owner', id: 'owner', name: 'Owner UI' };
  const created = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.write',
    operation: 'write',
    args: { op: 'write', path: 'src/guard.js', content: 'export const value = 1;\n' },
    principal: owner,
    source: 'test.owner',
  });
  assert.equal(created.ok, true, 'creating a new file does not need a prior read');

  const ownerRead = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.read',
    operation: 'file',
    args: { op: 'file', path: 'src/guard.js' },
    principal: owner,
    source: 'test.owner',
  });
  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'workspace.write',
      operation: 'write',
      args: { op: 'write', path: 'src/guard.js', content: 'stale owner write\n' },
      principal: owner,
      source: 'test.owner',
    }),
    (err) => err.status === 409 && /expectedVersion/.test(err.message),
  );
  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'workspace.write',
      operation: 'write',
      args: {
        op: 'write',
        path: 'src/guard.js',
        content: 'stale owner write\n',
        expectedVersion: '0000000000000000',
      },
      principal: owner,
      source: 'test.owner',
    }),
    (err) => err.status === 409 && /写入冲突/.test(err.message),
  );
  const ownerWrite = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.write',
    operation: 'write',
    args: {
      op: 'write',
      path: 'src/guard.js',
      content: 'export const value = 2;\n',
      expectedVersion: ownerRead.result.version,
    },
    principal: owner,
    source: 'test.owner',
  });
  assert.equal(ownerWrite.ok, true);

  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'workspace.write',
      operation: 'write',
      args: { op: 'write', path: 'src/guard.js', content: 'agent without read\n' },
      agentId: agent.id,
      source: 'test.agent',
    }),
    (err) => err.status === 409 && /必须先读取/.test(err.message),
  );
  const agentRead = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.read',
    operation: 'file',
    args: { op: 'file', path: 'src/guard.js' },
    agentId: agent.id,
    source: 'test.agent',
  });
  const system = {
    kind: 'system',
    id: 'orchestrator',
    name: 'Orchestrator',
  };
  const orchestratorWrite = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.write',
    operation: 'write',
    args: { op: 'write', path: 'src/guard.js', content: 'export const value = 3;\n' },
    agentId: agent.id,
    principal: system,
    source: 'orchestrator',
  });
  assert.equal(orchestratorWrite.ok, true);
  await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.read',
    operation: 'file',
    args: { op: 'file', path: 'src/guard.js' },
    agentId: agent.id,
    source: 'test.agent',
  });
  const agentWrite = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.write',
    operation: 'write',
    args: { op: 'write', path: 'src/guard.js', content: 'export const value = 4;\n' },
    agentId: agent.id,
    source: 'test.agent',
  });
  assert.equal(agentWrite.ok, true, 'the agent read receipt follows its real identity');
  const postWriteRead = await toolGateway.invokeTool({
    taskId: task.id,
    toolId: 'workspace.read',
    operation: 'file',
    args: { op: 'file', path: 'src/guard.js' },
    agentId: agent.id,
    source: 'test.agent',
  });
  assert.equal(postWriteRead.result.content, 'export const value = 4;\n');

  fs.writeFileSync(
    path.join(task.workspace, 'src/guard.js'),
    'export const value = 5;\n',
  );
  await assert.rejects(
    toolGateway.invokeTool({
      taskId: task.id,
      toolId: 'workspace.write',
      operation: 'write',
      args: { op: 'write', path: 'src/guard.js', content: 'agent stale write\n' },
      agentId: agent.id,
      source: 'test.agent',
    }),
    (err) => err.status === 409 && /读取后已被修改/.test(err.message),
  );
  assert.equal(agentRead.result.version, ownerWrite.result.version);

  const events = store.getTask(task.id).events;
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool.call.end' &&
        event.data.tool === 'workspace.write' &&
        event.data.status === 'error' &&
        event.data.statusCode === 409,
    ),
    'conflicts must be visible in the run audit',
  );
  store.removeTask(task.id);
});
