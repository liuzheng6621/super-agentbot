import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-shards-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { Store } = await import('../server/store.mjs');
const { TaskShardStore } = await import('../server/persistence.mjs');

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

test('tasks live in per-task shards and db.json keeps metadata only', () => {
  const store = new Store({ instanceId: 'shard-a' });
  const task = store.createTask({ goal: '分片任务' });
  store.flush();

  const shardFile = path.join(temp, 'tasks', `${task.id}.json`);
  assert.equal(fs.existsSync(shardFile), true, '任务必须落到 tasks/<id>.json');
  const shard = JSON.parse(fs.readFileSync(shardFile, 'utf8'));
  assert.equal(shard.goal, '分片任务');

  const db = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
  assert.deepEqual(Object.keys(db).sort(), ['agents', 'profiles', 'providers', 'settings', 'tasks']);
  assert.deepEqual(db.tasks, [], 'db.json 只保留兼容形状，不再内联任务');

  const index = JSON.parse(fs.readFileSync(path.join(temp, 'tasks', 'index.json'), 'utf8'));
  assert.equal(index.version, 1);
  assert.ok(index.ids.includes(task.id));
  assert.equal(index.count, index.ids.length);
});

test('legacy db.json tasks migrate to shards with a backup', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'legacy-'));
  const legacyTask = {
    id: 'legacy-task',
    goal: 'legacy',
    title: 'legacy',
    mode: 'auto',
    status: 'done',
    createdAt: 1,
    messages: [],
    plan: [],
    artifacts: [],
    events: [],
    fileChanges: [],
  };
  const seed = new Store({ instanceId: 'seed' });
  const db = {
    agents: seed.db.agents,
    providers: seed.db.providers,
    profiles: [],
    tasks: [legacyTask],
    settings: seed.db.settings,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db), 'utf8');
  process.env.AGENTFORGE_DATA_DIR = dir;
  // 数据目录常量在导入时确定，这里直接用分片模块验证迁移本身。
  const shards = new TaskShardStore(path.join(dir, 'tasks'));
  const result = shards.migrate([legacyTask], { backupFile: path.join(dir, 'db.json') });
  assert.equal(result.migrated, 1);
  assert.equal(fs.existsSync(path.join(dir, 'tasks', 'legacy-task.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'db.json.bak')), true, '迁移前必须备份旧 db.json');
  process.env.AGENTFORGE_DATA_DIR = temp;
});

test('a corrupted shard is skipped and the index is rebuilt', () => {
  const dir = path.join(temp, 'corrupt');
  const shards = new TaskShardStore(path.join(dir, 'tasks'));
  shards.writeShard({ id: 'good-1', goal: 'ok', messages: [], plan: [], artifacts: [], events: [] });
  shards.writeShard({ id: 'good-2', goal: 'ok2', messages: [], plan: [], artifacts: [], events: [] });
  shards.writeIndex(['good-1', 'good-2']);
  fs.writeFileSync(path.join(dir, 'tasks', 'broken.json'), '{"id":"broken",', 'utf8');
  fs.writeFileSync(path.join(dir, 'tasks', 'index.json'), '{"version":1,"ids":["good-1"]}', 'utf8');

  const loaded = shards.loadAll();
  assert.deepEqual(loaded.map((task) => task.id).sort(), ['good-1', 'good-2']);
  const index = shards.readIndex();
  assert.deepEqual([...index.ids].sort(), ['good-1', 'good-2'], '索引必须按磁盘实际分片重建');
});

test('two instances write independent task shards without clobbering each other', () => {
  const dir = path.join(temp, 'multi');
  fs.mkdirSync(dir, { recursive: true });
  const a = new Store({ instanceId: 'shard-a' });
  // 两个 Store 共用同一 DATA_DIR（导入时的常量），用分片模块直接验证并发写。
  const shards = new TaskShardStore(path.join(temp, 'tasks'));
  const one = a.createTask({ goal: '实例 A 的任务' });
  a.flush();
  const two = (() => {
    const b = new Store({ instanceId: 'shard-b' });
    const created = b.createTask({ goal: '实例 B 的任务' });
    b.flush();
    return created;
  })();
  a.flush();

  const ids = shards.listIds();
  assert.ok(ids.includes(one.id));
  assert.ok(ids.includes(two.id));
  const index = shards.readIndex();
  assert.ok(index.ids.includes(one.id) && index.ids.includes(two.id));
});
