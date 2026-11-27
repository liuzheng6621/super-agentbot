import fs from 'node:fs';
import path from 'node:path';

const [mode = 'ok'] = process.argv.slice(2);

if (mode === 'write') {
  fs.writeFileSync(path.join(process.cwd(), 'command-output.txt'), 'created by controlled command\n');
  process.stdout.write('wrote command-output.txt\n');
  process.exit(0);
}

if (mode === 'fail') {
  process.stderr.write('fixture command failed\n');
  process.exit(7);
}

if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(`fixture:${mode}\n`);
}
