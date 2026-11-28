import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-transcript-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store, taskTranscript } = await import('../server/store.mjs');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      /* retry while the child starts */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

async function startServer(dataDir) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: dataDir,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForHealth(baseUrl, child);
    return { baseUrl, child, logs: () => `${stdout}\n${stderr}` };
  } catch (err) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

async function stopServer(server) {
  if (!server) return;
  if (server.child.exitCode === null) {
    try {
      await fetch(`${server.baseUrl}/api/shutdown`, { method: 'POST' });
    } catch {
      server.child.kill('SIGTERM');
    }
  }
  await new Promise((resolve) => {
    if (server.child.exitCode !== null) resolve();
    else server.child.once('exit', resolve);
    setTimeout(resolve, 3000).unref();
  });
}

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

test('中文、emoji、日文与引号标题经过创建、落库、重启和导出仍保持原文', async () => {
  const title = '修复「登录/权限」API：你好 🌏 こんにちは & <test> "quoted"';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-title-'));
  let first = null;
  let second = null;
  try {
    first = await startServer(dataDir);
    const createdResponse = await fetch(`${first.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ goal: title, autoRun: false }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.task.title, `${title.slice(0, 26)}…`);
    assert.equal(created.task.goal, title);

    const stateResponse = await fetch(`${first.baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    const listed = state.tasks.find((task) => task.id === created.task.id);
    assert.equal(listed.title, `${title.slice(0, 26)}…`);
    assert.equal(listed.goal, title);

    const markdownResponse = await fetch(
      `${first.baseUrl}/api/tasks/${created.task.id}/export?format=markdown`,
    );
    assert.equal(markdownResponse.status, 200);
    assert.match(markdownResponse.headers.get('content-type') || '', /charset=utf-8/i);
    const markdown = await markdownResponse.text();
    assert.match(markdown, /修复「登录\/权限」API：你好 🌏 こんにちは & <test> "quoted"/);

    const htmlResponse = await fetch(
      `${first.baseUrl}/api/tasks/${created.task.id}/export?format=html`,
    );
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-type') || '', /charset=utf-8/i);
    const html = await htmlResponse.text();
    assert.match(html, /修复「登录\/权限」API：你好 🌏 こんにちは &amp; &lt;test&gt; &quot;quoted&quot;/);

    await stopServer(first);
    first = null;

    const savedTask = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'tasks', `${created.task.id}.json`), 'utf8'),
    );
    assert.equal(savedTask.title, `${title.slice(0, 26)}…`);
    assert.equal(savedTask.goal, title);

    second = await startServer(dataDir);
    const detailResponse = await fetch(`${second.baseUrl}/api/tasks/${created.task.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.task.title, `${title.slice(0, 26)}…`);
    assert.equal(detail.task.goal, title);

    const restartedState = await fetch(`${second.baseUrl}/api/state`).then((response) =>
      response.json(),
    );
    const restartedTask = restartedState.tasks.find((task) => task.id === created.task.id);
    assert.equal(restartedTask.title, `${title.slice(0, 26)}…`);
    assert.equal(restartedTask.goal, title);
  } catch (err) {
    const logs = [first?.logs(), second?.logs()].filter(Boolean).join('\n');
    throw new Error(`${err.message}\n${logs}`);
  } finally {
    await stopServer(first);
    await stopServer(second);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows 临时目录偶发占用 */
    }
  }
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 临时目录偶发占用 */
  }
});
