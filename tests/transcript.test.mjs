import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-transcript-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store, taskTranscript } = await import('../server/store.mjs');

test('Markdown 导出包含运行记录、质量门和脱敏内容', () => {
  const task = store.createTask({ goal: '导出运行记录' });
  store.updateTask(task.id, {
    status: 'done',
    quality: {
      status: 'passed',
      command: 'npm test --silent',
      code: 0,
      elapsed: 123,
      stdout: 'PASS 42 tests',
      stderr: '',
      reviewerId: 'reviewer-1',
      implementerId: 'coder-1',
      selfReview: false,
    },
  });
  store.addMessage(task.id, {
    agentId: 'coder-1',
    name: 'Kilo',
    role: 'coder',
    title: '实现工程师',
    kind: 'text',
    done: true,
    text: '已完成。OPENAI_API_KEY=sk-live-secret-value',
  });
  store.addTaskEvent(task.id, {
    type: 'skill.activated',
    stepId: 'implement',
    agentId: 'coder-1',
    data: { skills: [{ id: 'frontend-ui', name: '前端界面规范', source: 'workspace' }] },
  });

  const result = taskTranscript(store.getTask(task.id), 'markdown');
  assert.equal(result.format, 'markdown');
  assert.match(result.contentType, /text\/markdown/);
  assert.match(result.body, /导出运行记录/);
  assert.match(result.body, /npm test --silent/);
  assert.match(result.body, /PASS 42 tests/);
  assert.match(result.body, /skill\.activated/);
  assert.match(result.body, /reviewer-1/);
  assert.doesNotMatch(result.body, /sk-live-secret-value/);
  assert.match(result.body, /\[REDACTED\]/);
});

test('HTML 导出转义用户内容并保留质量门字段', () => {
  const task = store.createTask({ goal: 'HTML 导出样本' });
  store.updateTask(task.id, {
    quality: { status: 'failed', command: 'node test.js', code: 1, stderr: '<script>bad()</script>' },
  });
  store.addMessage(task.id, {
    agentId: 'system',
    name: '<b>系统</b>',
    role: 'system',
    title: 'SYS',
    kind: 'text',
    done: true,
    text: '<script>alert(1)</script>',
  });

  const result = taskTranscript(store.getTask(task.id), 'html');
  assert.equal(result.format, 'html');
  assert.match(result.contentType, /text\/html/);
  assert.match(result.body, /<!doctype html>/i);
  assert.match(result.body, /node test\.js/);
  assert.doesNotMatch(result.body, /<script>alert\(1\)<\/script>/);
  assert.match(result.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 临时目录偶发占用 */
  }
});
