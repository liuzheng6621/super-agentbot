import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-coverage-'));
const testsDir = path.resolve('tests');
// 覆盖率门只跑快速单元用例：整库 + 覆盖率插桩会让 CI 跑十几分钟，
// 而这里的目标是给核心模块设下限，不是替代全量测试。
const FAST_TESTS = [
  'security.test.mjs',
  'path-allowlist.test.mjs',
  'spill-root.test.mjs',
  'store-modules.test.mjs',
  'task-shards.test.mjs',
  'rate-limit.test.mjs',
  'storage-gc.test.mjs',
  'review-independence.test.mjs',
  'debate.test.mjs',
  'plan-schema.test.mjs',
  'cli-policy.test.mjs',
  'markdown-links.test.mjs',
];
const files = FAST_TESTS.map((name) => path.join('tests', name)).filter((file) =>
  fs.existsSync(file),
);

const lines = process.env.AGENTFORGE_COVERAGE_LINES || '40';
const functions = process.env.AGENTFORGE_COVERAGE_FUNCTIONS || '35';
const child = spawn(
  process.execPath,
  [
    '--experimental-test-coverage',
    `--test-coverage-lines=${lines}`,
    `--test-coverage-functions=${functions}`,
    '--test-coverage-include=server/**',
    '--test',
    ...files,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENTFORGE_DATA_DIR: dataDir,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
      NODE_TEST_CONTEXT: undefined,
    },
  },
);

child.on('close', (code) => {
  if (code === 0) {
    try {
      fs.rmSync(dataDir, { recursive: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* best effort */
    }
  } else {
    console.error(`[coverage] 未达门槛（lines>=${lines}%, functions>=${functions}%），数据保留在 ${dataDir}`);
  }
  process.exitCode = code ?? 1;
});
