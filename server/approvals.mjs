import { randomUUID } from 'node:crypto';
import { store } from './store.mjs';
import { CommandError, commandText } from './command-runner.mjs';

const MAX_APPROVALS = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function approvalList() {
  if (!Array.isArray(store.db.settings.approvals)) store.db.settings.approvals = [];
  return store.db.settings.approvals;
}

function saveApprovals() {
  store.save({ settings: true });
  store.broadcast({ type: 'approvals.changed', approvals: approvalsSnapshot() });
}

export function approvalsSnapshot() {
  return approvalList().slice(-MAX_APPROVALS).reverse().map((item) => ({ ...item }));
}

export function approvalsForPrincipal(principal = null) {
  const list = approvalsSnapshot();
  if (principal?.kind !== 'agent') return list;
  return list.filter((item) => String(item.agentId) === String(principal.id));
}

export function getApproval(id) {
  return approvalList().find((item) => item.id === String(id || '')) || null;
}

export function expireApprovals(now = Date.now()) {
  let changed = false;
  for (const item of approvalList()) {
    if (item.status === 'pending' && Number(item.expiresAt) <= now) {
      item.status = 'expired';
      item.updatedAt = now;
      changed = true;
    }
  }
  if (changed) saveApprovals();
  return changed;
}

export function recoverInterruptedApprovals(now = Date.now()) {
  let changed = false;
  for (const item of approvalList()) {
    if (item.status !== 'executing') continue;
    item.status = 'failed';
    item.updatedAt = now;
    item.result = {
      ...(item.result || {}),
      error: '服务重启时命令执行被中断，不能自动重放',
      interruptedAt: now,
    };
    item.executionStartedAt = null;
    changed = true;
  }
  if (changed) saveApprovals();
  return changed;
}

export function createApprovalRequest({
  taskId,
  agentId,
  commandId,
  workingDirectory = '',
  requestedBy = null,
  ttlMs = DEFAULT_TTL_MS,
  reason = '',
  runner,
} = {}) {
  const task = store.getTask(String(taskId || ''));
  if (!task) throw new CommandError('任务不存在', 404);
  const agent = store.getAgent(String(agentId || ''));
  if (!agent) throw new CommandError('智能体不存在', 404);
  if (requestedBy?.kind === 'agent' && String(requestedBy.id) !== String(agent.id)) {
    throw new CommandError('Agent 只能为自己的身份申请审批', 403);
  }
  const implementation = [...(task.plan || [])]
    .reverse()
    .find((step) => step.role === 'coder' && step.agentId);
  const request = runner.normalizeRequest({ commandId, workingDirectory });
  runner.validateForExecution(task, request);
  const now = Date.now();
  const entry = runner.get(request.commandId);
  const approval = {
    id: randomUUID(),
    status: 'pending',
    taskId: task.id,
    agentId: agent.id,
    agentName: agent.name,
    requesterIsImplementer: implementation?.agentId === agent.id,
    requestedById: text(requestedBy?.id || agent.id, 80),
    requestedByKind: text(requestedBy?.kind || 'agent', 20),
    requestedByName: text(requestedBy?.name || agent.name, 120),
    commandId: request.commandId,
    command: commandText(entry.command, entry.args),
    args: [...entry.args],
    workingDirectory: request.workingDirectory,
    reason: text(reason, 500),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + Math.max(60000, Math.min(24 * 60 * 60 * 1000, Number(ttlMs) || DEFAULT_TTL_MS)),
    decidedAt: null,
    decidedBy: null,
    executedAt: null,
    result: null,
  };
  approvalList().push(approval);
  if (approvalList().length > MAX_APPROVALS) {
    approvalList().splice(0, approvalList().length - MAX_APPROVALS);
  }
  store.addTaskEvent(task.id, {
    type: 'approval.requested',
    agentId: agent.id,
    data: {
      approvalId: approval.id,
      commandId: approval.commandId,
      command: approval.command,
      workingDirectory: approval.workingDirectory,
      expiresAt: approval.expiresAt,
    },
  });
  saveApprovals();
  return { ...approval };
}

export function decideApproval(id, { decision, principal, runner } = {}) {
  expireApprovals();
  const approval = getApproval(id);
  if (!approval) throw new CommandError('审批不存在', 404);
  const approverId = text(principal?.id || 'operator', 80);
  if (principal?.kind === 'agent' && approval.agentId && approval.agentId === approverId) {
    throw new CommandError('申请 Agent 不能处理自己的审批', 403);
  }
  if (approval.status !== 'pending') {
    throw new CommandError(`审批当前状态为 ${approval.status}，不能重复处理`, 409);
  }
  if (!['approved', 'rejected', 'cancelled'].includes(decision)) {
    throw new CommandError('审批决定无效', 400);
  }
  if (decision === 'approved' && !runner.get(approval.commandId)) {
    throw new CommandError('命令已不在白名单中，不能批准', 409);
  }
  const now = Date.now();
  approval.status = decision;
  if (decision === 'rejected') approval.executionStartedAt = null;
  approval.updatedAt = now;
  approval.decidedAt = now;
  approval.decidedBy = {
    kind: text(principal?.kind || 'operator', 20),
    id: text(principal?.id || 'operator', 80),
    name: text(principal?.name || principal?.id || 'Operator', 120),
  };
  const task = store.getTask(approval.taskId);
  if (task) {
    store.addTaskEvent(task.id, {
      type: `approval.${decision}`,
      agentId: approval.agentId,
      data: {
        approvalId: approval.id,
        commandId: approval.commandId,
        decidedBy: approval.decidedBy,
      },
    });
  }
  saveApprovals();
  return { ...approval };
}

export async function executeApproval(id, { principal, runner } = {}) {
  expireApprovals();
  const approval = getApproval(id);
  if (!approval) throw new CommandError('审批不存在', 404);
  if (
    principal?.kind === 'agent' &&
    approval.agentId &&
    String(principal.id) === String(approval.agentId)
  ) {
    throw new CommandError('申请 Agent 不能执行自己的审批命令', 403);
  }
  if (approval.status === 'expired') throw new CommandError('审批已过期', 409);
  if (approval.status !== 'approved') {
    throw new CommandError(`审批当前状态为 ${approval.status}，不能执行`, 409);
  }
  const task = store.getTask(approval.taskId);
  if (!task) throw new CommandError('审批关联任务不存在', 404);
  runner.validateForExecution(task, {
    commandId: approval.commandId,
    workingDirectory: approval.workingDirectory,
  });
  approval.status = 'executing';
  approval.updatedAt = Date.now();
  approval.executionStartedAt = approval.updatedAt;
  saveApprovals();
  try {
    const result = await runner.execute({
      task,
      request: {
        commandId: approval.commandId,
        workingDirectory: approval.workingDirectory,
      },
      agentId: approval.agentId,
      principal,
      approvalId: approval.id,
    });
    approval.status =
      result.code === 0 ? 'executed' : result.cancelled ? 'cancelled' : 'failed';
    approval.executionStartedAt = null;
    approval.executedAt = Date.now();
    approval.updatedAt = approval.executedAt;
    approval.result = {
      code: result.code,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      elapsed: result.elapsed,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
    store.addTaskEvent(task.id, {
      type: `approval.${approval.status}`,
      agentId: approval.agentId,
      data: {
        approvalId: approval.id,
        commandId: approval.commandId,
        command: approval.command,
        code: result.code,
        timedOut: result.timedOut,
        elapsed: result.elapsed,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        principal: approval.decidedBy,
      },
    });
    saveApprovals();
    return { approval: { ...approval }, result };
  } catch (err) {
    approval.status = 'failed';
    approval.executionStartedAt = null;
    approval.updatedAt = Date.now();
    approval.result = { error: err.message };
    store.addTaskEvent(task.id, {
      type: 'approval.failed',
      agentId: approval.agentId,
      data: {
        approvalId: approval.id,
        commandId: approval.commandId,
        command: approval.command,
        error: err.message,
      },
    });
    saveApprovals();
    throw err;
  }
}

export function cancelApproval(id, { principal, runner } = {}) {
  expireApprovals();
  const approval = getApproval(id);
  if (!approval) throw new CommandError('审批不存在', 404);
  if (
    principal?.kind === 'agent' &&
    approval.agentId &&
    String(principal.id) === String(approval.agentId)
  ) {
    throw new CommandError('申请 Agent 不能取消自己的审批', 403);
  }
  if (approval.status === 'executing') {
    const cancelled = runner.cancel(id);
    if (!cancelled) {
      throw new CommandError('审批执行进程已不在运行，请刷新状态', 409);
    }
    return { ...approval, cancelRequested: true };
  }
  if (!['pending', 'approved'].includes(approval.status)) {
    throw new CommandError(`审批当前状态为 ${approval.status}，不能取消`, 409);
  }
  approval.status = 'cancelled';
  approval.cancelledBy = {
    kind: text(principal?.kind || 'operator', 20),
    id: text(principal?.id || 'operator', 80),
    name: text(principal?.name || principal?.id || 'Operator', 120),
  };
  approval.updatedAt = Date.now();
  approval.decidedAt = approval.decidedAt || Date.now();
  approval.decidedBy = approval.decidedBy || {
    kind: text(principal?.kind || 'operator', 20),
    id: text(principal?.id || 'operator', 80),
    name: text(principal?.name || principal?.id || 'Operator', 120),
  };
  saveApprovals();
  return { ...approval };
}

export const approvalInternals = { MAX_APPROVALS, DEFAULT_TTL_MS };
