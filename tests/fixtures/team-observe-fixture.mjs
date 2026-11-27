import fs from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const output = process.env.TEAM_OBSERVE_OUT;
if (output) {
  fs.writeFileSync(
    output,
    JSON.stringify({
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      stdin: Buffer.concat(chunks).toString('utf8'),
      env: {
        TEAM_PROVIDER_MARKER: process.env.TEAM_PROVIDER_MARKER || '',
        AGENTFORGE_PROVIDER_ID: process.env.AGENTFORGE_PROVIDER_ID || '',
        AGENTFORGE_PROVIDER_NAME: process.env.AGENTFORGE_PROVIDER_NAME || '',
        AGENTFORGE_MODEL: process.env.AGENTFORGE_MODEL || '',
      },
    }),
    'utf8',
  );
}

process.stdout.write('OK\n');
