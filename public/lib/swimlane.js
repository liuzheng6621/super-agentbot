/**
 * Swimlane derivation for task messages.
 *
 * Pure browser/Node module: derive from existing task data only, no backend
 * fields. The goal is a stable, deterministic model suitable for unit tests
 * and for rendering later.
 */

const SYSTEM_LANE_ID = "__system__";

const SYSTEM_KINDS = new Set([
  "system",
  "quality",
  "plan",
  "summary",
  "decision",
]);

const USER_KINDS = new Set(["user"]);

export const SEGMENT_DURATION_MS = 4000;

function safeMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

function laneIdOf(message) {
  if (SYSTEM_KINDS.has(String(message?.kind || ""))) return SYSTEM_LANE_ID;
  if (USER_KINDS.has(String(message?.kind || "")) || message?.agentId === "user") {
    return "__user__";
  }
  const fromName = String(message?.from?.name || message?.name || "").trim();
  if (fromName && fromName.toLowerCase() !== "system") {
    return `agent:${fromName}`;
  }
  return SYSTEM_LANE_ID;
}

function laneLabelOf(message, laneId) {
  if (laneId === SYSTEM_LANE_ID) return "系统";
  if (laneId === "__user__") return "你";
  return (
    String(message?.from?.name || message?.name || "成员").trim() || "成员"
  );
}

function laneRoleOf(message, laneId) {
  if (laneId === SYSTEM_LANE_ID) return "system";
  if (laneId === "__user__") return "user";
  const role = String(message?.from?.role || message?.role || "").trim();
  return role || "member";
}

function laneColorOf(message, agents, laneId) {
  if (laneId === SYSTEM_LANE_ID) return "#173d3b";
  if (laneId === "__user__") return "#4779e2";
  const name = String(message?.from?.name || message?.name || "").trim().toLowerCase();
  if (name) {
    const agent = (agents || []).find(
      (item) => String(item?.name || "").trim().toLowerCase() === name,
    );
    if (agent?.color) return agent.color;
  }
  const id = String(message?.agentId || "");
  if (id) {
    const agent = (agents || []).find((item) => String(item?.id || "") === id);
    if (agent?.color) return agent.color;
  }
  return "#b8d94f";
}

function shouldFold(segment, next, gapMs) {
  const foldKinds = ["text", "tool", "file", "workspace"];
  if (segment.kind !== next.kind) return false;
  if (segment.laneId !== next.laneId) return false;
  if (segment.done !== next.done) return false;
  if (!foldKinds.includes(segment.kind)) return false;
  return gapMs <= 45_000;
}

/**
 * Derive ordered lanes and folded segments from task messages.
 * @param {{messages?: Array<object>, agents?: Array<object>}} task
 * @returns {{lanes: Array<object>, totalMs: number, startMs: number, endMs: number}}
 */
export function deriveLanes(task) {
  const messages = (Array.isArray(task?.messages) ? task.messages : [])
    .filter((message) => message && (message.createdAt || message.id))
    .map((message, index) => ({
      ...message,
      createdAt: safeMs(message.createdAt || Date.now() + index),
    }))
    .sort((left, right) => safeMs(left.createdAt) - safeMs(right.createdAt));

  if (!messages.length) {
    return { lanes: [], totalMs: 0, startMs: 0, endMs: 0 };
  }

  const startMs = safeMs(messages[0].createdAt);
  const endMs = safeMs(messages[messages.length - 1].createdAt) + SEGMENT_DURATION_MS;
  const totalMs = Math.max(1, endMs - startMs);
  const raw = messages.map((message) => ({
    message,
    laneId: laneIdOf(message),
    createdAt: safeMs(message.createdAt),
    kind: String(message.kind || "text"),
    done: message.done !== false,
  }));

  const grouped = new Map();
  for (const item of raw) {
    if (!grouped.has(item.laneId)) {
      grouped.set(item.laneId, {
        id: item.laneId,
        label: laneLabelOf(item.message, item.laneId),
        role: laneRoleOf(item.message, item.laneId),
        color: laneColorOf(item.message, task?.agents, item.laneId),
        segments: [],
      });
    }
    const lane = grouped.get(item.laneId);
    const previousPoint = lane.segments.at(-1)?.lastPoint || null;
    const previousIndex = lane.segments.at(-1)?.lastMessageIndex ?? -1;
    const currentIndex = raw.indexOf(item);
    const contiguous = previousIndex === currentIndex - 1;
    const gapMs = contiguous ? item.createdAt - previousPoint : 0;
    if (
      lane.segments.length &&
      previousPoint !== null &&
      contiguous &&
      shouldFold(lane.segments.at(-1), item, gapMs)
    ) {
      lane.segments.at(-1).end = Math.max(
        lane.segments.at(-1).end,
        item.createdAt + SEGMENT_DURATION_MS,
      );
      lane.segments.at(-1).count += 1;
      lane.segments.at(-1).lastPoint = item.createdAt;
      lane.segments.at(-1).lastMessageIndex = raw.indexOf(item);
      lane.segments.at(-1).messageIds.push(String(item.message.id || ""));
    } else {
      lane.segments.push({
        id: `${item.laneId}:${item.createdAt}:${lane.segments.length}`,
        laneId: item.laneId,
        start: item.createdAt,
        end: item.createdAt + SEGMENT_DURATION_MS,
        kind: item.kind,
        done: item.done,
        count: 1,
        lastPoint: item.createdAt,
        lastMessageIndex: raw.indexOf(item),
        messageIds: [String(item.message.id || "")],
        preview: String(item.message.text || item.message.title || "").trim().slice(0, 120),
        label:
          item.kind === "decision"
            ? "裁决"
            : item.kind === "quality"
              ? "质量门"
              : item.kind === "proposal"
                ? "提案"
                : item.kind === "critique"
                  ? "质询"
                  : "过程",
      });
    }
  }

  const lanes = [...grouped.values()];
  return {
    lanes,
    startMs,
    endMs,
    totalMs,
  };
}

/**
 * Aggregate timeline metrics used by the replay scrubber and bottleneck hints.
 * @param {{messages?: Array<object>, agents?: Array<object>}} task
 * @returns {{
 *   startMs: number,
 *   endMs: number,
 *   totalMs: number,
 *   milestones: Array<object>,
 *   bottlenecks: Array<object>,
 *   parallelPoints: Array<{at:number,count:number}>
 * }}
 */
export function buildTimeline(task) {
  const { lanes, startMs, endMs, totalMs } = deriveLanes(task);
  const messages = Array.isArray(task?.messages) ? task.messages : [];
  const milestones = [];
  for (const message of messages) {
    const kind = String(message.kind || "");
    if (kind === "decision") {
      milestones.push({ at: safeMs(message.createdAt), type: "decision", label: "方案裁决" });
    }
    if (kind === "quality") {
      milestones.push({
        at: safeMs(message.createdAt),
        type: "quality",
        label: message.text?.includes("passed") ? "质量门通过" : "质量门",
      });
    }
    if (kind === "summary") {
      milestones.push({ at: safeMs(message.createdAt), type: "summary", label: "完成" });
    }
  }
  milestones.sort((left, right) => left.at - right.at);

  const activeWindows = [];
  for (const lane of lanes) {
    for (const segment of lane.segments) {
      activeWindows.push({ start: segment.start, end: Math.max(segment.end, segment.start + 1) });
    }
  }
  const activeBoundaries = [...new Set(activeWindows.flatMap((w) => [w.start, w.end]))].sort(
    (left, right) => left - right,
  );
  const parallelPoints = [];
  for (let i = 0; i < activeBoundaries.length - 1; i += 1) {
    const at = (activeBoundaries[i] + activeBoundaries[i + 1]) / 2;
    parallelPoints.push({
      at,
      count: lanes.filter((lane) =>
        lane.segments.some((segment) => segment.start <= at && segment.end > at),
      ).length,
    });
  }

  const bottlenecks = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, cursor + 15_000);
    const active = lanes.filter((lane) =>
      lane.segments.some((segment) => segment.start <= cursor && segment.end > cursor),
    ).length;
    bottlenecks.push({ start: cursor, end: next, active });
    cursor = next;
  }

  const longestIdle = bottlenecks
    .filter((window) => window.active === 0)
    .sort((left, right) => right.end - right.start - (left.end - left.start))[0] || null;

  return {
    startMs,
    endMs,
    totalMs,
    milestones,
    bottlenecks,
    parallelPoints,
    longestIdle,
    maxParallel: parallelPoints.reduce((max, point) => Math.max(max, point.count), 0),
  };
}

/**
 * Snapshot active segments at a point in time, used by the replay scrubber.
 * @param {{messages?: Array<object>, agents?: Array<object>}} task Task record.
 * @param {number} replayAtMs Replay position in milliseconds.
 * @returns {{lanes: Array<object>, atMs: number}} Replay lanes and clamped position.
 */
export function replaySnapshot(task, replayAtMs) {
  const { lanes, startMs, endMs } = deriveLanes(task);
  const at = Math.max(startMs, Math.min(endMs, safeMs(replayAtMs)));
  return {
    atMs: at,
    lanes: lanes.map((lane) => ({
      id: lane.id,
      label: lane.label,
      role: lane.role,
      color: lane.color,
      active: lane.segments.find((segment) => segment.start <= at && segment.end > at) || null,
      completed: lane.segments.filter((segment) => segment.end <= at).length,
      upcoming: lane.segments.filter((segment) => segment.start > at).length,
    })),
  };
}
