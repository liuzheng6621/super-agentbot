import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticateApi,
  corsDecision,
  corsHeaders,
  parseAllowedOrigins,
  resolveSecurityConfig,
  securityInternals,
  securitySummary,
  validateListenSecurity,
} from '../server/security.mjs';

const TOKEN = ['agentforge', 'test', 'token', '0123456789'].join('-');

test('security config keeps loopback zero-config and rejects unsafe remote listen', () => {
  const loopback = resolveSecurityConfig({});
  assert.equal(loopback.tokenEnabled, false);
  assert.equal(validateListenSecurity({ host: '127.0.0.1', config: loopback }).ok, true);
  assert.equal(validateListenSecurity({ host: '::1', config: loopback }).ok, true);

  const remote = validateListenSecurity({ host: '0.0.0.0', config: loopback });
  assert.equal(remote.ok, false);
  assert.match(remote.error, /AGENTFORGE_API_TOKEN/);

  const insecure = validateListenSecurity({
    host: '0.0.0.0',
    config: { ...loopback, allowInsecureRemote: true },
  });
  assert.equal(insecure.ok, true);
  assert.ok(insecure.warning);

  const shortToken = resolveSecurityConfig({ AGENTFORGE_API_TOKEN: 'too-short' });
  assert.match(shortToken.tokenError, /至少需要 16 个字符/);
  assert.equal(validateListenSecurity({ host: '127.0.0.1', config: shortToken }).ok, false);
});

test('API token accepts bearer and dedicated header without weakening query handling', () => {
  const config = resolveSecurityConfig({ AGENTFORGE_API_TOKEN: TOKEN });
  const stateUrl = new URL('http://localhost/api/state');
  const streamUrl = new URL(`http://localhost/api/stream?token=${TOKEN}`);

  assert.equal(
    authenticateApi({ headers: { authorization: `Bearer ${TOKEN}` } }, stateUrl, config).ok,
    true,
  );
  assert.equal(
    authenticateApi({ headers: { 'x-agentforge-token': TOKEN } }, stateUrl, config).ok,
    true,
  );
  assert.equal(authenticateApi({ headers: {} }, stateUrl, config).ok, false);
  assert.equal(authenticateApi({ headers: {} }, streamUrl, config).source, 'query');
  assert.equal(
    authenticateApi({ headers: { authorization: 'Bearer wrong-token-value' } }, stateUrl, config).ok,
    false,
  );
  assert.equal(securityInternals.secureEqual(TOKEN, TOKEN), true);
  assert.equal(securityInternals.secureEqual(TOKEN, `${TOKEN}x`), false);
});

test('CORS defaults to same-origin and supports an explicit allow list', () => {
  assert.deepEqual(parseAllowedOrigins('https://a.example, https://b.example, *'), [
    'https://a.example',
    'https://b.example',
  ]);
  const config = resolveSecurityConfig({
    AGENTFORGE_API_TOKEN: TOKEN,
    AGENTFORGE_CORS_ORIGINS: 'https://team.example',
  });
  const same = corsDecision(
    { headers: { host: 'localhost:8787', origin: 'http://localhost:8787' } },
    config,
  );
  assert.equal(same.allowed, true);
  assert.equal(same.sameOrigin, true);
  assert.equal(corsHeaders(same)['Access-Control-Allow-Origin'], 'http://localhost:8787');

  const listed = corsDecision(
    { headers: { host: 'localhost:8787', origin: 'https://team.example' } },
    config,
  );
  assert.equal(listed.allowed, true);
  assert.equal(listed.sameOrigin, false);

  const denied = corsDecision(
    { headers: { host: 'localhost:8787', origin: 'https://evil.example' } },
    config,
  );
  assert.equal(denied.allowed, false);

  const summary = securitySummary({ host: '127.0.0.1', config });
  assert.equal(summary.loopbackOnly, true);
  assert.equal(summary.apiTokenConfigured, true);
  assert.deepEqual(summary.allowedOrigins, ['https://team.example']);
});
