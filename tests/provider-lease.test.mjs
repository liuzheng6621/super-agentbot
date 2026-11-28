import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-provider-lease-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { Store } = await import('../server/store.mjs');

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

test('provider slots are arbitrated across two store instances', () => {
  const a = new Store({ instanceId: 'instance-a' });
  const b = new Store({ instanceId: 'instance-b' });
  const limitFor = () => 2;

  const first = a.acquireProviderSlots('task-1', ['builtin'], { limitFor });
  assert.equal(first.ok, true);
  const second = b.acquireProviderSlots('task-2', ['builtin'], { limitFor });
  assert.equal(second.ok, true, '两个实例各占一个槽位');

  const third = b.acquireProviderSlots('task-3', ['builtin'], { limitFor });
  assert.equal(third.ok, false, '超过配额必须拒绝');
  assert.equal(third.blocked.providerId, 'builtin');
  assert.equal(third.blocked.used, 2);
  assert.equal(third.blocked.limit, 2);

  const snapshot = b.providerSlotSnapshot();
  assert.equal(snapshot.builtin.length, 2);
  assert.equal(snapshot.builtin.filter((slot) => slot.owned).length, 1);

  // 续期不重复占槽
  assert.equal(a.acquireProviderSlots('task-1', ['builtin'], { limitFor }).ok, true);
  assert.equal(b.providerSlotSnapshot().builtin.length, 2);

  assert.equal(a.releaseProviderSlots('task-1'), 1);
  assert.equal(b.acquireProviderSlots('task-3', ['builtin'], { limitFor }).ok, true);

  b.releaseProviderSlots('task-2');
  b.releaseProviderSlots('task-3');
  assert.equal(b.providerSlotSnapshot().builtin, undefined);
});

test('expired provider slots are reclaimed', () => {
  const a = new Store({ instanceId: 'instance-a' });
  const b = new Store({ instanceId: 'instance-b' });
  const limitFor = () => 1;
  a.acquireProviderSlots('task-expire', ['builtin'], { limitFor, ttlMs: 1000 });
  assert.equal(b.acquireProviderSlots('task-next', ['builtin'], { limitFor }).ok, false);

  // 直接改写租约文件的过期时间，模拟实例崩溃后 TTL 到期
  const file = path.join(temp, '.leases.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const slot of data.providers.builtin) slot.expiresAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');

  assert.equal(b.acquireProviderSlots('task-next', ['builtin'], { limitFor }).ok, true);
});
