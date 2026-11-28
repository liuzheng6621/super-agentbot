import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-team-startup-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { checkCandidates, ensureRealTeam } = await import('../server/team.mjs');

const fixture = path.resolve('tests/fixtures/team-observe-fixture.mjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-team-observe-'));

after(() => {
  for (const dir of [temp, scratch]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows may keep a handle briefly. */
    }
  }
});

function candidate(name) {
  const output = path.join(scratch, `${name}.json`);
  return {
    output,
    item: {
      key: `fixture-${name}`,
      label: `Fixture ${name}`,
      path: process.execPath,
      args: [fixture],
      health: null,
      executionAgent: {
        cli: {
          command: process.execPath,
          args: [fixture],
          env: { TEAM_OBSERVE_OUT: output },
        },
      },
    },
  };
}

test('checkCandidates without probe performs no real prompt call', async () => {
  const { item, output } = candidate('no-probe');
  const candidates = [item];
  await checkCandidates(candidates, { probe: false, timeout: 5000 });
  assert.equal(candidates[0].health, null, '未探测时不能伪造健康状态');
  assert.equal(fs.existsSync(output), false, '默认启动不能发起真实提示词调用');

  await checkCandidates(candidates, { timeout: 5000 });
  assert.equal(fs.existsSync(output), true, '显式体检才会真正调用 CLI');
  assert.equal(candidates[0].health.ok, true, candidates[0].health.note);
});
