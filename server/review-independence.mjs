import { store } from './store.mjs';

function agentIdentity(agent) {
  const provider = agent ? store.providerForAgent(agent) : null;
  const providerId = String(agent?.providerId || provider?.id || '');
  const model = String(agent?.model || provider?.model || '');
  const cli = String(agent?.cli?.command || '');
  return {
    id: String(agent?.id || ''),
    name: agent?.name || '',
    role: agent?.role || '',
    providerId,
    model,
    cli,
    // 只有真正配置了 Provider + 模型才算同一执行内核；零配置席位沿用旧的 ID 比较。
    tier: providerId && model ? `${providerId}|${model}|${cli}` : '',
  };
}

export function isSelfReview(role, agent, implementer = null) {
  if (role !== 'reviewer' || !agent?.id) return false;
  const implementerId =
    typeof implementer === 'string'
      ? implementer
      : String(implementer?.id || implementer?.agentId || '');
  return implementerId ? agent.id === implementerId : agent.role === 'coder';
}

/** Resolve reviewer and implementer execution identity (agent, Provider, model, CLI). */
export function reviewIndependenceFor(task, reviewer) {
  const plan = Array.isArray(task?.plan) ? task.plan : [];
  const implementations = plan.filter((step) => step.role === 'coder' && step.agentId);
  const completed = implementations.filter((step) => ['done', 'running'].includes(step.status));
  const relevant = completed.length ? completed : implementations;
  const implementerIds = [
    ...new Set(relevant.map((step) => String(step.agentId || '')).filter(Boolean)),
  ];
  const implementerNames = implementerIds.map((id) => store.getAgent(id)?.name || '');
  const implementationStepIds = [...new Set(relevant.map((step) => step.id))];
  const implementation = relevant.at(-1) || null;
  const reviewerId = String(reviewer?.id || '');
  const implementerId = implementerIds.at(-1) || '';

  const reviewerIdentity = agentIdentity(reviewer);
  const implementerIdentities = implementerIds.map((id) => agentIdentity(store.getAgent(id)));
  const lastImplementer = implementerIdentities.at(-1) || agentIdentity(null);
  const sameAgentId = !!reviewerId && implementerIds.includes(reviewerId);
  const sameModel = implementerIdentities.some(
    (identity) => !!reviewerIdentity.tier && identity.tier === reviewerIdentity.tier,
  );
  const sameProvider = implementerIdentities.some(
    (identity) =>
      !!reviewerIdentity.providerId && identity.providerId === reviewerIdentity.providerId,
  );

  return {
    reviewerId,
    reviewerName: reviewer?.name || '',
    reviewerProviderId: reviewerIdentity.providerId,
    reviewerModel: reviewerIdentity.model,
    reviewerCli: reviewerIdentity.cli,
    implementerId,
    implementerName: implementerNames.at(-1) || '',
    implementerIds,
    implementerNames,
    implementerProviderId: lastImplementer.providerId,
    implementerModel: lastImplementer.model,
    implementerCli: lastImplementer.cli,
    sameModel,
    sameProvider,
    // 同 Provider + 同模型（含同一 CLI）自审不再算独立评审。
    selfReview: sameAgentId || sameModel,
    implementationStepId: implementation?.id || '',
    implementationStepIds,
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
  if (identity.selfReview) {
    store.addTaskEvent(taskId, {
      type: 'self-review',
      runId: current.runId || null,
      stepId: step?.id || '',
      agentId: reviewer?.id || '',
      data: {
        ...identity,
        reason: identity.sameModel
          ? `评审与实现使用同一 Provider/模型：${identity.reviewerProviderId}/${identity.reviewerModel}`
          : '评审与实现是同一 Agent',
      },
    });
  }
  return { identity, quality };
}
