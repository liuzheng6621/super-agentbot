import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { resolveCommand, clearResolveCache, resolveStats, CANDIDATES } = await import(
  '../server/adapters.mjs'
);
const { withProviderProfile } = await import('../server/providers.mjs');

const lookupKey = process.platform === 'win32' ? 'whereCalls' : 'whichCalls';

test('同一完整命令串只解析一次，/api/probe 的失效路径会重新解析', () => {
  clearResolveCache();
  const before = resolveStats[lookupKey];

  const first = resolveCommand('node');
  const second = resolveCommand('node');
  assert.ok(first);
  assert.equal(second, first);
  assert.equal(resolveStats[lookupKey], before + 1, '第二次必须命中进程级缓存');

  clearResolveCache();
  const third = resolveCommand('node');
  assert.equal(third, first);
  assert.equal(resolveStats[lookupKey], before + 2, '失效后必须重新查询 PATH');
});

test('缓存 key 保留完整命令串，但解析时优先取可执行名', () => {
  clearResolveCache();
  const misses = resolveStats.cacheMisses;

  const bare = resolveCommand('node');
  const withArgs = resolveCommand('node --version');
  const absoluteWithArgs = resolveCommand(`${process.execPath} --version`);
  assert.ok(bare);
  assert.equal(withArgs, bare, '参数不能污染可执行文件解析');
  assert.equal(path.resolve(absoluteWithArgs), path.resolve(process.execPath), '带空格的绝对路径也要正确剥离参数');
  assert.equal(resolveStats.cacheMisses, misses + 3, '带参数的命令串必须使用独立 key');
});

test('内置 CLI 候选不携带 Magpie 网关、模型或凭据参数', () => {
  const serialized = JSON.stringify(CANDIDATES).toLowerCase();
  for (const forbidden of [
    'magpie',
    '127.0.0.1:3425',
    'agentforge_model',
    'trae-cn/glm-5.3-flash',
    '--openai-api-key',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const claude = CANDIDATES.find((candidate) => candidate.command === 'claude');
  assert.ok(claude.args.includes('--permission-mode'));
  assert.ok(claude.args.includes('bypassPermissions'));
});

test('Provider cliBindings 注入模型、地址、密钥与 prompt', () => {
  const provider = {
    id: 'custom-gateway',
    name: 'Custom Gateway',
    baseUrl: 'https://gateway.example/v1',
    model: 'vision-model',
    apiKeyRef: 'TEST_PROVIDER_KEY',
    env: {},
    cliBindings: {
      gemini: {
        args: ['--model', '{{model}}', '--base-url', '{{baseUrl}}', '{{prompt}}'],
        env: {
          GEMINI_API_KEY: '{{apiKey}}',
          GOOGLE_GEMINI_BASE_URL: '{{baseUrl}}',
        },
      },
    },
  };
  const agent = {
    providerId: provider.id,
    cli: { command: 'gemini', args: ['--skip-trust'] },
  };
  const execution = withProviderProfile(agent, provider, {
    TEST_PROVIDER_KEY: 'secret-from-env',
  });
  assert.deepEqual(execution.cli.args, [
    '--model',
    'vision-model',
    '--base-url',
    'https://gateway.example/v1',
    '{{prompt}}',
  ]);
  assert.equal(execution.cli.env.GEMINI_API_KEY, 'secret-from-env');
  assert.equal(execution.cli.env.GOOGLE_GEMINI_BASE_URL, 'https://gateway.example/v1');
});
