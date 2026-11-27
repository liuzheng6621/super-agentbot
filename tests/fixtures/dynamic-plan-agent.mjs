import fs from 'node:fs';
import path from 'node:path';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function write(relPath, content) {
  const abs = path.join(process.cwd(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const close = (text) => process.stdout.write(text.trim() + '\n');
const hasGoal = (text) => prompt.includes(text);
const singleModuleFeature = hasGoal('SINGLE_MODULE_FEATURE');
const bugfixOnly = hasGoal('BUGFIX_ONLY');

function requirePrompt(condition, message) {
  if (condition) return;
  process.stderr.write(`prompt contract failed: ${message}\n`);
  process.exit(12);
}

if (singleModuleFeature && prompt.includes('PLAN CONTRACT v1')) {
  close([
    'Plan for one module without an architecture-only step.',
    '',
    '```json',
    JSON.stringify({
      steps: [
        {
          id: 'feature',
          title: 'Implement greeting module',
          role: 'coder',
          needs: ['plan'],
          outputPaths: ['src/greeting.js'],
        },
        {
          id: 'tests',
          title: 'Test greeting module',
          role: 'tester',
          needs: ['feature'],
          outputPaths: ['tests/greeting.test.js'],
        },
        {
          id: 'final-review',
          title: 'Review greeting module',
          role: 'reviewer',
          needs: ['tests'],
          outputPaths: [],
        },
      ],
    }),
    '```',
    '下一步建议：实现、测试并评审单模块功能。',
  ].join('\n'));
} else if (singleModuleFeature && prompt.includes('STEP_ID: feature')) {
  requirePrompt(prompt.includes('中文验收：生成问候语'), 'Chinese goal missing');
  requirePrompt(prompt.includes('"双引号"'), 'double quotes missing');
  requirePrompt(prompt.includes('第一行\n第二行'), 'multiline goal missing');
  write(
    'src/greeting.js',
    "export function greeting(name) {\n  return `你好，${name}！`;\n}\n",
  );
  close('Implemented the single-module greeting feature.\n下一步建议：补充回归测试。');
} else if (singleModuleFeature && prompt.includes('STEP_ID: tests')) {
  write(
    'tests/greeting.test.js',
    [
      "import assert from 'node:assert/strict';",
      "import { greeting } from '../src/greeting.js';",
      "assert.equal(greeting('世界'), '你好，世界！');",
      "console.log('single-module CLI acceptance passed');",
      '',
    ].join('\n'),
  );
  close('Added greeting regression coverage.\n下一步建议：进入最终评审。');
} else if (singleModuleFeature && prompt.includes('STEP_ID: review')) {
  close([
    'The greeting module and its regression test are present.',
    'VERDICT: {"decision":"PASS","blockers":0,"should":0}',
  ].join('\n'));
} else if (bugfixOnly && prompt.includes('PLAN CONTRACT v1')) {
  close([
    'Bug fix plan deliberately omits the architecture-only step.',
    '',
    '```json',
    JSON.stringify({
      steps: [
        {
          id: 'bugfix',
          title: 'Fix calculator overflow',
          role: 'coder',
          needs: ['plan'],
          outputPaths: ['src/calculator.js'],
        },
        {
          id: 'regression',
          title: 'Add overflow regression test',
          role: 'tester',
          needs: ['bugfix'],
          outputPaths: ['tests/calculator.test.js'],
        },
        {
          id: 'final-review',
          title: 'Review bug fix',
          role: 'reviewer',
          needs: ['regression'],
          outputPaths: [],
        },
      ],
    }),
    '```',
    '下一步建议：直接修复缺陷并回归验证。',
  ].join('\n'));
} else if (bugfixOnly && prompt.includes('STEP_ID: bugfix')) {
  write(
    'src/calculator.js',
    [
      'export function add(a, b) {',
      '  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {',
      "    throw new RangeError('unsafe integer');",
      '  }',
      '  const result = a + b;',
      '  if (!Number.isSafeInteger(result)) {',
      "    throw new RangeError('unsafe integer');",
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'),
  );
  close('Fixed overflow handling.\n下一步建议：运行回归测试。');
} else if (bugfixOnly && prompt.includes('STEP_ID: regression')) {
  write(
    'tests/calculator.test.js',
    [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/calculator.js';",
      "assert.equal(add(2, 3), 5);",
      "assert.throws(() => add(Number.MAX_SAFE_INTEGER, 1), RangeError);",
      "console.log('bug-fix CLI acceptance passed');",
      '',
    ].join('\n'),
  );
  close('Added overflow regression coverage.\n下一步建议：进入最终评审。');
} else if (bugfixOnly && prompt.includes('STEP_ID: review')) {
  close([
    'The bug fix is scoped and the regression test covers the overflow path.',
    'VERDICT: {"decision":"PASS","blockers":0,"should":0}',
  ].join('\n'));
} else if (hasGoal('动态计划返工夹具') && prompt.includes('STEP_ID: review')) {
  close([
    'The first review found issues in both implementation modules.',
    '- `src/core.js`: missing the repaired marker.',
    '- `src/api.js`: missing the repaired marker.',
    'VERDICT: {"decision":"FAIL","blockers":2,"should":0}',
  ].join('\n'));
} else if (hasGoal('动态计划返工夹具') && prompt.includes('STEP_ID: fix-1')) {
  write('src/core.js', "export const core = 'core repaired';\n");
  write('src/api.js', "export const api = 'api repaired';\n");
  close('Repaired both implementation modules.\n下一步建议：回归验证。');
} else if (hasGoal('动态计划返工夹具') && prompt.includes('STEP_ID: retest-1')) {
  write(
    'tests/core.test.js',
    [
      "import assert from 'node:assert/strict';",
      "import { core } from '../src/core.js';",
      "import { api } from '../src/api.js';",
      "assert.equal(core, 'core repaired');",
      "assert.equal(api, 'api repaired');",
      "console.log('dynamic plan repair fixture passed');",
      '',
    ].join('\n'),
  );
  close('Wrote the regression test after repair.\n下一步建议：复评。');
} else if (hasGoal('动态计划返工夹具') && prompt.includes('STEP_ID: re-review-1')) {
  close([
    'Both repaired modules now satisfy the original blockers.',
    'VERDICT: {"decision":"PASS","blockers":0,"should":0}',
  ].join('\n'));
} else if (prompt.includes('PLAN CONTRACT v1')) {
  const steps = [
    {
      id: 'core',
      title: 'Implement core module',
      role: 'coder',
      needs: ['plan'],
      outputPaths: ['src/core.js'],
    },
    {
      id: 'api',
      title: 'Implement API module',
      role: 'coder',
      needs: ['plan'],
      outputPaths: ['src/api.js'],
    },
    {
      id: 'tests',
      title: 'Write regression tests',
      role: 'tester',
      needs: ['core', 'api'],
      outputPaths: ['tests/core.test.js'],
    },
    {
      id: 'final-review',
      title: 'Final review',
      role: 'reviewer',
      needs: ['tests'],
      outputPaths: [],
    },
  ];
  close([
    'Plan generated by the dynamic-plan fixture.',
    '',
    '```json',
    JSON.stringify({ steps }),
    '```',
    '下一步建议：实现两个模块，然后测试并评审。',
  ].join('\n'));
} else if (prompt.includes('STEP_ID: core')) {
  await wait(120);
  write('src/core.js', "export const core = 'core';\n");
  close('Implemented the core module.\n下一步建议：实现 API 模块。');
} else if (prompt.includes('STEP_ID: api')) {
  await wait(120);
  write('src/api.js', "export const api = 'api';\n");
  close('Implemented the API module.\n下一步建议：编写回归测试。');
} else if (prompt.includes('STEP_ID: tests')) {
  write(
    'tests/core.test.js',
    [
      "import assert from 'node:assert/strict';",
      "import { core } from '../src/core.js';",
      "import { api } from '../src/api.js';",
      "assert.equal(core, 'core');",
      "assert.equal(api, 'api');",
      "console.log('dynamic plan fixture passed');",
      '',
    ].join('\n'),
  );
  close('Wrote regression tests.\n下一步建议：最终评审。');
} else if (prompt.includes('STEP_ID: implement')) {
  await wait(120);
  write('src/feature.js', "export const feature = 'feature';\n");
  close('Implemented the feature module.\n下一步建议：补齐测试设计。');
} else if (prompt.includes('STEP_ID: test-design')) {
  write(
    'tests/core.test.js',
    [
      "import assert from 'node:assert/strict';",
      "import { feature } from '../src/feature.js';",
      "assert.equal(feature, 'feature');",
      "console.log('fallback plan fixture passed');",
      '',
    ].join('\n'),
  );
  close('Designed regression tests.\n下一步建议：最终评审。');
} else if (prompt.includes('STEP_ID: design')) {
  write('docs/feature-design.md', '# Feature design\n');
  close('Documented the interface contract.\n下一步建议：实现功能。');
} else if (prompt.includes('STEP_ID: review')) {
  close([
    'Core and API artifacts exist and the generated test covers both.',
    'VERDICT: {"decision":"PASS","blockers":0,"should":0}',
  ].join('\n'));
} else {
  close('Dynamic-plan fixture received an unrecognized task.\n下一步建议：检查夹具。');
}
