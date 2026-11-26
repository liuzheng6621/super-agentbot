import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-debate-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const {
  selectDebateRoster,
  parseProposalScores,
  rankProposals,
  stepAgentCandidates,
  isUsableProposalText,
  isCompleteProposalText,
  isCompleteCritiqueText,
  isCompleteStepText,
  isCompleteSummaryText,
  isCompleteDecisionText,
  shouldRetryCliResult,
  CLI_TIMEOUTS,
  chat,
} = await import('../server/orchestrator.mjs');
const { classifyCliExit, normalizeCliArgs, spawnCli } = await import('../server/adapters.mjs');

test('评分解析支持表格与行内写法，并排除自己的方案', () => {
  const text = [
    '| 方案 | 评分 | 关键理由 | 硬伤 |',
    '|------|------|----------|------|',
    '| A | 8 | 契约清楚 | 偏重 |',
    '| **B** | 7.5 | 最快 | 结构弱 |',
    '',
    '方案 C：9',
  ].join('\n');

  assert.deepEqual(parseProposalScores(text), { A: 8, B: 7.5, C: 9 });
  assert.deepEqual(parseProposalScores(text, { selfId: 'A' }), { B: 7.5, C: 9 });
  assert.deepEqual(parseProposalScores('没有评分'), {});
  // 超范围与重复编号不应污染结果
  assert.deepEqual(parseProposalScores('| A | 99 | 越界 |\n方案 B：0'), {});
});

test('评分解析兼容 CLI 常见的等号、分值和十等分写法', () => {
  assert.deepEqual(parseProposalScores('评分：A=7, B=8, C=7'), { A: 7, B: 8, C: 7 });
  assert.deepEqual(parseProposalScores('- **A**：8分\n- B方案 7/10\n- 方案 C 9分'), {
    A: 8,
    B: 7,
    C: 9,
  });
  assert.deepEqual(parseProposalScores('A（7分）\nB - 8/10\n| 方案 C | 9/10 |'), {
    A: 7,
    B: 8,
    C: 9,
  });
  assert.deepEqual(parseProposalScores('A=7, B=8, C=7', { selfId: 'B' }), { A: 7, C: 7 });
  assert.deepEqual(parseProposalScores('A=11, B=0, C=6.5'), { C: 6.5 });
});

test('排名按平均分、票数依次比较，未评分与失败方案排在后面', () => {
  const ranking = rankProposals([
    { id: 'A', name: 'Forge', angleKey: 'contract', status: 'done', votes: [{ score: 7 }, { score: 8 }] },
    { id: 'B', name: 'Kilo', angleKey: 'mvp', status: 'done', votes: [{ score: 9 }, { score: 9 }] },
    { id: 'C', name: 'Probe', angleKey: 'test-first', status: 'done', votes: [] },
    { id: 'D', name: 'Lens', angleKey: 'risk-first', status: 'failed', votes: [] },
  ]);

  assert.deepEqual(ranking.map((p) => p.id), ['B', 'A', 'C']);
  assert.equal(ranking[0].average, 9);
  assert.equal(ranking[2].average, null);
  assert.equal(ranking[0].angleLabel, '最小闭环');
});

test('讨论组优先执行席位，并纳入工具池 CLI，主持人除外', () => {
  const planner = store.findAgentByRole('planner');
  const pool = store.addAgent({
    name: 'Codex',
    role: 'coder',
    mode: 'cli',
    cli: { command: 'codex' },
  });
  assert.equal(pool.seat, false, '同角色重名 CLI 应进入工具池');

  const roster = selectDebateRoster(planner, { size: 5, poolSeats: 1 });
  assert.equal(roster.length, 5);
  assert.ok(!roster.some((a) => a.id === planner.id), '主持人不应参与提案');
  assert.ok(roster.some((a) => a.id === pool.id), '工具池 CLI 应进入讨论组');
  assert.equal(new Set(roster.map((a) => a.role)).size, 4, '席位角色不重复');

  const forced = selectDebateRoster(planner, { size: 5, poolSeats: 1 }, [
    pool.id,
    store.findAgentByRole('tester').id,
  ]);
  assert.ok(forced.some((a) => a.id === pool.id));
  assert.ok(forced.some((a) => a.id === store.findAgentByRole('tester').id));
  assert.ok(!forced.some((a) => a.id === planner.id));
});

test('CLI 故障分类和可重试判断能区分 Windows 初始化失败与业务退出', () => {
  assert.equal(classifyCliExit(0).kind, 'ok');
  assert.equal(classifyCliExit({ code: 3221225794 }).kind, 'windows-init');
  assert.equal(classifyCliExit({ code: 3221225794 }).retryable, true);
  assert.equal(classifyCliExit({ code: -3, timedOut: true }).kind, 'timeout');
  assert.equal(classifyCliExit({ code: 1073807364 }).kind, 'terminated');
  assert.equal(shouldRetryCliResult({ code: 3221225794 }), true);
  assert.equal(shouldRetryCliResult({ code: 7 }), false);
  assert.equal(shouldRetryCliResult({ code: 7, stderr: '429 rate limit' }), true);
});

test('讨论超时预算覆盖真实 CLI 的长推理，不再沿用 150 秒假超时', () => {
  assert.ok(CLI_TIMEOUTS.proposal >= 300000);
  assert.ok(CLI_TIMEOUTS.critique >= 300000);
  assert.ok(CLI_TIMEOUTS.decision >= 180000);
  assert.ok(CLI_TIMEOUTS.step >= 600000);
  assert.ok(CLI_TIMEOUTS.qualityGate >= 180000);
});

test('Gemini 自动切换 headless，Trae 自动限制步数，其他 CLI 参数保持不变', () => {
  assert.deepEqual(normalizeCliArgs('gemini', ['--skip-trust', '--approval-mode', 'yolo']), [
    '--skip-trust',
    '--approval-mode',
    'yolo',
    '--prompt=',
  ]);
  assert.deepEqual(normalizeCliArgs('C:\\tools\\gemini.cmd', ['--prompt=']), ['--prompt=']);
  assert.deepEqual(normalizeCliArgs('trae-cli', ['run', '--config-file', 'config.json']), [
    'run',
    '--console-type',
    'simple',
    '--max-steps',
    '16',
    '--config-file',
    'config.json',
  ]);
  assert.deepEqual(
    normalizeCliArgs('trae-cli', ['run', '--max-steps', '4', '--console-type', 'rich']),
    ['run', '--max-steps', '4', '--console-type', 'rich'],
  );
  assert.deepEqual(normalizeCliArgs('codex', ['exec', '--skip-git-repo-check']), [
    'exec',
    '--skip-git-repo-check',
  ]);
});

test('CLI 输出满足完整条件后，静默窗口结束就收口而不等进程退出', async () => {
  const started = Date.now();
  const res = await spawnCli(
    {
      cli: {
        command: process.execPath,
        args: ['-e', "process.stdout.write('READY'); setInterval(() => {}, 1000);"],
      },
    },
    'ignored',
    {
      cwd: temp,
      timeout: 5000,
      completeWhen: (text) => text.includes('READY'),
      settleMs: 80,
    },
  );
  assert.equal(res.code, 0);
  assert.equal(res.settledEarly, true);
  assert.match(res.stdout, /READY/);
  assert.ok(Date.now() - started < 3000);
});

test('完整提案要求 400 字和五个规定标题，完整质询要求所有方案评分与选择行', () => {
  const proposal = [
    '# 核心主张',
    '这是一段足够长的方案说明。'.repeat(30),
    '# 技术路线',
    '模块、存储和错误处理。'.repeat(20),
    '# 落地工序',
    '工序、负责人、产出和依赖。'.repeat(20),
    '# 代价与风险',
    '风险和代价。'.repeat(20),
    '# 工作量估计',
    '约 2 人日。',
  ].join('\n');
  assert.equal(isCompleteProposalText(proposal), true);
  assert.equal(isCompleteProposalText(proposal.replace('# 工作量估计', '# 其他')), false);
  const boldProposal = proposal
    .replace('# 核心主张', '**核心主张**')
    .replace('# 技术路线', '**技术路线**')
    .replace('# 落地工序', '**落地工序**')
    .replace('# 代价与风险', '**代价与风险**')
    .replace('# 工作量估计', '**工作量**');
  assert.equal(isCompleteProposalText(boldProposal), true);

  const critique = [
    '| 方案 | 评分 | 关键理由 | 硬伤 |',
    '| A | 7 | 结构清楚 | 范围偏大 |',
    '| B | 8 | 最小闭环 | 测试不足 |',
    '选择：B。',
  ].join('\n');
  assert.equal(isCompleteCritiqueText(critique, ['A', 'B']), true);
  assert.equal(isCompleteCritiqueText(critique, ['A', 'B', 'C']), false);
  assert.equal(isCompleteCritiqueText(critique.replace('选择：B。', '继续分析'), ['A', 'B']), false);
});

test('步骤、交付收口和裁决都能识别完整结尾，避免进程挂住后一直等超时', () => {
  assert.equal(
    isCompleteStepText('已完成实现，文件已写入。\n下一步建议：运行回归测试。', 'coder'),
    true,
  );
  assert.equal(
    isCompleteStepText('已完成评审，没有 Blocker。\nVERDICT: PASS', 'reviewer'),
    true,
  );
  assert.equal(isCompleteStepText('还差最后一步', 'coder'), false);
  assert.equal(
    isCompleteSummaryText(
      `# 交付结论\n\n任务已完成。${'补充说明。'.repeat(40)}\n\n## 需要用户拍板的 3 件事\n\n1. 是否合入。\n2. 是否保留文档。\n3. 是否继续优化。`,
    ),
    true,
  );
  assert.equal(
    isCompleteDecisionText(
      `采纳方案 A，因为它先冻结契约。${'补充说明。'.repeat(20)}\n\n## 实施硬约束\n1. 不改接口。\n2. 先补测试。\n3. 分批提交。`,
    ),
    true,
  );
});

test('部分方案输出只有在结构足够完整时才允许继续', () => {
  const complete = [
    '# 核心主张',
    '这是一段足够长的方案说明。'.repeat(20),
    '# 技术路线',
    '模块、存储和错误处理。'.repeat(12),
    '# 落地工序',
    '工序、负责人、产出和依赖。'.repeat(12),
  ].join('\n');
  assert.equal(isUsableProposalText(complete), true);
  assert.equal(isUsableProposalText('# 核心主张\n# 技术路线\n'.repeat(10)), false);
  assert.equal(isUsableProposalText('太短'), false);
});

test('执行回退按 CLI 命令去重，且 CLI 任务不会静默落到模拟成员', () => {
  const alpha = store.addAgent({
    name: '回退测试 Alpha',
    role: 'coder',
    mode: 'cli',
    cli: { command: 'C:\\tools\\retry-test-alpha.cmd', args: ['-p', '{{prompt}}'] },
  });
  const duplicate = store.addAgent({
    name: '回退测试 Alpha 重复项',
    role: 'coder',
    mode: 'cli',
    cli: { command: 'C:/tools/retry-test-alpha.exe', args: ['-p', '{{prompt}}'] },
  });
  const beta = store.addAgent({
    name: '回退测试 Beta',
    role: 'coder',
    mode: 'cli',
    cli: { command: 'retry-test-beta', args: ['-p', '{{prompt}}'] },
  });
  const broken = store.addAgent({
    name: '回退测试 Broken',
    role: 'coder',
    mode: 'cli',
    cli: { command: '', args: [] },
  });

  const candidates = stepAgentCandidates({ role: 'coder' }, alpha);
  assert.ok(candidates.some((a) => a.id === alpha.id));
  assert.ok(!candidates.some((a) => a.id === duplicate.id));
  assert.ok(candidates.some((a) => a.id === beta.id));
  assert.ok(!candidates.some((a) => a.id === broken.id));
  assert.ok(candidates.every((a) => a.mode === 'cli' && a.cli.command));

  const onlyCli = stepAgentCandidates({ role: 'coder' }, broken);
  assert.ok(onlyCli.length > 0);
  assert.ok(onlyCli.every((a) => a.mode === 'cli' && a.cli.command));
});

test('真实 CLI 调用失败后按 Provider 路由切换到备用网关', async () => {
  const primary = store.addProvider({
    id: 'fallback-primary',
    name: 'Fallback Primary',
    kind: 'cli-native',
    cliBindings: {
      node: {
        args: ['-e', "process.stderr.write('PRIMARY_FAILED'); process.exit(1)"],
      },
    },
  });
  const backup = store.addProvider({
    id: 'fallback-backup',
    name: 'Fallback Backup',
    kind: 'cli-native',
    cliBindings: {
      node: {
        args: ['-e', "process.stdout.write('BACKUP_OK')"],
      },
    },
  });
  const agent = store.addAgent({
    name: 'RouteFallbackAgent',
    role: 'coder',
    mode: 'cli',
    providerId: primary.id,
    fallbackProviderIds: [backup.id],
    cli: { command: process.execPath, args: ['-e', 'process.exit(2)'] },
  });
  const task = store.createTask({ goal: 'provider fallback integration' });

  try {
    const ok = await chat(task.id, '@RouteFallbackAgent ping');
    assert.equal(ok, true);
    const events = store.getTask(task.id).events;
    assert.ok(
      events.some(
        (event) =>
          event.type === 'provider.fallback' &&
          event.data.fromProviderId === primary.id &&
          event.data.toProviderId === backup.id,
      ),
    );
    const message = store
      .getTask(task.id)
      .messages.find((item) => item.agentId === agent.id && item.kind === 'text');
    assert.match(message.text, /BACKUP_OK/);
    assert.equal(message.meta.providerFallback, true);
    assert.equal(message.meta.providerId, backup.id);
  } finally {
    store.removeAgent(agent.id);
    store.removeProvider(primary.id);
    store.removeProvider(backup.id);
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
