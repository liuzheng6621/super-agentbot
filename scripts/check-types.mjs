import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET_DIRS = ['server', 'public', 'scripts'];

function listFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      listFiles(abs, out);
    } else if (/\.(?:mjs|js)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Zero-dependency type gate.
 *
 * 1. Every file must parse (`node --check`), which catches syntax drift.
 * 2. Any JSDoc block that declares `@param` must name parameters that exist in
 *    the following function signature — the most common JSDoc rot.
 * 3. Return annotations must carry a type.
 *
 * The rules are intentionally opt-in per function so the gate can be introduced
 * without rewriting untouched modules, while still failing CI on malformed docs.
 */
function checkFunctionDocs(source, file) {
  const problems = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\/\*\*/.test(lines[index])) continue;
    let end = index;
    while (end < lines.length && !/\*\//.test(lines[end])) end += 1;
    const block = lines.slice(index, end + 1).join('\n');
    if (!/@param|@returns|@return\b/.test(block)) continue;

    let fnLine = end + 1;
    const signaturePattern = /(?:export\s+)?function\s+[A-Za-z_$]|=>/;
    while (fnLine < lines.length && !signaturePattern.test(lines[fnLine])) {
      if (/^\s*(?:export\s+)?(?:const|let)\s+[A-Za-z_$]/.test(lines[fnLine])) break;
      fnLine += 1;
      if (fnLine - end > 3) break;
    }
    const signatureLine = lines[fnLine] || '';
    const signature = (() => {
      let text = '';
      for (let i = fnLine; i < Math.min(fnLine + 6, lines.length); i += 1) {
        text += lines[i];
        if (/\)\s*(?:=>|\{)/.test(lines[i])) break;
      }
      return text;
    })();

    const params = [...block.matchAll(/@param\s+\{[^}]+\}\s+\[?([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1],
    );
    if (params.length && signature) {
      const argsPart = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'));
      const paramPattern = (name) => new RegExp(String.raw`(^|[\s,{])${name}(?:\s*(?:,|=|:|\})|$)`);
      for (const name of params) {
        if (!paramPattern(name).test(argsPart)) {
          problems.push(`${file}:${index + 1} @param ${name} 不在签名中（${signatureLine.trim().slice(0, 80)}）`);
        }
      }
    }
    for (const match of block.matchAll(/@returns?\s*(?:\{([^}]*)\})?/g)) {
      if (!match[1] || !match[1].trim()) {
        problems.push(`${file}:${index + 1} @returns 缺少类型`);
      }
    }
    index = end;
  }
  return problems;
}

const files = TARGET_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir)));
const problems = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const check = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (check.status !== 0) {
    problems.push(`${path.relative(ROOT, file)}: 语法错误 ${String(check.stderr || '').split('\n')[0]}`);
    continue;
  }
  problems.push(...checkFunctionDocs(source, path.relative(ROOT, file)));
}

if (problems.length) {
  console.error(`[types] ${problems.length} 处问题：`);
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`[types] ${files.length} 个文件通过 JSDoc 与语法门`);
