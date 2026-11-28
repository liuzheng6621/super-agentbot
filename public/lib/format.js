/* AgentForge · 纯格式化工具（无构建依赖的 ESM 模块） */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const pad2 = (n) => String(n).padStart(2, "0");

export const fmtMs = (ms) => {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
};

export const fmtTime = (ts) => {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const fmtBytes = (n) => (n > 1024 ? `${(n / 1024).toFixed(1)}K` : `${n || 0}B`);

export const initials = (name = "?") =>
  (name.replace(/[^\w\u4e00-\u9fa5]/g, "").slice(0, 2) || "AI").toUpperCase();
