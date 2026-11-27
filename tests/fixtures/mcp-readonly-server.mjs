import readline from 'node:readline';

const mode = process.argv.includes('--hang') ? 'hang' : 'normal';

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (mode === 'hang') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      },
    })}\n`);
    return;
  }
  if (message.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'read_doc',
            description: 'Read a fixture document',
            annotations: { effect: 'read' },
            inputSchema: { type: 'object' },
          },
          {
            name: 'write_doc',
            description: 'Write a fixture document',
            annotations: { effect: 'write' },
            inputSchema: { type: 'object' },
          },
          {
            name: 'hinted_read',
            description: 'A standard MCP read-only hint',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object' },
          },
          {
            name: 'unannotated',
            description: 'A tool without an effect declaration',
            inputSchema: { type: 'object' },
          },
        ],
      },
    })}\n`);
    return;
  }
  if (message.method === 'tools/call') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          {
            type: 'text',
            text: `fixture:${message.params?.name}:${process.env.MCP_FIXTURE_SECRET || 'no-secret'}`,
          },
        ],
      },
    })}\n`);
  }
});

if (mode === 'hang') setInterval(() => {}, 1000);
