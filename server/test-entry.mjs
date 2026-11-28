import fs from 'node:fs';
import path from 'node:path';
import * as sim from './sim.mjs';

const NODE_TEST_FILE = /\.(?:test|spec)\.(?:m?js|cjs)$/i;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR = /^(?:tests?|__tests__|spec)\//i;

// `exit 0`、`true`、`:`、纯 echo 这类脚本永远通过，不能作为质量门依据。
const TRIVIAL_SCRIPTS = [
  /^no test specified\.?$/i,
  /^exit\s+0$/i,
  /^true$/i,
  /^:$/,
  /^(?:echo|printf|rem|@echo)\b[^&|;]*$/i,
  /^(?:echo|printf)\b[^&|;]*(?:&&|\|\|)\s*(?:exit\s+0|true)\s*$/i,
  /^node\s+-e\s+["']{2}$/i,
];

export function isTrivialTestScript(script = '') {
  const text = String(script || '').trim().replace(/^["']|["']$/g, '');
  if (!text) return true;
  // npm 初始化的占位脚本（echo "Error: no test specified" && exit 1）同样是占位。
  if (/no test specified/i.test(text)) return true;
  return TRIVIAL_SCRIPTS.some((pattern) => pattern.test(text));
}

/** Test files are any path under tests/ or matching *.test/*.spec. */
export function isTestFile(filePath = '') {
  const value = String(filePath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  return TEST_DIR.test(value) || TEST_FILE.test(value);
}

/**
 * Parse runner output for real pass/fail evidence. Exit code alone is not
 * evidence: `exit 0`, an empty echo or a crashed runner can all look green.
 */
export function testEvidence(output = '') {
  const text = String(output || '');
  const readCount = (pattern) => {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const nodePass = readCount(/^#\s*pass\s+(\d+)/im);
  const nodeFail = readCount(/^#\s*fail\s+(\d+)/im);
  const tapOk = (text.match(/^ok\s+\d+/gm) || []).length;
  const tapNotOk = (text.match(/^not ok\s+\d+/gm) || []).length;
  const jestPass = readCount(/(\d+)\s+passing/i);
  const jestFail = readCount(/(\d+)\s+failing/i);
  const pytestPass = readCount(/(\d+)\s+passed/i);
  const pytestFail = readCount(/(\d+)\s+failed/i);
  const nodeSummaryPass = readCount(/^\s*ℹ\s*pass\s+(\d+)\s*$/im);
  const nodeSummaryFail = readCount(/^\s*ℹ\s*fail\s+(\d+)\s*$/im);
  const cargoOk = /test result:\s*ok\./i.test(text);
  const cargoFail = readCount(/(\d+)\s+failed/i);
  const goOk = /^ok\s+\S+/m.test(text);
  const goFail = /^FAIL\s+\S+/m.test(text);

  const passedFirst = nodePass ?? nodeSummaryPass ?? jestPass ?? pytestPass;
  const passed = passedFirst === null || passedFirst === undefined
    ? tapOk || (cargoOk ? 1 : 0) || (goOk ? 1 : 0)
    : passedFirst;
  const failedFirst = nodeFail ?? nodeSummaryFail ?? jestFail ?? pytestFail;
  const failed = failedFirst === null || failedFirst === undefined
    ? tapNotOk + (cargoFail || 0) + (goFail ? 1 : 0)
    : failedFirst;
  const hasEvidence =
    nodePass !== null ||
    nodeSummaryPass !== null ||
    jestPass !== null ||
    pytestPass !== null ||
    tapOk > 0 ||
    tapNotOk > 0 ||
    cargoOk ||
    goOk ||
    goFail ||
    /(?:^|\s)(?:PASS|FAIL)(?:\s|$)/m.test(text);
  return {
    hasEvidence,
    passed: Math.max(0, Number(passed) || 0),
    failed: Math.max(0, Number(failed) || 0),
    source:
      nodePass !== null || nodeSummaryPass !== null
        ? 'node-test'
        : jestPass !== null
          ? 'jest'
          : pytestPass !== null
            ? 'pytest'
            : 'generic',
  };
}

/** Which files changed this run, and whether any of them is a test file. */
export function testScope(task) {
  const changed = (task?.fileChanges || [])
    .map((item) => String(item?.path || '').replace(/\\/g, '/'))
    .filter(Boolean);
  const testFiles = changed.filter(isTestFile);
  return {
    changedFiles: changed,
    testFiles,
    status: testFiles.length ? 'tests-touched' : changed.length ? 'no-test-file-changed' : 'no-changes',
  };
}

export function commandText(command, args = []) {
  return [command, ...args]
    .map((part) => {
      const value = String(part ?? '');
      return /[\s"'&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
    })
    .join(' ');
}

export function discoverNodeTestFiles(root) {
  const testsDir = path.join(root, 'tests');
  let stat;
  try {
    stat = fs.statSync(testsDir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile() && NODE_TEST_FILE.test(entry.name)) {
        found.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  visit(testsDir);
  return found.sort();
}

/**
 * Detect a real test entry in the workspace. Return null when none exists so
 * the quality gate can report `no-test-entry` instead of silently passing.
 */
export function detectTestCommand(task) {
  const root = task.workspace;
  const abs = (rel) => path.join(root, rel);
  const exists = (rel) => {
    try {
      return fs.existsSync(abs(rel));
    } catch {
      return false;
    }
  };
  const read = (rel) => {
    try {
      return fs.readFileSync(abs(rel), 'utf8');
    } catch {
      return '';
    }
  };

  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(read('package.json').replace(/^\uFEFF/, ''));
      const script = pkg?.scripts?.test;
      if (typeof script === 'string' && script.trim() && !isTrivialTestScript(script)) {
        return {
          command: 'npm',
          args: ['test', '--silent'],
          label: 'npm test',
          source: `package.json scripts.test: ${script.trim().slice(0, 80)}`,
        };
      }
    } catch {
      /* A broken package.json has no usable test entry. */
    }
  }
  if (exists('Makefile') && /^test\s*:/m.test(read('Makefile'))) {
    return { command: 'make', args: ['test'], label: 'make test', source: 'Makefile' };
  }
  const pyproject = read('pyproject.toml');
  const hasPytestConfig =
    exists('pytest.ini') ||
    exists('tox.ini') ||
    /^\s*\[tool\.pytest(?:\]|\.)/m.test(pyproject) ||
    /^\s*\[tool:pytest\]/m.test(read('setup.cfg'));
  if (hasPytestConfig) {
    return { command: 'python', args: ['-m', 'pytest', '-q'], label: 'pytest', source: 'Python 测试配置' };
  }
  if (exists('Cargo.toml')) {
    return { command: 'cargo', args: ['test', '--quiet'], label: 'cargo test', source: 'Cargo.toml' };
  }
  if (exists('go.mod')) {
    return { command: 'go', args: ['test', './...'], label: 'go test ./...', source: 'go.mod' };
  }
  const nodeTests = discoverNodeTestFiles(root);
  if (nodeTests.length) {
    return {
      command: process.execPath,
      args: ['--test', ...nodeTests],
      label: `node --test ${nodeTests.join(' ')}`,
      source: 'tests/ 目录',
    };
  }
  const rel = `tests/${sim.pickModule(task.goal).name}.test.js`;
  if (exists(rel)) {
    return { command: process.execPath, args: [rel], label: `node ${rel}`, source: '关键词模板' };
  }
  return null;
}
