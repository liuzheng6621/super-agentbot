import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve('.');
const storeUrl = pathToFileURL(path.join(root, 'server/store.mjs')).href;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-multi-instance-'));

function runChild(code, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    env: { ...process.env, AGENTFORGE_DATA_DIR: temp, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
}

function spawnChild(code, env = {}) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    env: { ...process.env, AGENTFORGE_DATA_DIR: temp, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('等待条件超时');
}

function readDb() {
  return JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
}

function readTaskShards(dir) {
  const tasksDir = path.join(dir, 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir)
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => JSON.parse(fs.readFileSync(path.join(tasksDir, name), 'utf8')));
}


function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', resolve);
  });
}

test('two instances merge concurrent task writes instead of overwriting each other', async () => {
  const seed = runChild(
    `import { store } from ${JSON.stringify(storeUrl)}; store.createTask({ goal: 'seed' }); store.flush();`,
  );
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  const script = (goal) => `
    import { store } from ${JSON.stringify(storeUrl)};
    const task = store.createTask({ goal: ${JSON.stringify(goal)} });
    store.flush();
    console.log(task.id);
  `;
  const run = (goal) =>
    new Promise((resolve) => {
      const child = spawnChild(script(goal));
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('exit', (code) => resolve({ code, out }));
    });
  const [first, second] = await Promise.all([run('instance one'), run('instance two')]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const ids = readTaskShards(temp).map((task) => task.id);
  assert.ok(ids.includes(first.out.trim()));
  assert.ok(ids.includes(second.out.trim()));
});

test('starting another instance does not recover a task leased by a live instance', async () => {
  const holder = spawnChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    const task = store.createTask({ goal: 'live leased task' });
    store.updateTask(task.id, { status: 'running' }, 'task.status');
    store.acquireTaskLease(task.id, { ttlMs: 60000 });
    store.flush();
    console.log(task.id);
    setInterval(() => store.renewTaskLease(task.id, { ttlMs: 60000 }), 1000);
  `);
  let holderOut = '';
  holder.stdout.on('data', (chunk) => (holderOut += chunk));
  await waitFor(() => holderOut.trim().length > 0);

  const observer = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    console.log(store.getTask(${JSON.stringify(holderOut.trim())}).status);
    store.flush();
  `);
  assert.equal(observer.status, 0, observer.stderr || observer.stdout);
  assert.equal(observer.stdout.trim(), 'running');

  holder.kill('SIGTERM');
  await waitExit(holder);
});

test('two instances cannot acquire the same task lease', async () => {
  const create = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    const task = store.createTask({ goal: 'lease race' });
    store.flush();
    console.log(task.id);
  `);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const taskId = create.stdout.trim();
  const holder = spawnChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    console.log(store.acquireTaskLease(${JSON.stringify(taskId)}, { ttlMs: 60000 }) ? 'yes' : 'no');
    setInterval(() => {}, 1000);
  `);
  let holderOut = '';
  holder.stdout.on('data', (chunk) => (holderOut += chunk));
  await waitFor(() => holderOut.trim().length > 0);
  const contender = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    console.log(store.acquireTaskLease(${JSON.stringify(taskId)}) ? 'yes' : 'no');
  `);
  assert.equal(holderOut.trim(), 'yes');
  assert.equal(contender.status, 0, contender.stderr || contender.stdout);
  assert.equal(contender.stdout.trim(), 'no');
  holder.kill('SIGTERM');
  await waitExit(holder);
});

test('two loaded instances detect a same-task write conflict at flush time', async () => {
  const create = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    const task = store.createTask({ goal: 'two-reader conflict' });
    store.updateTask(task.id, { note: 'base' });
    store.flush();
    console.log(task.id);
  `);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const taskId = create.stdout.trim();
  const childCode = `
    import { store } from ${JSON.stringify(storeUrl)};
    store.updateTask(${JSON.stringify(taskId)}, { note: process.env.NOTE });
    setTimeout(() => {
      try { store.flush({ throwOnConflict: true }); console.log('ok'); }
      catch (err) { console.log(err.code); process.exit(err.code === 'STORE_CONFLICT' ? 0 : 1); }
    }, Number(process.env.DELAY));
  `;
  const [first, second] = await Promise.all([
    new Promise((resolve) => {
      const child = spawnChild(childCode, { NOTE: 'one', DELAY: '0' });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('exit', (code) => resolve({ code, out }));
    }),
    new Promise((resolve) => {
      const child = spawnChild(childCode, { NOTE: 'two', DELAY: '300' });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('exit', (code) => resolve({ code, out }));
    }),
  ]);
  assert.equal(first.code, 0, first.out);
  assert.equal(first.out.trim(), 'ok');
  assert.equal(second.code, 0, second.out);
  assert.equal(second.out.trim(), 'STORE_CONFLICT');
});

test('automation claims are exclusive across instances', async () => {
  const holder = spawnChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    console.log(store.claimAutomation('shared-automation', { ttlMs: 60000 }) ? 'claimed' : 'no');
    setInterval(() => {}, 1000);
  `);
  let holderOut = '';
  holder.stdout.on('data', (chunk) => (holderOut += chunk));
  await waitFor(() => holderOut.trim().length > 0);

  const contender = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    console.log(store.claimAutomation('shared-automation', { ttlMs: 60000 }) ? 'blocked' : 'claimed');
  `);
  assert.equal(holderOut.trim(), 'claimed');
  assert.equal(contender.status, 0, contender.stderr || contender.stdout);
  assert.equal(contender.stdout.trim(), 'claimed');
  holder.kill('SIGTERM');
  await waitExit(holder);
});

test('a clean instance does not rewrite db.json on startup', () => {
  const create = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    store.createTask({ goal: 'clean startup' });
    store.flush();
  `);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const before = fs.statSync(path.join(temp, 'db.json')).mtimeMs;
  const reader = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    console.log(store.persistenceStats.writes);
    store.flush();
  `);
  assert.equal(reader.status, 0, reader.stderr || reader.stdout);
  assert.equal(reader.stdout.trim(), '0');
  assert.equal(fs.statSync(path.join(temp, 'db.json')).mtimeMs, before);
});

test('task removal survives another instance write', async () => {
  const create = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    const task = store.createTask({ goal: 'remove shared task' });
    store.flush();
    console.log(task.id);
  `);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const taskId = create.stdout.trim();
  const other = spawnChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    console.log('loaded');
    setInterval(() => {}, 1000);
  `);
  let otherOut = '';
  other.stdout.on('data', (chunk) => (otherOut += chunk));
  await waitFor(() => otherOut.includes('loaded'));
  const remover = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    store.removeTask(${JSON.stringify(taskId)});
    store.flush();
  `);
  assert.equal(remover.status, 0, remover.stderr || remover.stdout);
  other.kill('SIGTERM');
  await waitExit(other);
  assert.equal(readTaskShards(temp).some((task) => task.id === taskId), false);
});

test('a stale lock file without a holder is reclaimed after a grace period', () => {
  const lock = path.join(temp, '.db.lock');
  fs.writeFileSync(lock, '{not-json');
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lock, old, old);
  const result = runChild(`
    import { store } from ${JSON.stringify(storeUrl)};
    store.createTask({ goal: 'lock recovery' });
    store.flush();
    console.log('ok');
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'ok');
  assert.equal(fs.existsSync(lock), false);
});

test('db.json keeps its five-key compatibility shape after multi-instance writes', () => {
  assert.deepEqual(Object.keys(readDb()).sort(), [
    'agents',
    'profiles',
    'providers',
    'settings',
    'tasks',
  ]);
  assert.equal(fs.existsSync(path.join(temp, '.leases.json')), true);
});

test.after(() => {
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a workspace directory briefly. */
  }
});
