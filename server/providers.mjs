import { randomUUID } from 'node:crypto';
import { normalizeTimeoutOverrides } from './timeouts.mjs';
import { commandKey } from './command-key.mjs';

export const DEFAULT_PROVIDER_ID = 'local-default';
export const PROVIDER_KINDS = ['cli-native', 'openai-compatible'];

const SECRET_KEY = /(?:key|token|secret|password)/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z][\w:-]*)\s*\}\}/g;
const TEMPLATE_ONLY = /^\s*(?:\{\{\s*[a-zA-Z][\w:-]*\s*\}\}\s*)+$/;
const REDACTED_SECRET = '••••••';

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

function preserveMaskedEnv(value, fallback = {}) {
  const env = cleanEnv(value);
  for (const [key, envValue] of Object.entries(env)) {
    if (envValue === REDACTED_SECRET && fallback?.[key] !== undefined) {
      env[key] = String(fallback[key]);
    }
  }
  return env;
}

function maskEnv(env) {
  const masked = {};
  for (const [key, value] of Object.entries(env || {})) {
    masked[key] =
      SECRET_KEY.test(key) && !TEMPLATE_ONLY.test(String(value ?? ''))
        ? REDACTED_SECRET
        : value;
  }
  return masked;
}

export function cliCommandKey(command) {
  return commandKey(command);
}

function cleanCliBindings(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawBinding] of Object.entries(value).slice(0, 24)) {
    const key = cliCommandKey(rawKey);
    if (!key) continue;
    const binding =
      rawBinding && typeof rawBinding === 'object' && !Array.isArray(rawBinding) ? rawBinding : {};
    const args = Array.isArray(binding.args)
      ? binding.args
          .map((arg) => String(arg ?? '').slice(0, 4000))
          .filter((arg) => arg.trim())
          .slice(0, 64)
      : [];
    const env = preserveMaskedEnv(binding.env, fallback?.[key]?.env);
    if (args.length || Object.keys(env).length) out[key] = { args, env };
  }
  return out;
}

function stringList(value, max = 16) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 80)).filter(Boolean))].slice(0, max);
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
      capabilities: ['chat', 'tools'],
      cliBindings: {},
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
    env: preserveMaskedEnv(source.env, fallback.env),
    capabilities: stringList(source.capabilities),
    cliBindings: cleanCliBindings(source.cliBindings, fallback.cliBindings),
    timeouts: normalizeTimeoutOverrides(source.timeouts),
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
  const env = maskEnv(item.env);
  const cliBindings = {};
  for (const [key, binding] of Object.entries(item.cliBindings || {})) {
    cliBindings[key] = {
      args: [...(binding.args || [])],
      env: maskEnv(binding.env),
    };
  }
  return { ...item, env, cliBindings };
}

export function resolveProvider(agent, providers = []) {
  const id = text(agent?.providerId, 64) || DEFAULT_PROVIDER_ID;
  return (
    providers.find((provider) => provider.id === id) ||
    providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ||
    null
  );
}

/**
 * Resolve the ordered provider route for an agent. Disabled providers are
 * skipped when an enabled alternative exists; if everything is disabled we
 * return the configured route so the UI can still explain why it failed.
 */
export function providerRoute(agent, providers = []) {
  const ids = [
    text(agent?.providerId, 64) || DEFAULT_PROVIDER_ID,
    ...(Array.isArray(agent?.fallbackProviderIds) ? agent.fallbackProviderIds.map(String) : []),
  ];
  const found = [];
  for (const id of [...new Set(ids)]) {
    const provider = providers.find((item) => item.id === id);
    if (provider && !found.some((item) => item.id === provider.id)) found.push(provider);
  }
  if (!found.length) {
    const primary = resolveProvider(agent, providers);
    if (primary) found.push(primary);
  }
  const enabled = found.filter((provider) => provider.enabled !== false);
  return enabled.length ? enabled : found;
}

export function providerCliBinding(provider, command) {
  const key = cliCommandKey(command);
  return key ? provider?.cliBindings?.[key] || null : null;
}

export function renderProviderTemplate(value, context = {}, { keepPrompt = true } = {}) {
  return String(value ?? '').replace(TEMPLATE_TOKEN, (match, key) => {
    if (key === 'prompt') return keepPrompt ? match : '';
    if (key.startsWith('env:')) {
      const envKey = key.slice(4);
      return context.env && Object.hasOwn(context.env, envKey) ? String(context.env[envKey]) : match;
    }
    return Object.hasOwn(context, key) ? String(context[key] ?? '') : match;
  });
}

function providerTemplateContext(provider, baseEnv = process.env) {
  const keyRef = text(provider?.apiKeyRef, 80);
  return {
    model: text(provider?.model, 160),
    baseUrl: text(provider?.baseUrl, 1000),
    apiKey: keyRef && baseEnv?.[keyRef] ? String(baseEnv[keyRef]) : '',
    providerId: text(provider?.id, 64),
    providerName: text(provider?.name, 80),
    env: { ...(baseEnv || {}), ...(provider?.env || {}) },
  };
}

export function providerEnv(provider, baseEnv = process.env, command = '') {
  if (!provider) return {};
  const context = providerTemplateContext(provider, baseEnv);
  const binding = providerCliBinding(provider, command);
  const bindingEnv = {};
  for (const [key, value] of Object.entries(binding?.env || {})) {
    bindingEnv[key] = renderProviderTemplate(value, context, { keepPrompt: false });
  }
  const env = { ...(provider.env || {}), ...bindingEnv };
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
  if (context.apiKey) {
    env.OPENAI_API_KEY ||= context.apiKey;
    env.GEMINI_API_KEY ||= context.apiKey;
    env.ANTHROPIC_API_KEY ||= context.apiKey;
    env.AGENTFORGE_PROVIDER_API_KEY ||= context.apiKey;
  }
  env.AGENTFORGE_PROVIDER_ID = provider.id;
  if (provider.name) env.AGENTFORGE_PROVIDER_NAME = provider.name;
  return env;
}

/**
 * Return a shallow execution copy. The persisted agent keeps only a provider
 * reference; resolved environment values stay in the child process.
 */
export function withProviderProfile(agent, provider, baseEnv = process.env) {
  if (!agent) return agent;
  if (!provider) return { ...agent, cli: { ...(agent.cli || {}) } };
  // An Agent-level model is an execution override, not a second provider.
  // Keep the persisted provider intact and resolve the effective copy here.
  const effectiveProvider = {
    ...provider,
    model: text(agent.model || provider.model, 160),
  };
  const command = agent.cli?.command || '';
  const binding = providerCliBinding(effectiveProvider, command);
  const context = providerTemplateContext(effectiveProvider, baseEnv);
  const args = binding?.args?.length
    ? binding.args.map((arg) => renderProviderTemplate(arg, context))
    : agent.cli?.args || [];
  return {
    ...agent,
    providerId: effectiveProvider.id,
    provider: effectiveProvider,
    cli: {
      ...(agent.cli || {}),
      args,
      env: {
        ...(agent.cli?.env || {}),
        ...providerEnv(effectiveProvider, baseEnv, command),
      },
    },
  };
}

export function providerDisplayName(provider) {
  return provider?.name || provider?.id || DEFAULT_PROVIDER_ID;
}
