import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-timeouts-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const {
  defaultTimeouts,
  normalizeTimeoutOverrides,
  resolveTimeouts,
  timeoutCatalog,
} = await import('../server/timeouts.mjs');
const { timeoutAuditFor } = await import('../server/orchestrator.mjs');

after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may hold a workspace handle briefly. */
  }
});

test('timeout precedence is settings then Provider then Agent/Profile, with sparse layers', () => {
  const defaults = defaultTimeouts();
  const resolved = resolveTimeouts({
    settings: { timeouts: { proposal: 120_000, step: 600_000 } },
    provider: { timeouts: { proposal: 180_000, critique: 240_000 } },
    agent: { timeouts: { critique: 300_000, qualityGate: 420_000 } },
  });
  assert.equal(resolved.proposal, 180_000);
  assert.equal(resolved.critique, 300_000);
  assert.equal(resolved.step, 600_000, 'Provider/Agent 未声明的项继续继承全局');
  assert.equal(resolved.qualityGate, 420_000);
  assert.equal(resolved.decision, defaults.decision);
  assert.deepEqual(normalizeTimeoutOverrides({ step: 1, proposal: 99_999_999 }), {
    step: 30_000,
    proposal: 3_600_000,
  });
});

test('profile timeout updates sync bound agents and state exposes effective budgets', () => {
  const provider = store.addProvider({
    id: 'timeout-provider',
    name: 'Timeout Provider',
    timeouts: { proposal: 180_000 },
  });
  const profile = store.addProfile({
    id: 'timeout-profile',
    name: 'Timeout Profile',
    role: 'coder',
    providerId: provider.id,
    timeouts: { step: 600_000 },
  });
  const agent = store.addAgent({
    name: 'Timeout Agent',
    role: 'coder',
    profileId: profile.id,
    providerId: provider.id,
    mode: 'sim',
  });
  assert.equal(store.getAgent(agent.id).timeouts.step, 600_000);

  store.updateProfile(profile.id, { timeouts: { step: 720_000 } });
  assert.equal(store.getAgent(agent.id).timeouts.step, 720_000);
  store.updateSettings({ timeouts: { qualityGate: 300_000 } });

  const audit = timeoutAuditFor(store.getAgent(agent.id));
  assert.equal(audit.proposal, 180_000, 'Provider 覆盖全局');
  assert.equal(audit.step, 720_000, 'Agent/Profile 覆盖 Provider');
  assert.equal(audit.qualityGate, 300_000, '未覆盖阶段继承全局');
  assert.match(audit.summary, /qualityGate=300s/);
  assert.ok(timeoutCatalog().some((item) => item.key === 'step' && item.defaultMs === 900_000));
});
