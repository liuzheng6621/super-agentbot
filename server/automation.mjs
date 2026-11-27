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
      trigger: ['schedule', 'manual', 'retry'].includes(item.trigger) ? item.trigger : 'schedule',
      status: String(item.status || 'scheduled'),
      startedAt: Number(item.startedAt) || null,
      finishedAt: Number(item.finishedAt) || null,
      error: cleanText(item.error, 1000),
    }));
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
      clientMessageId,
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
  automation.nextRunAt = nextRunFor(automation.schedule, now);
  historyEntry(automation, task.id, trigger, 'scheduled', now);
  store.addTaskEvent(task.id, {
    type: 'automation.scheduled',
    data: {
      automationId: automation.id,
      automationName: automation.name,
      trigger,
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
      if (automation.lastTaskId && isScheduled(automation.lastTaskId)) continue;
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
