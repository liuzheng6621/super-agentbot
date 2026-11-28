/** Trace / event span helpers kept pure so they can be unit tested directly. */

export function safeSpanId(value = '') {
  return String(value || '').replace(/[^\w-]/g, '').slice(0, 80);
}

/**
 * Decide the parent span for a new task event.
 *
 * - `run.start` and the trace root are roots.
 * - Step events attach to the step span; a step gets one span id for its whole
 *   lifetime and hangs under the run root.
 * - Everything else attaches to the run root.
 *
 * Returns the parent plus an optional step patch the caller must persist.
 */
export function resolveParentSpanId({
  event = {},
  type = 'event',
  spanId = '',
  trace = {},
  step = null,
  createId = () => '',
} = {}) {
  if (Object.prototype.hasOwnProperty.call(event, 'parentSpanId')) {
    return {
      parentSpanId: event.parentSpanId ? safeSpanId(event.parentSpanId) : null,
      stepPatch: null,
    };
  }
  if (type === 'run.start' || spanId === trace.rootSpanId) {
    return { parentSpanId: null, stepPatch: null };
  }
  if (!step) return { parentSpanId: trace.rootSpanId || null, stepPatch: null };

  const patch = {};
  if (!step.traceSpanId) patch.traceSpanId = createId() || safeSpanId(createId());
  if (!step.traceParentSpanId) patch.traceParentSpanId = trace.rootSpanId || null;
  const effectiveStepSpan = step.traceSpanId || patch.traceSpanId;
  if (effectiveStepSpan) patch.traceSpanId = effectiveStepSpan;
  return { parentSpanId: effectiveStepSpan || trace.rootSpanId || null, stepPatch: patch };
}
