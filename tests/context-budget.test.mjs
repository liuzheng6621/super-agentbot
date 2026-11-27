// 上下文成本与文件落盘的验收测试：改动前这些断言都不成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-budget-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store, taskTranscript } = await import('../server/store.mjs');
const {
  stableBlock,
  volatileBlock,
  buildPrompt,
  buildContextPack,
  compactTaskContext,
  listTaskCompactions,
  replayTaskCompaction,
} = await import('../server/orchestrator.mjs');
const { estimateTokens } = await import('../server/tokens.mjs');
const { writeFileAtomic, versionOf, spillText, readSpillText, spillValue } = await import('../server/fs.mjs');

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
  assert.ok(ref.excerpt.length < text.length);
  assert.match(ref.retrievalHint, /只读路径/);
  assert.equal(readSpillText(ref).content, text, 'spill 引用必须能校验并读回原文');
});

test('spill 引用会拒绝被篡改或大小不符的内容', () => {
  const ref = spillText({ taskId: 't-2', name: 'tamper', content: '原始内容' });
  writeFileAtomic(ref.locator, '被篡改');
  assert.throws(() => readSpillText(ref), /摘要不匹配/);
  assert.throws(() => readSpillText({ ...ref, sha256: '', bytes: 1 }), /大小不匹配/);
});

test('事件、消息、工具输出与导出都能被 spill 引用而不是无限内联', () => {
  const task = store.createTask({ goal: 'spill 推广样本' });
  const bigText = '事件细节'.repeat(12000);
  const bigEventData = { stdout: bigText };
  const event = store.addTaskEvent(task.id, {
    type: 'tool.call.end',
    data: bigEventData,
  });
  assert.ok(event.data.spill?.locator, '大事件必须落盘');
  assert.ok(event.data.preview.length < bigText.length);
  assert.deepEqual(JSON.parse(readSpillText(event.data.spill).content), bigEventData);

  const message = store.addMessage(task.id, {
    agentId: 'system',
    name: 'system',
    role: 'system',
    title: 'SYS',
    kind: 'text',
    done: true,
    text: bigText,
  });
  assert.ok(message.spill?.locator, '大消息必须落盘');
  assert.equal(readSpillText(message.spill).content, bigText);

  const value = spillValue({
    taskId: task.id,
    name: 'tool-output',
    value: { stdout: bigText },
  });
  assert.ok(value.spill.locator);
  assert.ok(value.text.length < bigText.length);

  const transcript = store.getTask(task.id);
  transcript.messages.push({
    id: 'synthetic-transcript-message',
    createdAt: Date.now(),
    name: 'probe',
    role: 'tester',
    kind: 'text',
    done: true,
    text: '导出内容'.repeat(80000),
  });
  const exported = taskTranscript(transcript, 'markdown');
  assert.ok(exported.spill?.locator, '超长导出必须生成 spill 句柄');
  assert.match(exported.spill.retrievalHint, /只读路径/);
  assert.equal(readSpillText(exported.spill).content, exported.body);
});

test('contextStates 区分未知窗口，压缩保留原文且摘要可审计', () => {
  const workspaceDir = path.join(temp, 'context-ws');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const task = store.createTask({
    goal: '验证上下文压缩',
    workspace: workspaceDir,
  });
  for (let index = 0; index < 18; index += 1) {
    store.addMessage(task.id, {
      agentId: 'system',
      name: index % 2 ? '测试' : '实现',
      role: index % 2 ? 'tester' : 'coder',
      title: 'MEM',
      kind: 'text',
      done: true,
      text: `第 ${index + 1} 条历史消息：${'细节'.repeat(40)}`,
    });
  }
  const before = buildContextPack(store.getTask(task.id), { files: [] });
  assert.equal(before.contextState.contextWindow, null, '未知窗口必须返回 null');
  assert.equal(before.contextState.autoCompactAt, null, '未知阈值必须返回 null');
  assert.equal(before.contextState.lastCompactionAt, null);
  assert.equal(before.messages.length, 8);
  assert.equal(before.contextState.messages, 18);
  assert.ok(before.contextState.estimatedTokens > 0);

  const original = store.getTask(task.id).messages.map((message) => message.id);
  const result = compactTaskContext(task.id, { maxMessages: 4 });
  assert.equal(result.compacted, true);
  const after = buildContextPack(store.getTask(task.id), { files: [] });
  assert.ok(after.contextState.lastCompactionAt > 0);
  assert.ok(after.contextState.compaction.sourceMessages > after.messages.length);
  assert.equal(after.contextState.compaction.originalPreserved, true);
  assert.ok(after.contextState.compaction.summary.includes('完整原文仍保存在任务消息中'));
  assert.deepEqual(
    store.getTask(task.id).messages.map((message) => message.id),
    original,
    '压缩不能覆盖或删除原始消息',
  );
  assert.ok(
    store.getTask(task.id).events.some((event) => event.type === 'context.compacted'),
    '压缩必须留下审计事件',
  );
});

test('压缩历史记录质量、来源范围并可回放原始消息', () => {
  const workspaceDir = path.join(temp, 'context-history-ws');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const task = store.createTask({
    goal: '验证压缩历史与回放',
    workspace: workspaceDir,
  });
  for (let index = 0; index < 16; index += 1) {
    store.addMessage(task.id, {
      agentId: 'system',
      name: index % 3 === 0 ? '编排器' : index % 3 === 1 ? '实现' : '测试',
      role: index % 3 === 0 ? 'system' : index % 3 === 1 ? 'coder' : 'tester',
      title: 'MEM',
      kind: 'text',
      done: true,
      text: `第 ${index + 1} 条压缩来源：${'内容'.repeat(30)}`,
    });
  }

  const result = compactTaskContext(task.id, { maxMessages: 4 });
  assert.equal(result.compacted, true);
  const state = store.getTask(task.id).contextState;
  assert.equal(state.compactions.length, 1);
  assert.equal(state.compactions[0].id, state.compaction.id);
  assert.equal(state.compaction.auto, false);
  assert.ok(state.compaction.quality.score >= 0 && state.compaction.quality.score <= 100);
  assert.ok(['good', 'fair', 'weak'].includes(state.compaction.quality.label));
  assert.ok(state.compaction.quality.factors.length >= 3);
  assert.ok(state.compaction.sections.length >= 2);
  assert.equal(
    state.compaction.sourceMessageIds.length,
    state.compaction.sourceMessages,
  );
  assert.ok(state.compaction.sourceRange.fromIndex >= 0);
  assert.ok(state.compaction.sourceRange.toIndex >= state.compaction.sourceRange.fromIndex);
  assert.equal(
    state.compaction.sourceRange.fromMessageId,
    state.compaction.sourceMessageIds[0],
  );
  assert.equal(
    state.compaction.sourceRange.toMessageId,
    state.compaction.sourceMessageIds.at(-1),
  );

  const history = listTaskCompactions(task.id);
  assert.equal(history.length, 1);
  const replay = replayTaskCompaction(task.id, state.compaction.id);
  assert.equal(replay.compaction.id, state.compaction.id);
  assert.deepEqual(
    replay.messages.map((message) => message.id),
    state.compaction.sourceMessageIds,
  );
  assert.equal(replay.originalPreserved, true);
});

test('上下文压力达到阈值时自动压缩，且不会重复压缩同一范围', () => {
  const workspaceDir = path.join(temp, 'context-auto-ws');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const task = store.createTask({
    goal: '验证自动压缩',
    workspace: workspaceDir,
  });
  for (let index = 0; index < 20; index += 1) {
    store.addMessage(task.id, {
      agentId: 'system',
      name: index % 2 ? '测试' : '实现',
      role: index % 2 ? 'tester' : 'coder',
      title: 'MEM',
      kind: 'text',
      done: true,
      text: `自动压缩样本 ${index + 1}：${'细节'.repeat(50)}`,
    });
  }
  store.updateContextState(task.id, {
    contextWindow: 200,
    autoCompactAt: 1,
  });

  const first = buildContextPack(store.getTask(task.id), { files: [] });
  assert.equal(first.contextState.compaction.auto, true);
  assert.equal(first.contextState.compactions, 1);
  assert.equal(first.contextState.autoCompaction.status, 'compacted');

  const second = buildContextPack(store.getTask(task.id), { files: [] });
  assert.equal(second.contextState.compactions, 1, '同一来源范围不能被自动重复压缩');
  assert.ok(
    ['already-compacted', 'not-enough-history'].includes(
      second.contextState.autoCompaction.status,
    ),
  );
  assert.equal(store.getTask(task.id).messages.length, 20, '自动压缩不得删除原文');
});
