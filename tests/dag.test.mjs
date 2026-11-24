import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDag, runDag } from '../server/dag.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('独立分支并行，汇合节点等待全部依赖', async () => {
  const order = [];
  let active = 0;
  let peak = 0;
  const result = await runDag(
    [
      { id: 'arch', needs: [] },
      { id: 'code', needs: ['arch'] },
      { id: 'test', needs: ['arch'] },
      { id: 'review', needs: ['code', 'test'] },
    ],
    {
      maxConcurrency: 2,
      run: async (step) => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(`start:${step.id}`);
        await wait(25);
        active -= 1;
        order.push(`end:${step.id}`);
        return { ok: true, note: 'ok' };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(peak, 2);
  assert.ok(order.indexOf('start:review') > order.indexOf('end:code'));
  assert.ok(order.indexOf('start:review') > order.indexOf('end:test'));
});

test('失败节点的后代被阻断，独立分支继续执行', async () => {
  const visited = [];
  const result = await runDag(
    [
      { id: 'a', needs: [] },
      { id: 'b', needs: [] },
      { id: 'c', needs: ['a'] },
      { id: 'd', needs: ['c'] },
    ],
    {
      maxConcurrency: 2,
      run: async (step) => {
        visited.push(step.id);
        return step.id === 'a' ? { ok: false, note: 'boom' } : { ok: true };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(visited.sort(), ['a', 'b']);
  assert.equal(result.statuses.c, 'blocked');
  assert.equal(result.statuses.d, 'blocked');
  assert.equal(result.statuses.b, 'done');
});

test('拒绝缺失依赖和环路', () => {
  assert.throws(() => validateDag([{ id: 'a', needs: ['missing'] }]), /依赖不存在/);
  assert.throws(
    () =>
      validateDag([
        { id: 'a', needs: ['b'] },
        { id: 'b', needs: ['a'] },
      ]),
    /环路/,
  );
});

test('取消后停止调度且不启动新节点', async () => {
  const controller = new AbortController();
  const visited = [];
  const pending = runDag(
    [
      { id: 'a', needs: [] },
      { id: 'b', needs: ['a'] },
    ],
    {
      signal: controller.signal,
      run: async (step, { signal }) => {
        visited.push(step.id);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
        return { ok: true };
      },
    },
  );
  await wait(10);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.deepEqual(visited, ['a']);
});
