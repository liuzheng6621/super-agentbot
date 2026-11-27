import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-team-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { judgeHealth, pickRealTeam, isBuiltinSeat, baseName, collectCandidates, checkCandidates } =
  await import('../server/team.mjs');
const { commandBaseName, commandKey } = await import('../server/command-key.mjs');
const { adoptInstalledClis, rebalanceTeam } = await import('../server/adopt.mjs');
const { store } = await import('../server/store.mjs');

const cand = (key, health) => ({ key, label: key, path: key, args: [], health });

test('体检判定：正常回复 / 鉴权失败 / 超时收口', () => {
  assert.equal(judgeHealth({ code: 0, stdout: 'OK\n', stderr: '', elapsed: 100 }).ok, true);
  assert.equal(
    judgeHealth({
      code: 0,
      stdout: '在线\n',
      stderr: 'WARN codex_core_plugins::manager: api key auth is not supported',
      elapsed: 100,
    }).ok,
    true,
    '正常短回复旁的 Codex 插件警告不应判死',
  );
  assert.equal(
    judgeHealth({ code: 1, stdout: 'API Error: 405 Not Allowed', stderr: '', elapsed: 100 }).ok,
    false,
    '网关 405 不能算可用',
  );
  assert.equal(
    judgeHealth({ code: 1, stdout: '', stderr: 'Please set an Auth method / GEMINI_API_KEY', elapsed: 100 }).ok,
    false,
    '未配置鉴权不能算可用',
  );
  assert.equal(
    judgeHealth({ code: 0, stdout: '', stderr: 'No providers configured', elapsed: 100 }).ok,
    false,
  );

  const soft = judgeHealth({
    code: -3,
    stdout: 'OK',
    stderr: 'Reading additional input from stdin...',
    elapsed: 25000,
  });
  assert.equal(soft.ok, true, '吐完结果后卡住 stdin 的 CLI 仍应视为可用');
  assert.match(soft.note, /进程未自行退出/);
  assert.equal(judgeHealth({ code: -3, stdout: '', stderr: '[超时]', elapsed: 25000 }).ok, false);
  assert.equal(judgeHealth({ code: 0, stdout: 'x'.repeat(500), stderr: '', elapsed: 100 }).ok, false);
});

test('只有一个可用 CLI 时，5 个席位都由它兼任', () => {
  const plan = pickRealTeam([
    cand('opencode', { ok: true, note: '在线' }),
    cand('gemini', { ok: false, note: '未配置 Auth' }),
  ]);
  assert.equal(plan.length, 5);
  assert.ok(plan.every((p) => p.candidate.key === 'opencode'), '能用的优先，且允许复用');
  assert.deepEqual(
    plan.map((p) => p.role),
    ['planner', 'architect', 'coder', 'tester', 'reviewer'],
  );
});

test('多个可用 CLI 时按角色偏好分给不同工具', () => {
  const plan = pickRealTeam([
    cand('claude', { ok: true }),
    cand('codex', { ok: true }),
    cand('opencode', { ok: true }),
    cand('gemini', { ok: false }),
  ]);
  assert.equal(plan.length, 5);
  assert.ok(plan.every((p) => p.candidate.health.ok), '体检失败的不能占席位');
  assert.ok(new Set(plan.map((p) => p.candidate.key)).size >= 2, '尽量别把 5 席全塞给同一个 CLI');
  assert.equal(plan.find((p) => p.role === 'coder').candidate.key, 'codex');
  assert.equal(plan.find((p) => p.role === 'planner').candidate.key, 'claude');
});

test('未体检的候选优先于体检失败的候选', () => {
  const plan = pickRealTeam([
    cand('claude', { ok: false, note: '405' }),
    cand('qwen', null),
  ]);
  assert.ok(plan.every((p) => p.candidate.key === 'qwen'));
});

test('空候选不产生席位', () => {
  assert.deepEqual(pickRealTeam([]), []);
});

test('内置演示席位能被识别，真实 CLI 不会被误判', () => {
  assert.equal(isBuiltinSeat({ builtin: true, mode: 'cli', name: 'Nova' }), true);
  assert.equal(isBuiltinSeat({ mode: 'sim', name: 'Kilo' }), true, '老数据没有 builtin 标记，靠名字兜底');
  assert.equal(isBuiltinSeat({ mode: 'cli', name: 'OpenCode' }), false);
  assert.equal(isBuiltinSeat({ mode: 'sim', name: '自定义' }), false);
});

test('baseName 把绝对路径与 .cmd/.exe 折成同一个 key', () => {
  assert.equal(baseName('C:\\Users\\six\\AppData\\Roaming\\npm\\opencode.cmd'), 'opencode');
  assert.equal(baseName('C:/Users/six/.local/bin/aider.exe'), 'aider');
  assert.equal(baseName('codex'), 'codex');
});

test('命令归一化不会把参数、引号或空格当成文件名', () => {
  assert.equal(commandBaseName('C:\\tools\\codex.exe'), 'codex');
  assert.equal(commandBaseName('C:/tools/codex.cmd'), 'codex');
  assert.equal(commandBaseName('codex'), 'codex');
  assert.equal(commandBaseName('"C:\\Program Files\\Codex CLI\\codex.exe" --sandbox read-only'), 'codex');
  assert.equal(commandBaseName('C:\\Program Files\\Codex CLI\\codex.exe --sandbox read-only'), 'codex');
  assert.equal(commandBaseName(''), '');
  assert.equal(commandKey('C:\\tools\\codex.exe'), 'codex');
  assert.equal(commandKey('"C:\\Program Files\\Codex CLI\\codex.exe" --version'), 'codex');
  assert.equal(commandKey(''), '');
});

test('接管同一 CLI 的不同路径与扩展名只创建一次', async () => {
  const candidates = [
    { found: true, command: 'codex', label: 'Codex CLI', path: 'C:\\tools\\codex.exe', args: [] },
    { found: true, command: 'codex', label: 'Codex CLI', path: 'C:/tools/codex.cmd', args: [] },
    { found: true, command: 'codex', label: 'Codex CLI', path: 'codex', args: [] },
  ];
  const result = await adoptInstalledClis({ probe: async () => candidates });
  assert.equal(result.created.length, 1);
  assert.equal(result.skipped.filter((item) => item.reason === '已在团队中').length, 2);
});

test('候选按命令名去重，并复用已持久化的体检缓存', () => {
  const probed = [
    { found: true, command: 'opencode', label: 'OpenCode', path: 'C:/x/opencode.cmd', args: ['run', '{{prompt}}'] },
    { found: true, command: 'C:/x/opencode.cmd', label: '重复项', path: 'C:/x/opencode.cmd', args: [] },
    { found: false, command: 'missing', label: '未安装' },
  ];
  const agents = [
    { mode: 'cli', cli: { command: 'C:/x/opencode.cmd' }, health: { ok: true, note: '在线' } },
  ];
  const list = collectCandidates(probed, agents);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'opencode');
  assert.equal(list[0].health.ok, true);
  assert.equal(list[0].path, 'C:/x/opencode.cmd');
});

test('真实体检会在独立临时工作区执行候选命令', async () => {
  const fixture = path.resolve('tests/fixtures/command-fixture.mjs');
  const candidates = [
    {
      key: 'fixture',
      label: 'Fixture',
      path: process.execPath,
      args: [fixture, 'ok'],
      health: null,
    },
  ];
  await checkCandidates(candidates);
  assert.equal(candidates[0].health.ok, true);
  assert.match(candidates[0].health.note, /在线|进程未自行退出/);
});

test('团队体检会把 Agent 的 Provider Profile 注入真实子进程', async () => {
  const fixture = path.resolve('tests/fixtures/team-observe-fixture.mjs');
  const output = path.join(temp, 'team-observe-provider.json');
  const provider = store.addProvider({
    id: 'team-observe-provider',
    name: 'Team Observe Provider',
    model: 'team-observe-model',
    cliBindings: {
      node: {
        args: [fixture, '--provider-arg', '{{model}}'],
        env: {
          TEAM_OBSERVE_OUT: output,
          TEAM_PROVIDER_MARKER: 'from-provider-binding',
        },
      },
    },
  });
  try {
    const agent = {
      id: 'team-observe-agent',
      mode: 'cli',
      providerId: provider.id,
      cli: { command: process.execPath, args: [fixture] },
    };
    const candidates = collectCandidates(
      [
        {
          found: true,
          command: process.execPath,
          label: 'Observe Fixture',
          path: process.execPath,
          args: [fixture],
        },
      ],
      [agent],
    );
    assert.ok(candidates[0].executionAgent, '匹配到 Agent 时必须生成 Provider 解析后的执行副本');
    await checkCandidates(candidates, { timeout: 5000 });
    assert.equal(candidates[0].health.ok, true, candidates[0].health.note);

    const observed = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(path.basename(observed.cwd).startsWith('af-team-'), true);
    assert.deepEqual(observed.argv, ['--provider-arg', 'team-observe-model']);
    assert.equal(observed.stdin, 'Reply with exactly: OK\n');
    assert.equal(observed.env.TEAM_PROVIDER_MARKER, 'from-provider-binding');
    assert.equal(observed.env.AGENTFORGE_PROVIDER_ID, provider.id);
    assert.equal(observed.env.AGENTFORGE_PROVIDER_NAME, provider.name);
    assert.equal(observed.env.AGENTFORGE_MODEL, provider.model);
  } finally {
    store.removeProvider(provider.id);
  }
});

test(
  '团队体检对 Windows .cmd 使用真实 Provider 环境并通过 stdin 传 prompt',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = fs.mkdtempSync(path.join(temp, 'team-cmd-'));
    const fixture = path.resolve('tests/fixtures/team-observe-fixture.mjs');
    const output = path.join(dir, 'team-observe-cmd.json');
    const command = path.join(dir, 'team-observe.cmd');
    fs.writeFileSync(
      command,
      ['@echo off', `"${process.execPath}" "${fixture}" %*`, ''].join('\r\n'),
      'utf8',
    );
    const provider = store.addProvider({
      id: 'team-observe-cmd-provider',
      name: 'Team Observe CMD Provider',
      cliBindings: {
        'team-observe': {
          env: {
            TEAM_OBSERVE_OUT: output,
            TEAM_PROVIDER_MARKER: 'from-cmd-provider',
          },
        },
      },
    });
    try {
      const agent = {
        id: 'team-observe-cmd-agent',
        mode: 'cli',
        providerId: provider.id,
        cli: { command, args: ['--from-agent', 'a & b'] },
      };
      const candidates = collectCandidates(
        [
          {
            found: true,
            command,
            label: 'Team Observe CMD',
            path: command,
            args: ['--from-agent', 'a & b'],
          },
        ],
        [agent],
      );
      await checkCandidates(candidates, { timeout: 5000 });
      assert.equal(candidates[0].health.ok, true, candidates[0].health.note);

      const observed = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.equal(path.basename(observed.cwd).startsWith('af-team-'), true);
      assert.deepEqual(observed.argv, ['--from-agent', 'a & b']);
      assert.equal(observed.stdin, 'Reply with exactly: OK\n');
      assert.equal(observed.env.TEAM_PROVIDER_MARKER, 'from-cmd-provider');
      assert.equal(observed.env.AGENTFORGE_PROVIDER_ID, provider.id);
    } finally {
      store.removeProvider(provider.id);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    }
  },
);

test('新接入的 CLI 不再是内置席位，且带体检字段', () => {
  const a = store.addAgent({ name: '真实成员', mode: 'cli', cli: { command: 'opencode' } });
  assert.equal(a.builtin, false);
  assert.equal(a.health, null);
  assert.equal(store.getAgent(a.id).builtin, false);
});

test.after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 上偶发占用，交给系统清理 */
  }
});
