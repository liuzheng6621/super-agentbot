/**
 * 零依赖 DAG 调度器。
 * - 只调度依赖已完成的节点
 * - 独立分支并行，失败节点的后代标记 blocked
 * - 支持取消，取消后不再启动新节点
 * - completed 用于把上一轮已完成的节点视为外部前置
 */

export function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export function validateDag(steps, completed = []) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('DAG 至少需要一个节点');
  const ids = new Set();
  for (const step of steps) {
    if (!step.id) throw new Error('DAG 节点缺少 id');
    if (ids.has(step.id)) throw new Error(`DAG 节点 id 重复：${step.id}`);
    ids.add(step.id);
  }
  const external = new Set(completed);
  for (const step of steps) {
    for (const need of step.needs || []) {
      if (!ids.has(need) && !external.has(need)) {
        throw new Error(`工序「${step.title || step.id}」依赖不存在：${need}`);
      }
      if (need === step.id) throw new Error(`工序「${step.id}」不能依赖自己`);
    }
  }

  const byId = new Map(steps.map((s) => [s.id, s]));
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    if (external.has(id)) return;
    const state = color.get(id) || 0;
    if (state === 1) {
      const start = stack.indexOf(id);
      throw new Error(`工序依赖存在环路：${[...stack.slice(start), id].join(' → ')}`);
    }
    if (state === 2) return;
    color.set(id, 1);
    stack.push(id);
    for (const need of byId.get(id).needs || []) visit(need);
    stack.pop();
    color.set(id, 2);
  };
  for (const step of steps) visit(step.id);
}

export async function runDag(
  steps,
  {
    run,
    onUpdate,
    signal,
    maxConcurrency = 2,
    completed = [],
    runId = '',
    resourceKey = (node) => node?.agentId || '',
  } = {},
) {
  if (typeof run !== 'function') throw new Error('runDag 缺少 run 回调');
  validateDag(steps, completed);

  const external = new Set(completed);
  const status = new Map(steps.map((s) => [s.id, 'pending']));
  const results = new Map();
  const active = new Set();
  const activeResources = new Map();
  const contexts = new Map();
  const limit = Math.max(1, Number(maxConcurrency) || 1);
  let executionSequence = 0;
  let failed = false;

  const keyFor = (node) => {
    const key = typeof resourceKey === 'function' ? resourceKey(node) : resourceKey;
    return String(key || '');
  };

  const update = (node, next, patch = {}) => {
    status.set(node.id, next);
    onUpdate?.(node.id, { status: next, ...patch }, contexts.get(node.id) || null);
  };

  const depStatus = (id) => (external.has(id) ? 'done' : status.get(id));

  const launch = (node) => {
    executionSequence += 1;
    const resource = keyFor(node);
    const context = {
      stepId: node.id,
      agentId: String(node.agentId || ''),
      executionId: `${runId || 'run'}:${node.id}:${executionSequence}`,
      runId: String(runId || ''),
    };
    contexts.set(node.id, context);
    if (resource) activeResources.set(resource, (activeResources.get(resource) || 0) + 1);
    update(node, 'running', { startedAt: Date.now() });
    const promise = Promise.resolve()
      .then(() => {
        throwIfAborted(signal);
        return run(node, { ...context, signal });
      })
      .then((result) => {
        if (signal?.aborted) throw abortError();
        results.set(node.id, result);
        if (result?.ok === false) {
          failed = true;
          update(node, 'error', {
            note: result.note || result.error || '工序失败',
            endedAt: Date.now(),
          });
        } else {
          update(node, 'done', {
            note: result?.note || '已完成',
            endedAt: Date.now(),
            verdict: result?.verdict,
          });
        }
      })
      .catch((err) => {
        const aborted = signal?.aborted || err?.name === 'AbortError';
        results.set(node.id, { ok: false, error: err?.message || String(err), aborted });
        if (!aborted) failed = true;
        update(node, aborted ? 'stopped' : 'error', {
          note: aborted ? '已停止' : err?.message || '工序异常',
          endedAt: Date.now(),
        });
      })
      .finally(() => {
        active.delete(promise);
        if (resource) {
          const count = Math.max(0, (activeResources.get(resource) || 1) - 1);
          if (count) activeResources.set(resource, count);
          else activeResources.delete(resource);
        }
      });
    active.add(promise);
  };

  try {
    while (true) {
      throwIfAborted(signal);

      let changed = true;
      while (changed) {
        changed = false;
        for (const node of steps) {
          if (status.get(node.id) !== 'pending') continue;
          const broken = (node.needs || []).some((id) =>
            ['error', 'blocked', 'stopped', 'skipped'].includes(depStatus(id)),
          );
          if (broken) {
            failed = true;
            update(node, 'blocked', { note: '上游工序未完成', endedAt: Date.now() });
            results.set(node.id, { ok: false, blocked: true });
            changed = true;
          }
        }
      }

      const ready = steps.filter(
        (node) =>
          status.get(node.id) === 'pending' &&
          (node.needs || []).every((id) => depStatus(id) === 'done'),
      );
      for (const node of ready) {
        if (active.size >= limit) break;
        const resource = keyFor(node);
        if (resource && activeResources.get(resource)) continue;
        launch(node);
      }

      if (active.size) {
        await Promise.race(active);
        continue;
      }

      const remaining = steps.some((node) => status.get(node.id) === 'pending');
      if (!remaining) break;
      throw new Error('DAG 无法继续：可能存在未识别依赖');
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      for (const node of steps) {
        const state = status.get(node.id);
        if (state === 'pending' || state === 'running') {
          update(node, 'stopped', { note: '已停止', endedAt: Date.now() });
        }
      }
      await Promise.allSettled([...active]);
    }
    throw err;
  }

  return {
    ok: !failed && steps.every((node) => status.get(node.id) === 'done'),
    results,
    statuses: Object.fromEntries(status),
  };
}
