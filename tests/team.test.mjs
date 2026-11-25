import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-team-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { judgeHealth, pickRealTeam, isBuiltinSeat, baseName, collectCandidates } =
  await import('../server/team.mjs');
const { store } = await import('../server/store.mjs');

const cand = (key, health) => ({ key, label: key, path: key, args: [], health });

test('体检判定：正常回复 / 鉴权失败 / 超时收口', () => {
  assert.equal(judgeHealth({ code: 0, stdout: 'OK\n', stderr: '', elapsed: 100 }).ok, true);
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
