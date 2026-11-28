import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-forgery-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { store } = await import('../server/store.mjs');
const { detectTestCommand, isTrivialTestScript, testEvidence } = await import(
  '../server/test-entry.mjs'
);
const { runQualityGate, qualityGateAllowsDelivery } = await import('../server/orchestrator.mjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-forgery-ws-'));

after(() => {
  for (const dir of [temp, scratch]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows may keep a handle briefly. */
    }
  }
});

function workspace(name, files) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

test('trivial test scripts are not accepted as a test entry', () => {
  assert.equal(isTrivialTestScript('exit 0'), true);
  assert.equal(isTrivialTestScript('exit 0 '), true);
  assert.equal(isTrivialTestScript('true'), true);
  assert.equal(isTrivialTestScript(':'), true);
  assert.equal(isTrivialTestScript('echo "ok"'), true);
  assert.equal(isTrivialTestScript('echo done && exit 0'), true);
  assert.equal(isTrivialTestScript('no test specified'), true);
  assert.equal(isTrivialTestScript('node --test tests/'), false);
  assert.equal(isTrivialTestScript('jest --ci'), false);

  const trivial = workspace('trivial', {
    'package.json': JSON.stringify({ scripts: { test: 'exit 0' } }),
  });
  assert.equal(detectTestCommand({ workspace: trivial }), null, 'exit 0 不能算测试入口');
});

test('runner output must contain pass/fail evidence', () => {
  const nodeOk = testEvidence('# tests 3\n# pass 3\n# fail 0\nok 1 - a');
  assert.equal(nodeOk.hasEvidence, true);
  assert.equal(nodeOk.failed, 0);
  assert.equal(nodeOk.passed, 3);

  const nodeFail = testEvidence('not ok 1 - b\n# pass 1\n# fail 1');
  assert.equal(nodeFail.hasEvidence, true);
  assert.equal(nodeFail.failed, 1);

  const python = testEvidence('===== 3 passed in 0.12s =====');
  assert.equal(python.hasEvidence, true);

  const silent = testEvidence('hello world');
  assert.equal(silent.hasEvidence, false);
});

test('exit 0 without evidence fails closed and does not allow delivery', async () => {
  const silent = workspace('silent-pass', {
    'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  });
  const task = store.createTask({ goal: '无证据通过', workspace: silent });
  const quality = await runQualityGate(task, { round: 0 }, new AbortController().signal);
  assert.equal(quality.status, 'failed');
  assert.equal(quality.reason?.includes('证据') || quality.code === 'no-test-evidence', true);
  assert.equal(qualityGateAllowsDelivery(quality), false);

  const real = workspace('real-pass', {
    'package.json': JSON.stringify({
      scripts: { test: 'node -e "console.log(\'# pass 2\');console.log(\'# fail 0\')"' },
    }),
  });
  const okTask = store.createTask({ goal: '真实通过', workspace: real });
  const passed = await runQualityGate(okTask, { round: 0 }, new AbortController().signal);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.evidence.failed, 0);
});

test('quality gate reports when no test file was touched', async () => {
  const root = workspace('scope', {
    'package.json': JSON.stringify({
      scripts: { test: 'node -e "console.log(\'# pass 1\');console.log(\'# fail 0\')"' },
    }),
    'tests/sample.test.mjs': "import test from 'node:test';\ntest('x', () => {});\n",
  });
  const task = store.createTask({ goal: '只改源码', workspace: root });
  store.addFileChange(task.id, { path: 'src/app.mjs', status: 'M' });
  const quality = await runQualityGate(store.getTask(task.id), { round: 0 }, new AbortController().signal);
  assert.equal(quality.status, 'passed');
  assert.equal(quality.scope.status, 'no-test-file-changed');
  assert.deepEqual(quality.scope.changedFiles, ['src/app.mjs']);

  store.addFileChange(task.id, { path: 'tests/sample.test.mjs', status: 'M' });
  const covered = await runQualityGate(store.getTask(task.id), { round: 0 }, new AbortController().signal);
  assert.equal(covered.scope.status, 'tests-touched');
});

test('quality gate subprocess does not inherit provider secrets', async () => {
  const root = workspace('env', {
    'package.json': JSON.stringify({
      scripts: {
        test:
          'node -e "console.log(\'# pass 1\');console.log(\'# fail 0\');console.log((process.env.OPENAI_API_KEY||\'clean\'))"',
      },
    }),
  });
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-should-not-leak';
  try {
    const task = store.createTask({ goal: '环境隔离', workspace: root });
    const quality = await runQualityGate(task, { round: 0 }, new AbortController().signal);
    assert.equal(quality.status, 'passed');
    assert.equal(String(quality.stdout).includes('sk-should-not-leak'), false, '密钥不能进入测试子进程');
    assert.equal(String(quality.stdout).includes('clean'), true);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
