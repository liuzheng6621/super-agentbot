import crypto from 'node:crypto';
import { APP_VERSION } from './version.mjs';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BATCH_SPANS = 256;
const MAX_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_LENGTH = 2000;
const MAX_REDACTION_DEPTH = 4;
const SENSITIVE_KEY = /(?:api[-_]?key|token|secret|pass(?:word|wd)?|authorization|cookie)/i;

function cleanText(value, max = MAX_ATTRIBUTE_LENGTH) {
  return String(value ?? '').slice(0, max);
}

function hexId(value, bytes) {
  const raw = String(value || '').toLowerCase();
  if (new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(raw)) return raw;
  return crypto
    .createHash('sha256')
    .update(raw || crypto.randomUUID())
    .digest('hex')
    .slice(0, bytes * 2);
}

function anyValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.slice(0, 32).map((item) => anyValue(item)),
      },
    };
  }
  if (value && typeof value === 'object') {
    return {
      stringValue: cleanText(JSON.stringify(value)),
    };
  }
  return { stringValue: cleanText(value) };
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return cleanText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_REDACTION_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => redact(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_ATTRIBUTES)) {
      result[cleanText(key, 120)] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return result;
  }
  return cleanText(value);
}

function attributes(input = {}) {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, MAX_ATTRIBUTES)
    .map(([key, value]) => ({
      key: cleanText(key, 120),
      value: anyValue(value),
    }));
}

function eventAttributes(event = {}) {
  const data = redact(event.data && typeof event.data === 'object' ? event.data : {});
  return attributes({
    'agentforge.event.type': event.type || 'event',
    'agentforge.event.kind': event.kind || 'event',
    'agentforge.run.id': event.runId || '',
    'agentforge.agent.id': event.agentId || '',
    'agentforge.step.id': event.stepId || '',
    ...data,
  });
}

export function otlpSpanFromEvent(event, task = {}) {
  const at = Number(event?.at) || Date.now();
  const traceId = hexId(event?.traceId || task?.trace?.traceId || task?.runId || task?.id, 16);
  const spanId = hexId(event?.spanId, 8);
  const parentSpanId = event?.parentSpanId ? hexId(event.parentSpanId, 8) : '';
  const endAt =
    event?.type === 'run.end' || event?.type === 'run.error'
      ? at
      : Number(event?.endedAt) || at + 1;
  return {
    traceId,
    spanId,
    parentSpanId,
    name: cleanText(event?.type || 'event', 120),
    kind: 1,
    startTimeUnixNano: String(Math.max(0, at) * 1_000_000),
    endTimeUnixNano: String(Math.max(at + 1, endAt) * 1_000_000),
    attributes: eventAttributes({
      ...event,
      data: {
        ...(event?.data && typeof event.data === 'object' ? event.data : {}),
        'agentforge.task.id': task?.id || '',
        'agentforge.task.title': task?.title || '',
        'agentforge.tenant.id': task?.tenantId || 'default',
      },
    }),
    status: {
      code: event?.type === 'run.error' || event?.data?.status === 'error' ? 2 : 1,
    },
  };
}

export function otlpPayload(spans = []) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            'service.name': 'agentforge',
            'service.version': APP_VERSION,
          }),
        },
        scopeSpans: [
          {
            scope: {
              name: 'agentforge.trace',
              version: APP_VERSION,
            },
            spans,
          },
        ],
      },
    ],
  };
}

export class OtlpExporter {
  constructor({ endpoint = '', headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    this.endpoint = String(endpoint || '').trim();
    this.headers = headers && typeof headers === 'object' ? headers : {};
    this.timeoutMs = Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.fetchImpl = fetchImpl;
    this.queue = [];
    this.inFlight = null;
    this.timer = null;
    this.status = {
      enabled: !!this.endpoint,
    endpoint: redactEndpoint(this.endpoint),
      queued: 0,
      exported: 0,
      failed: 0,
      lastError: '',
      lastExportAt: null,
    };
  }

  snapshot() {
    return {
      ...this.status,
      queued: this.queue.length,
      inFlight: !!this.inFlight,
    };
  }

  enqueue(spans) {
    if (!this.endpoint) return false;
    for (const span of Array.isArray(spans) ? spans : [spans]) {
      if (span) this.queue.push(span);
    }
    while (this.queue.length > MAX_BATCH_SPANS) this.queue.shift();
    this.status.queued = this.queue.length;
    if (!this.timer && !this.inFlight) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch(() => {});
      }, 0);
      this.timer.unref?.();
    }
    return true;
  }

  async flush() {
    if (this.inFlight) {
      await this.inFlight;
      if (!this.queue.length) return this.snapshot();
    }
    if (!this.endpoint || !this.queue.length) return this.snapshot();
    clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0, MAX_BATCH_SPANS);
    this.status.queued = this.queue.length;
    this.inFlight = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      timeout.unref?.();
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.headers,
          },
          body: JSON.stringify(otlpPayload(batch)),
          signal: controller.signal,
        });
        if (!response?.ok) {
          throw new Error(`OTLP receiver returned HTTP ${response?.status || 'unknown'}`);
        }
        this.status.exported += batch.length;
        this.status.lastError = '';
        this.status.lastExportAt = Date.now();
      } catch (err) {
        this.status.failed += batch.length;
        this.status.lastError = cleanText(err?.name === 'AbortError' ? 'OTLP export timed out' : err?.message || err, 500);
      } finally {
        clearTimeout(timeout);
        this.inFlight = null;
      }
    })();
    await this.inFlight;
    if (this.queue.length && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch(() => {});
      }, 0);
      this.timer.unref?.();
    }
    return this.snapshot();
  }
}

function redactEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return cleanText(endpoint, 500);
  }
}

export function resolveOtlpConfig(env = process.env) {
  let headers = {};
  if (env.AGENTFORGE_OTLP_HEADERS) {
    try {
      const parsed = JSON.parse(env.AGENTFORGE_OTLP_HEADERS);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed)
            .map(([key, value]) => [cleanText(key, 120), cleanText(value, 1000)])
            .filter(([key]) => key),
        );
      }
    } catch {
      /* Invalid optional headers must not prevent local tracing. */
    }
  }
  return {
    endpoint: String(env.AGENTFORGE_OTLP_ENDPOINT || '').trim(),
    headers,
    timeoutMs: Math.max(100, Number(env.AGENTFORGE_OTLP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  };
}
