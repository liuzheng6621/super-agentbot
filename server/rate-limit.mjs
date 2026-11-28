/** Fixed-window rate limiting; zero dependencies and no timers. */
export class FixedWindowLimiter {
  constructor({ windowMs = 60000, max = 60, now = Date.now } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || 60000);
    this.max = Math.max(1, Number(max) || 60);
    this.now = typeof now === 'function' ? now : Date.now;
    this.buckets = new Map();
  }

  /** Returns { ok, remaining, retryAfterMs, count, limit }. */
  hit(key, { limit = this.max, cost = 1 } = {}) {
    const id = String(key || 'anonymous');
    const cap = Math.max(1, Number(limit) || this.max);
    const now = this.now();
    const bucket = this.buckets.get(id);
    if (!bucket || now - bucket.startedAt >= this.windowMs) {
      const fresh = { startedAt: now, count: Math.max(0, Number(cost) || 1) };
      this.buckets.set(id, fresh);
      return {
        ok: fresh.count <= cap,
        remaining: Math.max(0, cap - fresh.count),
        retryAfterMs: this.windowMs,
        count: fresh.count,
        limit: cap,
      };
    }
    bucket.count += Math.max(0, Number(cost) || 1);
    const ok = bucket.count <= cap;
    return {
      ok,
      remaining: Math.max(0, cap - bucket.count),
      retryAfterMs: Math.max(0, this.windowMs - (now - bucket.startedAt)),
      count: bucket.count,
      limit: cap,
    };
  }

  /** Drop expired buckets so a long-running process does not leak keys. */
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= this.windowMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  snapshot() {
    return [...this.buckets.entries()].map(([key, bucket]) => ({
      key,
      count: bucket.count,
      startedAt: bucket.startedAt,
    }));
  }

  reset() {
    this.buckets.clear();
  }
}
