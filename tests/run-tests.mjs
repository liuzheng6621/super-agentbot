import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-test-data-'));
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'all';
const selected = process.argv.slice(3);
const files = selected.length
  ? selected
  : fs
      .readdirSync(testsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
      .map((entry) => path.join('tests', entry.name))
      .sort();

if (!files.length) {
  console.error(`[test] 没有找到测试文件（mode=${mode}）`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    AGENTFORGE_DATA_DIR: dataDir,
    NODE_TEST_CONTEXT: undefined,
  },
});

child.on('error', (err) => {
  console.error(`[test] 无法启动测试进程: ${err.message}`);
  console.error(`[test] 测试数据保留在 ${dataDir}`);
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  if (exitCode !== 0) {
    console.error(`[test] 测试失败，临时数据保留在 ${dataDir}`);
    process.exitCode = exitCode;
    return;
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch (err) {
    console.error(`[test] 测试通过，但临时数据清理失败: ${dataDir}: ${err.message}`);
  }
  process.exitCode = 0;
});
