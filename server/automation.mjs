import { randomUUID } from 'node:crypto';
import { store } from './store.mjs';
import { isScheduled, scheduleTask } from './orchestrator.mjs';

const MAX_HISTORY = 20;
const DEFAULT_INTERVAL_MINUTES = 60;
const RUNNER_INTERVAL_MS = 5000;

let runnerTimer = null;
let tickInFlight = false;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

export function normalizeSchedule(input = {}) {
  const kind = input.kind === 'daily' ? 'daily' : 'interval';
  if (kind === 'daily') {
    const match = String(input.time || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return {
      kind,
      time: match ? `${match[1]}:${match[2]}` : '09:00',
    };
  }
  return {
    kind,
    everyMinutes: clampInt(
      input.everyMinutes ?? input.intervalMinutes,
      1,
      7 * 24 * 60,
      DEFAULT_INTERVAL_MINUTES,
    ),
  };
}

export function nextRunFor(schedule, from = Date.now()) {
  const normalized = normalizeSchedule(schedule);
  const start = new Date(Number(from) || Date.now());
  if (normalized.kind === 'interval') {
    return start.getTime() + normalized.everyMinutes * 60_000;
  }
  const [hour, minute] = normalized.time.split(':').map(Number);
  const next = new Date(start);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= start.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .slice(-MAX_HISTORY)
    .map((item) => ({
      id: String(item.id || randomUUID()),
      taskId: String(item.taskId || ''),
      trigger: ['schedule', 'manual', 'retry', 'event'].includes(item.trigger)
        ? item.trigger
        : 'schedule',
      status: String(item.status || 'scheduled'),
      startedAt: Number(item.startedAt) || null,
      finishedAt: Number(item.finishedAt) || null,
      error: cleanText(item.error, 1000),
      eventId: cleanText(item.eventId, 200),
    }));
}

export function normalizeEventWait(value = null, previous = null, now = Date.now()) {
  const source = value && typeof value === 'object' ? value : previous;
  if (!source || typeof source !== 'object') return null;
  const status = ['waiting', 'woken', 'cancelled', 'completed'].includes(source.status)
    ? source.status
    : 'waiting';
  const processedEventIds = [
    ...new Set(
      (Array.isArray(source.processedEventIds) ? source.processedEventIds : [])
        .map((id) => cleanText(id, 200))
        .filter(Boolean),
    ),
  ].slice(-50);
  return {
    status,
    eventId: cleanText(source.eventId, 200),
    requestedAt: Number(source.requestedAt) || null,
    wokenAt: Number(source.wokenAt) || null,
    cancelledAt: Number(source.cancelledAt) || null,
    completedAt: Number(source.completedAt) || null,
    taskId: cleanText(source.taskId, 80),
    runKey: cleanText(source.runKey, 200),
    processedEventIds,
    updatedAt: Number(source.updatedAt) || now,
  };
}

export function normalizeAutomation(input = {}, existing = null, now = Date.now()) {
  const previous = existing || {};
  const schedule = normalizeSchedule(input.schedule || previous.schedule || {});
  const enabled = input.enabled === undefined ? previous.enabled !== false : input.enabled !== false;
  const flowMode =
    input.flowMode === 'direct' || input.flowMode === 'debate'
      ? input.flowMode
      : input.flowMode === null
        ? null
        : previous.flowMode || null;
  const scheduleChanged =
    JSON.stringify(schedule) !== JSON.stringify(previous.schedule || {});
  const becomingEnabled = enabled && previous.enabled === false;
  const nextRunAt =
    enabled
      ? Number(input.nextRunAt) ||
        (previous.nextRunAt && !scheduleChanged && !becomingEnabled
          ? Number(previous.nextRunAt)
          : nextRunFor(schedule, now))
      : null;

  return {
    id: String(previous.id || input.id || randomUUID()).replace(/[^\w-]/g, '').slice(0, 64) || randomUUID(),
    tenantId: String(input.tenantId ?? previous.tenantId ?? 'default').trim().slice(0, 80) || 'default',
    ownerId: String(input.ownerId ?? previous.ownerId ?? 'owner').trim().slice(0, 80) || 'owner',
    taskLimit: clampInt(
      input.taskLimit ?? previous.taskLimit,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
    name: cleanText(input.name ?? previous.name, 80) || '未命名自动化',
    goal: cleanText(input.goal ?? previous.goal, 4000),
    workspace: cleanText(input.workspace ?? previous.workspace, 1000),
    isolation: input.isolation === 'worktree' ? 'worktree' : previous.isolation === 'worktree' ? 'worktree' : 'direct',
    flowMode,
    speed: clampInt(input.speed ?? previous.speed, 1, 20, 1),
    enabled,
    schedule,
    retryLimit: clampInt(input.retryLimit ?? previous.retryLimit, 0, 3, 0),
    retryDelayMinutes: clampInt(input.retryDelayMinutes ?? previous.retryDelayMinutes, 1, 60, 5),
    nextRunAt,
    lastRunAt: Number(input.lastRunAt ?? previous.lastRunAt) || null,
    lastTaskId: String(input.lastTaskId ?? previous.lastTaskId ?? ''),
    lastStatus: String(input.lastStatus ?? previous.lastStatus ?? (enabled ? 'idle' : 'paused')),
    lastError: cleanText(input.lastError ?? previous.lastError, 1000),
    retryCount: clampInt(input.retryCount ?? previous.retryCount, 0, 3, 0),
    retryDueAt: Number(input.retryDueAt ?? previous.retryDueAt) || null,
    runCount: clampInt(input.runCount ?? previous.runCount, 0, Number.MAX_SAFE_INTEGER, 0),
    failureCount: clampInt(input.failureCount ?? previous.failureCount, 0, Number.MAX_SAFE_INTEGER, 0),
    consecutiveFailures: clampInt(
      input.consecutiveFailures ?? previous.consecutiveFailures,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
    eventWait: normalizeEventWait(
      input.eventWait === undefined ? previous.eventWait : input.eventWait,
      previous.eventWait,
      now,
    ),
    history: normalizeHistory(input.history ?? previous.history),
    createdAt: Number(previous.createdAt || input.createdAt) || now,
    updatedAt: now,
  };
}

function automationListInternal() {
  if (!Array.isArray(store.db.settings.automations)) store.db.settings.automations = [];
  return store.db.settings.automations;
}

function saveAutomations() {
  store.save({ settings: true });
  store.broadcast({ type: 'automations.changed', automations: automationSnapshot() });
}

function historyEntry(automation, taskId, trigger, status, now, extra = {}) {
  const entry = {
    id: randomUUID(),
    taskId,
    trigger,
    status,
    startedAt: now,
    finishedAt: null,
    error: '',
    ...extra,
  };
  automation.history = [...(automation.history || []), entry].slice(-MAX_HISTORY);
  return entry;
}

function eventHistoryEntry(automation, taskId, status, now, extra = {}) {
  return historyEntry(automation, taskId, 'event', status, now, {
    eventId: automation.eventWait?.eventId || '',
    ...extra,
  });
}

export function listAutomations() {
  return automationListInternal();
}

export function getAutomation(id) {
  return automationListInternal().find((item) => item.id === id) || null;
}

export function automationSummary(automation) {
  if (!automation) return null;
  return {
    ...automation,
    eventWait: automation.eventWait ? { ...automation.eventWait } : null,
    scheduleText:
      automation.schedule?.kind === 'daily'
        ? `每天 ${automation.schedule.time}`
        : `每 ${automation.schedule?.everyMinutes || DEFAULT_INTERVAL_MINUTES} 分钟`,
    history: (automation.history || []).slice(-8).reverse(),
  };
}

export function automationSnapshot(filter = {}) {
  const tenantId =
    filter?.tenantId === null || filter?.tenantId === undefined
      ? null
      : String(filter.tenantId);
  return automationListInternal()
    .filter(
      (automation) =>
        tenantId === null || String(automation.tenantId || 'default') === tenantId,
    )
    .map(automationSummary);
}

export function createAutomation(input = {}) {
  const automation = normalizeAutomation(input);
  if (!automation.goal) throw new Error('自动化目标不能为空');
  automationListInternal().push(automation);
  saveAutomations();
  return automation;
}

export function updateAutomation(id, patch = {}) {
  const list = automationListInternal();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const current = list[index];
  const next = normalizeAutomation({ ...patch, id: current.id }, current);
  if (!next.goal) throw new Error('自动化目标不能为空');
  if (patch.enabled === false) {
    next.nextRunAt = null;
    next.retryDueAt = null;
    next.lastStatus = 'paused';
  }
  list[index] = next;
  saveAutomations();
  return next;
}

export function removeAutomation(id) {
  const list = automationListInternal();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return false;
  list.splice(index, 1);
  saveAutomations();
  return true;
}

function taskTerminalStatus(status) {
  return ['done', 'needs_attention', 'error', 'stopped'].includes(String(status || ''));
}

function recordScheduleFailure(automation, trigger, now, task, reason) {
  const message = cleanText(reason, 1000) || '自动化任务调度失败';
  if (task?.id) {
    store.updateTask(
      task.id,
      {
        status: 'stopped',
        endedAt: now,
        finishedAt: now,
        error: message,
        waitingReason: message,
      },
      'task.status',
    );
    store.addTaskEvent(task.id, {
      type: 'automation.schedule.failed',
      data: {
        automationId: automation.id,
        automationName: automation.name,
        trigger,
        reason: message,
      },
    });
  }
  automation.failureCount = (automation.failureCount || 0) + 1;
  automation.consecutiveFailures = (automation.consecutiveFailures || 0) + 1;
  automation.lastError = message;
  automation.retryDueAt =
    (automation.retryCount || 0) < (automation.retryLimit || 0)
      ? now + automation.retryDelayMinutes * 60_000
      : null;
  automation.lastStatus = automation.retryDueAt ? 'retry-waiting' : 'failed';
  automation.nextRunAt = nextRunFor(automation.schedule, now);
  historyEntry(automation, task?.id || '', trigger, 'failed', now, {
    finishedAt: now,
    error: message,
  });
  automation.updatedAt = now;
  saveAutomations();
  return { ok: false, reason: message, task: task || null };
}

function scheduleAutomation(automation, trigger, now, dependencies = {}) {
  const create = dependencies.createTask || ((input) => store.createTask(input));
  const schedule = dependencies.scheduleTask || scheduleTask;
  const clientMessageId = String(dependencies.clientMessageId || '').trim().slice(0, 200);
  const eventId = String(dependencies.eventId || '').trim().slice(0, 200);
  const idempotencyScope = `automation:${automation.id}`;
  const tenantScope = String(automation.tenantId || 'default').trim().slice(0, 80) || 'default';
  if (clientMessageId) {
    const existing = store.findTenantIdempotentTask(
      clientMessageId,
      tenantScope,
      idempotencyScope,
      now,
    );
    if (existing) {
      return {
        ok: true,
        task: existing,
        scheduled: { accepted: true, replay: true },
        idempotentReplay: true,
      };
    }
  }
  if (automation.lastTaskId && isScheduled(automation.lastTaskId)) {
    automation.lastStatus = 'waiting';
    automation.lastError = '上一轮任务仍在排队或运行';
    automation.updatedAt = now;
    return { ok: false, reason: automation.lastError };
  }
  let task;
  try {
    task = create({
      goal: automation.goal,
      mode: 'auto',
      workspace: automation.workspace,
      isolation: automation.isolation,
      debate: automation.flowMode,
      clientMessageId: clientMessageId || (eventId ? `event:${eventId}` : ''),
      clientMessageScope: idempotencyScope,
      tenantId: automation.tenantId,
      ownerId: automation.ownerId,
      taskLimit: automation.taskLimit,
    });
  } catch (err) {
    return recordScheduleFailure(automation, trigger, now, null, err.message);
  }
  const scheduled = schedule(task.id, {
    speed: automation.speed,
    source: trigger === 'retry' ? 'automation.retry' : 'automation',
  });
  if (!scheduled?.accepted) {
    return recordScheduleFailure(
      automation,
      trigger,
      now,
      task,
      scheduled?.reason || '任务调度失败',
    );
  }
  automation.lastTaskId = task.id;
  automation.lastRunAt = now;
  automation.lastStatus = 'scheduled';
  automation.lastError = '';
  automation.retryDueAt = null;
  automation.runCount = (automation.runCount || 0) + 1;
  if (trigger === 'event') {
    automation.nextRunAt = nextRunFor(automation.schedule, now);
    eventHistoryEntry(automation, task.id, 'scheduled', now);
  } else {
    automation.nextRunAt = nextRunFor(automation.schedule, now);
    historyEntry(automation, task.id, trigger, 'scheduled', now);
  }
  store.addTaskEvent(task.id, {
    type: 'automation.scheduled',
    data: {
      automationId: automation.id,
      automationName: automation.name,
      trigger,
      eventId: eventId || null,
    },
  });
  automation.updatedAt = now;
  saveAutomations();
  return { ok: true, task, scheduled };
}

export function runAutomationNow(id, dependencies = {}) {
  const automation = getAutomation(id);
  if (!automation) return { ok: false, reason: '自动化不存在' };
  return scheduleAutomation(automation, 'manual', Date.now(), dependencies);
}

export function waitForAutomationEvent(id, { eventId = '', now = Date.now() } = {}) {
  const automation = getAutomation(id);
  if (!automation) return { ok: false, reason: '自动化不存在' };
  if (automation.eventWait && ['waiting', 'woken'].includes(automation.eventWait.status)) {
    return {
      ok: false,
      reason: '自动化已有未完成的事件等待',
      eventWait: automation.eventWait,
    };
  }
  automation.eventWait = normalizeEventWait(
    {
      status: 'waiting',
      eventId: cleanText(eventId, 200),
      requestedAt: now,
      wokenAt: null,
      cancelledAt: null,
      completedAt: null,
      taskId: '',
      runKey: '',
      processedEventIds: automation.eventWait?.processedEventIds || [],
      updatedAt: now,
    },
    null,
    now,
  );
  automation.lastStatus = 'event-waiting';
  automation.lastError = '';
  automation.updatedAt = now;
  saveAutomations();
  return { ok: true, eventWait: automation.eventWait };
}

export function cancelAutomationWait(id, { now = Date.now() } = {}) {
  const automation = getAutomation(id);
  if (!automation) return { ok: false, reason: '自动化不存在' };
  if (!automation.eventWait || !['waiting', 'woken'].includes(automation.eventWait.status)) {
    return { ok: false, reason: '当前没有可取消的事件等待' };
  }
  automation.eventWait = normalizeEventWait(
    {
      ...automation.eventWait,
      status: 'cancelled',
      cancelledAt: now,
      updatedAt: now,
    },
    automation.eventWait,
    now,
  );
  automation.lastStatus = automation.enabled ? 'idle' : 'paused';
  automation.lastError = '';
  automation.updatedAt = now;
  saveAutomations();
  return { ok: true, eventWait: automation.eventWait };
}

export function wakeAutomationEvent(
  id,
  { eventId = '', now = Date.now(), dependencies = {} } = {},
) {
  const automation = getAutomation(id);
  if (!automation) return { ok: false, reason: '自动化不存在' };
  const normalizedEventId = cleanText(eventId, 200);
  if (!normalizedEventId) return { ok: false, reason: '缺少 eventId' };
  const wait = automation.eventWait;
  if (!wait) return { ok: false, reason: '自动化未进入事件等待' };
  if (wait.status === 'cancelled') return { ok: false, reason: '事件等待已取消' };
  if (wait.status === 'completed') return { ok: false, reason: '事件等待已完成' };
  if (
    wait.status === 'waiting' &&
    wait.eventId &&
    wait.eventId !== normalizedEventId
  ) {
    return { ok: false, reason: 'eventId 与等待中的事件不匹配' };
  }
  if (wait.processedEventIds?.includes(normalizedEventId)) {
    return { ok: true, duplicate: true, task: wait.taskId ? store.getTask(wait.taskId) : null };
  }
  if (wait.status === 'woken') {
    return {
      ok: true,
      duplicate: true,
      task: wait.taskId ? store.getTask(wait.taskId) : null,
    };
  }

  const runKey = `event:${normalizedEventId}`;
  const claim = store.claimAutomation(automation.id, { runKey });
  if (!claim) return { ok: false, reason: '自动化已被其他实例处理' };
  try {
    const latest = getAutomation(id);
    if (!latest) return { ok: false, reason: '自动化不存在' };
    const latestWait = latest.eventWait;
    if (!latestWait) return { ok: false, reason: '自动化未进入事件等待' };
    if (latestWait.status === 'cancelled') return { ok: false, reason: '事件等待已取消' };
    if (latestWait.status === 'completed') return { ok: false, reason: '事件等待已完成' };
    if (latestWait.processedEventIds?.includes(normalizedEventId)) {
      return {
        ok: true,
        duplicate: true,
        task: latestWait.taskId ? store.getTask(latestWait.taskId) : null,
      };
    }
    if (latestWait.status === 'woken') {
      return {
        ok: true,
        duplicate: true,
        task: latestWait.taskId ? store.getTask(latestWait.taskId) : null,
      };
    }
    if (latestWait.eventId && latestWait.eventId !== normalizedEventId) {
      return { ok: false, reason: 'eventId 与等待中的事件不匹配' };
    }
    const result = scheduleAutomation(automation, 'event', now, {
      ...dependencies,
      eventId: normalizedEventId,
    });
    if (!result.ok) {
      store.releaseAutomationClaim(automation.id);
      return result;
    }
    automation.eventWait = normalizeEventWait(
      {
        ...wait,
        status: 'woken',
        eventId: normalizedEventId,
        wokenAt: now,
        taskId: result.task.id,
        runKey,
        processedEventIds: [...(wait.processedEventIds || []), normalizedEventId],
        updatedAt: now,
      },
      wait,
      now,
    );
    automation.updatedAt = now;
    saveAutomations();
    return { ...result, eventWait: automation.eventWait };
  } finally {
    store.releaseAutomationClaim(automation.id);
  }
}

function updateHistory(automation, taskId, patch) {
  const entry = [...(automation.history || [])].reverse().find((item) => item.taskId === taskId);
  if (!entry) {
    automation.history = [
      ...(automation.history || []),
      {
        id: randomUUID(),
        taskId,
        trigger: 'schedule',
        status: String(patch.status || 'unknown'),
        startedAt: Number(automation.lastRunAt) || null,
        finishedAt: null,
        error: '',
        ...patch,
      },
    ].slice(-MAX_HISTORY);
    return;
  }
  Object.assign(entry, patch);
}

export function reconcileAutomationRuns({ now = Date.now() } = {}) {
  let changed = false;
  for (const automation of automationListInternal()) {
    const eventWait = automation.eventWait;
    if (
      eventWait?.status === 'woken' &&
      eventWait.taskId &&
      eventWait.completedAt == null
    ) {
      const task = store.getTask(eventWait.taskId);
      if (task && taskTerminalStatus(task.status)) {
        const finishedAt = task.finishedAt || task.endedAt || now;
        eventWait.status = 'completed';
        eventWait.completedAt = finishedAt;
        eventWait.updatedAt = now;
        if (task.status === 'done') {
          eventHistoryEntry(automation, task.id, 'done', now, {
            startedAt: eventWait.wokenAt,
            finishedAt,
          });
        } else {
          const error =
            task.error?.message ||
            task.quality?.reason ||
            (task.status === 'stopped' ? '任务已停止' : `任务结束状态：${task.status}`);
          eventHistoryEntry(automation, task.id, 'failed', now, {
            startedAt: eventWait.wokenAt,
            finishedAt,
            error: cleanText(error, 1000),
          });
        }
        automation.updatedAt = now;
        changed = true;
      }
    }
    if (!automation.lastTaskId || !['scheduled', 'running', 'waiting'].includes(automation.lastStatus)) {
      continue;
    }
    const task = store.getTask(automation.lastTaskId);
    if (!task) continue;
    if (['queued', 'running', 'stopping'].includes(task.status)) {
      if (automation.lastStatus !== 'running') {
        automation.lastStatus = 'running';
        automation.updatedAt = now;
        changed = true;
      }
      continue;
    }
    if (!taskTerminalStatus(task.status)) continue;

    const finishedAt = task.finishedAt || task.endedAt || now;
    if (task.status === 'done') {
      automation.lastStatus = 'done';
      automation.lastError = '';
      automation.retryDueAt = null;
      automation.retryCount = 0;
      automation.consecutiveFailures = 0;
      updateHistory(automation, task.id, { status: 'done', finishedAt });
    } else {
      const error =
        task.error?.message ||
        task.quality?.reason ||
        (task.status === 'stopped' ? '任务已停止' : `任务结束状态：${task.status}`);
      automation.failureCount = (automation.failureCount || 0) + 1;
      automation.consecutiveFailures = (automation.consecutiveFailures || 0) + 1;
      automation.lastError = cleanText(error, 1000);
      updateHistory(automation, task.id, {
        status: task.status === 'stopped' ? 'stopped' : 'failed',
        finishedAt,
        error: automation.lastError,
      });
      if ((automation.retryCount || 0) < (automation.retryLimit || 0)) {
        automation.retryCount = (automation.retryCount || 0) + 1;
        automation.retryDueAt = now + automation.retryDelayMinutes * 60_000;
        automation.lastStatus = 'retry-waiting';
      } else {
        automation.lastStatus = 'failed';
        automation.retryDueAt = null;
      }
    }
    automation.updatedAt = now;
    changed = true;
  }
  if (changed) saveAutomations();
  return changed;
}

export async function tickAutomations({ now = Date.now(), dependencies = {} } = {}) {
  if (tickInFlight) return { skipped: true };
  tickInFlight = true;
  try {
    reconcileAutomationRuns({ now });
    const started = [];
    for (const automation of automationListInternal()) {
      if (!automation.enabled) continue;
      if (
        automation.eventWait &&
        ['waiting', 'woken'].includes(automation.eventWait.status)
      ) {
        continue;
      }
      if (automation.lastTaskId && isScheduled(automation.lastTaskId)) {
        // 运行期心跳：claim 只有启动期 TTL，长任务不续约就会过期被别的实例抢走。
        if (store.automationClaimIsOwned(automation.id)) {
          store.renewAutomationClaim(automation.id, {
            runKey: `task:${automation.lastTaskId}`,
          });
        }
        continue;
      }
      if (automation.retryDueAt && automation.retryDueAt <= now) {
        const claim = store.claimAutomation(automation.id, {
          runKey: `retry:${automation.retryDueAt}`,
        });
        if (!claim) continue;
        const result = scheduleAutomation(automation, 'retry', now, dependencies);
        if (result.ok) started.push({ id: automation.id, taskId: result.task.id, trigger: 'retry' });
        else store.releaseAutomationClaim(automation.id);
        continue;
      }
      if (automation.nextRunAt && automation.nextRunAt <= now) {
        const claim = store.claimAutomation(automation.id, {
          runKey: `schedule:${automation.nextRunAt}`,
        });
        if (!claim) continue;
        const result = scheduleAutomation(automation, 'schedule', now, dependencies);
        if (result.ok) started.push({ id: automation.id, taskId: result.task.id, trigger: 'schedule' });
        else store.releaseAutomationClaim(automation.id);
      }
    }
    return { skipped: false, started };
  } finally {
    tickInFlight = false;
  }
}

export function startAutomationRunner({ intervalMs = RUNNER_INTERVAL_MS } = {}) {
  if (runnerTimer) return runnerTimer;
  reconcileAutomationRuns();
  runnerTimer = setInterval(() => {
    tickAutomations().catch((err) => console.error('[automation]', err));
  }, intervalMs);
  runnerTimer.unref?.();
  tickAutomations().catch((err) => console.error('[automation]', err));
  return runnerTimer;
}

export function stopAutomationRunner() {
  if (runnerTimer) clearInterval(runnerTimer);
  runnerTimer = null;
}

export function automationRunnerSnapshot() {
  return {
    running: !!runnerTimer,
    intervalMs: RUNNER_INTERVAL_MS,
    total: automationListInternal().length,
    enabled: automationListInternal().filter((item) => item.enabled).length,
  };
}
