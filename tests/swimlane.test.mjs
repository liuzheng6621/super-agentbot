import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTimeline,
  deriveLanes,
  replaySnapshot,
  SEGMENT_DURATION_MS,
} from "../public/lib/swimlane.js";

function msg(id, at, name, kind = "text", extra = {}) {
  return {
    id,
    createdAt: at,
    text: `${kind}-${id}`,
    kind,
    done: true,
    agentId: name?.toLowerCase() || "",
    from: {
      kind: name ? "agent" : "system",
      id: name?.toLowerCase() || "system",
      name: name || "System",
      role: name ? "member" : "system",
    },
    ...extra,
  };
}

test("empty task produces no lanes", () => {
  assert.deepEqual(deriveLanes(null).lanes, []);
  assert.deepEqual(deriveLanes({ messages: [] }).lanes, []);
});

test("single message produces one lane and one segment", () => {
  const result = deriveLanes({ messages: [msg("m1", 1000, "Nova")] });
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0].label, "Nova");
  assert.equal(result.lanes[0].segments.length, 1);
  assert.equal(result.lanes[0].segments[0].count, 1);
});

test("same-lane adjacent messages fold into one block", () => {
  const result = deriveLanes({
    messages: [msg("m1", 1000, "Nova"), msg("m2", 3000, "Nova")],
  });
  assert.equal(result.lanes[0].segments.length, 1);
  assert.equal(result.lanes[0].segments[0].count, 2);
  assert.equal(result.lanes[0].segments[0].start, 1000);
  assert.equal(result.lanes[0].segments[0].end, 3000 + SEGMENT_DURATION_MS);
});

test("parallel agents occupy separate lanes", () => {
  const result = deriveLanes({
    messages: [
      msg("a1", 1000, "Nova"),
      msg("b1", 1200, "Forge"),
      msg("a2", 1800, "Nova"),
      msg("b2", 2000, "Forge"),
    ],
  });
  assert.equal(result.lanes.length, 2);
  assert.deepEqual(result.lanes.map((lane) => lane.label).sort(), ["Forge", "Nova"]);
});

test("system, user and agent lanes stay separated", () => {
  const result = deriveLanes({
    messages: [
      msg("u", 1000, "Owner", "user"),
      msg("s", 1100, "", "system"),
      msg("a", 1200, "Nova"),
    ],
  });
  assert.equal(result.lanes.length, 3);
  assert.ok(result.lanes.some((lane) => lane.label === "你"));
  assert.ok(result.lanes.some((lane) => lane.label === "系统"));
});

test("long gap splits blocks even in the same lane", () => {
  const result = deriveLanes({
    messages: [msg("m1", 1000, "Nova"), msg("m2", 1000 + 120_000, "Nova")],
  });
  assert.equal(result.lanes[0].segments.length, 2);
});

test("out-of-order timestamps are normalized deterministically", () => {
  const result = deriveLanes({
    messages: [msg("late", 5000, "Nova"), msg("early", 1000, "Nova")],
  });
  assert.equal(result.lanes[0].segments[0].start, 1000);
  assert.equal(result.lanes[0].segments[0].end, 5000 + SEGMENT_DURATION_MS);
});

test("missing timestamps still yield a stable lane", () => {
  const message = { id: "no-time", name: "Nova", kind: "text", from: { name: "Nova" } };
  const result = deriveLanes({ messages: [message] });
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0].label, "Nova");
});

test("timeline metrics expose milestones and parallel peak", () => {
  const timeline = buildTimeline({
    messages: [
      msg("a1", 1000, "Nova"),
      msg("b1", 1200, "Forge"),
      msg("decision", 7000, "Lens", "decision"),
      msg("quality", 9000, "", "quality"),
      msg("summary", 11000, "", "summary"),
    ],
  });
  assert.equal(timeline.maxParallel, 2);
  assert.equal(timeline.milestones.some((m) => m.type === "decision"), true);
  assert.equal(timeline.milestones.some((m) => m.type === "quality"), true);
  assert.equal(timeline.milestones.some((m) => m.type === "summary"), true);
});

test("bottleneck detection can identify idle window", () => {
  const timeline = buildTimeline({
    messages: [msg("m1", 1000, "Nova"), msg("m2", 1000 + 60_000, "Nova")],
  });
  assert.equal(timeline.longestIdle?.active, 0);
  assert.ok(timeline.longestIdle?.end - timeline.longestIdle?.start > 0);
});

test("replay snapshot reports active, completed and upcoming work", () => {
  const task = {
    messages: [
      msg("m1", 1000, "Nova"),
      msg("m2", 5000, "Forge"),
      msg("m3", 9000, "Nova"),
    ],
  };
  const mid = replaySnapshot(task, 6000);
  const nova = mid.lanes.find((lane) => lane.label === "Nova");
  const forge = mid.lanes.find((lane) => lane.label === "Forge");
  assert.equal(nova.completed, 1);
  assert.equal(nova.upcoming, 1);
  assert.ok(forge.active);
});

test("snapshot clamps out-of-range timestamps", () => {
  const task = { messages: [msg("m1", 1000, "Nova")] };
  const late = replaySnapshot(task, 999_999);
  assert.equal(late.atMs, 1000 + SEGMENT_DURATION_MS);
});
