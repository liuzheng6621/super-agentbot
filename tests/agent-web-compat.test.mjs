import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_WEB_ROOT = path.resolve(
  process.env.AGENT_WEB_ROOT || path.join(REPO_ROOT, '..', 'agent-web'),
);
const AGENT_WEB_COMMIT =
  process.env.AGENT_WEB_COMMIT || 'fe543ead03c9b200a9bfebf39e86cf5b676edfbc';
const AGENT_WEB_NODE = process.env.AGENT_WEB_NODE || process.execPath;
const AGENT_WEB_BIN = path.join(AGENT_WEB_ROOT, 'bin', 'agent-web.mjs');
const CASES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'agent-web', 'cases');
const ADAPTER = path.join(REPO_ROOT, 'tests', 'fixtures', 'agent-web', 'agentforge-adapter.mjs');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

const checkoutExists = fs.existsSync(AGENT_WEB_BIN);

test(
  'agent-web acceptance suite passes against the real HTTP adapter',
  { skip: !checkoutExists && `agent-web checkout not found at ${AGENT_WEB_ROOT}` },
  () => {
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: AGENT_WEB_ROOT });
    assert.equal(head.status, 0, head.stderr || head.stdout);
    assert.equal(
      head.stdout.trim(),
      AGENT_WEB_COMMIT,
      `agent-web must stay at reviewed commit ${AGENT_WEB_COMMIT}`,
    );

    const result = run(
      AGENT_WEB_NODE,
      [
        AGENT_WEB_BIN,
        'verify',
        CASES_DIR,
        `--adapter=${ADAPTER}`,
        '--json',
      ],
      {
        cwd: AGENT_WEB_ROOT,
        timeout: 180_000,
        env: {
          ...process.env,
          AGENT_WEB_QUIET_ADAPTER_WARNING: '1',
        },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout.slice(-4000));

    const verdicts = JSON.parse(result.stdout);
    assert.equal(verdicts.length, 10);
    const failed = verdicts
      .filter((verdict) => verdict.status !== 'pass')
      .map((verdict) => ({
        case_id: verdict.case_id,
        status: verdict.status,
        reason_code: verdict.reason_code,
        detail: verdict.detail,
      }));
    assert.deepEqual(failed, []);
  },
);
