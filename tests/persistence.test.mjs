import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-persistence-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const dbFile = path.join(temp, 'db.json');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('appendMessage 使用 dirty 窗口合并写，且只重新序列化变化任务', async () => {
  const changed = store.createTask({ goal: '高频流式消息样本' });
  const untouched = store.createTask({ goal: '不应被重复序列化' });
  store.updateTask(untouched.id, { note: 'KEEP_THIS_TASK_UNCHANGED' });
  const message = store.addMessage(changed.id, {
    agentId: store.findAgentByRole('coder').id,
    name: 'Probe',
    role: 'coder',
    title: '测试',
    text: '',
  });
  store.endMessage(changed.id, message.id, {});
  store.flush();

  const writes = store.persistenceStats.writes;
  const taskSerializations = store.persistenceStats.taskSerializations;
  const fullSerializations = store.persistenceStats.fullSerializations;

  for (let index = 0; index < 200; index += 1) {
    store.appendMessage(changed.id, message.id, 'x');
  }
  assert.equal(store.persistenceStats.writes, writes, '同步追加期间不应逐条写盘');

  await wait(260);
  assert.equal(store.persistenceStats.writes, writes + 1, '200 次追加只应合并成一次写盘');
  assert.ok(store.persistenceStats.writes - writes < 200);
  assert.equal(
    store.persistenceStats.taskSerializations - taskSerializations,
    1,
    '只应序列化发生变化的那个任务',
  );
  assert.equal(
    store.persistenceStats.fullSerializations,
    fullSerializations,
    'dirty flush 不应退化成整库序列化',
  );

  const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const savedTask = saved.tasks.find((task) => task.id === changed.id);
  const savedMessage = savedTask.messages.find((item) => item.id === message.id);
  assert.equal(savedMessage.text, 'x'.repeat(200), '窗口到期后数据完整可读');
  assert.deepEqual(Object.keys(saved).sort(), [
    'agents',
    'profiles',
    'providers',
    'settings',
    'tasks',
  ]);
});

test('进程正常退出前会 flush 尚未到期的 dirty 数据', () => {
  const childDir = fs.mkdtempSync(path.join(temp, 'exit-'));
  const storeUrl = pathToFileURL(path.resolve('server/store.mjs')).href;
  const script = [
    `import { store } from ${JSON.stringify(storeUrl)};`,
    "const task = store.createTask({ goal: 'exit flush' });",
    "const message = store.addMessage(task.id, { agentId: 'system', name: 'system', role: 'system', title: 'SYS', text: '' });",
    "store.appendMessage(task.id, message.id, 'EXIT_FLUSH_COMPLETE');",
    'process.exit(0);',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, AGENTFORGE_DATA_DIR: childDir },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);

  const saved = JSON.parse(fs.readFileSync(path.join(childDir, 'db.json'), 'utf8'));
  const task = saved.tasks.find((item) => item.goal === 'exit flush');
  assert.ok(task);
  assert.equal(task.messages[0].text, 'EXIT_FLUSH_COMPLETE', '正常退出不能丢最后一段流式文本');
});

test('no-arg save upgrades an existing precise dirty hint to a full save', async () => {
  const task = store.createTask({ goal: 'no-arg save probe' });
  const message = store.addMessage(task.id, {
    agentId: 'system',
    name: 'system',
    role: 'system',
    title: 'SYS',
    text: '',
  });
  store.appendMessage(task.id, message.id, 'precise-dirty');
  store.db.settings.noArgSaveProbe = 'persist-me';
  store.save();

  await wait(260);
  const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.equal(saved.settings.noArgSaveProbe, 'persist-me');
  const savedTask = saved.tasks.find((item) => item.id === task.id);
  assert.equal(savedTask.messages.find((item) => item.id === message.id).text, 'precise-dirty');
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 上偶发占用，交给系统清理 */
  }
});
