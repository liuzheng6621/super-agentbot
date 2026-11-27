const ROLE_WHITELIST = new Set(['architect', 'coder', 'tester', 'reviewer']);
const RESERVED_ID = /^(?:debate|plan|fix-\d+|retest-\d+|re-review-\d+)$/;
const VALID_ID = /^[a-z][a-z0-9-]{0,39}$/;
const JSON_FENCE = /```json\s*([\s\S]*?)```/gi;
const NEXT_STEP = /(?:^|\n)\s*下一步建议\s*[：:]/;
const MAX_OUTPUT_PATHS = 8;

function failure(reason) {
  return { ok: false, steps: [], reason };
}

function normalizeTitle(value, id) {
  const title = String(value || '').trim();
  return title || id;
}

function parseLastJsonBlock(text) {
  const value = String(text || '');
  const blocks = [...value.matchAll(JSON_FENCE)];
  if (!blocks.length) return { ok: false, reason: '没有找到 JSON 代码块' };
  const block = blocks.at(-1);
  const closingEnd = (block.index || 0) + block[0].length;
  const closing = value.slice(closingEnd);
  const nextSteps = [...closing.matchAll(new RegExp(NEXT_STEP.source, 'g'))];
  if (!nextSteps.length) return { ok: false, reason: 'JSON 代码块后缺少最终的「下一步建议：」收口行' };
  const nextStep = nextSteps.at(-1);
  if (/\S/.test(closing.slice(0, nextStep.index))) {
    return { ok: false, reason: '「下一步建议：」必须是 JSON 代码块后的第一个非空内容' };
  }
  if (/\S/.test(closing.slice(nextStep.index + nextStep[0].length).split(/\r?\n/).slice(1).join('\n'))) {
    return { ok: false, reason: '「下一步建议：」必须是 JSON 代码块之后的最后内容' };
  }
  try {
    return { ok: true, value: JSON.parse(block[1]) };
  } catch (err) {
    return { ok: false, reason: `JSON 解析失败：${err.message}` };
  }
}

function validateOutputPath(value) {
  const rel = String(value || '');
  if (!rel) return '输出路径不能为空';
  if (rel.includes('\\')) return `输出路径不能包含反斜杠：${rel}`;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return `输出路径必须是工作区相对路径：${rel}`;
  const segments = rel.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return `输出路径包含空段或越界段：${rel}`;
  }
  if (segments.some((segment) => segment === '.git' || segment === '.agentforge')) {
    return `输出路径不能进入保留目录：${rel}`;
  }
  return '';
}

function validateNeedsReachability(steps, review) {
  const ids = new Set(steps.map((step) => step.id));
  const parents = new Map(steps.map((step) => [step.id, step.needs || []]));
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id) || id === 'plan' || !ids.has(id)) return;
    visited.add(id);
    for (const need of parents.get(id) || []) visit(need);
  };
  for (const need of review.needs || []) visit(need);
  return visited.size === steps.length - 1;
}

export function parsePlannerPlan(text) {
  const parsed = parseLastJsonBlock(text);
  if (!parsed.ok) return failure(parsed.reason);
  const payload = parsed.value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure('JSON 顶层必须是包含 steps 数组的对象');
  }
  if (!Array.isArray(payload.steps)) return failure('JSON 缺少 steps 数组');
  const steps = payload.steps;
  if (steps.length < 2 || steps.length > 12) {
    return failure(`工序数量必须在 2 到 12 之间，当前为 ${steps.length}`);
  }

  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < steps.length; index += 1) {
    const input = steps[index];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return failure(`第 ${index + 1} 个工序必须是对象`);
    }
    const id = String(input.id || '').trim();
    if (!VALID_ID.test(id)) return failure(`工序 id 不合法：${id || '(空)'}`);
    if (RESERVED_ID.test(id)) return failure(`工序 id 使用了平台保留值：${id}`);
    if (seen.has(id)) return failure(`工序 id 重复：${id}`);
    if (id === 'review' && input.role !== 'reviewer') {
      return failure('非 reviewer 工序不能占用保留 id：review');
    }
    seen.add(id);

    const role = String(input.role || '').trim();
    if (!ROLE_WHITELIST.has(role)) return failure(`工序「${id}」的角色不合法：${role || '(空)'}`);
    if (input.needs !== undefined && !Array.isArray(input.needs)) {
      return failure(`工序「${id}」的 needs 必须是数组`);
    }
    const needs = Array.isArray(input.needs) ? [...new Set(input.needs.map(String))] : [];
    for (const need of needs) {
      if (need !== 'plan' && !seen.has(need)) {
        return failure(`工序「${id}」只能依赖 plan 或更早出现的工序：${need}`);
      }
    }
    if (input.outputPaths !== undefined && !Array.isArray(input.outputPaths)) {
      return failure(`工序「${id}」的 outputPaths 必须是数组`);
    }
    const outputPaths = Array.isArray(input.outputPaths) ? input.outputPaths.map(String) : [];
    if (outputPaths.length > MAX_OUTPUT_PATHS) {
      return failure(`工序「${id}」的 outputPaths 最多 ${MAX_OUTPUT_PATHS} 个`);
    }
    for (const outputPath of outputPaths) {
      const reason = validateOutputPath(outputPath);
      if (reason) return failure(`工序「${id}」${reason}`);
    }
    normalized.push({
      id,
      title: normalizeTitle(input.title, id),
      role,
      needs,
      outputPaths,
    });
  }

  const roles = new Set(normalized.map((step) => step.role));
  if (!roles.has('coder')) return failure('计划至少需要一个 coder 工序');
  if (!roles.has('tester')) return failure('计划至少需要一个 tester 工序');
  const reviewers = normalized.filter((step) => step.role === 'reviewer');
  if (reviewers.length !== 1) return failure(`计划必须恰好包含一个 reviewer，当前为 ${reviewers.length}`);

  const review = reviewers[0];
  const reviewIndex = normalized.indexOf(review);
  const dependedOn = new Set(normalized.flatMap((step) => step.needs || []));
  if (dependedOn.has(review.id)) return failure('reviewer 必须是终端节点，不能被其他工序依赖');
  if (reviewIndex !== normalized.length - 1) return failure('reviewer 必须是计划中的最后一个工序');
  if (!validateNeedsReachability(normalized, review)) {
    return failure('reviewer 必须直接或间接覆盖其余全部工序');
  }

  if (review.id !== 'review') {
    const previousId = review.id;
    review.id = 'review';
    for (const step of normalized) {
      step.needs = step.needs.map((need) => (need === previousId ? 'review' : need));
    }
  }
  return { ok: true, steps: normalized, reason: '' };
}

export function isPlannerPlanComplete(text) {
  const parsed = parseLastJsonBlock(text);
  if (!parsed.ok) return false;
  const plan = parsePlannerPlan(text);
  return plan.ok;
}
