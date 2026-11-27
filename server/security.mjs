import crypto from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const MIN_TOKEN_LENGTH = 16;

export function isLoopbackHost(host = '') {
  return LOOPBACK_HOSTS.has(String(host).trim().toLowerCase());
}

export function parseAllowedOrigins(value = '') {
  return [
    ...new Set(
      String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item && item !== '*'),
    ),
  ];
}

export function resolveSecurityConfig(env = process.env) {
  const token = String(env.AGENTFORGE_API_TOKEN || '').trim();
  return {
    token,
    tokenEnabled: !!token,
    tokenError:
      token && token.length < MIN_TOKEN_LENGTH
        ? `AGENTFORGE_API_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符`
        : '',
    allowedOrigins: parseAllowedOrigins(env.AGENTFORGE_CORS_ORIGINS),
    allowInsecureRemote: env.AGENTFORGE_ALLOW_INSECURE_REMOTE === '1',
  };
}

export function validateListenSecurity({ host, config }) {
  if (config?.tokenError) return { ok: false, error: config.tokenError };
  if (isLoopbackHost(host)) return { ok: true };
  if (config?.tokenEnabled) return { ok: true };
  if (config?.allowInsecureRemote) return { ok: true, warning: '远程监听未启用 API Token' };
  return {
    ok: false,
    error:
      `监听 ${host} 会暴露到本机之外。请设置 AGENTFORGE_API_TOKEN（至少 ${MIN_TOKEN_LENGTH} 个字符），` +
      '或显式设置 AGENTFORGE_ALLOW_INSECURE_REMOTE=1 接受无鉴权风险。',
  };
}

function suppliedToken(req, url, allowQuery) {
  const authorization = String(req.headers?.authorization || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return { value: bearer[1].trim(), source: 'bearer' };

  const headerToken = String(req.headers?.['x-agentforge-token'] || '').trim();
  if (headerToken) return { value: headerToken, source: 'header' };

  if (allowQuery) {
    const queryToken = String(url?.searchParams?.get('token') || '').trim();
    if (queryToken) return { value: queryToken, source: 'query' };
  }
  return { value: '', source: '' };
}

function secureEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

export function authenticateApi(req, url, config) {
  if (!config?.tokenEnabled) return { ok: true, source: 'disabled' };
  const supplied = suppliedToken(req, url, url?.pathname === '/api/stream');
  if (!supplied.value) return { ok: false, reason: '缺少 API Token', source: '' };
  if (!secureEqual(supplied.value, config.token)) {
    return { ok: false, reason: 'API Token 无效', source: supplied.source };
  }
  return { ok: true, source: supplied.source };
}

export function requestOrigin(req) {
  return String(req.headers?.origin || '').trim();
}

function sameOrigin(req, origin) {
  try {
    const parsed = new URL(origin);
    return parsed.host === String(req.headers?.host || '');
  } catch {
    return false;
  }
}

export function corsDecision(req, config) {
  const origin = requestOrigin(req);
  if (!origin) return { allowed: true, origin: '', sameOrigin: false };
  if (sameOrigin(req, origin)) return { allowed: true, origin, sameOrigin: true };
  if ((config?.allowedOrigins || []).includes(origin)) {
    return { allowed: true, origin, sameOrigin: false };
  }
  return { allowed: false, origin, sameOrigin: false };
}

export function corsHeaders(decision) {
  const headers = {
    Vary: 'Origin',
  };
  if (decision?.origin) headers['Access-Control-Allow-Origin'] = decision.origin;
  return headers;
}

export function clientAddress(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function securitySummary({ host, config }) {
  return {
    apiTokenConfigured: !!config?.tokenEnabled,
    host,
    loopbackOnly: isLoopbackHost(host),
    insecureRemoteAllowed: !!config?.allowInsecureRemote,
    allowedOrigins: [...(config?.allowedOrigins || [])],
  };
}

export const securityInternals = {
  MIN_TOKEN_LENGTH,
  secureEqual,
};
