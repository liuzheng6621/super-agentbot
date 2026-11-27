import * as sim from './sim.mjs';
import { parseReviewVerdictDetails } from './review-analysis.mjs';

export function parseProposalScores(text, { selfId = '' } = {}) {
  const scores = {};
  const value = String(text || '');
  const normalizeId = (raw) => {
    const cleaned = String(raw || '').replace(/[*`]/g, '').trim();
    const match = cleaned.match(/^(?:方案\s*)?([A-F])(?:\s*方案)?$/i);
    return match ? match[1].toUpperCase() : '';
  };
  const parseScore = (raw) => {
    const match = String(raw || '').match(/\d{1,2}(?:\.\d+)?/);
    if (!match) return null;
    const score = Number(match[0]);
    if (!Number.isFinite(score) || score < 1 || score > 10) return null;
    return Math.round(score * 10) / 10;
  };
  const setScore = (rawId, rawScore) => {
    const id = normalizeId(rawId);
    const score = parseScore(rawScore);
    if (!id || id === selfId || score == null || scores[id] != null) return;
    scores[id] = score;
  };

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    setScore(cells[0], cells[1]);
  }

  // CLI 经常省略“方案”和表格，直接写成 A=7、B：8分 或 方案 C 7/10。
  // 统一在去掉 Markdown 强调符后按行解析，已有分数不会被后出现的宽松格式覆盖。
  const inline = value.replace(/[*`]/g, '');
  const patterns = [
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*(?:评分|得分|分数)?\s*[:：=＝]\s*(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|分)?/gi,
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*(?:评分|得分|分数)?\s*[:：=＝]?\s*(\d{1,2}(?:\.\d+)?)\s*(?:分|\/\s*10)/gi,
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*[（(]\s*(\d{1,2}(?:\.\d+)?)\s*(?:分|\/\s*10)?\s*[)）]/gi,
    /(?:^|[\s,，;；。:：|])(?:方案\s*)?([A-F])\s*(?:方案)?\s*[-—–]\s*(\d{1,2}(?:\.\d+)?)\s*(?:分|\/\s*10)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of inline.matchAll(pattern)) setScore(match[1], match[2]);
  }
  return scores;
}

const PROPOSAL_DUPLICATE_THRESHOLD = 0.72;

function proposalFingerprint(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  if (normalized.length < 3) return new Set();
  const grams = new Set();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    grams.add(normalized.slice(index, index + 3));
  }
  return grams;
}

function jaccardSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

/**
 * 辩论不是投票越多越好：多个成员重复同一条路线时，表面票数会掩盖视角缺失。
 * 这里只做确定性审计，不调用模型，也不改变提案原文和原始评分。
 */
export function proposalDiversity(proposals = []) {
  const items = proposals
    .filter((proposal) => proposal.status !== 'failed')
    .map((proposal) => ({
      id: String(proposal.id || ''),
      angleKey: sim.angleByKey(proposal.angleKey).key,
      fingerprint: proposalFingerprint(proposal.text),
    }))
    .filter((proposal) => proposal.id);
  const pairs = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      pairs.push({
        ids: [items[left].id, items[right].id],
        similarity: jaccardSimilarity(items[left].fingerprint, items[right].fingerprint),
      });
    }
  }
  const duplicatePairs = pairs.filter(
    (pair) => pair.similarity >= PROPOSAL_DUPLICATE_THRESHOLD,
  );
  const duplicateIds = new Set(duplicatePairs.flatMap((pair) => pair.ids));
  const duplicateGroups = [];
  for (const pair of duplicatePairs) {
    const matching = duplicateGroups.find((group) =>
      pair.ids.some((id) => group.includes(id)),
    );
    if (matching) {
      for (const id of pair.ids) {
        if (!matching.includes(id)) matching.push(id);
      }
    } else {
      duplicateGroups.push([...pair.ids]);
    }
  }
  const angleKeys = [...new Set(items.map((proposal) => proposal.angleKey))];
  const expectedAngles = Math.min(3, Math.max(2, items.length));
  const angleCoverage = expectedAngles ? angleKeys.length / expectedAngles : 0;
  const maxSimilarity = pairs.reduce(
    (maximum, pair) => Math.max(maximum, pair.similarity),
    0,
  );
  const issues = [];
  if (duplicatePairs.length) {
    issues.push({
      code: 'duplicate-proposals',
      message: '存在高度相似方案，独立视角不足',
      ids: [...duplicateIds],
    });
  }
  if (items.length >= 3 && angleKeys.length < expectedAngles) {
    issues.push({
      code: 'angle-coverage-low',
      message: `仅覆盖 ${angleKeys.length} 个角度，建议至少 ${expectedAngles} 个`,
      angleKeys,
    });
  }
  return {
    sufficient: issues.length === 0,
    threshold: PROPOSAL_DUPLICATE_THRESHOLD,
    maxSimilarity: Math.round(maxSimilarity * 1000) / 1000,
    duplicateIds: [...duplicateIds],
    duplicateGroups,
    angleKeys,
    angleCoverage: Math.round(Math.min(1, angleCoverage) * 1000) / 1000,
    issues,
  };
}

export function rankProposals(proposals = []) {
  const diversity = proposalDiversity(proposals);
  const duplicateIds = new Set(diversity.duplicateIds);
  const list = proposals
    .filter((p) => p.status !== 'failed')
    .map((p) => {
      const votes = p.votes || [];
      const average = votes.length
        ? votes.reduce((sum, v) => sum + Number(v.score || 0), 0) / votes.length
        : null;
      const duplicateOf = (diversity.duplicateGroups.find((group) => group.includes(p.id)) || [])
        .filter((id) => id !== p.id);
      const diversityPenalty = duplicateIds.has(p.id) ? 1.5 : 0;
      return {
        id: p.id,
        name: p.name,
        agentId: p.agentId,
        angleKey: p.angleKey,
        angleLabel: sim.angleByKey(p.angleKey).label,
        average,
        effectiveScore: average == null ? null : average - diversityPenalty,
        diversityPenalty,
        duplicateGroup: duplicateOf.length ? [p.id, ...duplicateOf] : [],
        votes: votes.length,
        text: p.text || '',
      };
    });

  list.sort((a, b) => {
    if (a.effectiveScore == null && b.effectiveScore == null) return a.id.localeCompare(b.id);
    if (a.effectiveScore == null) return 1;
    if (b.effectiveScore == null) return -1;
    if (Math.abs(b.effectiveScore - a.effectiveScore) > 1e-9) {
      return b.effectiveScore - a.effectiveScore;
    }
    if (b.votes !== a.votes) return b.votes - a.votes;
    return a.id.localeCompare(b.id);
  });
  return list;
}

function proposalHeadingCount(text) {
  const value = String(text || '');
  const headings = value.matchAll(
    /^\s{0,3}(?:#{1,6}\s*)?(?:\d+[.\u3001]\s*)?(?:\*\*|__)?\s*(\u6838\u5fc3\u4e3b\u5f20|\u6280\u672f\u8def\u7ebf|\u843d\u5730\u5de5\u5e8f|\u4ee3\u4ef7\u4e0e\u98ce\u9669|\u5de5\u4f5c\u91cf(?:\u4f30\u8ba1)?)\s*(?:\*\*|__)?\s*(?:[:\uFF1A]|$)/gm,
  );
  const keys = new Set();
  for (const heading of headings) keys.add(heading[1]);
  return keys.size;
}

export function isUsableProposalText(text) {
  const value = String(text || '');
  return value.trim().length >= 200 && proposalHeadingCount(value) >= 3;
}

export function isCompleteProposalText(text) {
  return String(text || '').trim().length >= 400 && proposalHeadingCount(text) >= 5;
}

export function isCompleteCritiqueText(text, expectedIds = []) {
  const value = String(text || '');
  if (!/(?:\u9009\u62e9|\u63a8\u8350)\s*[:\uFF1A]/.test(value)) return false;
  const scores = parseProposalScores(value);
  return expectedIds.length > 0 && expectedIds.every((id) => scores[id] != null);
}

export function isCompleteStepText(text, role = '') {
  const value = String(text || '');
  if (value.trim().length < 20) return false;
  if (role === 'reviewer') {
    return parseReviewVerdictDetails(value).valid;
  }
  return /\u4e0b\u4e00\u6b65\u5efa\u8bae\s*[:\uFF1A]/.test(value);
}

export function isCompleteSummaryText(text) {
  const value = String(text || '');
  return (
    value.trim().length >= 200 &&
    /(?:\u4ea4\u4ed8\u7ed3\u8bba|\u4ea4\u4ed8\u6536\u53e3)/.test(value) &&
    /\u9700\u8981\u7528\u6237\u62cd\u677f/.test(value)
  );
}

export function isCompleteDecisionText(text) {
  const value = String(text || '');
  return (
    value.trim().length >= 120 &&
    /(?:\u91c7\u7eb3|\u88c1\u51b3)/.test(value) &&
    /\u786c\u7ea6\u675f/.test(value)
  );
}
