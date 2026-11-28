import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-claim-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { Store } = await import('../server/store.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

test('automation claim heartbeat keeps ownership past the original TTL', async () => {
  const a = new Store({ instanceId: 'instance-a' });
  const b = new Store({ instanceId: 'instance-b' });
  const claim = a.claimAutomation('auto-1', { ttlMs: 1200, runKey: 'task:t1' });
  assert.equal(claim.owned, true);
  assert.equal(b.claimAutomation('auto-1', { ttlMs: 1200, runKey: 'task:t1' }), null);

  await sleep(700);
  const renewed = a.renewAutomationClaim('auto-1', { ttlMs: 1200, runKey: 'task:t1' });
  assert.equal(renewed?.owned, true);

  await sleep(800); // 距首次 claim 已 1500ms，超过原始 TTL，但心跳已续到 1900ms
  assert.equal(a.automationClaimIsOwned('auto-1'), true, '续约后仍应持有');
  assert.equal(b.claimAutomation('auto-1', { ttlMs: 1200, runKey: 'task:t1' }), null);

  a.releaseAutomationClaim('auto-1');
  const taken = b.claimAutomation('auto-1', { ttlMs: 1200, runKey: 'task:t1' });
  assert.equal(taken?.owned, true);
});

test('crashed instance claim expires and can be reclaimed', async () => {
  const a = new Store({ instanceId: 'instance-a' });
  const b = new Store({ instanceId: 'instance-b' });
  a.claimAutomation('auto-2', { ttlMs: 1000, runKey: 'task:t2' });
  assert.equal(b.claimAutomation('auto-2', { ttlMs: 1000, runKey: 'task:t2' }), null);
  await sleep(1250);
  const reclaimed = b.claimAutomation('auto-2', { ttlMs: 1000, runKey: 'task:t2' });
  assert.equal(reclaimed?.owned, true, 'TTL 到期后必须能回收');
  assert.equal(reclaimed.instanceId, 'instance-b');

  // 原实例恢复后不能续约别人的 claim
  assert.equal(a.renewAutomationClaim('auto-2', { ttlMs: 1000 }), null);
});
