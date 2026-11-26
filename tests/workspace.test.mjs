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

  writeWorkspaceEntry(task, 'src/app.js', 'export const answer = 42;\n');
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
