import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-store-modules-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { processIsAlive, pruneExpiredLeases, taskLeaseIsLive } = await import(
  '../server/leases.mjs'
);
const { resolveParentSpanId, safeSpanId } = await import('../server/events.mjs');
const { TaskShardStore, readJsonFile, writeJsonAtomic, acquireFileLockSync, releaseFileLockSync } =
  await import('../server/persistence.mjs');

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

test('lease helpers keep live leases and drop dead or expired ones', () => {
  const live = { pid: process.pid, expiresAt: Date.now() + 5000 };
  const expired = { pid: process.pid, expiresAt: Date.now() - 1 };
  const dead = { pid: 999999, expiresAt: Date.now() + 5000 };
  assert.equal(taskLeaseIsLive(live), true);
  assert.equal(taskLeaseIsLive(expired), false);
  assert.equal(taskLeaseIsLive(dead), false);
  assert.equal(taskLeaseIsLive(null), false);
  assert.equal(processIsAlive(process.pid), true);

  const pruned = pruneExpiredLeases({
    tasks: { a: live, b: expired },
    automations: { c: live, d: dead },
    providers: { p: [live, expired] },
  });
  assert.deepEqual(Object.keys(pruned.tasks), ['a']);
  assert.deepEqual(Object.keys(pruned.automations), ['c']);
  assert.equal(pruned.providers.p.length, 1);
  assert.equal(pruned.version, 1);
  assert.deepEqual(pruneExpiredLeases({}).providers, {});
});

test('span resolution attaches step events to the step span and roots run.start', () => {
  const trace = { rootSpanId: 'root-1' };
  assert.equal(
    resolveParentSpanId({ event: { type: 'run.start' }, type: 'run.start', spanId: 's1', trace })
      .parentSpanId,
    null,
  );
  assert.equal(
    resolveParentSpanId({ event: {}, type: 'message', spanId: 's2', trace }).parentSpanId,
    'root-1',
  );

  const step = {};
  const first = resolveParentSpanId({
    event: {},
    type: 'step.start',
    spanId: 's3',
    trace,
    step,
    createId: () => 'step-span',
  });
  assert.equal(first.parentSpanId, 'step-span');
  assert.equal(first.stepPatch.traceSpanId, 'step-span');
  assert.equal(first.stepPatch.traceParentSpanId, 'root-1');
  Object.assign(step, first.stepPatch);

  const second = resolveParentSpanId({
    event: {},
    type: 'step.end',
    spanId: 's4',
    trace,
    step,
    createId: () => 'other',
  });
  assert.equal(second.parentSpanId, 'step-span', '同一步骤复用同一 span');
  assert.equal(second.stepPatch.traceSpanId, 'step-span');

  assert.equal(
    resolveParentSpanId({
      event: { parentSpanId: 'explicit' },
      type: 'step.start',
      spanId: 's5',
      trace,
      step,
    }).parentSpanId,
    'explicit',
  );
  assert.equal(safeSpanId('a/b c!'), 'abc');
});

test('persistence primitives round-trip atomically and guard the lock', () => {
  const file = path.join(temp, 'nested', 'value.json');
  writeJsonAtomic(file, { hello: 'world' });
  assert.deepEqual(readJsonFile(file), { hello: 'world' });
  assert.equal(readJsonFile(path.join(temp, 'missing.json'), { fallback: true }).fallback, true);

  const lock = path.join(temp, '.test.lock');
  const token = acquireFileLockSync(lock);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(releaseFileLockSync(lock, 'wrong-token'), false);
  assert.equal(releaseFileLockSync(lock, token), true);
  assert.equal(fs.existsSync(lock), false);

  const shards = new TaskShardStore(path.join(temp, 'shards'));
  shards.writeShard({ id: 't1', goal: 'g' });
  assert.equal(shards.readShard('t1').goal, 'g');
  assert.equal(shards.removeShard('t1'), true);
  assert.equal(shards.readShard('t1'), null);
});
