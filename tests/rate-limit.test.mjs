import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { FixedWindowLimiter } = await import('../server/rate-limit.mjs');

test('fixed window allows up to the limit, then reports retry-after', () => {
  let now = 1_000_000;
  const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: 3, now: () => now });
  assert.equal(limiter.hit('k').ok, true);
  assert.equal(limiter.hit('k').ok, true);
  const third = limiter.hit('k');
  assert.equal(third.ok, true);
  assert.equal(third.remaining, 0);

  const blocked = limiter.hit('k');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterMs, 60_000);

  // 窗口滚过之后重新计数
  now += 60_001;
  assert.equal(limiter.hit('k').ok, true);
  // 不同 key 互不影响
  assert.equal(limiter.hit('other').ok, true);
  limiter.reset();
  assert.deepEqual(limiter.snapshot(), []);
  limiter.hit('stale');
  now += 60_001;
  assert.equal(limiter.sweep(), 1, '过期桶必须被回收');
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-rate-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

function request({ port, method = 'GET', path: target = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers, timeout: 5000 },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('repeated auth failures hit a 429 with Retry-After and an audit entry', async () => {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address();
      server.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
  const token = ['agentforge', 'rate', 'limit', '0123456789'].join('-');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: temp,
      AGENTFORGE_API_TOKEN: token,
      AGENTFORGE_SKIP_TEAM_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        const health = await request({ port, path: '/api/health' });
        if (health.status === 200) break;
      } catch {
        /* retry */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let limited = null;
    for (let i = 0; i < 12; i += 1) {
      const res = await request({
        port,
        path: '/api/state',
        headers: { Authorization: 'Bearer wrong-token-value' },
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
      assert.equal(res.status, 401);
    }
    assert.ok(limited, '连续认证失败必须触发 429');
    assert.equal(limited.body.code, 'rate-limited');
    assert.ok(Number(limited.headers['retry-after']) >= 1);

    const owner = await request({
      port,
      path: '/api/state',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(owner.status, 200, '限流不能影响正常鉴权请求');
    const audit = owner.body.security.audit.some((entry) => entry.type === 'api.rate_limited');
    assert.equal(audit, true, '限流必须写入安全审计');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    try {
      fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows may keep a handle briefly. */
    }
  }
});

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});
