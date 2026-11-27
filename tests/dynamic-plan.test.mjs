import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-dynamic-plan-'));
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'dynamic-plan-agent.mjs',
);
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { startTask, repairPathsFor } = await import('../server/orchestrator.mjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  store.flush();
  await wait(250);
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    // Windows may briefly retain workspace directories after child processes exit.
  }
});

function configureFixtureAgents() {
  const roles = ['planner', 'architect', 'coder', 'tester', 'reviewer'];
  const saved = [];
  for (const role of roles) {
    const agent = store.findAgentByRole(role);
    saved.push({
      id: agent.id,
      mode: agent.mode,
      cli: { ...agent.cli },
      seat: agent.seat,
      providerId: agent.providerId,
    });
    store.updateAgent(agent.id, {
      mode: 'cli',
      providerId: 'local-default',
      cli: {
        command: process.execPath,
        args: [fixture],
      },
    });
  }
  return saved;
}

function restoreAgents(saved) {
  for (const agent of saved) {
    store.updateAgent(agent.id, {
      mode: agent.mode,
      cli: agent.cli,
      seat: agent.seat,
      providerId: agent.providerId,
    });
  }
}

function addSecondCoder() {
  return store.addAgent({
    name: 'Kilo Pool',
    role: 'coder',
    title: 'Implementation pool',
    seat: false,
    mode: 'cli',
    providerId: 'local-default',
    cli: {
      command: process.execPath,
      args: [fixture],
    },
  });
}

function configureTestCommand(task) {
  fs.writeFileSync(
    path.join(task.workspace, 'package.json'),
    JSON.stringify({ scripts: { test: 'node tests/core.test.js' } }, null, 2),
  );
}

test('真实 CLI 规划输出生成动态 DAG，双 coder 产物归属正确工序', async () => {
  const saved = configureFixtureAgents();
  const secondCoder = addSecondCoder();
  const previous = {
    debateEnabled: store.db.settings.debateEnabled,
    dynamicPlanEnabled: store.db.settings.dynamicPlanEnabled,
    maxRepairRounds: store.db.settings.maxRepairRounds,
  };
  store.updateSettings({
    debateEnabled: false,
    dynamicPlanEnabled: true,
    maxRepairRounds: 0,
  });
  try {
    const task = store.createTask({ goal: '动态计划双模块夹具', debate: 'direct' });
    configureTestCommand(task);
    const ok = await startTask(task.id, { speed: 1000 });
    const done = store.getTask(task.id);

    assert.equal(
      ok,
      true,
      done.error || done.plan.map((step) => `${step.id}:${step.status}`).join(','),
    );
    assert.deepEqual(
      done.plan.map((step) => step.id),
      ['debate', 'plan', 'core', 'api', 'tests', 'review'],
    );
    const coreStep = done.plan.find((step) => step.id === 'core');
    const apiStep = done.plan.find((step) => step.id === 'api');
    assert.equal(coreStep.status, 'done');
    assert.equal(apiStep.status, 'done');
    assert.notEqual(coreStep.agentId, apiStep.agentId, '两个 coder 工序应分配给不同 Agent');
    assert.deepEqual(
      new Set([coreStep.agentId, apiStep.agentId]),
      new Set([store.findAgentByRole('coder').id, secondCoder.id]),
    );
    assert.equal(done.plan.find((step) => step.id === 'review').status, 'done');

    const core = done.artifacts.find((artifact) => artifact.path === 'src/core.js');
    const api = done.artifacts.find((artifact) => artifact.path === 'src/api.js');
    assert.equal(core?.stepId, 'core');
    assert.equal(api?.stepId, 'api');
    assert.ok(core?.executionId, 'artifact must retain the execution that produced it');
    assert.ok(api?.executionId, 'artifact must retain the execution that produced it');
    assert.notEqual(core.executionId, api.executionId);
    assert.ok(
      done.messages.some(
        (message) => message.stepId === 'core' && message.executionId === core.executionId,
      ),
      'CLI message must carry the execution context',
    );
    assert.ok(
      done.events.some(
        (event) => event.stepId === 'api' && event.executionId === api.executionId,
      ),
      'CLI events must carry the execution context',
    );
    assert.ok(
      done.fileChanges.some(
        (change) => change.path === 'src/core.js' && change.executionId === core.executionId,
      ),
      'file changes must carry the execution context',
    );
    assert.match(fs.readFileSync(path.join(done.workspace, 'src/core.js'), 'utf8'), /core/);
    assert.match(fs.readFileSync(path.join(done.workspace, 'src/api.js'), 'utf8'), /api/);
    assert.ok(done.events.some((event) => event.type === 'plan.generated'));
    assert.equal(done.events.some((event) => event.type === 'plan.fallback'), false);
  } finally {
    store.removeAgent(secondCoder.id);
    restoreAgents(saved);
    store.updateSettings(previous);
  }
});

test('非法规划 JSON 保留模板计划并写入 plan.fallback', async () => {
  const saved = configureFixtureAgents();
  const planner = store.findAgentByRole('planner');
  const before = { cli: { ...planner.cli }, mode: planner.mode };
  const previous = {
    debateEnabled: store.db.settings.debateEnabled,
    dynamicPlanEnabled: store.db.settings.dynamicPlanEnabled,
    maxRepairRounds: store.db.settings.maxRepairRounds,
  };
  store.updateAgent(planner.id, {
    mode: 'cli',
    cli: {
      command: process.execPath,
      args: [
        '-e',
        "console.log('说明\\n```json\\n{\"steps\":[]}\\n```\\n下一步建议：回退')",
      ],
    },
  });
  store.updateSettings({
    debateEnabled: false,
    dynamicPlanEnabled: true,
    maxRepairRounds: 0,
  });
  try {
    const task = store.createTask({ goal: '非法动态计划回退夹具', debate: 'direct' });
    configureTestCommand(task);
    const ok = await startTask(task.id, { speed: 1000 });
    const done = store.getTask(task.id);
    assert.equal(ok, true, done.error || 'fallback task should complete');
    assert.equal(done.plan.find((step) => step.id === 'implement').status, 'done');
    assert.ok(done.events.some((event) => event.type === 'plan.fallback'));
    assert.equal(done.events.some((event) => event.type === 'plan.generated'), false);
  } finally {
    store.updateAgent(planner.id, before);
    restoreAgents(saved.filter((agent) => agent.id !== planner.id));
    store.updateSettings(previous);
  }
});

test('返工路径聚合全部 coder/tester 真实产物，并拒绝越界与重复路径', () => {
  const task = {
    goal: '返工路径',
    plan: [
      {
        id: 'core',
        role: 'coder',
        status: 'done',
        agentId: 'coder-a',
        outputPaths: ['src/core.js', 'src/core.js', '../escape.js'],
      },
      {
        id: 'api',
        role: 'coder',
        status: 'done',
        agentId: 'coder-b',
        outputPaths: ['src/api.js'],
      },
      {
        id: 'tests',
        role: 'tester',
        status: 'done',
        agentId: 'tester-a',
        outputPaths: ['tests/core.test.js'],
      },
    ],
    artifacts: [
      { path: 'src/core.js', stepId: 'core', agentId: 'coder-a', status: '' },
      { path: 'src/api.js', stepId: 'api', agentId: 'coder-b', status: '' },
      { path: 'tests/core.test.js', stepId: 'tests', agentId: 'tester-a', status: '' },
      { path: 'C:/outside.js', stepId: 'core', agentId: 'coder-a', status: '' },
      { path: '.git/config', stepId: 'core', agentId: 'coder-a', status: '' },
    ],
  };
  assert.deepEqual(repairPathsFor(task, {
    text: 'Fix src/api.js and src/core.js; ignore ../../outside.js',
  }), ['src/api.js', 'src/core.js', 'tests/core.test.js']);
});

test('真实 CLI 首评失败后会修复两个模块并回归复评通过', async () => {
  const saved = configureFixtureAgents();
  const secondCoder = addSecondCoder();
  const previous = {
    debateEnabled: store.db.settings.debateEnabled,
    dynamicPlanEnabled: store.db.settings.dynamicPlanEnabled,
    maxRepairRounds: store.db.settings.maxRepairRounds,
    maxAutoReplans: store.db.settings.maxAutoReplans,
  };
  store.updateSettings({
    debateEnabled: false,
    dynamicPlanEnabled: true,
    maxRepairRounds: 1,
    maxAutoReplans: 0,
  });
  try {
    const task = store.createTask({ goal: '动态计划返工夹具', debate: 'direct' });
    configureTestCommand(task);
    const ok = await startTask(task.id, { speed: 1000 });
    const done = store.getTask(task.id);

    assert.equal(ok, true, done.error || done.plan.map((step) => `${step.id}:${step.status}`).join(','));
    const fix = done.plan.find((step) => step.id === 'fix-1');
    const retest = done.plan.find((step) => step.id === 'retest-1');
    assert.deepEqual(
      new Set(fix.outputPaths),
      new Set(['src/core.js', 'src/api.js', 'tests/core.test.js']),
    );
    assert.ok(fix.outputPaths.includes('tests/core.test.js'));
    assert.ok(retest.outputPaths.includes('tests/core.test.js'));
    assert.equal(done.plan.find((step) => step.id === 'review').verdict, 'fail');
    assert.equal(done.plan.find((step) => step.id === 're-review-1').verdict, 'pass');
    assert.equal(done.status, 'done');
    assert.match(fs.readFileSync(path.join(done.workspace, 'src/core.js'), 'utf8'), /repaired/);
    assert.match(fs.readFileSync(path.join(done.workspace, 'src/api.js'), 'utf8'), /repaired/);
    assert.ok(
      done.events.some(
        (event) => event.type === 'quality.gate.passed' && event.stepId === 're-review-1',
      ),
    );
  } finally {
    store.removeAgent(secondCoder.id);
    restoreAgents(saved);
    store.updateSettings(previous);
  }
});
