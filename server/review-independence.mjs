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
  const implementation =
    [...implementations].reverse().find((step) => ['done', 'running'].includes(step.status)) ||
    implementations.at(-1) ||
    null;
  const implementer = implementation ? store.getAgent(implementation.agentId) : null;
  const reviewerId = String(reviewer?.id || '');
  const implementerId = String(implementation?.agentId || implementer?.id || '');
  return {
    reviewerId,
    reviewerName: reviewer?.name || '',
    implementerId,
    implementerName: implementer?.name || '',
    implementationStepId: implementation?.id || '',
    selfReview: isSelfReview('reviewer', reviewer, implementerId),
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
