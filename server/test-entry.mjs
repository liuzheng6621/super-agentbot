import fs from 'node:fs';
import path from 'node:path';
import * as sim from './sim.mjs';

const PLACEHOLDER_TEST = /no test specified/i;
const NODE_TEST_FILE = /\.(?:test|spec)\.(?:m?js|cjs)$/i;

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
      if (typeof script === 'string' && script.trim() && !PLACEHOLDER_TEST.test(script)) {
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
