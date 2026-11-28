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

test('同一 Agent 的就绪节点串行，不同 Agent 仍可并行', async () => {
  let activeSame = 0;
  let peakSame = 0;
  let activeOther = 0;
  let peakOther = 0;
  let activeAll = 0;
  let peakAll = 0;
  const contexts = new Map();
  const order = [];
  const result = await runDag(
    [
      { id: 'coder-a', agentId: 'coder-1', needs: [] },
      { id: 'coder-b', agentId: 'coder-1', needs: [] },
      { id: 'tester-a', agentId: 'tester-1', needs: [] },
    ],
    {
      maxConcurrency: 3,
      resourceKey: (step) => step.agentId,
      run: async (step, context) => {
        contexts.set(step.id, context);
        activeAll += 1;
        peakAll = Math.max(peakAll, activeAll);
        if (step.agentId === 'coder-1') {
          activeSame += 1;
          peakSame = Math.max(peakSame, activeSame);
        } else {
          activeOther += 1;
          peakOther = Math.max(peakOther, activeOther);
        }
        order.push(`start:${step.id}`);
        await wait(30);
        order.push(`end:${step.id}`);
        if (step.agentId === 'coder-1') activeSame -= 1;
        else activeOther -= 1;
        activeAll -= 1;
        return { ok: true };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(peakSame, 1, '同一 Agent 不能并发执行两个节点');
  assert.equal(peakOther, 1);
  assert.equal(peakAll, 2, '不同 Agent 应能并行');
  assert.ok(order.indexOf('start:tester-a') < order.indexOf('end:coder-a'));
  assert.notEqual(contexts.get('coder-a').executionId, contexts.get('coder-b').executionId);
  assert.equal(contexts.get('coder-a').stepId, 'coder-a');
  assert.equal(contexts.get('coder-b').stepId, 'coder-b');
  assert.equal(contexts.get('coder-a').agentId, 'coder-1');
});

test('资源约束不影响原有未声明资源键的并行行为', async () => {
  let active = 0;
  let peak = 0;
  const result = await runDag(
    [
      { id: 'a', needs: [] },
      { id: 'b', needs: [] },
    ],
    {
      maxConcurrency: 2,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await wait(20);
        active -= 1;
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(peak, 2);
});
