import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-debate-coverage-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { store } = await import('../server/store.mjs');
const { proposalDiversity, rankProposals } = await import('../server/debate-analysis.mjs');
const { recordDebateDiversity } = await import('../server/orchestrator.mjs');

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

function proposal(id, angleKey, text, score) {
  return {
    id,
    name: id,
    agentId: `agent-${id}`,
    angleKey,
    status: 'done',
    text,
    votes: [{ score }],
  };
}

test('duplicate proposals are penalised in ranking', () => {
  const duplicated = '相同的核心主张与技术路线，落地工序完全一致。'.repeat(12);
  const proposals = [
    proposal('p1', 'minimal', duplicated, 9),
    proposal('p2', 'minimal', duplicated, 9),
    proposal('p3', 'scalable', '另一条技术路线，强调可扩展与回滚。'.repeat(12), 8),
  ];
  const ranking = rankProposals(proposals);
  const p1 = ranking.find((item) => item.id === 'p1');
  assert.ok(p1.diversityPenalty > 0, '重复提案必须扣分');
  assert.equal(p1.effectiveScore, p1.average - p1.diversityPenalty);
  assert.equal(ranking[0].id, 'p3', '扣分后独立视角应排到前面');
});

test('angle coverage warning is computed and recorded as a task event', () => {
  const proposals = [
    proposal('a', 'minimal', '最小可行路线，先跑通主链路。'.repeat(8), 7),
    proposal('b', 'minimal', '另一份最小可行路线，措辞不同。'.repeat(8), 7),
    proposal('c', 'minimal', '第三份最小可行路线，仍然同一角度。'.repeat(8), 7),
  ];
  const diversity = proposalDiversity(proposals);
  assert.ok(diversity.issues.some((issue) => issue.code === 'angle-coverage-low'));
  assert.ok(diversity.angleCoverage < 1);

  const task = store.createTask({ goal: '角度覆盖事件' });
  const event = recordDebateDiversity(task.id, diversity);
  assert.ok(event, '警告必须写入任务事件');
  const saved = store.getTask(task.id);
  const recorded = saved.events.find((item) => item.type === 'debate.diversity');
  assert.ok(recorded);
  assert.equal(recorded.data.angleCoverage, diversity.angleCoverage);
  assert.ok(recorded.data.issues.some((issue) => issue.code === 'angle-coverage-low'));

  // 覆盖面正常时不写噪声事件
  assert.equal(recordDebateDiversity(task.id, { issues: [] }), null);
});
