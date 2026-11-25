// 上下文成本与文件落盘的验收测试：改动前这些断言都不成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-budget-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { stableBlock, volatileBlock, buildPrompt } = await import('../server/orchestrator.mjs');
const { estimateTokens } = await import('../server/tokens.mjs');
const { writeFileAtomic, versionOf, spillText } = await import('../server/fs.mjs');

const context = (over = {}) => ({
  goal: '做一个并发安全的待办 API',
  workspace: 'E:/tmp/ws',
  status: 'running',
  plan: [{ id: 'plan', title: '需求拆解', role: 'planner', status: 'done' }],
  files: [{ path: 'src/a.js', bytes: 12 }],
  messages: [{ name: '规划', text: '先拆工序' }],
  ...over,
});

const agent = { name: 'Codex', title: '实现工程师', role: 'coder' };

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

test('中文 token 估算不再按 1/3 低估', () => {
  const zh = '一二三四五六七八九十一二三四五六七八九十';
  assert.ok(estimateTokens(zh) >= 16, `20 个汉字应估到 16 token 以上，实际 ${estimateTokens(zh)}`);
  assert.ok(estimateTokens(zh) <= 26, '不该反过来高估');
  assert.ok(estimateTokens('') === 0);
  // 同样的字符数，中文必须显著高于英文
  assert.ok(estimateTokens('中文中文中文中文') > estimateTokens('abcdefghijklmnop'));
});

test('稳定区与易变区真的分开了', () => {
  const stable = stableBlock(context());
  const volatile = volatileBlock(context(), '实现工序');
  assert.ok(stable.includes('项目目标') === false && stable.includes('做一个并发安全的待办 API'));
  assert.ok(!stable.includes('running'), '状态属于易变内容，不能进稳定区');
  assert.ok(volatile.includes('running'));
  assert.ok(volatile.includes('实现工序'));
  assert.ok(volatile.includes('src/a.js'));
  // 账本/文件清单这些每步都变的东西，一个都不许留在稳定区
  assert.ok(!stable.includes('工序账本'));
  assert.ok(!stable.includes('已知文件'));
});

test('连续两步的 prompt 共享稳定前缀（前缀缓存才可能命中）', () => {
  const stepA = { id: 'implement', title: '实现工序', role: 'coder', needs: [] };
  const stepB = { id: 'test-design', title: '测试设计', role: 'tester', needs: [] };
  const a = buildPrompt(
    { goal: '做一个并发安全的待办 API' },
    agent,
    stepA,
    '无',
    context({ status: 'running' }),
  );
  const b = buildPrompt(
    { goal: '做一个并发安全的待办 API' },
    agent,
    stepB,
    '无',
    context({ status: 'running', messages: [{ name: '实现', text: '写完了' }], files: [{ path: 'src/b.js', bytes: 9 }] }),
  );
  const stableLen = stableBlock(context()).length;
  assert.ok(commonPrefixLen(a, b) >= stableLen, '稳定区必须完整共享');
  // 易变内容必须落在末尾，而不是开头
  assert.ok(a.trimEnd().endsWith(volatileBlock(context({ status: 'running' }), '实现工序').trimEnd()));
  assert.ok(!a.startsWith('# 项目上下文（实时）'), '易变区不能出现在最前面');
});

test('writeFileAtomic 写出的内容完整且不留临时文件', () => {
  const dir = path.join(temp, 'ws');
  const abs = path.join(dir, 'a.txt');
  writeFileAtomic(abs, 'hello 世界\n');
  assert.equal(fs.readFileSync(abs, 'utf8'), 'hello 世界\n');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
    '原子写不能残留临时文件',
  );

  const v1 = versionOf(abs);
  writeFileAtomic(abs, 'hello 世界!!\n'); // 等长改写
  const v2 = versionOf(abs);
  assert.ok(v1 && v2 && v1 !== v2, '等长改写必须产生新版本');
  assert.equal(versionOf(path.join(dir, 'missing.txt')), null);
});

test('超长上游产物落盘成句柄，原文可完整取回', () => {
  const text = `# 产物\n${'细节'.repeat(5000)}`;
  const ref = spillText({ taskId: 't-1', name: 'coder-implement', content: text });
  assert.ok(ref.bytes > 20000);
  assert.equal(fs.readFileSync(ref.locator, 'utf8'), text);
  // 同样的内容重复落盘不产生第二个文件
  const again = spillText({ taskId: 't-1', name: 'coder-implement', content: text });
  assert.equal(again.locator, ref.locator);
});
