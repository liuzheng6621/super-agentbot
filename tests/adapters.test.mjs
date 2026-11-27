import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { resolveCommand, clearResolveCache, resolveStats } = await import('../server/adapters.mjs');

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
