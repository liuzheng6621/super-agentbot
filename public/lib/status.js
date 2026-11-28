/* AgentForge · 状态文案与角色元数据（无构建依赖的 ESM 模块） */

export const STATUS_TEXT = {
  idle: "待命",
  queued: "排队中",
  running: "协作中",
  stopping: "停止中",
  done: "已交付",
  stopped: "已停止",
  error: "出错",
  needs_attention: "待人工确认",
};

export const ROLE_META = {
  planner: { short: "规划", order: 1 },
  architect: { short: "架构", order: 2 },
  coder: { short: "实现", order: 3 },
  tester: { short: "测试", order: 4 },
  reviewer: { short: "评审", order: 5 },
};

export const STEP_STATUS_TEXT = {
  pending: "等待上游",
  queued: "排队中",
  running: "执行中",
  retrying: "重试中",
  done: "完成",
  error: "失败",
  blocked: "上游中断",
  stopped: "已停止",
  skipped: "已跳过",
};

export const PRIORITY_TEXT = {
  high: "高",
  normal: "普通",
  low: "低",
};

export const AUTOMATION_STATUS_LABEL = {
  idle: "待运行",
  paused: "已暂停",
  scheduled: "已排队",
  running: "运行中",
  waiting: "等待上一轮",
  "event-waiting": "等待事件",
  woken: "事件已唤醒",
  done: "已完成",
  failed: "失败",
  "retry-waiting": "等待重试",
};
