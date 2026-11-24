import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-debate-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { selectDebateRoster, parseProposalScores, rankProposals } = await import('../server/orchestrator.mjs');

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

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 上偶发占用，交给系统清理 */
  }
});
