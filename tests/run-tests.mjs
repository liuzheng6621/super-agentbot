import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-test-data-'));
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

// 每个测试文件独立数据目录：分片与租约都以数据目录为边界，
// 共享目录会让不同用例看到彼此的任务，产生跨文件假失败。
const cpuCount = os.cpus()?.length || 2;
const defaultConcurrency = Math.max(2, Math.min(4, cpuCount - 1));
const concurrency = Math.max(
  1,
  Math.min(8, Number(process.env.AGENTFORGE_TEST_CONCURRENCY) || defaultConcurrency),
);

function dataDirFor(file) {
  const safe = path.basename(file, '.test.mjs').replace(/[^\w.-]/g, '-');
  const dir = path.join(rootDir, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        AGENTFORGE_DATA_DIR: dataDirFor(file),
        AGENTFORGE_SKIP_TEAM_BOOTSTRAP: process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP ?? '1',
        NODE_TEST_CONTEXT: undefined,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (err) => {
      resolve({ file, code: 1, output: `${output}\n${err.message}` });
    });
    child.on('close', (code, signal) => {
      resolve({ file, code: code ?? (signal ? 1 : 0), output });
    });
  });
}

const queue = [...files];
const results = [];
const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) {
    const file = queue.shift();
    const result = await runFile(file);
    results.push(result);
    if (result.code === 0) {
      // 成功文件只留一行，失败文件保留完整 TAP 输出。
      const passMatch = result.output.match(/^# pass (\d+)/m);
      console.log(`[test] ok ${file} (${passMatch ? passMatch[1] : '?'} tests)`);
    } else {
      // GitHub Actions 会把 ::error:: 提取成注解，失败文件在运行页就能看到。
      if (process.env.GITHUB_ACTIONS === 'true') {
        const names = [...result.output.matchAll(/^not ok \d+ - (.+)$/gm)]
          .map((match) => match[1].trim())
          .slice(0, 5);
        console.error(
          `::error file=${file}::测试文件失败 ${file}${names.length ? `：${names.join(' / ')}` : ''}`,
        );
      }
      console.error(`[test] FAIL ${file}\n${result.output}`);
    }
  }
});

await Promise.all(workers);
const failed = results.filter((result) => result.code !== 0);
const total = results.length;

if (failed.length) {
  console.error(`[test] ${failed.length}/${total} 个测试文件失败，数据保留在 ${rootDir}`);
  process.exitCode = 1;
} else {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch (err) {
    console.error(`[test] 测试通过，但临时数据清理失败: ${rootDir}: ${err.message}`);
  }
  console.log(`[test] ${total} 个测试文件全部通过`);
  process.exitCode = 0;
}
