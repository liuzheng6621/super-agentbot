import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-roots-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { matchRoot, normalizeRoots, withinAnyRoot, withinRoot } = await import(
  '../server/path-roots.mjs'
);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-roots-projects-'));
const insideRoot = path.join(scratch, 'allowed');
const outsideRoot = path.join(scratch, 'outside');
const siblingPrefix = path.join(scratch, 'allowed-evil');
for (const dir of [insideRoot, outsideRoot, siblingPrefix]) fs.mkdirSync(dir, { recursive: true });

after(() => {
  for (const dir of [temp, scratch]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows may keep a handle briefly. */
    }
  }
});

test('path roots treat sibling prefixes and parent directories as outside', () => {
  const roots = normalizeRoots([insideRoot]);
  assert.equal(withinRoot(insideRoot, insideRoot), true);
  assert.equal(withinRoot(path.join(insideRoot, 'src', 'a.js'), insideRoot), true);
  assert.equal(withinRoot(siblingPrefix, insideRoot), false);
  assert.equal(withinRoot(path.dirname(insideRoot), insideRoot), false);
  assert.equal(matchRoot(siblingPrefix, roots), '');
  assert.equal(withinAnyRoot(path.join(insideRoot, 'x'), roots), true);
});

test('normalizeRoots accepts comma strings and drops duplicates', () => {
  const roots = normalizeRoots(`${insideRoot}, ${insideRoot} ,${outsideRoot}`);
  assert.deepEqual(roots, [path.resolve(insideRoot), path.resolve(outsideRoot)]);
});

test('external workspace is rejected outside workspaceRoots', () => {
  store.updateSettings({ workspaceRoots: [insideRoot] });
  const allowed = store.createTask({
    goal: '使用白名单内的工作区',
    workspace: insideRoot,
    isolation: 'direct',
  });
  assert.equal(allowed.external, true);
  assert.equal(path.resolve(allowed.workspace), path.resolve(insideRoot));

  assert.throws(
    () => store.createTask({ goal: '越界工作区', workspace: outsideRoot, isolation: 'direct' }),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'workspace-not-allowed');
      return true;
    },
  );

  assert.throws(
    () => store.createTask({ goal: '越界前缀', workspace: siblingPrefix, isolation: 'worktree' }),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'workspace-not-allowed');
      return true;
    },
  );
});

test('empty workspaceRoots keeps zero-config behaviour but still resolves the path', () => {
  store.updateSettings({ workspaceRoots: [] });
  const task = store.createTask({ goal: '未配置白名单', workspace: outsideRoot, isolation: 'direct' });
  assert.equal(task.external, true);
  assert.equal(path.resolve(task.workspace), path.resolve(outsideRoot));
});
