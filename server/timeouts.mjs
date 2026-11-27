const DEFAULT_TIMEOUTS = Object.freeze({
  proposal: 360000,
  critique: 360000,
  decision: 240000,
  step: 900000,
  qualityGate: 300000,
});

const LIMITS = Object.freeze({
  proposal: [30000, 3600000],
  critique: [30000, 3600000],
  decision: [30000, 3600000],
  step: [30000, 7200000],
  qualityGate: [30000, 3600000],
});

export const TIMEOUT_KEYS = Object.freeze(Object.keys(DEFAULT_TIMEOUTS));
export const TIMEOUT_LABELS = Object.freeze({
  proposal: '方案提案',
  critique: '交叉质询',
  decision: '方案裁决',
  step: '工序执行',
  qualityGate: '质量门',
});

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function normalizeLayer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const key of TIMEOUT_KEYS) {
    const number = positive(value[key]);
    if (number === null) continue;
    const [min, max] = LIMITS[key];
    output[key] = Math.min(max, Math.max(min, number));
  }
  return output;
}

/** Return only explicit, bounded overrides. Missing keys stay inherited. */
export function normalizeTimeoutOverrides(value) {
  return normalizeLayer(value);
}

export function defaultTimeouts() {
  return { ...DEFAULT_TIMEOUTS };
}

/**
 * Resolve a timeout in this order: explicit call, Agent/Profile, Provider,
 * global settings, built-in defaults. Every layer is bounded so a bad setting
 * cannot create an unbounded process.
 */
export function resolveTimeouts({ settings, agent, provider } = {}) {
  const layers = [
    normalizeLayer(settings?.timeouts),
    normalizeLayer(provider?.timeouts),
    normalizeLayer(agent?.timeouts),
  ];
  const result = defaultTimeouts();
  for (const layer of layers) Object.assign(result, layer);
  return result;
}

export function effectiveTimeoutsFor(agent, { provider = null, settings = null } = {}) {
  return resolveTimeouts({
    settings: settings || {},
    provider,
    agent,
  });
}

export function timeoutFor(agent, kind, { provider = null, settings = null, explicit = null } = {}) {
  return resolveTimeout(
    kind,
    {
      settings: settings || {},
      provider,
      agent,
    },
    explicit,
  );
}

export function resolveTimeout(kind, sources = {}, explicit = null) {
  const direct = positive(explicit);
  if (direct !== null && TIMEOUT_KEYS.includes(kind)) {
    const [min, max] = LIMITS[kind];
    return Math.min(max, Math.max(min, direct));
  }
  return resolveTimeouts(sources)[kind];
}

export function timeoutCatalog() {
  return TIMEOUT_KEYS.map((key) => ({
    key,
    label: TIMEOUT_LABELS[key],
    defaultMs: DEFAULT_TIMEOUTS[key],
    minMs: LIMITS[key][0],
    maxMs: LIMITS[key][1],
  }));
}

export function timeoutSummary(timeouts) {
  const resolved = { ...defaultTimeouts(), ...(timeouts || {}) };
  return TIMEOUT_KEYS.map((key) => `${key}=${Math.round(resolved[key] / 1000)}s`).join(', ');
}

/** Convert milliseconds to the seconds used by the settings/Profile forms. */
export function timeoutSeconds(timeouts = {}) {
  const output = {};
  for (const key of TIMEOUT_KEYS) {
    const value = positive(timeouts?.[key]);
    if (value !== null) output[key] = Math.round(value / 1000);
  }
  return output;
}
