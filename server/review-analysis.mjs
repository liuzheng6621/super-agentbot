export function parseReviewVerdictDetails(text) {
  const value = String(text || '');
  const matches = [
    ...value.matchAll(/(?:VERDICT|质量门结论)\s*[:：]\s*(\{[\s\S]*?\})/gi),
  ];
  const raw = matches.at(-1)?.[1] || '';
  if (!raw) {
    return {
      decision: 'unknown',
      structured: false,
      valid: false,
      blockers: null,
      should: null,
      raw: '',
      reason: '缺少结构化 VERDICT JSON',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      decision: 'unknown',
      structured: true,
      valid: false,
      blockers: null,
      should: null,
      raw,
      reason: 'VERDICT JSON 无法解析',
    };
  }
  const hasBlockers = Object.prototype.hasOwnProperty.call(parsed || {}, 'blockers');
  const hasShould =
    Object.prototype.hasOwnProperty.call(parsed || {}, 'should') ||
    Object.prototype.hasOwnProperty.call(parsed || {}, 'shouldFix');
  if (!hasBlockers || !hasShould) {
    return {
      decision: 'unknown',
      structured: true,
      valid: false,
      blockers: null,
      should: null,
      raw,
      reason: 'VERDICT 缺少 blockers 或 should 字段',
    };
  }
  const normalized = String(parsed?.decision || '').trim().toUpperCase();
  const decision =
    normalized === 'PASS' || normalized === '通过'
      ? 'pass'
      : normalized === 'FAIL' || normalized === '不通过' || normalized === '未通过'
        ? 'fail'
        : 'unknown';
  const rawBlockers = parsed?.blockers;
  const rawShould = parsed?.should ?? parsed?.shouldFix;
  const blockers = typeof rawBlockers === 'number' ? rawBlockers : NaN;
  const should = typeof rawShould === 'number' ? rawShould : NaN;
  if (
    decision === 'unknown' ||
    rawBlockers === null ||
    rawShould === null ||
    !Number.isInteger(blockers) ||
    blockers < 0 ||
    !Number.isInteger(should) ||
    should < 0
  ) {
    return {
      decision: 'unknown',
      structured: true,
      valid: false,
      blockers: Number.isFinite(blockers) ? blockers : null,
      should: Number.isFinite(should) ? should : null,
      raw,
      reason: 'VERDICT 字段不合法',
    };
  }
  if (decision === 'pass' && blockers > 0) {
    return {
      decision: 'unknown',
      structured: true,
      valid: false,
      blockers,
      should,
      raw,
      reason: 'PASS 不能带 Blocker',
    };
  }
  return {
    decision,
    structured: true,
    valid: true,
    blockers,
    should,
    raw,
    reason: '',
  };
}

export function parseReviewVerdict(text) {
  const details = parseReviewVerdictDetails(text);
  return details.decision === 'pass' ? true : details.decision === 'fail' ? false : null;
}
