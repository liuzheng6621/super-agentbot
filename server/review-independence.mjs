import { store } from './store.mjs';

export function isSelfReview(role, agent, implementer = null) {
  if (role !== 'reviewer' || !agent?.id) return false;
  const implementerId =
    typeof implementer === 'string'
      ? implementer
      : String(implementer?.id || implementer?.agentId || '');
  return implementerId ? agent.id === implementerId : agent.role === 'coder';
}

/** Resolve the actual implementer for this run and compare stable agent IDs. */
export function reviewIndependenceFor(task, reviewer) {
  const plan = Array.isArray(task?.plan) ? task.plan : [];
  const implementations = plan.filter((step) => step.role === 'coder' && step.agentId);
  const completed = implementations.filter((step) => ['done', 'running'].includes(step.status));
  const relevant = completed.length ? completed : implementations;
  const implementerIds = [
    ...new Set(relevant.map((step) => String(step.agentId || '')).filter(Boolean)),
  ];
  const implementerNames = implementerIds.map(
    (id) => store.getAgent(id)?.name || '',
  );
  const implementationStepIds = [...new Set(relevant.map((step) => step.id))];
  const implementation = relevant.at(-1) || null;
  const reviewerId = String(reviewer?.id || '');
  const implementerId = implementerIds.at(-1) || '';
  return {
    reviewerId,
    reviewerName: reviewer?.name || '',
    implementerId,
    implementerName: implementerNames.at(-1) || '',
    implementerIds,
    implementerNames,
    implementationStepId: implementation?.id || '',
    implementationStepIds,
    selfReview:
      reviewerId &&
      implementerIds.some((id) => isSelfReview('reviewer', reviewer, id)),
  };
}

export function recordReviewIndependence(task, step, reviewer) {
  const identity = reviewIndependenceFor(task, reviewer);
  const taskId = task.id;
  const current = store.getTask(taskId) || task;
  const quality = {
    ...(current.quality || {}),
    ...identity,
  };
  if (step?.id) store.updateStep(taskId, step.id, identity);
  store.updateTask(taskId, { quality });
  store.addTaskEvent(taskId, {
    type: 'review.independence',
    runId: current.runId || null,
    stepId: step?.id || '',
    agentId: reviewer?.id || '',
    data: identity,
  });
  return { identity, quality };
}
