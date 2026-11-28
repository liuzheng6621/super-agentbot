import { normalizeTaskPriority, store } from './store.mjs';
import { DEFAULT_PROVIDER_ID, providerRoute } from './providers.mjs';

/**
 * Task-level scheduler.
 *
 * The DAG scheduler decides which steps inside one task can run in parallel.
 * This scheduler is deliberately above it: it decides which tasks may enter
 * the process at all, and enforces provider quotas plus explicit agent leases.
 */

const queue = [];
const active = new Map();
const agentLeases = new Map();
const agentWaiters = [];
let executor = null;
let dispatching = false;
let queueSeq = 0;
const LEASE_HEARTBEAT_MS = 10000;
const PRIORITY_RANK = {
  high: 3,
  normal: 2,
  low: 1,
};

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function priorityRank(priority) {
  return PRIORITY_RANK[normalizeTaskPriority(priority)];
}

function compareQueueEntries(left, right) {
  const byPriority = priorityRank(right.priority) - priorityRank(left.priority);
  if (byPriority) return byPriority;
  return Number(left.queueSeq || 0) - Number(right.queueSeq || 0);
}

function sortQueue() {
  queue.sort(compareQueueEntries);
}

function taskProviderIds(task, options = {}) {
  const resources = task?.resources || {};
  const explicit = options.providerIds || resources.providerIds;
  if (Array.isArray(explicit) && explicit.length) return unique(explicit.map(String));

  const fromPlan = (task?.plan || [])
    .map((step) => store.getAgent(step.agentId))
    .filter(Boolean)
    .map((agent) => providerRoute(agent, store.providers)[0]?.id || agent.providerId || DEFAULT_PROVIDER_ID);
  if (fromPlan.length) return unique(fromPlan);

  const seats = store.agents
    .filter((agent) => agent.seat !== false)
    .map((agent) => providerRoute(agent, store.providers)[0]?.id || agent.providerId || DEFAULT_PROVIDER_ID);
  return unique(seats.length ? seats : [DEFAULT_PROVIDER_ID]);
}

function taskAgentIds(task, options = {}) {
  const resources = task?.resources || {};
  const explicit = options.agentIds || resources.agentIds;
  return Array.isArray(explicit) ? unique(explicit.map(String)) : [];
}

function maxTaskConcurrency() {
  return Math.max(1, Number(store.db.settings.maxTaskConcurrency) || 2);
}

function providerUsage(providerId) {
  let count = 0;
  for (const item of active.values()) {
    if (item.providerIds.includes(providerId)) count += 1;
  }
  return count;
}

function providerLimit(providerId) {
  const provider = store.getProvider(providerId);
  if (!provider || provider.enabled === false) return 0;
  return Math.max(1, Number(provider.maxConcurrency) || 1);
}

function agentLimit(agentId) {
  return Math.max(1, Number(store.getAgent(agentId)?.maxConcurrency) || 1);
}

function agentName(agentId) {
  return store.getAgent(agentId)?.name || agentId;
}

function waitingReason(entry) {
  const reasons = [];
  const limit = maxTaskConcurrency();
  if (active.size >= limit) {
    reasons.push(`等待全局并发槽（${active.size}/${limit}）`);
  }
  for (const providerId of entry.providerIds) {
    const provider = store.getProvider(providerId);
    if (!provider || provider.enabled === false) {
      reasons.push(`Provider「${provider?.name || providerId}」已停用`);
      continue;
    }
    const used = providerUsage(providerId);
    const cap = providerLimit(providerId);
    if (used >= cap) reasons.push(`等待 Provider「${provider.name}」（${used}/${cap}）`);
  }
  for (const agentId of entry.agentIds) {
    const lease = agentLeases.get(agentId);
    if (!lease) continue;
    const current = lease.byTask.get(entry.taskId) || 0;
    const limit = agentLimit(agentId);
    if (current === 0 && lease.total >= limit) {
      reasons.push(`等待 Agent「${agentName(agentId)}」（${lease.total}/${limit}）`);
    }
  }
  return reasons.join('；');
}

function canRun(entry) {
  if (!entry.leaseOwned) return false;
  if (active.has(entry.taskId)) return false;
  if (active.size >= maxTaskConcurrency()) return false;
  for (const providerId of entry.providerIds) {
    const provider = store.getProvider(providerId);
    if (!provider || provider.enabled === false) return false;
    if (providerUsage(providerId) >= providerLimit(providerId)) return false;
  }
  for (const agentId of entry.agentIds) {
    const lease = agentLeases.get(agentId);
    if (!lease) continue;
    const current = lease.byTask.get(entry.taskId) || 0;
    if (current === 0 && lease.total >= agentLimit(agentId)) return false;
  }
  return true;
}

function renewEntryLease(entry) {
  const lease = store.renewTaskLease(entry.taskId);
  if (!lease) {
    entry.leaseOwned = false;
    entry.waitingReason = '任务租约已失效';
    return false;
  }
  return true;
}

function startEntryLeaseHeartbeat(entry) {
  if (entry.leaseTimer) return;
  entry.leaseTimer = setInterval(() => {
    renewEntryLease(entry);
  }, LEASE_HEARTBEAT_MS);
  entry.leaseTimer.unref?.();
}

function stopEntryLeaseHeartbeat(entry) {
  if (!entry.leaseTimer) return;
  clearInterval(entry.leaseTimer);
  entry.leaseTimer = null;
}

function releaseEntryLease(entry) {
  stopEntryLeaseHeartbeat(entry);
  store.releaseTaskLease(entry.taskId);
  store.releaseProviderSlots(entry.taskId);
  entry.leaseOwned = false;
}

function refreshQueuePositions() {
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    const reason = waitingReason(entry);
    entry.waitingReason = reason;
    const task = store.getTask(entry.taskId);
    if (!task) continue;
    const patch = {
      status: 'queued',
      queuePosition: index + 1,
      waitingReason: reason,
    };
    if (task.queuePosition !== patch.queuePosition || task.waitingReason !== patch.waitingReason) {
      store.updateTask(entry.taskId, patch, 'task.queue');
    }
  }
}

function acquireExplicitAgents(entry) {
  for (const agentId of entry.agentIds) {
    const current = agentLeases.get(agentId) || {
      byTask: new Map(),
      total: 0,
    };
    current.byTask.set(entry.taskId, (current.byTask.get(entry.taskId) || 0) + 1);
    current.total += 1;
    agentLeases.set(agentId, current);
  }
}

function releaseExplicitAgents(entry) {
  for (const agentId of entry.agentIds) {
    const current = agentLeases.get(agentId);
    if (!current) continue;
    const count = current.byTask.get(entry.taskId) || 0;
    if (count <= 0) continue;
    current.total -= 1;
    if (count === 1) current.byTask.delete(entry.taskId);
    else current.byTask.set(entry.taskId, count - 1);
    if (current.total <= 0) agentLeases.delete(agentId);
  }
}

function notifyAgentWaiters() {
  const waiters = agentWaiters.splice(0);
  for (const waiter of waiters) waiter.resolve();
}

function activeEntry(taskId) {
  return active.get(taskId) || null;
}

export function configureScheduler({ execute } = {}) {
  executor = typeof execute === 'function' ? execute : null;
  queueMicrotask(() => dispatch());
}

export function ensureTaskLease(taskId) {
  const lease = store.acquireTaskLease(taskId);
  if (!lease) {
    const error = new Error('任务已被其他实例占用');
    error.code = 'TASK_LEASE_UNAVAILABLE';
    throw error;
  }
  return lease;
}

export function enqueueTask(taskId, options = {}) {
  const task = store.getTask(taskId);
  if (!task) return { accepted: false, reason: '任务不存在' };
  if (active.has(taskId)) return { accepted: false, reason: '任务正在执行' };
  if (queue.some((entry) => entry.taskId === taskId)) {
    const index = queue.findIndex((entry) => entry.taskId === taskId);
    return { accepted: false, reason: '任务已在队列中', position: index + 1 };
  }
  const lease = store.acquireTaskLease(taskId);
  if (!lease) {
    return { accepted: false, reason: '任务已被其他实例占用' };
  }
  const entry = {
    taskId,
    queueSeq: ++queueSeq,
    priority: normalizeTaskPriority(task.priority),
    queuedAt: Date.now(),
    providerIds: taskProviderIds(task, options),
    agentIds: taskAgentIds(task, options),
    options: { ...options },
    waitingReason: '',
    leaseOwned: true,
    leaseTimer: null,
  };
  startEntryLeaseHeartbeat(entry);
  queue.push(entry);
  sortQueue();
  store.updateTask(
    taskId,
    {
      status: 'queued',
      priority: entry.priority,
      queuedAt: entry.queuedAt,
      queuePosition: queue.findIndex((item) => item.taskId === taskId) + 1,
      waitingReason: '',
      startedAt: null,
      finishedAt: null,
      queueMs: 0,
      executionMs: 0,
      scheduler: {
        providerIds: entry.providerIds,
        agentIds: entry.agentIds,
        queuedAt: entry.queuedAt,
        priority: entry.priority,
      },
    },
    'task.queue',
  );
  refreshQueuePositions();
  const position = queue.findIndex((item) => item.taskId === taskId) + 1;
  dispatch();
  return {
    accepted: true,
    taskId,
    position,
    waitingReason: entry.waitingReason,
  };
}

export function cancelQueuedTask(taskId) {
  const index = queue.findIndex((entry) => entry.taskId === taskId);
  if (index < 0) return false;
  const [entry] = queue.splice(index, 1);
  releaseEntryLease(entry);
  store.updateTask(
    taskId,
    {
      status: 'stopped',
      endedAt: Date.now(),
      queuePosition: null,
      waitingReason: '已取消排队',
      finishedAt: Date.now(),
      queueMs: Math.max(0, Date.now() - entry.queuedAt),
      scheduler: {
        ...(store.getTask(taskId)?.scheduler || {}),
        cancelledAt: Date.now(),
      },
    },
    'task.status',
  );
  store.addTaskEvent(taskId, {
    type: 'scheduler.cancelled',
    data: { queuedAt: entry.queuedAt, reason: '用户取消排队' },
  });
  refreshQueuePositions();
  dispatch();
  return true;
}

export function isQueued(taskId) {
  return queue.some((entry) => entry.taskId === taskId);
}

export function isScheduled(taskId) {
  return isQueued(taskId) || active.has(taskId);
}

export function schedulerSnapshot() {
  const crossProcessCounts = Object.fromEntries(
    Object.entries(store.providerSlotSnapshot() || {}).map(([id, slots]) => [id, slots.length]),
  );
  const providers = (store.db.providers || []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled !== false,
    maxConcurrency: providerLimit(provider.id),
    active: providerUsage(provider.id),
  }));
  return {
    maxTaskConcurrency: maxTaskConcurrency(),
    activeCount: active.size,
    queuedCount: queue.length,
    queue: queue.map((entry, index) => ({
      taskId: entry.taskId,
      position: index + 1,
      priority: entry.priority,
      queuedAt: entry.queuedAt,
      waitingReason: entry.waitingReason || waitingReason(entry),
      providerIds: [...entry.providerIds],
      agentIds: [...entry.agentIds],
    })),
    active: [...active.values()].map((entry) => ({
      taskId: entry.taskId,
      runId: store.getTask(entry.taskId)?.runId || null,
      startedAt: entry.startedAt,
      priority: entry.priority,
      providerIds: [...entry.providerIds],
      agentIds: [...entry.agentIds],
    })),
    providers: providers.map((provider) => ({
      ...provider,
      crossProcess: crossProcessCounts[provider.id] || 0,
    })),
    agentLeases: [...agentLeases.entries()].map(([agentId, lease]) => ({
      agentId,
      limit: agentLimit(agentId),
      total: lease.total,
      tasks: [...lease.byTask.entries()].map(([taskId, count]) => ({ taskId, count })),
    })),
  };
}

export async function withAgentLease(taskId, agentId, signal, fn) {
  if (!agentId || typeof fn !== 'function') return fn ? fn() : undefined;
  while (true) {
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const current = agentLeases.get(agentId);
    const taskCount = current?.byTask.get(taskId) || 0;
    const limit = agentLimit(agentId);
    if (!current || taskCount > 0 || current.total < limit) {
      const lease = current || { byTask: new Map(), total: 0 };
      lease.byTask.set(taskId, taskCount + 1);
      lease.total += 1;
      agentLeases.set(agentId, lease);
      const task = store.getTask(taskId);
      if (task?.waitingReason?.startsWith('等待 Agent')) {
        store.updateTask(
          taskId,
          {
            waitingReason: '',
            scheduler: { ...(task.scheduler || {}), waitingAgentId: '' },
          },
          'scheduler.agent',
        );
      }
      try {
        return await fn();
      } finally {
        const lease = agentLeases.get(agentId);
        if (lease) {
          const count = lease.byTask.get(taskId) || 0;
          if (count > 0) {
            lease.total -= 1;
            if (count === 1) lease.byTask.delete(taskId);
            else lease.byTask.set(taskId, count - 1);
            if (lease.total <= 0) agentLeases.delete(agentId);
          }
        }
        notifyAgentWaiters();
        dispatch();
      }
    }
    const used = current?.total || 0;
    store.updateTask(
      taskId,
      {
        waitingReason: `等待 Agent「${agentName(agentId)}」（${used}/${limit}）`,
        scheduler: {
          ...(store.getTask(taskId)?.scheduler || {}),
          waitingAgentId: agentId,
        },
      },
      'scheduler.agent',
    );
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { cleanup(); resolve(); } };
      const onAbort = () => {
        const index = agentWaiters.indexOf(waiter);
        if (index >= 0) agentWaiters.splice(index, 1);
        cleanup();
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      agentWaiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

export function dispatch() {
  if (dispatching || !executor) return;
  dispatching = true;
  try {
    while (queue.length) {
      const index = queue.findIndex(canRun);
      if (index < 0) break;
      const [entry] = queue.splice(index, 1);
      if (!renewEntryLease(entry)) {
        releaseEntryLease(entry);
        store.updateTask(
          entry.taskId,
          {
            status: 'stopped',
            endedAt: Date.now(),
            finishedAt: Date.now(),
            queuePosition: null,
            waitingReason: '任务租约已失效，已取消调度',
          },
          'task.status',
        );
        store.addTaskEvent(entry.taskId, {
          type: 'scheduler.lease.lost',
          data: { reason: '任务租约已失效' },
        });
        continue;
      }
      const slots = store.acquireProviderSlots(entry.taskId, entry.providerIds, {
        limitFor: providerLimit,
      });
      if (!slots.ok) {
        const blocked = slots.blocked || {};
        const name = store.getProvider(blocked.providerId)?.name || blocked.providerId || 'Provider';
        entry.waitingReason = `等待 Provider「${name}」（跨实例 ${blocked.used}/${blocked.limit}）`;
        queue.unshift(entry);
        sortQueue();
        refreshQueuePositions();
        // 其他实例释放槽位没有事件通知，退避后重试一次。
        setTimeout(() => dispatch(), 1000).unref?.();
        break;
      }
      entry.startedAt = Date.now();
      active.set(entry.taskId, entry);
      acquireExplicitAgents(entry);
      const task = store.getTask(entry.taskId);
      store.updateTask(
        entry.taskId,
        {
          status: 'queued',
          queuePosition: null,
          waitingReason: '',
          startedAt: entry.startedAt,
          scheduler: {
            ...(task?.scheduler || {}),
            providerIds: entry.providerIds,
            agentIds: entry.agentIds,
            queuedAt: entry.queuedAt,
            dispatchedAt: entry.startedAt,
          },
        },
        'task.queue',
      );
      Promise.resolve()
        .then(() => executor(entry.taskId, { ...entry.options, scheduled: true }))
        .catch((err) => {
          console.error('[scheduler]', err);
        })
        .finally(() => {
          releaseExplicitAgents(entry);
          releaseEntryLease(entry);
          active.delete(entry.taskId);
          notifyAgentWaiters();
          refreshQueuePositions();
          dispatch();
        });
    }
  } finally {
    dispatching = false;
    refreshQueuePositions();
  }
}

/** Test and process-reset hook. */
export function resetScheduler() {
  for (const entry of [...queue, ...active.values()]) releaseEntryLease(entry);
  queue.length = 0;
  active.clear();
  agentLeases.clear();
  agentWaiters.splice(0);
  executor = null;
  dispatching = false;
  queueSeq = 0;
}

export { activeEntry };
