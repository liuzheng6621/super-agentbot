const MESSAGE_PROTOCOL_VERSION = 1;

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function snapshotSteps(steps) {
  return (steps || []).map((step) => {
    const saved = cloneJson(step);
    if (typeof saved.resultText === 'string') {
      saved.resultTextBytes = Buffer.byteLength(saved.resultText);
      delete saved.resultText;
    }
    return saved;
  });
}

function sourceKind(message = {}) {
  const id = String(message.agentId || message.from?.id || '').toLowerCase();
  if (id === 'user' || id === 'owner') return 'owner';
  if (id === 'system' || id === 'orchestrator' || id.startsWith('system:')) return 'system';
  return 'agent';
}

function normalizeRecipient(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return { kind: value === '*' ? 'broadcast' : 'agent', id: value, name: '', role: '' };
  }
  if (typeof value !== 'object') return null;
  const id = String(value.id || value.agentId || value.role || value.kind || '').trim();
  if (!id) return null;
  return {
    kind: String(value.kind || (id === '*' ? 'broadcast' : 'agent')),
    id,
    name: String(value.name || ''),
    role: String(value.role || ''),
  };
}

export function normalizeRecipients(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const recipients = items.map(normalizeRecipient).filter(Boolean);
  if (!recipients.length) {
    return [{ kind: 'broadcast', id: '*', name: 'Task', role: '' }];
  }
  const seen = new Set();
  return recipients.filter((recipient) => {
    const key = `${recipient.kind}:${recipient.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createMessageEnvelope(task, message = {}, options = {}) {
  const kind = sourceKind(message);
  const from = message.from || {
    kind,
    id: String(message.agentId || (kind === 'owner' ? 'user' : 'system')),
    name: String(message.name || (kind === 'owner' ? 'Owner' : 'System')),
    role: String(message.role || kind),
    title: String(message.title || ''),
  };
  const to = normalizeRecipients(options.to ?? message.to);
  const correlationId = String(
    options.correlationId || message.correlationId || task?.runId || task?.id || '',
  );
  const parentMessageId = String(
    options.parentMessageId || message.parentMessageId || '',
  );
  const causeBy = String(options.causeBy || message.causeBy || '');
  const stepId = String(options.stepId || message.stepId || '');
  const executionId = String(options.executionId || message.executionId || '');
  const artifactRefs = Array.isArray(options.artifactRefs)
    ? options.artifactRefs
    : Array.isArray(message.artifactRefs)
      ? message.artifactRefs
      : [];
  const broadcast = to.some((recipient) => recipient.kind === 'broadcast');

  return {
    from: cloneJson(from),
    to,
    causeBy,
    correlationId,
    parentMessageId,
    artifactRefs: cloneJson(artifactRefs),
    stepId,
    executionId,
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    route: {
      channel: 'task',
      taskId: String(task?.id || ''),
      scope: broadcast ? 'broadcast' : 'direct',
      broadcast,
      recipients: to.map((recipient) => recipient.id),
    },
  };
}

export function ensureMessageEnvelope(task, message = {}) {
  if (
    message.from &&
    Array.isArray(message.to) &&
    message.route &&
    message.protocolVersion === MESSAGE_PROTOCOL_VERSION
  ) {
    return false;
  }
  Object.assign(message, createMessageEnvelope(task, message, {
    to: message.to,
    correlationId: message.correlationId,
    parentMessageId: message.parentMessageId,
    causeBy: message.causeBy,
    stepId: message.stepId,
    executionId: message.executionId,
    artifactRefs: message.artifactRefs,
  }));
  return true;
}

export function planDiff(previousSteps = [], nextSteps = []) {
  const previous = new Map(previousSteps.map((step) => [step.id, step]));
  const next = new Map(nextSteps.map((step) => [step.id, step]));
  const added = [...next.keys()].filter((id) => !previous.has(id));
  const removed = [...previous.keys()].filter((id) => !next.has(id));
  const changed = [...next.keys()].filter((id) => {
    const before = previous.get(id);
    if (!before) return false;
    const after = next.get(id);
    return (
      before.status !== after.status ||
      before.agentId !== after.agentId ||
      before.title !== after.title ||
      before.note !== after.note
    );
  });
  return { added, removed, changed };
}

export function summarizePlan(steps = []) {
  const summary = {
    total: steps.length,
    done: 0,
    pending: 0,
    running: 0,
    failed: 0,
    blocked: 0,
  };
  for (const step of steps) {
    if (step.status === 'done' || step.status === 'skipped') summary.done += 1;
    else if (['running', 'retrying', 'queued'].includes(step.status)) summary.running += 1;
    else if (['error', 'blocked', 'stopped'].includes(step.status)) {
      summary.failed += 1;
      if (step.status === 'blocked') summary.blocked += 1;
    } else summary.pending += 1;
  }
  return summary;
}

export function createPlanSnapshot({
  version,
  previousSteps = [],
  steps = [],
  reason = 'plan-updated',
  source = 'platform',
  runId = '',
  createdAt = Date.now(),
  added,
  removed,
  changed,
} = {}) {
  const diff = planDiff(previousSteps, steps);
  return {
    version: Math.max(1, Number(version) || 1),
    createdAt,
    reason: String(reason || 'plan-updated'),
    source: String(source || 'platform'),
    runId: String(runId || ''),
    added: Array.isArray(added) ? [...added] : diff.added,
    removed: Array.isArray(removed) ? [...removed] : diff.removed,
    changed: Array.isArray(changed) ? [...changed] : diff.changed,
    summary: summarizePlan(steps),
    steps: snapshotSteps(steps),
  };
}

export function ensurePlanVersionState(task, { reason = 'legacy-plan' } = {}) {
  let changed = false;
  if (!Number.isInteger(task.planVersion) || task.planVersion < 0) {
    task.planVersion = 0;
    changed = true;
  }
  if (!Array.isArray(task.planVersions)) {
    task.planVersions = [];
    changed = true;
  }
  if (!Array.isArray(task.autoReplans)) {
    task.autoReplans = [];
    changed = true;
  }
  if (Array.isArray(task.plan) && task.plan.length && !task.planVersions.length) {
    const snapshot = createPlanSnapshot({
      version: 1,
      previousSteps: [],
      steps: task.plan,
      reason,
      source: 'migration',
      runId: task.runId || '',
      createdAt: task.createdAt || Date.now(),
    });
    task.planVersions.push(snapshot);
    task.planVersion = 1;
    changed = true;
  }
  return changed;
}

export { MESSAGE_PROTOCOL_VERSION };
