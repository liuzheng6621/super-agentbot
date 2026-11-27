import { spawnSync } from 'node:child_process';

const listed = spawnSync(
  'git',
  ['ls-files', '-z', '-co', '--exclude-standard', '--', '*.js', '*.mjs'],
  { encoding: 'utf8' },
);

if (listed.error) {
  console.error(`[syntax] failed to list files: ${listed.error.message}`);
  process.exit(1);
}

if (listed.status !== 0) {
  if (listed.stderr) process.stderr.write(listed.stderr);
  console.error(`[syntax] git ls-files exited with code ${listed.status}`);
  process.exit(1);
}

const files = listed.stdout
  .split('\0')
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right, 'en'));

if (files.length === 0) {
  console.error('[syntax] no .js or .mjs files found');
  process.exit(1);
}

let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`ok ${file}`);
    continue;
  }

  failed += 1;
  console.error(`FAIL ${file}`);
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
}

console.log(`[syntax] ${files.length - failed}/${files.length} files passed`);
if (failed > 0) process.exitCode = 1;
