import { store } from './store.mjs';

const TERMINAL_TASK_STATES = new Set(['done', 'needs_attention', 'error', 'stopped']);

function stepStatus(step) {
  const status = String(step?.status || 'pending');
  return ['pending', 'queued', 'running', 'retrying', 'done', 'error', 'blocked', 'skipped'].includes(
    status,
  )
    ? status
    : 'pending';
}

function eventSummary(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const value =
    data.summary ||
    data.message ||
    data.path ||
    data.command ||
    data.tool ||
    data.reason ||
    data.error ||
    '';
  return String(value).replace(/\s+/g, ' ').slice(0, 180);
}

export function taskGraph(task) {
  const plan = Array.isArray(task?.plan) ? task.plan : [];
  const known = new Set(plan.map((step) => step.id));
  const events = Array.isArray(task?.events) ? task.events : [];
  const nodes = plan.map((step) => {
    const related = events.filter((event) => event.stepId === step.id);
    const last = related[related.length - 1];
    return {
      id: step.id,
      title: step.title || step.id,
      role: step.role || '',
      agentId: step.agentId || '',
      status: stepStatus(step),
      needs: (step.needs || []).filter((id) => known.has(id)),
      attempt: Number(step.attempt) || 1,
      round: Number(step.round) || 0,
      traceSpanId: step.traceSpanId || '',
      eventCount: related.length,
      lastEvent: last
        ? { type: last.type || 'event', at: last.at || null, summary: eventSummary(last) }
        : null,
    };
  });
  const edges = nodes.flatMap((node) =>
    node.needs.map((from) => ({ from, to: node.id, kind: 'dependency' })),
  );
  const layers = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const layerOf = new Map();
  const resolveLayer = (node, visiting = new Set()) => {
    if (layerOf.has(node.id)) return layerOf.get(node.id);
    if (visiting.has(node.id)) return 0;
    visiting.add(node.id);
    const layer = node.needs.length
      ? Math.max(...node.needs.map((id) => resolveLayer(byId.get(id), visiting))) + 1
      : 0;
    visiting.delete(node.id);
    layerOf.set(node.id, layer);
    return layer;
  };
  for (const node of nodes) {
    const index = resolveLayer(node);
    if (!layers[index]) layers[index] = [];
    layers[index].push(node.id);
  }
  return {
    taskId: task?.id || '',
    nodes,
    edges,
    layers: layers.filter(Boolean),
    summary: {
      total: nodes.length,
      done: nodes.filter((node) => node.status === 'done').length,
      running: nodes.filter((node) => ['running', 'retrying'].includes(node.status)).length,
      blocked: nodes.filter((node) => ['blocked', 'error'].includes(node.status)).length,
      parallel: layers.some((layer) => layer.length > 1),
    },
  };
}

export function taskReplay(task) {
  const frames = [];
  for (const message of task?.messages || []) {
    frames.push({
      id: `message:${message.id}`,
      at: Number(message.createdAt) || 0,
      kind: 'message',
      label: message.kind || 'message',
      stepId: message.stepId || '',
      agentId: message.agentId || '',
      summary: String(message.text || '').replace(/\s+/g, ' ').slice(0, 220),
      refs: {
        messageId: message.id,
        artifactRefs: Array.isArray(message.artifactRefs) ? message.artifactRefs : [],
      },
    });
  }
  for (const event of task?.events || []) {
    frames.push({
      id: `event:${event.id}`,
      at: Number(event.at) || 0,
      kind: 'event',
      label: event.type || 'event',
      stepId: event.stepId || '',
      agentId: event.agentId || '',
      summary: eventSummary(event),
      refs: {
        eventId: event.id,
        traceId: event.traceId || '',
        spanId: event.spanId || '',
        parentSpanId: event.parentSpanId || '',
      },
    });
  }
  for (const change of task?.fileChanges || []) {
    frames.push({
      id: `change:${change.id || `${change.path}:${change.updatedAt || change.createdAt || 0}`}`,
      at: Number(change.updatedAt || change.createdAt) || 0,
      kind: 'file',
      label: change.status || 'M',
      stepId: change.stepId || '',
      agentId: change.agentId || '',
      summary: change.previousPath
        ? `${change.previousPath} -> ${change.path}`
        : change.path || '',
      refs: { path: change.path || '', previousPath: change.previousPath || '' },
    });
  }
  frames.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const limit = 400;
  const selected = frames.slice(-limit);
  return {
    taskId: task?.id || '',
    total: frames.length,
    truncated: frames.length > limit,
    frames: selected.map((frame, index) => ({ ...frame, index: index + 1 })),
  };
}

function taskProject(task) {
  return task.sourceWorkspace || task.workspace || '';
}

export function crossTaskOverview() {
  const tasks = store.tasks.map((task) => {
    const graph = taskGraph(task);
    const runningStep =
      (task.plan || []).find((step) => ['running', 'retrying'].includes(step.status)) ||
      (task.plan || []).find((step) => step.status === 'queued');
    return {
      ...store.taskSummary(task),
      project: taskProject(task),
      currentStep: runningStep
        ? {
            id: runningStep.id,
            title: runningStep.title || runningStep.id,
            role: runningStep.role || '',
            agentId: runningStep.agentId || '',
            status: stepStatus(runningStep),
          }
        : null,
      graph: graph.summary,
      blockers: (task.plan || [])
        .filter((step) => ['blocked', 'error'].includes(step.status))
        .map((step) => ({
          id: step.id,
          title: step.title || step.id,
          status: step.status,
          note: step.note || step.error || '',
        })),
      terminal: TERMINAL_TASK_STATES.has(task.status),
    };
  });
  return {
    tasks,
    summary: {
      total: tasks.length,
      active: tasks.filter((task) => !task.terminal).length,
      blocked: tasks.filter((task) => task.blockers.length || task.status === 'needs_attention').length,
      projects: new Set(tasks.map((task) => task.project).filter(Boolean)).size,
    },
  };
}
