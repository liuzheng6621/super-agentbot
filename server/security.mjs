import crypto from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const MIN_TOKEN_LENGTH = 16;
export const API_SCOPES = Object.freeze([
  'read',
  'task:write',
  'automation:write',
  'tool:execute',
  'operator:admin',
]);
const DEFAULT_AGENT_SCOPES = Object.freeze(['read', 'tool:execute']);
const DEFAULT_OPERATOR_SCOPES = Object.freeze([
  'read',
  'task:write',
  'automation:write',
  'tool:execute',
]);

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

export function parseScopes(value, fallback = ['read']) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/[\s,]+/)
        .filter(Boolean);
  const scopes = raw
    .map((scope) => String(scope || '').trim())
    .filter((scope) => scope === '*' || API_SCOPES.includes(scope));
  return [...new Set(scopes.length ? scopes : fallback)];
}

function principalForToken(token, input = {}, fallbackKind = 'operator') {
  const kind = ['owner', 'operator', 'agent', 'system'].includes(input.kind)
    ? input.kind
    : fallbackKind;
  const id = String(
    input.id || (kind === 'owner' ? 'owner' : kind === 'system' ? 'system' : kind),
  ).slice(0, 80);
  const scopes =
    kind === 'owner'
      ? ['*']
      : parseScopes(
          input.scopes,
          kind === 'agent' ? DEFAULT_AGENT_SCOPES : DEFAULT_OPERATOR_SCOPES,
        );
  return {
    token,
    principal: {
      kind,
      id,
      name: String(input.name || id).slice(0, 120),
      scopes,
      source: 'token',
    },
  };
}

function parseAgentTokens(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.entries(parsed).map(([token, input]) => ({ token, ...(input || {}) }))
      : [];
  return entries
    .map((item) => {
      const token = String(item?.token || '').trim();
      if (token.length < MIN_TOKEN_LENGTH) return null;
      return principalForToken(token, { ...item, kind: 'agent' }, 'agent');
    })
    .filter(Boolean);
}

function tokenErrorFor(token, label) {
  return token && token.length < MIN_TOKEN_LENGTH
    ? `${label} 至少需要 ${MIN_TOKEN_LENGTH} 个字符`
    : '';
}

export function resolveSecurityConfig(env = process.env) {
  const token = String(env.AGENTFORGE_API_TOKEN || '').trim();
  const operatorToken = String(env.AGENTFORGE_OPERATOR_TOKEN || '').trim();
  const principals = [];
  if (token) {
    principals.push(principalForToken(token, { kind: 'owner', id: 'owner', scopes: ['*'] }));
  }
  if (operatorToken) {
    principals.push(
      principalForToken(operatorToken, {
        kind: 'operator',
        id: String(env.AGENTFORGE_OPERATOR_ID || 'operator'),
        name: String(env.AGENTFORGE_OPERATOR_NAME || 'Operator'),
        scopes: env.AGENTFORGE_OPERATOR_SCOPES,
      }),
    );
  }
  principals.push(...parseAgentTokens(env.AGENTFORGE_AGENT_TOKENS));
  const tokenError =
    tokenErrorFor(token, 'AGENTFORGE_API_TOKEN') ||
    tokenErrorFor(operatorToken, 'AGENTFORGE_OPERATOR_TOKEN');
  return {
    token,
    tokenEnabled: principals.length > 0,
    tokenError,
    principals,
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
  if (!config?.tokenEnabled) {
    return {
      ok: true,
      source: 'disabled',
      principal: {
        kind: 'owner',
        id: 'owner',
        name: 'Local Owner',
        scopes: ['*'],
        source: 'loopback',
      },
    };
  }
  const supplied = suppliedToken(req, url, url?.pathname === '/api/stream');
  if (!supplied.value) return { ok: false, reason: '缺少 API Token', source: '' };
  const matched = (config.principals || []).find(
    (item) => item?.token && secureEqual(supplied.value, item.token),
  );
  if (!matched) {
    return { ok: false, reason: 'API Token 无效', source: supplied.source };
  }
  return {
    ok: true,
    source: supplied.source,
    principal: { ...matched.principal, source: supplied.source },
  };
}

export function hasScope(principal, scope) {
  const scopes = Array.isArray(principal?.scopes) ? principal.scopes : [];
  return scopes.includes('*') || scopes.includes(String(scope || ''));
}

function requiredScope(method, pathname) {
  if (pathname === '/api/shutdown' || pathname === '/api/fs') return 'operator:admin';
  if (
    pathname === '/api/probe' ||
    pathname === '/api/team/ensure' ||
    pathname === '/api/team/refresh' ||
    pathname === '/api/agents/adopt' ||
    pathname === '/api/agents/rebalance'
  ) {
    return 'operator:admin';
  }
  if (
    pathname.startsWith('/api/providers') ||
    pathname.startsWith('/api/agents') ||
    pathname === '/api/settings'
  ) {
    return method === 'GET' ? 'read' : 'operator:admin';
  }
  if (pathname.startsWith('/api/automations')) {
    return method === 'GET' ? 'read' : 'automation:write';
  }
  if (pathname.startsWith('/api/tasks')) {
    return method === 'GET' ? 'read' : 'task:write';
  }
  if (pathname.startsWith('/api/tools')) return method === 'GET' ? 'read' : 'tool:execute';
  if (method === 'GET') return 'read';
  return 'operator:admin';
}

export function authorizeApi(principal, method = 'GET', pathname = '/') {
  const scope = requiredScope(String(method || 'GET').toUpperCase(), String(pathname || '/'));
  if (hasScope(principal, scope)) return { ok: true, scope };
  return {
    ok: false,
    scope,
    reason: `主体「${principal?.id || 'anonymous'}」缺少 ${scope} 作用域`,
  };
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
    tokenCount: (config?.principals || []).length,
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
