import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

test('项目保持零运行时依赖，克隆后只需 Node.js 即可启动', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const entries = Object.keys(manifest[field] || {});
    assert.deepEqual(entries, [], `${field} 必须为空，实际包含：${entries.join(', ')}`);
  }
});
