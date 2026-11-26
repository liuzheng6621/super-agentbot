import { randomUUID } from 'node:crypto';

export const DEFAULT_PROVIDER_ID = 'local-default';
export const PROVIDER_KINDS = ['cli-native', 'openai-compatible'];

const SECRET_KEY = /(?:key|token|secret|password)/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function integer(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = text(rawKey, 80);
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    out[key] = String(rawValue).slice(0, 4000);
  }
  return out;
}

export function defaultProviders() {
  return [
    {
      id: DEFAULT_PROVIDER_ID,
      name: '本机 CLI',
      kind: 'cli-native',
      baseUrl: '',
      model: '',
      apiKeyRef: '',
      env: {},
      maxConcurrency: 2,
      enabled: true,
      builtin: true,
      createdAt: Date.now(),
    },
  ];
}

export function normalizeProvider(input = {}, fallback = {}) {
  const source = { ...fallback, ...input };
  const name = text(source.name, 40) || '未命名 Provider';
  const rawId = text(source.id || fallback.id, 64);
  const id = PROVIDER_ID.test(rawId)
    ? rawId
    : `provider-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  return {
    id,
    name,
    kind: PROVIDER_KINDS.includes(source.kind) ? source.kind : 'cli-native',
    baseUrl: text(source.baseUrl, 1000),
    model: text(source.model, 160),
    apiKeyRef: text(source.apiKeyRef, 80),
    env: cleanEnv(source.env),
    maxConcurrency: integer(source.maxConcurrency, 1, 16, 2),
    enabled: source.enabled !== false,
    builtin: source.builtin === true || fallback.builtin === true,
    createdAt: Number(source.createdAt) || Date.now(),
  };
}

/**
 * Provider profiles are configuration, not secret storage. API responses keep
 * environment keys visible so they can be edited, but mask secret-looking
 * values and never return an API key resolved from process.env.
 */
export function redactProvider(provider) {
  const item = normalizeProvider(provider);
  const env = {};
  for (const [key, value] of Object.entries(item.env)) {
    env[key] = SECRET_KEY.test(key) ? '••••••' : value;
  }
  return { ...item, env };
}

export function resolveProvider(agent, providers = []) {
  const id = text(agent?.providerId, 64) || DEFAULT_PROVIDER_ID;
  return (
    providers.find((provider) => provider.id === id) ||
    providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ||
    null
  );
}

export function providerEnv(provider, baseEnv = process.env) {
  if (!provider) return {};
  const env = { ...(provider.env || {}) };
  const baseUrl = text(provider.baseUrl, 1000);
  const model = text(provider.model, 160);
  if (baseUrl) {
    env.OPENAI_BASE_URL ||= baseUrl;
    env.OPENAI_API_BASE ||= baseUrl;
    env.GOOGLE_GEMINI_BASE_URL ||= baseUrl;
    env.ANTHROPIC_BASE_URL ||= baseUrl;
    env.AGENTFORGE_PROVIDER_BASE_URL = baseUrl;
  }
  if (model) {
    env.OPENAI_MODEL ||= model;
    env.AGENTFORGE_MODEL = model;
  }
  const keyRef = text(provider.apiKeyRef, 80);
  if (keyRef && baseEnv?.[keyRef]) {
    env.OPENAI_API_KEY ||= String(baseEnv[keyRef]);
    env.GEMINI_API_KEY ||= String(baseEnv[keyRef]);
    env.ANTHROPIC_API_KEY ||= String(baseEnv[keyRef]);
    env.AGENTFORGE_PROVIDER_API_KEY ||= String(baseEnv[keyRef]);
  }
  env.AGENTFORGE_PROVIDER_ID = provider.id;
  return env;
}

/**
 * Return a shallow execution copy. The persisted agent keeps only a provider
 * reference; resolved environment values stay in the child process.
 */
export function withProviderProfile(agent, provider, baseEnv = process.env) {
  if (!agent) return agent;
  if (!provider) return { ...agent, cli: { ...(agent.cli || {}) } };
  return {
    ...agent,
    providerId: provider.id,
    provider: { ...provider },
    cli: {
      ...(agent.cli || {}),
      env: {
        ...(agent.cli?.env || {}),
        ...providerEnv(provider, baseEnv),
      },
    },
  };
}

export function providerDisplayName(provider) {
  return provider?.name || provider?.id || DEFAULT_PROVIDER_ID;
}
