import { store, randomUUID, ROLE_LABEL } from './store.mjs';
import { estimateTokens } from './tokens.mjs';
import { attachmentAbsolutePath, imageDataUrl } from './attachments.mjs';

const CONTEXT_SUMMARY_HEAD = 180;
const CONTEXT_SUMMARY_LIMIT = 24;
const CONTEXT_SUMMARY_SOURCE_LIMIT = 40;
const CONTEXT_COMPACTION_LIMIT = 20;

function compactContextMessages(messages, { beforeIndex = 0, maxMessages = 8 } = {}) {
  const candidates = messages
    .slice(0, Math.max(0, beforeIndex))
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => String(message.text || '').trim());
  if (!candidates.length) return null;
  const selected = candidates.slice(-CONTEXT_SUMMARY_SOURCE_LIMIT);
  const lines = selected
    .slice(-CONTEXT_SUMMARY_LIMIT)
    .map(({ message }) => {
      const name = message.name || message.role || 'AI';
      const text = String(message.text || '').replace(/\s+/g, ' ').trim();
      const clipped = text.length > CONTEXT_SUMMARY_HEAD
        ? `${text.slice(0, CONTEXT_SUMMARY_HEAD)}…`
        : text;
      return `- ${name}: ${clipped}`;
    });
  const sourceMessages = candidates.length;
  const sourceTokens = candidates.reduce(
    (sum, { message }) => sum + estimateTokens(message.text || ''),
    0,
  );
  const text = [
    `（早先 ${sourceMessages} 条协作消息的摘要；完整原文仍保存在任务消息中）`,
    ...lines,
  ].join('\n');
  const sourceMessageIds = candidates
    .map(({ message }) => message.id)
    .filter(Boolean);
  const first = candidates[0];
  const last = candidates.at(-1);
  const sections = [
    {
      title: '压缩范围',
      content: `覆盖第 ${first.index + 1} 至 ${last.index + 1} 条消息，共 ${sourceMessages} 条。`,
    },
    {
      title: '关键上下文',
      content: lines.join('\n') || '无',
    },
    {
      title: '保留策略',
      content: '原始消息未删除；可通过压缩历史按来源范围回放。',
    },
  ];
  const compressionRatio = sourceTokens > 0 ? estimateTokens(text) / sourceTokens : 1;
  const factors = [
    { name: '来源覆盖', value: sourceMessages, score: Math.min(100, sourceMessages * 4) },
    { name: '压缩比', value: Number(compressionRatio.toFixed(3)), score: compressionRatio <= 0.35 ? 100 : compressionRatio <= 0.6 ? 75 : 45 },
    { name: '摘要分段', value: sections.length, score: Math.min(100, sections.length * 30) },
    { name: '原文可回放', value: true, score: 100 },
  ];
  const qualityScore = Math.max(
    0,
    Math.min(100, Math.round(factors.reduce((sum, factor) => sum + factor.score, 0) / factors.length)),
  );
  const quality = {
    score: qualityScore,
    label: qualityScore >= 80 ? 'good' : qualityScore >= 55 ? 'fair' : 'weak',
    factors,
  };
  return {
    text,
    summary: text,
    sourceMessages,
    sourceTokens,
    tokens: estimateTokens(text),
    generatedAt: Date.now(),
    coversThroughIndex: Math.max(0, beforeIndex - 1),
    sourceMessageIds,
    sourceRange: {
      fromIndex: first.index,
      toIndex: last.index,
      fromMessageId: first.message.id || '',
      toMessageId: last.message.id || '',
    },
    sections,
    quality,
    originalPreserved: true,
  };
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildContextPack(
  task,
  { maxMessages = 8, maxFiles = 80, files, listFiles } = {},
) {
  let currentTask = task;
  const isPersistedTask = !!task?.id && store.getTask(task.id) === task;
  const autoCompaction = isPersistedTask
    ? maybeAutoCompact(currentTask, maxMessages)
    : currentTask?.contextState?.autoCompaction || null;
  if (autoCompaction?.compacted) {
    currentTask = store.getTask(task.id) || task;
  }
  const allFiles = files || listFiles(currentTask);
  const messages = Array.isArray(currentTask.messages) ? currentTask.messages : [];
  const visibleMessages = messages.filter((message) => message.text || message.image);
  const recentStart = Math.max(0, visibleMessages.length - maxMessages);
  const beforeIndex = messages.findIndex((message) => message === visibleMessages[recentStart]);
  const compaction = currentTask.contextState?.compaction || null;
  const compactions = Array.isArray(currentTask.contextState?.compactions)
    ? currentTask.contextState.compactions
    : compaction
      ? [compaction]
      : [];
  const recent = visibleMessages
    .slice(-maxMessages)
    .map((m) => ({
      name: m.name || m.role || 'AI',
      role: m.role || '',
      kind: m.kind || 'text',
      from: m.from?.name || m.name || '',
      to: (m.to || []).map((recipient) => recipient.name || recipient.id).join(', '),
      correlationId: m.correlationId || '',
      stepId: m.stepId || '',
      text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 300),
      image: m.image ? { ...m.image } : null,
    }));
  const images = recent.filter((message) => message.image).map((message) => message.image);
  const selectedFiles = allFiles.filter((f) => f.bytes > 0).slice(0, maxFiles);
  const estimate = estimateTokens(
    [
      currentTask.goal,
      currentTask.workspace,
      compaction?.summary || '',
      ...recent.map((m) => m.text),
      ...images.map((image) => image.sha256),
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return {
    goal: currentTask.goal,
    workspace: currentTask.workspace,
    status: currentTask.status,
    mode: currentTask.mode,
    planVersion: currentTask.planVersion || 0,
    planVersionReason: currentTask.planVersions?.at(-1)?.reason || '',
    plan: (currentTask.plan || []).map((s) => ({
      id: s.id,
      title: s.title,
      role: s.role,
      status: s.status,
      round: s.round || 0,
    })),
    files: selectedFiles,
    messages: recent,
    images,
    compaction,
    contextState: {
      estimatedTokens: estimate,
      messages: visibleMessages.length,
      files: allFiles.length,
      budget: { maxMessages, maxFiles },
      contextWindow: numericOrNull(currentTask.contextState?.contextWindow),
      autoCompactAt: numericOrNull(currentTask.contextState?.autoCompactAt),
      lastCompactionAt: numericOrNull(compaction?.generatedAt),
      compaction: compaction || null,
      compactions: compactions.length,
      autoCompaction: autoCompaction || currentTask.contextState?.autoCompaction || null,
    },
    budget: {
      maxMessages,
      maxFiles,
      messagesAvailable: messages.length,
      filesAvailable: allFiles.length,
    },
  };
}

function maybeAutoCompact(task, maxMessages) {
  if (!task?.id) return null;
  const contextWindow = numericOrNull(task.contextState?.contextWindow);
  const autoCompactAt = numericOrNull(task.contextState?.autoCompactAt);
  if (contextWindow === null && autoCompactAt === null) return null;
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const pressure = estimateTokens(
    [task.goal, task.workspace, ...messages.map((message) => message.text || '')]
      .filter(Boolean)
      .join('\n'),
  );
  const threshold =
    autoCompactAt !== null
      ? autoCompactAt
      : contextWindow !== null
        ? Math.max(1, Math.floor(contextWindow * 0.8))
        : null;
  if (threshold === null || pressure < threshold) {
    return {
      status: 'below-threshold',
      pressure,
      threshold,
    };
  }
  const result = compactTaskContext(task.id, {
    maxMessages,
    force: false,
    auto: true,
  });
  if (result?.compacted) {
    return {
      status: 'compacted',
      pressure,
      threshold,
      compactionId: result.contextState?.compaction?.id || null,
    };
  }
  return {
    status: result?.reason || 'not-enough-history',
    pressure,
    threshold,
  };
}

export function compactTaskContext(taskId, { maxMessages = 8, force = false, auto = false } = {}) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const visible = messages.filter((message) => String(message.text || '').trim());
  const keepFrom = Math.max(0, visible.length - maxMessages);
  const source = visible.slice(0, keepFrom);
  if (!source.length) {
    return {
      compacted: false,
      reason: 'not-enough-history',
      contextState: task.contextState || null,
    };
  }
  const sourceLastIndex = messages.findIndex((message) => message === source.at(-1));
  const previous = task.contextState?.compaction || null;
  if (
    !force &&
    previous?.sourceRange &&
    sourceLastIndex >= 0 &&
    sourceLastIndex <= Number(previous.sourceRange.toIndex)
  ) {
    return {
      compacted: false,
      reason: 'already-compacted',
      contextState: task.contextState || null,
    };
  }
  const sourceTokens = source.reduce((sum, message) => sum + estimateTokens(message.text || ''), 0);
  const compacted = compactContextMessages(messages, {
    beforeIndex: sourceLastIndex + 1,
    maxMessages,
  });
  if (!compacted) {
    return {
      compacted: false,
      reason: 'not-enough-history',
      contextState: task.contextState || null,
    };
  }
  if (!force && compacted.sourceMessages <= maxMessages) {
    return {
      compacted: false,
      reason: 'already-within-budget',
      contextState: task.contextState || null,
    };
  }
  const summary = compacted.summary;
  const compaction = {
    id: randomUUID(),
    summary,
    sections: compacted.sections,
    quality: compacted.quality,
    generatedAt: compacted.generatedAt,
    sourceMessages: compacted.sourceMessages,
    sourceTokens,
    tokens: compacted.tokens,
    coversThroughIndex: compacted.coversThroughIndex,
    sourceMessageIds: compacted.sourceMessageIds,
    sourceRange: compacted.sourceRange,
    auto: auto === true,
    previousGeneratedAt: previous?.generatedAt || null,
    originalPreserved: true,
  };
  const previousHistory = Array.isArray(task.contextState?.compactions)
    ? task.contextState.compactions
    : previous
      ? [previous]
      : [];
  const state = store.updateContextState(task.id, {
    compaction,
    compactions: [...previousHistory, compaction].slice(-CONTEXT_COMPACTION_LIMIT),
    autoCompaction: {
      status: auto ? 'compacted' : 'manual',
      at: compacted.generatedAt,
      compactionId: compaction.id,
    },
  });
  store.addTaskEvent(task.id, {
    type: 'context.compacted',
    runId: task.runId || null,
    data: {
      sourceMessages: compacted.sourceMessages,
      sourceTokens,
      summaryTokens: compacted.tokens,
      coversThroughIndex: compacted.coversThroughIndex,
      sourceRange: compacted.sourceRange,
      quality: compacted.quality,
      auto: auto === true,
      originalPreserved: true,
    },
  });
  return { compacted: true, reason: 'compacted', compaction, contextState: state };
}

export function listTaskCompactions(taskId) {
  const task = store.getTask(taskId);
  if (!task) return [];
  const history = Array.isArray(task.contextState?.compactions)
    ? task.contextState.compactions
    : task.contextState?.compaction
      ? [task.contextState.compaction]
      : [];
  return [...history].sort((a, b) => Number(a.generatedAt || 0) - Number(b.generatedAt || 0));
}

export function replayTaskCompaction(taskId, compactionId) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const compaction = listTaskCompactions(taskId).find((item) => item.id === compactionId);
  if (!compaction) return null;
  const ids = new Set(compaction.sourceMessageIds || []);
  const messages = (task.messages || []).filter((message) => ids.has(message.id));
  return {
    compaction,
    messages,
    originalPreserved: true,
  };
}

export function stableBlock(context) {
  if (!context) return '';
  return ['# 项目上下文', `- 目标: ${context.goal}`, `- 工作区: ${context.workspace}`].join('\n');
}

export function volatileBlock(context, step = '', { inlineImages = true } = {}) {
  if (!context) return '';
  return [
    '# 项目上下文（实时）',
    `- 状态: ${context.status}`,
    `- 计划版本: v${context.planVersion || 0}${context.planVersionReason ? ` · ${context.planVersionReason}` : ''}`,
    step ? `- 当前工序: ${step}` : '',
    '',
    '# 工序账本',
    context.plan?.length
      ? context.plan.map((s) => `- [${s.status}] ${ROLE_LABEL[s.role] || s.role} · ${s.title}`).join('\n')
      : '- 暂无',
    '',
    '# 最近协作摘要',
    context.compaction?.summary ? `- 早先上下文：${context.compaction.summary}` : '',
    context.messages.length
      ? context.messages
          .map((m) =>
            m.image
              ? `- ${m.name}: [图片 ${m.image.width}×${m.image.height} ${m.image.mime} sha256=${m.image.sha256.slice(0, 12)}] ${m.text || ''}`.trim()
              : `- ${m.name}: ${m.text}`,
          )
          .join('\n')
      : '- 暂无',
    context.images?.length
      ? `\n# 本轮图片输入\n${context.images
          .map((image, index) => {
            const meta = `${index + 1}. ${image.mime} ${image.width}×${image.height}`;
            if (!inlineImages) {
              return `${meta}，只读路径：${attachmentAbsolutePath(image)}`;
            }
            return `${meta}，data URL：data:${image.mime};base64,${imageDataUrl(image).split(',')[1]}`;
          })
          .join('\n')}`
      : '',
    '',
    '# 已知文件',
    context.files.length
      ? context.files.map((f) => `- ${f.path} (${f.bytes}B)`).join('\n')
      : '- 暂无',
  ]
    .filter(Boolean)
    .join('\n');
}
