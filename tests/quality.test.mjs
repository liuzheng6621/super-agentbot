import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-quality-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const {
  detectTestCommand,
  pickAgent,
  isSelfReview,
  reviewIndependenceFor,
  recordReviewIndependence,
  buildContextPack,
  runQualityGate,
  qualityGateAllowsDelivery,
  isTransientCliError,
  scanStats,
  workMsOf,
} = await import('../server/orchestrator.mjs');

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(temp, 'ws-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return { id: 'probe', goal: '做一个待办 API', workspace: dir };
}

test('只有上游瞬时故障才重试，真实失败照旧上报', () => {
  assert.equal(isTransientCliError('Error: Transport: ECONNRESET: The socket connection was closed unexpectedly.'), true);
  assert.equal(isTransientCliError('fetch failed: ETIMEDOUT'), true);
  assert.equal(isTransientCliError('429 Too Many Requests'), true);
  assert.equal(isTransientCliError('socket hang up'), true);
  assert.equal(isTransientCliError('Error: Upstream request failed: Model is unavailable.'), true);
  assert.equal(isTransientCliError('HTTP 502 Bad Gateway'), true);
  assert.equal(isTransientCliError('Error: Cannot find module "express"'), false);
  assert.equal(isTransientCliError('error: no test specified'), false);
  assert.equal(isTransientCliError(''), false);
  assert.equal(isTransientCliError(undefined), false);
});

test('测试入口探测按 npm / Makefile / pytest 优先级执行', () => {
  const npm = detectTestCommand(
    workspace({ 'package.json': JSON.stringify({ scripts: { test: 'node --test tests/' } }) }),
  );
  assert.equal(npm.command, 'npm');
  assert.match(npm.source, /scripts\.test/);

  const bomPackage = detectTestCommand(
    workspace({
      'package.json': `\uFEFF${JSON.stringify({ scripts: { test: 'node --test tests/' } })}`,
    }),
  );
  assert.equal(bomPackage.command, 'npm', 'PowerShell UTF-8 BOM must not hide the test entry');

  const allConfigured = detectTestCommand(
    workspace({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      Makefile: 'test:\n\tnode --test\n',
      'pyproject.toml': '[tool.pytest.ini_options]\n',
    }),
  );
  assert.equal(allConfigured.command, 'npm', 'package.json scripts.test 优先');

  const makeAndPytest = detectTestCommand(
    workspace({
      Makefile: 'test:\n\tnode --test\n',
      'pyproject.toml': '[tool.pytest.ini_options]\n',
    }),
  );
  assert.equal(makeAndPytest.command, 'make', 'Makefile 优先于 pytest 配置');

  const placeholder = detectTestCommand(
    workspace({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }),
  );
  assert.equal(placeholder, null, '占位脚本不算测试入口');

  assert.equal(detectTestCommand(workspace({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })).command, 'python');
  assert.equal(detectTestCommand(workspace({ 'pyproject.toml': '[project]\nname = "x"\n' })), null);
  assert.equal(detectTestCommand(workspace({ 'pytest.ini': '[pytest]\n' })).command, 'python');
  assert.equal(detectTestCommand(workspace({ 'tox.ini': '[pytest]\n' })).command, 'python');
  assert.equal(detectTestCommand(workspace({ 'Cargo.toml': '[package]\n' })).command, 'cargo');
  assert.equal(detectTestCommand(workspace({ 'go.mod': 'module x\n' })).command, 'go');

  const nodeTests = detectTestCommand(workspace({ 'tests/a.test.js': '' }));
  assert.deepEqual(nodeTests.args, ['--test', 'tests/a.test.js']);
  assert.equal(nodeTests.command, process.execPath);

  const specOnly = detectTestCommand(workspace({ 'tests/unit/foo.spec.mjs': '' }));
  assert.deepEqual(specOnly.args, ['--test', 'tests/unit/foo.spec.mjs']);

  const nested = detectTestCommand(
    workspace({
      'tests/unit/foo.test.mjs': '',
      'tests/unit/bar.spec.cjs': '',
    }),
  );
  assert.deepEqual(nested.args, [
    '--test',
    'tests/unit/bar.spec.cjs',
    'tests/unit/foo.test.mjs',
  ]);

  assert.equal(detectTestCommand(workspace({ 'tests/notes.js': '' })), null, '非测试 JS 不算入口');
  assert.equal(detectTestCommand(workspace({ tests: 'not-a-directory' })), null, 'tests 文件不算目录');

  assert.equal(detectTestCommand(workspace({ 'README.md': '# 空' })), null, '什么都没有就必须返回 null');
});

test('评审员缺位时先退到测试员/架构师，只有 coder 时显式不可用', () => {
  const original = store.agents.map((a) => ({ id: a.id, seat: a.seat }));
  const seatOnly = (roles) => {
    for (const a of store.agents) a.seat = roles.includes(a.role);
  };
  try {
    seatOnly(['planner', 'architect', 'coder', 'tester', 'reviewer']);
    assert.equal(pickAgent('reviewer').role, 'reviewer');
    assert.notEqual(pickAgent('reviewer').role, 'coder', '正常多角色场景必须由独立评审席位执行');

    seatOnly(['planner', 'architect', 'coder', 'tester']);
    assert.equal(pickAgent('reviewer').role, 'tester', '没有评审席位时退到测试员');

    seatOnly(['planner', 'architect', 'coder']);
    assert.equal(pickAgent('reviewer').role, 'architect');

    seatOnly(['coder']);
    const only = pickAgent('reviewer');
    assert.equal(only, null, '只剩实现者时不能把 coder 当作 reviewer');
  } finally {
    for (const o of original) {
      const a = store.getAgent(o.id);
      if (a) a.seat = o.seat;
    }
  }
});

test('自审按 reviewerId 与 implementerId 判定，并在记录中带出双方身份', () => {
  const coder = store.findAgentByRole('coder');
  const tester = store.findAgentByRole('tester');
  const task = store.createTask({ goal: '评审独立性样本' });
  store.setPlan(task.id, [{ id: 'implement', title: '实现', role: 'coder', agentId: coder.id }]);
  store.updateStep(task.id, 'implement', { status: 'done' });

  const independent = reviewIndependenceFor(store.getTask(task.id), tester);
  assert.equal(independent.reviewerId, tester.id);
  assert.equal(independent.implementerId, coder.id);
  assert.equal(independent.selfReview, false, '不同成员是独立评审');

  const selfReviewAgent = { ...coder, role: 'tester' };
  assert.equal(isSelfReview('reviewer', selfReviewAgent, coder.id), true, '同一 ID 跨角色也必须标自审');
  assert.equal(isSelfReview('reviewer', tester, coder.id), false);

  const self = reviewIndependenceFor(store.getTask(task.id), selfReviewAgent);
  assert.equal(self.selfReview, true);
  assert.equal(self.reviewerId, coder.id);
  assert.equal(self.implementerId, coder.id);

  store.updateTask(task.id, { runId: 'run-self-review' });
  const step = store.getTask(task.id).plan[0];
  const recorded = recordReviewIndependence(store.getTask(task.id), step, selfReviewAgent);
  assert.equal(recorded.quality.selfReview, true);
  const saved = store.getTask(task.id);
  assert.equal(saved.quality.selfReview, true, 'run 级质量记录必须打标');
  assert.equal(saved.quality.reviewerId, coder.id);
  assert.equal(saved.plan[0].selfReview, true, '工序记录必须打标');
  assert.ok(saved.events.some((event) => event.type === 'review.independence' && event.data.selfReview));
  assert.equal(store.taskSummary(saved).quality.selfReview, true, '/api/state 的任务摘要可见');
});

test('上下文包可以直接复用目录快照，不再重复扫描', () => {
  const task = { id: 'ctx-task', goal: '看板', workspace: temp, status: 'running', mode: 'auto', plan: [], messages: [] };
  const before = scanStats.calls;
  const pack = buildContextPack(task, { files: [{ path: 'virtual.js', bytes: 10, mtimeMs: 1, mtimeNs: '1' }] });
  assert.equal(scanStats.calls, before, '传了快照就不该再扫目录');
  assert.deepEqual(
    pack.files.map((f) => f.path),
    ['virtual.js'],
  );

  buildContextPack(task);
  assert.equal(scanStats.calls, before + 1, '不传快照才扫一次');
});

test('质量门会真的跑工作区里的测试入口，找不到入口就报 no-test-entry', async () => {
  const signal = new AbortController().signal;

  const failing = store.createTask({
    goal: '质量门失败样本',
    workspace: workspace({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }) })
      .workspace,
  });
  const failed = await runQualityGate(failing, { round: 0 }, signal);
  assert.equal(failed.status, 'failed', '测试退出码非 0 必须判失败');
  assert.equal(failed.code, 1);
  assert.equal(store.getTask(failing.id).quality.status, 'failed', '结论要落库');

  const passing = store.createTask({
    goal: '质量门通过样本',
    workspace: workspace({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }) })
      .workspace,
  });
  const passed = await runQualityGate(passing, { round: 0 }, signal);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.code, 0);
  assert.match(passed.command, /npm test --silent/);
  assert.equal(typeof passed.elapsed, 'number');
  assert.ok(passed.stdout !== undefined);
  assert.ok(passed.stderr !== undefined);

  const empty = store.createTask({ goal: '没有测试入口', workspace: workspace({ 'README.md': '# 空' }).workspace });
  const missing = await runQualityGate(empty, { round: 0 }, signal);
  assert.equal(missing.status, 'no-test-entry', '找不到入口不能假装通过，也不能静默 skipped');
  assert.notEqual(missing.status, 'passed');
  assert.match(missing.reason, /没找到可执行的测试入口/);
  assert.equal(qualityGateAllowsDelivery(missing), false, '无入口不能让整体交付判通过');
  assert.equal(store.getTask(empty.id).quality.status, 'no-test-entry', '状态必须能从任务记录读取');
});

test('只有 CLI 成员时也会执行他们产出的测试文件，并记录真实命令、退出码与输出', async () => {
  const signal = new AbortController().signal;
  const ws = workspace({
    'tests/cli-generated.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('cli generated test really runs', () => {",
      "  console.log('CLI_GENERATED_TEST_OUTPUT');",
      '  assert.equal(2 + 2, 4);',
      '});',
      '',
    ].join('\n'),
  });
  const task = store.createTask({ goal: 'CLI 成员质量门样本', workspace: ws.workspace });
  const coder = store.findAgentByRole('coder');
  const tester = store.findAgentByRole('tester');
  const before = [coder, tester].map((agent) => ({ id: agent.id, mode: agent.mode, cli: { ...agent.cli } }));
  try {
    store.updateAgent(coder.id, { mode: 'cli', cli: { command: process.execPath, args: [] } });
    store.updateAgent(tester.id, { mode: 'cli', cli: { command: process.execPath, args: [] } });
    store.setPlan(task.id, [
      { id: 'implement', title: '实现', role: 'coder', agentId: coder.id },
      { id: 'test-design', title: '测试', role: 'tester', agentId: tester.id },
    ]);
    store.updateStep(task.id, 'implement', { status: 'done' });
    store.updateStep(task.id, 'test-design', { status: 'done' });

    const quality = await runQualityGate(store.getTask(task.id), { round: 0 }, signal);
    assert.equal(quality.cli, true, 'CLI 成员任务不能被当作模拟任务');
    assert.equal(quality.status, 'passed');
    assert.equal(quality.code, 0);
    assert.match(quality.command, /--test tests\//);
    assert.match(quality.command, /node/i);
    assert.ok(quality.elapsed >= 0, '耗时必须记录');
    assert.match(`${quality.stdout}\n${quality.stderr}`, /CLI_GENERATED_TEST_OUTPUT/);
    assert.equal(store.getTask(task.id).quality.command, quality.command, '真实命令必须落进任务记录');
  } finally {
    for (const item of before) {
      store.updateAgent(item.id, { mode: item.mode, cli: item.cli });
    }
  }
});

test('质量门真实超时会终止测试进程并留下可审计的失败记录', async () => {
  const signal = new AbortController().signal;
  const ws = workspace({
    'package.json': JSON.stringify({
      scripts: { test: 'node -e "console.log(\'GATE_TIMEOUT_MARKER\'); setTimeout(() => {}, 30000)"' },
    }),
  });
  const task = store.createTask({ goal: '质量门超时样本', workspace: ws.workspace });
  const coder = store.findAgentByRole('coder');
  const tester = store.findAgentByRole('tester');
  const before = { timeouts: { ...(coder.timeouts || {}) } };
  try {
    store.updateAgent(coder.id, { timeouts: { qualityGate: 30_000 } });
    // 质量门优先取最近完成的实现者；显式构造这道工序，避免继承其他测试留下的计划。
    store.setPlan(task.id, [
      { id: 'implement', title: '实现', role: 'coder', agentId: coder.id },
      { id: 'test-design', title: '测试', role: 'tester', agentId: tester?.id || coder.id },
    ]);
    store.updateStep(task.id, 'implement', { status: 'done' });
    store.updateStep(task.id, 'test-design', { status: 'done' });
    const quality = await runQualityGate(store.getTask(task.id), { round: 0 }, signal);
    assert.equal(quality.status, 'timeout', '超时必须显式落库，不能当作通过');
    assert.equal(quality.timedOut, true);
    assert.equal(quality.code, -3);
    assert.equal(quality.timeout, 30_000);
    assert.match(quality.stdout, /GATE_TIMEOUT_MARKER/);
    assert.match(quality.stderr, /\[超时\]/);
    assert.ok(quality.elapsed >= 30_000, '必须记录真实耗时');
    assert.equal(qualityGateAllowsDelivery(quality), false, '超时不得放行交付');

    const saved = store.getTask(task.id);
    assert.equal(saved.quality.status, 'timeout');
    assert.equal(saved.quality.command, quality.command);
    assert.ok(
      saved.messages.some((message) => message.kind === 'quality' && /超时/.test(message.text)),
      '质量门消息必须写明超时',
    );
    assert.ok(
      saved.events.some(
        (event) =>
          event.type === 'quality.gate.timeout' &&
          event.data?.code === -3 &&
          event.data?.elapsed >= 30_000,
      ),
      '超时必须写入任务事件，供状态接口和导出消费',
    );
  } finally {
    store.updateAgent(coder.id, { timeouts: before.timeouts });
  }
});

test('workMsOf 只累加真实工序耗时，不拿墙钟冒充', () => {
  assert.equal(workMsOf(undefined), 0);
  assert.equal(workMsOf({ plan: [] }), 0);
  assert.equal(
    workMsOf({
      plan: [
        { startedAt: 1000, endedAt: 1500 },
        { startedAt: 2000, endedAt: 2600 },
        { startedAt: 3000, status: 'pending' },
        { startedAt: 4000, endedAt: 3900 },
      ],
    }),
    1100,
    '只算结束过的工序，未结束与倒挂的跨度都不计入',
  );
});

test('token 账必须算输入，不能只算输出', () => {
  const task = store.createTask({ goal: 'token 记账样本', workspace: workspace({ 'a.txt': 'x' }).workspace });
  assert.equal(task.stats.tokensIn, 0, '新任务输入计数从 0 开始');
  const agent = store.agents[0];

  store.countPrompt(task.id, agent?.id, 1200);
  const msg = store.addMessage(task.id, {
    agentId: agent?.id || '',
    name: 'probe',
    role: 'coder',
    title: '实现工程师',
    kind: 'text',
    text: '',
  });
  store.appendMessage(task.id, msg.id, '一二三四五');

  const stats = store.getTask(task.id).stats;
  assert.equal(stats.tokensIn, 1200, '发出去的提示词必须入账');
  assert.equal(stats.tokensOut, 5, '输出按 CJK 一字一 token 估算');
  assert.equal(stats.tokens, 1205, '累计 = 输入 + 输出');
});

test('Provider 用量账本按 run 记录真实归属，未知成本保持 null', async () => {
  const task = store.createTask({ goal: 'provider usage ledger' });
  store.updateTask(task.id, { runId: 'run-usage-1' });
  const agent = store.findAgentByRole('coder');
  const entry = store.recordProviderUsage(task.id, {
    providerId: 'local-default',
    model: 'local-model',
    runId: 'run-usage-1',
    agentId: agent.id,
    tokensIn: 321,
    tokensOut: 123,
    cost: null,
    source: 'cli',
    usageSource: 'estimate',
    attempt: 1,
    routeIndex: 0,
    code: 0,
    elapsedMs: 45,
  });

  assert.equal(entry.taskId, task.id);
  assert.equal(entry.runId, 'run-usage-1');
  assert.equal(entry.providerId, 'local-default');
  assert.equal(entry.tokensIn, 321);
  assert.equal(entry.tokensOut, 123);
  assert.equal(entry.cost, null);
  assert.equal(entry.usageSource, 'estimate');

  const summary = store.taskSummary(store.getTask(task.id));
  assert.equal(summary.usage.entries, 1);
  assert.equal(summary.usage.tokensIn, 321);
  assert.equal(summary.usage.tokensOut, 123);
  assert.equal(summary.usage.cost, null, '没有价格配置时不能伪造 0 成本');

  store.flush();
  const saved = JSON.parse(
    fs.readFileSync(path.join(temp, 'db.json'), 'utf8'),
  ).tasks.find((item) => item.id === task.id);
  assert.equal(saved.usageLedger[0].runId, 'run-usage-1');
  assert.equal(saved.usageLedger[0].tokensOut, 123);
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 上偶发占用，交给系统清理 */
  }
});
