/* =========================================================
   AGENTFORGE · 前端逻辑
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  agents: [],
  providers: [],
  toolCatalog: [],
  roleTools: {},
  executionPolicies: [],
  tasks: [],
  task: null,
  settings: {},
  scheduler: null,
  probe: [],
  dir: "",
  worktree: false,
  flowMode: "debate",
  tab: "plan",
  atBottom: true,
  pending: new Map(),
  openStep: "",
  workspace: null,
  workspaceLoading: false,
  workspacePreviewPath: "",
  workspacePreviewData: null,
  workspaceRefreshTimer: null,
  workspaceConsoleOpen: false,
  workspaceConsoleView: "file",
  workspaceDiffPath: "",
  workspaceDiff: null,
  agentPolicyPreviewTimer: null,
  agentPolicyPreviewSeq: 0,
};

/* ---------------- 工具 ---------------- */

function toast(text, type = "") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = text;
  $("#toastWrap").appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(8px)";
    node.style.transition = "opacity .2s, transform .2s";
    setTimeout(() => node.remove(), 220);
  }, 2400);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const initials = (name = "?") => (name.replace(/[^\w\u4e00-\u9fa5]/g, "").slice(0, 2) || "AI").toUpperCase();

const fmtTime = (ts) => {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const fmtBytes = (n) => (n > 1024 ? `${(n / 1024).toFixed(1)}K` : `${n || 0}B`);

const fmtMs = (ms) => {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
};

const pad2 = (n) => String(n).padStart(2, "0");

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

/* ---------------- Markdown ---------------- */

function inlineMd(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return t;
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function md(src) {
  if (!src) return "";
  // 流式输出时代码块可能还没闭合，先补一个闭合标记，避免原样显示反引号
  const fences = (src.match(/```/g) || []).length;
  if (fences % 2 === 1) src += "\n```";

  const codes = [];
  let text = src.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    codes.push({ lang, code });
    return `\u0000C${codes.length - 1}\u0000`;
  });

  const lines = text.split(/\r?\n/);
  const out = [];
  let listType = null;
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const codeSlot = line.match(/^\u0000C(\d+)\u0000$/);

    if (codeSlot) {
      closeList();
      const c = codes[Number(codeSlot[1])];
      out.push(`<pre><code>${escapeHtml(c.code.replace(/\n$/, ""))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    // 表格
    if (line.includes("|") && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closeList();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inlineMd(h)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      i--;
      out.push(`<blockquote>${buf.map(inlineMd).join("<br />")}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      if (listType !== type) {
        closeList();
        out.push(`<${type}>`);
        listType = type;
      }
      out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
      continue;
    }

    closeList();
    const buf = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      !/^\u0000C\d+\u0000$/.test(lines[i + 1]) &&
      !/^(#{1,4})\s/.test(lines[i + 1]) &&
      !/^\s*[-*+]\s/.test(lines[i + 1]) &&
      !/^\s*\d+[.)]\s/.test(lines[i + 1]) &&
      !/^>\s?/.test(lines[i + 1]) &&
      !lines[i + 1].includes("|")
    ) {
      i++;
      buf.push(lines[i]);
    }
    out.push(`<p>${buf.map(inlineMd).join("<br />")}</p>`);
  }

  closeList();
  return out.join("");
}

/* ---------------- 渲染：团队 ---------------- */

function avatarHtml(agent, cls = "") {
  return `<span class="avatar ${cls}" style="--c:${agent.color || "#b8d94f"}">${initials(agent.name)}<i class="dot ${agent.status}"></i></span>`;
}

function normalizeAgentSeats(agents) {
  const seated = new Set();
  return (agents || []).map((a) => {
    if (typeof a.seat === "boolean") {
      if (a.seat) seated.add(a.role);
      return a;
    }
    // 兼容旧后端：同一角色只把第一个成员视为主执行席位。
    const seat = !seated.has(a.role);
    if (seat) seated.add(a.role);
    return { ...a, seat };
  });
}

function cliPolicyTag(agent) {
  if (agent?.mode !== "cli") return "";
  const policy = agent.cliPolicy || {};
  const strict = policy.policy === "strict" || agent.executionPolicy === "strict";
  const status = policy.status || (strict ? "unsupported" : "inherit");
  const label = status === "enforced" ? "STRICT" : status === "unsupported" ? "BLOCKED" : "INHERIT";
  const title =
    policy.reason ||
    (strict ? "严格策略未通过预检" : "沿用 CLI 自身权限参数");
  return `<i class="tag policy" data-policy="${escapeHtml(status)}" title="${escapeHtml(title)}">${label}</i>`;
}

function agentRowHtml(a, reserve = false) {
  const role = reserve ? "工具" : ROLE_META[a.role]?.short || "工具";
  const command = (a.cli?.command || "").split(/[\\/]/).pop();
  const detail =
    a.status === "working" && a.activity
      ? a.activity
      : reserve
        ? command || a.title || "可随时接席"
        : `${a.title || a.role}${a.mode === "cli" ? ` · ${providerName(a.providerId)}` : ""}`;
  const h = a.health;
  const healthTag =
    a.mode !== "cli"
      ? `<i class="tag health sim" title="内置模拟成员，不调用真实模型">SIM 演示</i>`
      : !h
        ? `<i class="tag health unknown" title="尚未体检，点左栏「体检并换真实席位」">? 未检</i>`
        : h.ok
          ? `<i class="tag health ok" title="${escapeHtml(h.note || "在线")}">✓ 可用</i>`
          : `<i class="tag health bad" title="${escapeHtml(h.note || "不可用")}">✗ 不可用</i>`;
  return `<div class="agent-row ${reserve ? "reserve" : "seated"}" data-agent="${a.id}">
    <span class="avatar" style="--c:${a.color}">${initials(a.name)}<i class="dot ${a.status}"></i></span>
    <span class="agent-meta">
      <span class="agent-name">${escapeHtml(a.name)}
        <i class="tag role" data-role="${reserve ? "tool" : a.role}">${role}</i>
        ${healthTag}
        ${cliPolicyTag(a)}
      </span>
      <span class="agent-role">${escapeHtml(detail)}${Array.isArray(a.tools) ? ` · ${a.tools.length} TOOLS` : ""}</span>
    </span>
    <span class="agent-right">
      <span class="runs">${pad2(a.stats?.runs || 0)}</span>
      <button class="agent-edit" data-edit="${a.id}" title="编辑配置">⚙</button>
    </span>
  </div>`;
}

/* 体检并把执行席位换成真正跑得通的真实 CLI（配置好 API Key 后点一次） */
async function refreshRealTeam() {
  const btn = $("#realTeamBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "体检中…";
  try {
    const r = await api("/api/team/refresh", { method: "POST", body: {} });
    await refreshAgents();
    const okCount = (r.health || []).filter((x) => x.ok).length;
    if (r.changed) {
      toast(
        `${r.reason}（${r.seats.map((s) => `${ROLE_META[s.role]?.short || s.role}→${s.name}`).join(" · ")}）`,
        "ok",
      );
    } else {
      toast(`体检完成：${okCount} 个 CLI 可用；${r.reason}`, okCount ? "ok" : "");
    }
    await probeClis();
  } catch (err) {
    toast(`体检失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function renderAgents() {
  const wrap = $("#agentList");
  const seats = S.agents
    .filter((a) => a.seat !== false)
    .sort((a, b) => (ROLE_META[a.role]?.order || 9) - (ROLE_META[b.role]?.order || 9));
  const reserved = S.agents.filter((a) => a.seat === false);
  const reserveHtml = reserved.length
    ? `<details class="reserve-group">
        <summary>工具池 · ${reserved.length}<span>可接席</span></summary>
        <div class="reserve-list">${reserved.map((a) => agentRowHtml(a, true)).join("")}</div>
      </details>`
    : "";
  wrap.innerHTML = `
    <div class="agent-group-head">
      <span>执行席位 · ${seats.length}</span>
      <em>${reserved.length ? `工具池 ${reserved.length}` : "5 个角色"}</em>
    </div>
    <div class="seat-list">${seats.map((a) => agentRowHtml(a)).join("")}</div>
    ${reserveHtml}
  `;
  $("#agentCount").textContent = pad2(seats.length || S.agents.length);
  $("#heroTeam").innerHTML = seats
    .map(
      (a) => `<span class="hero-agent">
        <span class="avatar" style="--c:${a.color}">${initials(a.name)}</span>
        <span class="ha-name">${escapeHtml(a.name)}</span>
        <span class="ha-role">${escapeHtml(ROLE_META[a.role]?.short || a.title || a.role)}</span>
      </span>`,
    )
    .join("");
  $("#mentionList").innerHTML = S.agents
    .map(
      (a) =>
        `<button class="mention" data-mention="${escapeHtml(a.name)}" style="--c:${a.color}">@${escapeHtml(a.name)}</button>`,
    )
    .join("");
  renderHeroStats();
}

function renderHeroStats() {
  $("#statAgents").textContent = pad2(S.agents.length);
  $("#statTasks").textContent = pad2(S.tasks.length);
  $("#statFiles").textContent = pad2(S.tasks.reduce((n, t) => n + (t.files || 0), 0));
}

/* ---------------- 渲染：任务列表 ---------------- */

const STATUS_TEXT = {
  idle: "待命",
  queued: "排队中",
  running: "协作中",
  stopping: "停止中",
  done: "已交付",
  stopped: "已停止",
  error: "出错",
  needs_attention: "待人工确认",
};

const ROLE_META = {
  planner: { short: "规划", order: 1 },
  architect: { short: "架构", order: 2 },
  coder: { short: "实现", order: 3 },
  tester: { short: "测试", order: 4 },
  reviewer: { short: "评审", order: 5 },
};

const STEP_STATUS_TEXT = {
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

function isDegradedDecision(decision, debateStatus = "") {
  return (
    !!decision?.degraded ||
    debateStatus === "fallback" ||
    (!!decision && Number(decision.votes || 0) === 0)
  );
}

function renderTasks() {
  $("#taskList").innerHTML = S.tasks.length
    ? S.tasks
        .map(
          (t) => `<div class="task-item ${S.task?.id === t.id ? "active" : ""}" data-task="${t.id}" title="${escapeHtml(
            t.waitingReason || "",
          )}">
            <span class="t-title">${escapeHtml(t.title)}</span>
            <span class="t-meta"><span>${STATUS_TEXT[t.status] || t.status}${
              t.status === "queued" && t.queuePosition ? ` #${t.queuePosition}` : ""
            }</span><span>${t.doneSteps}/${t.steps || 0}</span><span>${t.files}F</span></span>
            ${
              t.status === "queued" && t.waitingReason
                ? `<span class="t-wait">${escapeHtml(t.waitingReason)}</span>`
                : ""
            }
          </div>`,
        )
        .join("")
    : '<p class="hint">还没有任务，先描述一个目标。</p>';
  $("#taskCount").textContent = pad2(S.tasks.length);
  renderHeroStats();
}

/* ---------------- 渲染：顶部 ---------------- */

function renderTopbar() {
  const t = S.task;
  $("#topbarTitle").textContent = t ? t.title : "未选择任务";
  $("#topbarSub").textContent = t
    ? t.status === "queued"
      ? t.waitingReason || "已进入调度队列"
      : t.waitingReason
        ? t.waitingReason
        : t.worktree && t.sourceWorkspace
      ? `${t.goal} · 工作树 ${shortPath(t.sourceWorkspace)}`
      : t.external && t.workspace
      ? `${t.goal} · 📁 ${shortPath(t.workspace)}`
      : t.goal
    : "描述一个目标，团队会自己分工";
  $("#topbarSub").title = t ? t.workspace || "" : "";
  $("#topbarCode").textContent = t
    ? t.status === "queued"
      ? "QUEUED"
      : t.status === "running"
      ? "RUNNING"
      : t.status === "stopping"
        ? "STOPPING"
        : t.id.slice(0, 6).toUpperCase()
    : "IDLE";

  const pill = $("#statusPill");
  pill.dataset.status = t ? t.status : "idle";
  pill.textContent = t
    ? t.status === "queued" && t.queuePosition
      ? `排队 #${t.queuePosition}`
      : STATUS_TEXT[t.status] || t.status
    : "待命";

  // 只认 status：taskDetail.running 是首次拉取时的快照，任务结束后不会自动失效
  const busy = !!t && (t.status === "running" || t.status === "stopping" || t.status === "queued");
  $("#stopBtn").hidden = !busy || t?.status === "stopping";
  $("#runBtn").hidden = !t || busy;

  $("#composerTip").textContent = t
    ? "群聊 · @成员 指定回复"
    : `自动编排 · ${S.flowMode === "direct" ? "直接开工" : "先讨论后实施"}`;
  $("#input").disabled = false;
  $("#input").placeholder = t
    ? "跟团队补充需求，或 @某位成员 单独拉他进来…"
    : "描述你的目标，回车发起协作…";
  $("#sendBtn").disabled = false;
}

/* ---------------- 渲染：时间线 ---------------- */

function friendlyCliText(value) {
  return String(value || "")
    .replace(/CLI 退出码 3221225794/g, "Windows 进程初始化失败（0xC0000142）")
    .replace(/退出码 3221225794/g, "Windows 进程初始化失败（0xC0000142）")
    .replace(/CLI 退出码 1073807364/g, "进程被外部终止（0x40010004）")
    .replace(/退出码 1073807364/g, "进程被外部终止（0x40010004）")
    .replace(/CLI 退出码 -3/g, "执行超时")
    .replace(/退出码 -3/g, "执行超时");
}

function messageHtml(m) {
  const isUser = m.kind === "user" || m.agentId === "user";
  const color = m.color || "#b8d94f";
  const badge =
    m.kind === "proposal"
      ? `<span class="msg-badge proposal">方案 ${escapeHtml(m.debate?.proposalId || "")} · 提案</span>`
      : m.kind === "critique"
        ? '<span class="msg-badge critique">交叉质询</span>'
        : m.kind === "decision"
          ? '<span class="msg-badge decision">裁决</span>'
          : m.kind === "debate-intro"
            ? '<span class="msg-badge intro">讨论</span>'
            : "";
  const head = `<div class="msg-head">
      <span class="m-name">${escapeHtml(m.name || "AI")}</span>
      <span class="m-role">${escapeHtml((m.title || m.role || "").toUpperCase())}</span>
      ${badge}
      <span class="m-time">${fmtTime(m.createdAt)}</span>
    </div>`;
  const meta =
    m.done && m.meta
      ? `<div class="msg-meta">${m.meta.tokens ? `<span>${m.meta.tokens} tok</span>` : ""}${
          m.meta.ms ? `<span>${fmtMs(m.meta.ms)}</span>` : ""
        }${m.engine === "cli" ? "<span>CLI</span>" : ""}</div>`
      : "";
  return `<div class="msg ${isUser ? "user" : ""} ${m.done ? "" : "streaming"}" data-msg="${m.id}" ${
    stageOfMessage(m) ? `data-stage="${stageOfMessage(m)}"` : ""
  }>
      ${isUser ? "" : `<span class="avatar" style="--c:${color}">${initials(m.name)}</span>`}
      <div class="msg-main">
        ${head}
        <div class="bubble" style="--c:${color}">${md(friendlyCliText(m.text || ""))}</div>
        ${meta}
      </div>
      ${isUser ? `<span class="avatar" style="--c:${color}">${initials(m.name)}</span>` : ""}
    </div>`;
}

function renderMessages() {
  const wrap = $("#timeline");
  const t = S.task;
  if (!t || !t.messages?.length) {
    wrap.hidden = true;
    $("#hero").hidden = false;
    return;
  }
  $("#hero").hidden = true;
  wrap.hidden = false;
  let lastStage = null;
  wrap.innerHTML = t.messages
    .map((m) => {
      const st = stageOfMessage(m);
      const sep = st && st !== lastStage ? flowSepHtml(st) : "";
      if (st) lastStage = st;
      return sep + messageHtml(m);
    })
    .join("");
  scrollToBottom(true);
}

function patchMessage(msg) {
  const node = $(`[data-msg="${msg.id}"]`);
  if (!node) return;
  const bubble = $(".bubble", node);
  if (bubble) bubble.innerHTML = md(msg.text || "");
  node.classList.toggle("streaming", !msg.done);
  if (msg.done) {
    const meta = $(".msg-meta", node);
    if (meta && msg.meta) {
      meta.innerHTML = `${msg.meta.tokens ? `<span>${msg.meta.tokens} tok</span>` : ""}${
        msg.meta.ms ? `<span>${fmtMs(msg.meta.ms)}</span>` : ""
      }${msg.engine === "cli" ? "<span>CLI</span>" : ""}`;
    }
  }
}

function scrollToBottom(force = false) {
  const sc = $("#scroll");
  if (!sc) return;
  if (force || S.atBottom) {
    requestAnimationFrame(() => {
      sc.scrollTop = sc.scrollHeight;
    });
  }
}

/* ---------------- 渲染：工作流主线 ---------------- */

const FLOW_STAGES = [
  { id: "debate", label: "方案讨论", en: "DEBATE", kinds: ["debate-intro", "proposal", "critique", "decision"], tab: "debate" },
  { id: "plan", label: "需求拆解", en: "PLAN", kinds: ["plan"], tab: "plan" },
  { id: "build", label: "架构与实施", en: "BUILD", kinds: ["architect", "coder", "tester"], tab: "plan" },
  { id: "review", label: "质量评审", en: "REVIEW", kinds: ["reviewer", "quality"], tab: "plan" },
  { id: "deliver", label: "交付收口", en: "DELIVER", kinds: ["summary"], tab: "files" },
];

function stageOfMessage(m) {
  if (!m || m.kind === "user" || m.agentId === "user") return null;
  return FLOW_STAGES.find((s) => s.kinds.includes(m.kind))?.id || null;
}

function stageOfStep(step) {
  const id = step.id;
  if (id === "debate") return "debate";
  if (id === "plan") return "plan";
  if (["design", "implement", "test-design"].includes(id)) return "build";
  if (/^(review|fix-|retest-|re-review-)/.test(id)) return "review";
  return "build";
}

function lastStageOf(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const st = stageOfMessage(list[i]);
    if (st) return st;
  }
  return null;
}

/** 从任务状态推导五个阶段：不新增后端字段，界面自己算，重启后依然准确。 */
function deriveFlow(t) {
  const stages = FLOW_STAGES.map((s) => ({ ...s, status: "pending", note: "", steps: [] }));
  const byId = new Map(stages.map((s) => [s.id, s]));
  const empty = { stages, current: null, doneSteps: 0, totalSteps: 0 };
  if (!t) return empty;

  const plan = t.plan || [];
  for (const step of plan) {
    const st = byId.get(stageOfStep(step));
    if (st) st.steps.push(step);
  }

  for (const st of stages) {
    if (st.id === "deliver" || !st.steps.length) continue;
    const list = st.steps;
    const any = (fn) => list.some(fn);
    if (any((s) => ["running", "retrying", "queued"].includes(s.status))) st.status = "active";
    else if (any((s) => ["error", "stopped"].includes(s.status))) st.status = "error";
    else if (any((s) => s.status === "blocked")) st.status = "blocked";
    else if (list.every((s) => s.status === "done")) st.status = "done";
    else if (list.every((s) => s.status === "skipped")) st.status = "skipped";
    else if (any((s) => s.status === "done")) st.status = "active";
  }

  // 讨论阶段以 debate 状态为准，提案/质询期间工序还没进 plan
  const debate = byId.get("debate");
  const dStatus = t.debate?.status;
  const debateStep = plan.find((s) => s.id === "debate");
  if (dStatus === "skipped" || debateStep?.status === "skipped") {
    debate.status = "skipped";
    debate.note = t.debate?.reason || "本任务跳过了方案讨论";
  } else if (isDegradedDecision(t.debate?.decision, dStatus)) {
    debate.status = "warning";
    debate.note = t.debate?.decision
      ? `无有效交叉评分 · 降级采用方案 ${t.debate.decision.winnerId}`
      : "讨论未形成有效评分";
  } else if (dStatus === "decided" || debateStep?.status === "done") {
    debate.status = "done";
    debate.note = t.debate?.decision ? `采纳方案 ${t.debate.decision.winnerId}` : "已裁决";
  } else if (["proposing", "critiquing", "deciding"].includes(dStatus)) {
    debate.status = "active";
    debate.note = DEBATE_STATUS[dStatus] || "进行中";
    if (t.debate?.participants?.length) debate.note += ` · ${t.debate.participants.length} 位成员`;
  } else if (dStatus === "failed" || dStatus === "stopped") {
    debate.status = "error";
    debate.note = DEBATE_STATUS[dStatus] || "讨论中断";
  }

  // 交付收口看最终状态或收口消息
  const deliver = byId.get("deliver");
  const hasSummary = (t.messages || []).some((m) => m.kind === "summary" && m.done);
  if (["done", "needs_attention", "error", "stopped"].includes(t.status) || hasSummary) {
    deliver.status =
      t.status === "error" || t.status === "stopped"
        ? "error"
        : t.status === "needs_attention"
          ? "warning"
          : "done";
    deliver.note = STATUS_TEXT[t.status] || "已收口";
  } else if (
    t.status === "running" &&
    stages.slice(0, 4).every((s) => s.status === "done" || s.status === "skipped")
  ) {
    deliver.status = "active";
    deliver.note = "生成交付结论";
  }

  // 当前阶段的说明：优先显示正在执行的工序与负责人
  for (const st of stages) {
    if (st.status !== "active" || st.note) continue;
    const running =
      st.steps.find((s) => ["running", "retrying", "queued"].includes(s.status)) ||
      [...st.steps].reverse().find((s) => s.status === "done");
    if (running) {
      const owner = S.agents.find((a) => a.id === running.agentId)?.name;
      st.note = `${running.title}${owner ? ` · ${owner}` : ""}`;
    }
  }

  return {
    stages,
    current: stages.find((s) => ["active", "error", "blocked", "warning"].includes(s.status)) || null,
    doneSteps: plan.filter((s) => s.status === "done").length,
    totalSteps: plan.length,
  };
}

function flowSepHtml(stageId) {
  const st = FLOW_STAGES.find((s) => s.id === stageId);
  if (!st) return "";
  return `<div class="flow-sep" data-stage="${st.id}"><span>${pad2(FLOW_STAGES.indexOf(st) + 1)} / ${st.label}</span><em>${st.en}</em></div>`;
}

function renderFlow() {
  const bar = $("#flowbar");
  if (!bar) return;
  const t = S.task;
  const ticker = $("#ticker");
  if (!t || (!t.plan?.length && !t.messages?.length && t.status !== "queued")) {
    bar.hidden = true;
    if (ticker) ticker.hidden = false;
    return;
  }
  bar.hidden = false;
  // 有任务时用真实阶段条替代装饰性跑马灯，减少噪音
  if (ticker) ticker.hidden = true;
  const flow = deriveFlow(t);
  const mark = { done: "✓", active: "●", error: "!", blocked: "…", warning: "!", skipped: "–", pending: "" };
  $("#flowTrack").innerHTML = flow.stages
    .map(
      (s, i) => `<button class="flow-node" data-stage="${s.id}" data-status="${s.status}"
        title="${escapeHtml(s.note || `${s.label} · ${STEP_STATUS_TEXT[s.status] || s.status}`)}">
        <span class="fn-idx">${pad2(i + 1)}</span>
        <span class="fn-body"><b>${s.label}</b><small>${s.en}</small></span>
        <span class="fn-mark">${mark[s.status] || pad2(i + 1)}</span>
      </button>`,
    )
    .join('<span class="flow-link" aria-hidden="true"></span>');

  const cur = flow.current;
  const mode = t.flowMode === "direct" ? "直接开工" : t.flowMode === "debate" ? "先讨论后实施" : "默认流程";
  $("#flowNow").innerHTML = `
    <span class="now-dot" data-status="${t.status === "queued" ? "warning" : cur?.status || "pending"}"></span>
    <span class="now-text">${
      t.status === "queued"
        ? `<b>排队中${t.queuePosition ? ` #${t.queuePosition}` : ""}</b> · ${escapeHtml(
            t.waitingReason || "等待调度资源",
          )}`
        : cur
        ? `<b>${cur.label}</b> · ${escapeHtml(cur.note || STEP_STATUS_TEXT[cur.status] || "进行中")}`
        : `<b>${escapeHtml(STATUS_TEXT[t.status] || t.status)}</b> · 全流程已走完`
    }</span>
    <span class="now-mode">${mode}</span>
    <span class="now-progress">工序 ${flow.doneSteps}/${flow.totalSteps}</span>`;
}

function jumpToStage(stageId) {
  const st = FLOW_STAGES.find((s) => s.id === stageId);
  if (!st) return;
  switchTab(st.tab);
  closeDrawers();
  const sep = $(`#timeline .flow-sep[data-stage="${stageId}"]`);
  const msg = $(`#timeline .msg[data-stage="${stageId}"]`);
  const target = sep || msg;
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- 渲染：编排面板 ---------------- */

function renderPlan() {
  const wrap = $("#planList");
  const overview = $("#planOverview");
  const t = S.task;
  if (!t || !t.plan?.length) {
    if (overview) overview.hidden = true;
    wrap.innerHTML = '<p class="hint">任务开始后，这里会显示每道工序的状态。</p>';
    return;
  }
  const indexOf = new Map(t.plan.map((step, i) => [step.id, i + 1]));
  const qualityText =
    t.quality?.status === "passed"
      ? "质量门通过"
      : t.quality?.status === "failed"
        ? "质量门未通过"
        : t.quality?.status === "missing"
          ? "没有测试入口"
          : t.quality?.status === "skipped"
            ? "评审代质量门"
            : "质量门待执行";
  if (overview) {
    overview.hidden = false;
    overview.innerHTML = `
      <span class="po-mode">DAG · 自动编排</span>
      <b>${t.plan.length} 道工序</b>
      <span>${t.repairRound ? `返工 ${t.repairRound} 轮` : "首轮执行"}</span>
      ${
        t.debate?.decision
          ? `<span class="po-decision" data-degraded="${isDegradedDecision(t.debate.decision, t.debate.status)}" title="方案讨论结果">${
              isDegradedDecision(t.debate.decision, t.debate.status) ? "降级采用" : "采纳"
            }方案 ${t.debate.decision.winnerId}</span>`
          : ""
      }
      <span class="po-quality" data-quality="${t.quality?.status || "pending"}">${qualityText}</span>`;
  }

  wrap.innerHTML = t.plan
    .map((step, i) => {
      const agent = S.agents.find((a) => a.id === step.agentId);
      const role = ROLE_META[step.role]?.short || step.role;
      const deps = (step.needs || [])
        .map((id) => indexOf.get(id))
        .filter(Boolean)
        .map((n) => `#${pad2(n)}`)
        .join(" ");
      const parallel =
        t.plan.filter((s) => JSON.stringify(s.needs || []) === JSON.stringify(step.needs || [])).length > 1;
      const extras = [
        deps ? `依赖 ${deps}` : "",
        parallel ? "并行" : "",
        step.attempt > 1 ? `尝试 ${step.attempt}/${step.maxAttempts || 2}` : "",
        step.round ? `R${step.round} 返工` : "",
      ].filter(Boolean);
      const icon = step.status === "done" ? "✓" : step.status === "blocked" ? "×" : pad2(i + 1);
      const files = (t.artifacts || []).filter((f) => f.stepId === step.id);
      const open = S.openStep === step.id;
      const conclusion = (t.messages || [])
        .filter((m) => m.done && m.text && m.meta?.step === step.title && m.kind !== "user")
        .slice(-1)[0];
      const elapsed =
        step.startedAt && step.endedAt ? fmtMs(step.endedAt - step.startedAt) : "";
      const detail = open
        ? `<div class="step-detail">
            <div class="sd-line"><em>状态</em><span>${escapeHtml(step.note || STEP_STATUS_TEXT[step.status] || step.status)}</span></div>
            ${elapsed ? `<div class="sd-line"><em>耗时</em><span>${elapsed}</span></div>` : ""}
            ${step.verdict ? `<div class="sd-line"><em>评审</em><span>${step.verdict === "pass" ? "PASS" : step.verdict === "fail" ? "FAIL" : "结论不明确"}</span></div>` : ""}
            ${conclusion ? `<div class="sd-conclusion"><em>本步结论</em><p>${escapeHtml(conclusion.text.replace(/\s+/g, " ").slice(0, 260))}${conclusion.text.length > 260 ? "…" : ""}</p></div>` : ""}
            <div class="sd-files"><em>产出 ${files.length} 个文件</em>
              ${
                files.length
                  ? files
                      .map(
                        (f) =>
                          `<button class="sd-file" data-step-file="${escapeHtml(f.path)}">${escapeHtml(f.path)} <i>${fmtBytes(f.bytes)}</i></button>`,
                      )
                      .join("")
                  : '<span class="sd-empty">本步没有写入文件</span>'
              }
            </div>
          </div>`
        : "";
      return `<div class="step ${open ? "open" : ""}" data-status="${step.status}" data-role="${step.role}" data-step="${step.id}">
        <span class="step-num">${icon}</span>
        <div class="step-title"><i class="step-role">${role}</i>${escapeHtml(step.title)}</div>
        <div class="step-sub">
          ${agent ? `<span class="s-owner" style="--c:${agent.color}">${escapeHtml(agent.name)}</span>` : "<span>未指派</span>"}
          <span>·</span>
          <span>${escapeHtml(step.note || STEP_STATUS_TEXT[step.status] || "")}</span>
        </div>
        ${extras.length ? `<div class="step-deps">${extras.map((e) => `<span>${escapeHtml(e)}</span>`).join("")}</div>` : ""}
        ${files.length ? `<div class="step-files">产出 ${files.length} 个文件 · 点击查看详情</div>` : ""}
        ${detail}
      </div>`;
    })
    .join("");
}

/* ---------------- 渲染：方案讨论 ---------------- */

const DEBATE_STATUS = {
  pending: "待开始",
  proposing: "提案中",
  critiquing: "交叉质询中",
  decided: "已裁决",
  fallback: "降级裁决",
  skipped: "已跳过",
  failed: "讨论失败",
  stopped: "已停止",
};

function proposalScore(p) {
  const votes = p.votes || [];
  if (!votes.length) return null;
  return votes.reduce((sum, v) => sum + Number(v.score || 0), 0) / votes.length;
}

function renderDebate() {
  const head = $("#debateHead");
  const list = $("#debateList");
  if (!head || !list) return;
  const d = S.task?.debate;
  if (!d) {
    head.innerHTML = "";
    list.innerHTML =
      '<p class="hint">任务开始后，成员会先各自出方案、互相评分，这里会显示每份方案和最终裁决。</p>';
    return;
  }
  if (!d.participants?.length) {
    head.innerHTML =
      d.status && d.status !== "pending"
        ? `<div class="debate-status" data-status="${d.status}"><b>${
            DEBATE_STATUS[d.status] || d.status
          }</b></div>`
        : "";
    list.innerHTML = `<p class="hint">${escapeHtml(
      d.reason || "本轮没有进行方案讨论，直接进入实施。",
    )}</p>`;
    return;
  }

  const dec = d.decision;
  const degraded = isDegradedDecision(dec, d.status);
  head.innerHTML = `
    <div class="debate-status" data-status="${d.status}">
      <b>${DEBATE_STATUS[d.status] || d.status}</b>
      <span>${d.participants.length} 位提案人</span>
      ${dec ? `<em>${degraded ? "无有效评分" : dec.average == null ? "无评分" : `${dec.average} 分`}</em>` : ""}
    </div>
    <div class="debate-people">
      ${d.participants
        .map(
          (p) =>
            `<span class="dp" style="--c:${p.color}">${escapeHtml(p.name)}${
              p.seat === false ? '<i class="dp-pool">池</i>' : ""
            }</span>`,
        )
        .join("")}
    </div>
    ${
      dec
        ? `<div class="debate-winner" data-degraded="${degraded}">
            <span class="dw-tag">${degraded ? "降级" : "裁决"}</span>
            <div class="dw-main">
              <b>方案 ${dec.winnerId} · ${escapeHtml(dec.angleLabel)}</b>
              <span>${escapeHtml(dec.winnerName)} 提出 · ${
                degraded ? "无有效交叉评分" : `平均 ${dec.average ?? "—"} 分`
              } · ${dec.votes} 票</span>
              <span class="dw-judge">主持人 ${escapeHtml(dec.judgeName)}</span>
              ${degraded ? `<span class="dw-warning">${escapeHtml(dec.reason || "按提案顺序临时采用，需人工复核")}</span>` : ""}
            </div>
          </div>`
        : ""
    }
  `;

  const rank = new Map((dec?.ranking || []).map((r, i) => [r.id, i + 1]));
  const proposals = [...(d.proposals || [])].sort((a, b) => {
    const ra = rank.get(a.id) ?? 99;
    const rb = rank.get(b.id) ?? 99;
    if (ra !== rb) return ra - rb;
    return String(a.id).localeCompare(String(b.id));
  });

  if (!proposals.length) {
    list.innerHTML = `<p class="hint">${
      d.status === "proposing" ? "成员正在独立写方案…" : "本轮没有产生提案。"
    }</p>`;
    return;
  }

  list.innerHTML = proposals
    .map((p) => {
      const score = proposalScore(p);
      const win = dec && dec.winnerId === p.id;
      const winLabel = degraded ? "临时采用" : "已采纳";
      const votes = (p.votes || [])
        .map(
          (v) =>
            `<span class="vote-chip" title="${escapeHtml(v.reason || "")}">${escapeHtml(v.byName)} · ${v.score}</span>`,
        )
        .join("");
      return `<article class="proposal ${win ? "win" : ""}" data-status="${p.status || "running"}">
        <div class="proposal-head">
          <span class="p-id">方案 ${p.id}</span>
          <span class="p-author" style="--c:${p.color}">${escapeHtml(p.name)}</span>
          <span class="p-angle">${escapeHtml(p.angleLabel)}</span>
          <span class="p-score">${score == null ? "—" : score.toFixed(1)}</span>
        </div>
        <div class="p-bar"><i style="width:${score ? Math.min(100, score * 10) : 0}%"></i></div>
        <div class="p-meta">${
          p.status === "failed"
            ? escapeHtml(p.note || "提案失败")
            : p.status === "partial"
              ? `${p.votes?.length || 0} 票 · 输出不完整${win ? ` · ${winLabel}` : ""}`
              : `${p.votes?.length || 0} 票${win ? ` · ${winLabel}` : ""}`
        }</div>
        ${votes ? `<div class="p-votes">${votes}</div>` : ""}
        ${
          p.text
            ? `<details><summary>方案全文</summary><div class="p-body">${md(p.text)}</div></details>`
            : ""
        }
      </article>`;
    })
    .join("");

  const critiques = d.critiques || [];
  if (critiques.length) {
    list.insertAdjacentHTML(
      "beforeend",
      `<div class="debate-critiques">
        <div class="dc-title">交叉质询记录</div>
        ${critiques
          .map(
            (c) =>
              `<div class="dc-row ${c.ok ? "ok" : "fail"}">
                <span class="dc-name" style="--c:${c.color}">${escapeHtml(c.name)}</span>
                <span>${escapeHtml(friendlyCliText(c.note || (c.ok ? "已完成评分" : "质询失败")))}</span>
              </div>`,
          )
          .join("")}
      </div>`,
    );
  }
}

function renderFiles() {
  const t = S.task;
  const list = $("#fileList");
  if (!t || !t.artifacts?.length) {
    list.innerHTML = '<p class="hint">还没有产物。智能体写入的文件会出现在这里。</p>';
    return;
  }
  list.innerHTML = t.artifacts
    .map((f) => {
      const step = (t.plan || []).find((s) => s.id === f.stepId);
      const owner = step ? `${ROLE_META[step.role]?.short || step.role} · ${step.title}` : "未关联工序";
      return `<div class="file-item" data-file="${escapeHtml(f.path)}" title="${escapeHtml(owner)}">
        <span class="ext">${escapeHtml((f.lang || "txt").slice(0, 3))}</span>
        <span class="file-name">${escapeHtml(f.path)}<i>${escapeHtml(ROLE_META[step?.role]?.short || "")}</i></span>
        <span class="file-size">${fmtBytes(f.bytes)}</span>
      </div>`;
    })
    .join("");
}

const WORKSPACE_EVENT_LABEL = {
  "run.start": "运行开始",
  "run.end": "运行结束",
  "run.error": "运行中断",
  "tool.call.start": "工具调用",
  "tool.call.end": "工具完成",
  "tool.policy.denied": "策略拒绝",
  "cli.policy.start": "CLI 策略检查",
  "cli.policy.end": "CLI 策略生效",
  "cli.policy.denied": "CLI 策略拦截",
  "message.published": "消息路由",
  "plan.replanned": "计划重规划",
  "file.changed": "文件变更",
  "fs.write": "写入文件",
  "fs.mkdir": "新建目录",
  "fs.move": "移动路径",
  "fs.delete": "移入回收站",
};

function workspaceStatusBadge(status) {
  if (!status) return "";
  return `<i class="ws-status" data-status="${escapeHtml(status)}">${escapeHtml(status)}</i>`;
}

function workspacePathData(path) {
  return escapeHtml(encodeURIComponent(path || ""));
}

function workspaceTreeHtml(nodes) {
  return (nodes || [])
    .map((node) => {
      if (node.type === "dir") {
        return `<details class="ws-dir" open>
          <summary>${workspaceStatusBadge(node.status)}<span class="ws-file-name">${escapeHtml(node.name)}</span></summary>
          <div class="ws-dir-children">${workspaceTreeHtml(node.children)}</div>
        </details>`;
      }
      return `<button class="ws-file" type="button" data-workspace-file="${workspacePathData(node.path)}" title="${escapeHtml(node.path)}">
        ${workspaceStatusBadge(node.status)}
        <span class="ws-file-name">${escapeHtml(node.name)}</span>
        <span class="ws-file-size">${node.sensitive ? "LOCK" : fmtBytes(node.bytes)}</span>
      </button>`;
    })
    .join("");
}

function workspaceChangeHtml(change) {
  const path = change.previousPath
    ? `${change.previousPath} → ${change.path}`
    : change.path;
  const openable = change.status !== "D" && change.path;
  return `<div class="workspace-change" ${openable ? `data-workspace-file="${workspacePathData(change.path)}"` : ""}>
    ${workspaceStatusBadge(change.status)}
    <div class="workspace-change-main">
      <b>${escapeHtml(path)}</b>
      <span>${escapeHtml(change.source || "workspace")}${change.stepId ? ` · ${escapeHtml(change.stepId)}` : ""}${change.agentId ? ` · ${escapeHtml(change.agentId.slice(0, 8))}` : ""}</span>
    </div>
  </div>`;
}

function workspaceEventTone(event) {
  if (event.type === "run.error") return "error";
  if (event.type === "cli.policy.denied") return "error";
  if (event.type.startsWith("run.")) return "run";
  if (event.type.startsWith("cli.policy.")) return "tool";
  if (event.type.startsWith("tool.")) return "tool";
  return "file";
}

function workspaceEventSummary(event) {
  const data = event.data || {};
  if (event.type === "tool.call.start" || event.type === "tool.call.end") {
    const tool = data.tool || data.command || "CLI";
    const operation = data.operation ? ` · ${data.operation}` : "";
    const status = data.status ? ` · ${data.status}` : data.code === undefined ? "" : ` · exit ${data.code}`;
    const actor = data.principal?.name ? ` · ${data.principal.name}` : "";
    return `${tool}${operation}${status}${actor}`;
  }
  if (event.type === "tool.policy.denied") {
    return `${data.tool || "tool"} · ${data.principal?.name || data.agentId || "unknown"} · 已拒绝`;
  }
  if (event.type.startsWith("cli.policy.")) {
    const sandbox = data.sandbox && data.sandbox !== "cli-default" ? ` · ${data.sandbox}` : "";
    const status = data.status ? ` · ${data.status}` : "";
    return `${data.adapter || data.command || "CLI"}${sandbox}${status}${
      data.reason ? ` · ${data.reason}` : ""
    }`;
  }
  if (event.type === "message.published") {
    const from = data.from?.name || "—";
    const to = (data.to || []).map((item) => item.name || item.id).join("、") || "广播";
    return `${from} → ${to}`;
  }
  if (event.type === "plan.replanned") {
    return `${data.source || "auto"} · 保留 ${data.preserved?.length || 0} · 重开 ${data.reopened?.length || 0}`;
  }
  if (event.type === "file.changed") {
    return `${data.status || "M"} · ${data.path || ""}`;
  }
  if (event.type === "run.end") {
    return `${data.status || "done"}${data.ms ? ` · ${fmtMs(data.ms)}` : ""}`;
  }
  if (event.type === "run.error") return data.error || "运行中断";
  return data.path || data.from || data.command || "";
}

function workspaceEventHtml(event) {
  const label = WORKSPACE_EVENT_LABEL[event.type] || event.type;
  return `<div class="workspace-event" data-tone="${workspaceEventTone(event)}">
    <span class="ws-status">${escapeHtml(label.slice(0, 1))}</span>
    <div class="workspace-event-main">
      <b>${escapeHtml(label)}</b>
      <span>${escapeHtml(workspaceEventSummary(event))} · ${fmtTime(event.at)}</span>
    </div>
  </div>`;
}

function renderWorkspace() {
  const info = S.workspace?.info || S.task?.workspaceInfo;
  const summary = S.workspace?.summary || {};
  const changes = S.workspace?.changes || S.task?.fileChanges || [];
  const events = S.workspace?.events || S.task?.events || [];

  $("#workspaceKind").textContent = info?.isolation === "clone"
    ? "GIT CLONE ISOLATION"
    : info?.worktree
      ? "GIT WORKTREE"
    : info?.isGit
      ? "GIT WORKSPACE"
      : "WORKSPACE";
  $("#workspaceName").textContent = info?.name || "未选择任务";
  $("#workspacePathLabel").textContent = info?.path || "—";
  $("#workspaceMeta").innerHTML = info
    ? [
        `<span>${info.external ? "外部目录" : "自动工作区"}</span>`,
        info.isGit ? `<span>${escapeHtml(info.branch || "detached")}</span>` : "<span>非 Git</span>",
        info.head ? `<span>HEAD ${escapeHtml(info.head)}</span>` : "",
        info.source ? `<span title="${escapeHtml(info.source)}">源 ${escapeHtml(shortPath(info.source))}</span>` : "",
        info.isolation === "clone"
          ? `<span title="${escapeHtml(info.fallbackReason || "worktree 不可用")}">CLONE 回退</span>`
          : "",
      ]
        .filter(Boolean)
        .join("")
    : "";

  $("#workspaceStats").innerHTML = [
    ["文件", summary.files || 0],
    ["目录", summary.directories || 0],
    ["变更", changes.length],
    ["事件", events.length],
  ]
    .map(([label, value]) => `<div class="workspace-stat"><b>${pad2(value)}</b><span>${label}</span></div>`)
    .join("");

  $("#workspaceTreeCount").textContent = pad2(S.workspace?.entries || 0);
  $("#workspaceChangeCount").textContent = pad2(changes.length);
  $("#workspaceEventCount").textContent = pad2(events.length);
  $("#workspaceTree").innerHTML = S.workspace
    ? workspaceTreeHtml(S.workspace.tree) || '<p class="hint">工作区为空。</p>'
    : '<p class="hint">选择任务后显示工作区目录。</p>';
  $("#workspaceChanges").innerHTML = changes.length
    ? changes.slice().reverse().map(workspaceChangeHtml).join("")
    : '<p class="hint">暂无文件变更。</p>';
  $("#workspaceEvents").innerHTML = events.length
    ? events.slice().reverse().slice(0, 80).map(workspaceEventHtml).join("")
    : '<p class="hint">任务运行后会记录工具调用和文件变更。</p>';
  renderWorkspaceSearch();
  renderWorkspaceConsole();
}

function renderWorkspaceSearch() {
  const box = $("#workspaceSearchResults");
  const search = S.workspace?.search;
  if (!search?.query) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = search.results?.length
    ? search.results
        .map(
          (item) => `<button class="ws-search-item" type="button" data-workspace-file="${workspacePathData(item.path)}">
            <b>${escapeHtml(item.path)}:${item.line}:${item.column}</b>
            <span>${escapeHtml(item.text || "")}</span>
          </button>`,
        )
        .join("")
    : '<p class="hint">没有匹配内容。</p>';
}

function workspaceConsoleSearchHtml() {
  const search = S.workspace?.search;
  if (!search?.query) return "";
  if (!search.results?.length) return '<p class="wc-empty-line">没有匹配内容。</p>';
  return search.results
    .map(
      (item) => `<button class="wc-search-item" type="button" data-workspace-file="${workspacePathData(item.path)}">
        <b>${escapeHtml(item.path)}:${item.line}:${item.column}</b>
        <span>${escapeHtml(item.text || "")}</span>
      </button>`,
    )
    .join("");
}

function workspaceConsoleEventHtml(event) {
  const label = WORKSPACE_EVENT_LABEL[event.type] || event.type;
  return `<div class="wc-event">
    <b>${escapeHtml(label)}</b>
    <span>${escapeHtml(workspaceEventSummary(event) || "—")}</span>
    <em>${fmtTime(event.at)}</em>
  </div>`;
}

function workspaceConsoleContextHtml() {
  const context = S.task?.context || {};
  const files = context.files || [];
  const messages = context.messages || [];
  const budget = context.budget || {};
  return `
    <div class="wc-context-card">
      <b>GOAL / 当前目标</b>
      <p>${escapeHtml(context.goal || S.task?.goal || "—")}</p>
    </div>
    <div class="wc-context-card">
      <b>BUDGET / 注入预算</b>
      <p>消息 ${messages.length}/${budget.messagesAvailable ?? messages.length} · 文件 ${files.length}/${budget.filesAvailable ?? files.length}</p>
    </div>
    <div class="wc-context-card">
      <b>RECENT / 最近协作</b>
      ${
        messages.length
          ? messages
              .slice(-4)
              .reverse()
              .map(
                (message) => `<p><strong>${escapeHtml(message.name || "AI")}</strong> · ${escapeHtml(
                  String(message.text || "").slice(0, 220),
                )}</p>`,
              )
              .join("")
          : '<p>暂无近期协作摘要。</p>'
      }
    </div>
    <div class="wc-context-card">
      <b>FILES / 已知上下文</b>
      ${
        files.length
          ? files
              .slice(0, 12)
              .map(
                (file) =>
                  `<div class="wc-file-chip"><span>${escapeHtml(file.path)}</span><i>${fmtBytes(file.bytes)}</i></div>`,
              )
              .join("")
          : '<p>工作区还没有可读取的文件。</p>'
      }
    </div>`;
}

function workspacePolicyAgents() {
  const plan = S.task?.plan || [];
  const ids = [...new Set(plan.map((step) => step.agentId).filter(Boolean))];
  return ids.length
    ? ids.map((id) => S.agents.find((item) => item.id === id)).filter(Boolean)
    : S.agents.filter((agent) => agent.seat !== false);
}

function workspaceConsolePolicyHtml() {
  const agents = workspacePolicyAgents();
  if (!agents.length) return '<p class="wc-empty-line">团队里还没有可展示的成员策略。</p>';
  const labels = new Map(S.toolCatalog.map((tool) => [tool.id, tool.label]));
  return agents
    .map((agent) => {
      const tools = Array.isArray(agent.tools)
        ? agent.tools
        : S.roleTools?.[agent.role] || [];
      const policy = agent.cliPolicy || {};
      const strict = policy.policy === "strict" || agent.executionPolicy === "strict";
      const policyStatus = policy.status || (strict ? "unsupported" : "inherit");
      const policyLabel =
        policyStatus === "enforced"
          ? "STRICT"
          : policyStatus === "unsupported"
            ? "BLOCKED"
            : "INHERIT";
      return `<div class="wc-policy-card">
        <div class="wc-policy-title">
          <b>${escapeHtml(agent.name)} · ${escapeHtml(ROLE_META[agent.role]?.short || agent.role)}</b>
          <i data-policy="${escapeHtml(policyStatus)}">${policyLabel}</i>
        </div>
        <div class="wc-tool-list">${
          tools.length
            ? tools
                .map(
                  (tool) =>
                    `<span title="${escapeHtml(tool)}">${escapeHtml(labels.get(tool) || tool)}</span>`,
                )
                .join("")
            : '<span class="off">NO TOOLS</span>'
        }</div>
        <p>${escapeHtml(
          policy.reason ||
            (strict
              ? "严格策略尚未通过预检。"
              : "沿用 CLI 自身参数，平台不强制真实子进程边界。"),
        )}</p>
      </div>`;
    })
    .join("");
}

function workspaceConsoleSummaryHtml() {
  const task = S.task;
  if (!task) return "";
  const stats = task.stats || {};
  const done = (task.plan || []).filter((step) => step.status === "done").length;
  const changes = S.workspace?.changes || task.fileChanges || [];
  const events = S.workspace?.events || task.events || [];
  return `
    <div class="wc-summary-card"><b>STATUS</b><p>${escapeHtml(STATUS_TEXT[task.status] || task.status)}</p></div>
    <div class="wc-summary-card"><b>PROGRESS</b><p>${done}/${(task.plan || []).length} 工序完成</p></div>
    <div class="wc-summary-card"><b>QUALITY</b><p>${escapeHtml(task.quality?.status || "pending")}</p></div>
    <div class="wc-summary-card"><b>ACTIVITY</b><p>${changes.length} 个变更 · ${events.length} 个事件</p></div>
    <div class="wc-summary-card"><b>TOKENS</b><p>${Number(stats.tokens || 0).toLocaleString()}</p></div>`;
}

function workspaceConsoleLanesHtml() {
  const plan = S.task?.plan || [];
  if (!plan.length) {
    return S.task?.status === "queued"
      ? `<p class="wc-empty-line">排队中${S.task.queuePosition ? ` #${S.task.queuePosition}` : ""} · ${escapeHtml(
          S.task.waitingReason || "等待调度资源",
        )}</p>`
      : '<p class="wc-empty-line">任务开始后，这里会按成员展示工序与依赖。</p>';
  }
  const groups = new Map();
  for (const step of plan) {
    const key = step.agentId || `role:${step.role}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(step);
  }
  return [...groups.entries()]
    .map(([key, steps]) => {
      const agent = S.agents.find((item) => item.id === key);
      const role = agent?.role || steps[0]?.role;
      const name = agent?.name || ROLE_META[role]?.short || role || "未分配";
      const avatar = agent
        ? avatarHtml(agent)
        : `<span class="avatar" style="--c:#b8d94f">${initials(name)}</span>`;
      return `<div class="wc-lane">
        <div class="wc-lane-agent">${avatar}<span>${escapeHtml(name)}</span></div>
        <div class="wc-lane-steps">
          ${steps
            .map(
              (step) => `<div class="wc-step" data-status="${escapeHtml(step.status || "pending")}" title="${escapeHtml(
                step.note || "",
              )}">
                <b>${escapeHtml(step.title || step.id)}</b>
                <span>${escapeHtml(STEP_STATUS_TEXT[step.status] || step.status || "pending")}${
                  step.needs?.length ? ` · 依赖 ${step.needs.length}` : ""
                }${step.attempt > 1 ? ` · 尝试 ${step.attempt}` : ""}</span>
              </div>`,
            )
            .join("")}
        </div>
      </div>`;
    })
    .join("");
}

function workspaceConsolePlanVersionsHtml() {
  const versions = (S.task?.planVersions || []).slice().sort((a, b) => b.version - a.version);
  if (!versions.length) {
    return '<p class="wc-empty-line">任务开始后会记录初版、返工和重规划快照。</p>';
  }
  return versions
    .map(
      (version, index) => `<article class="wc-version" data-current="${index === 0}">
        <header class="wc-version-head">
          <b>V${version.version}</b>
          <div>
            <strong>${escapeHtml(version.reason || "计划更新")}</strong>
            <span>${escapeHtml(version.source || "platform")} · ${fmtTime(version.createdAt)} · ${version.summary?.done || 0}/${version.summary?.total || 0} 完成</span>
          </div>
          <em>${version.added?.length ? `+${version.added.length} ` : ""}${version.removed?.length ? `-${version.removed.length} ` : ""}${version.changed?.length ? `~${version.changed.length}` : ""}</em>
        </header>
        <div class="wc-version-steps">
          ${(version.steps || [])
            .map(
              (step) => `<div class="wc-version-step" data-status="${escapeHtml(step.status || "pending")}">
                <span>${escapeHtml(step.id)}</span>
                <b>${escapeHtml(step.title || step.id)}</b>
                <em>${escapeHtml(STEP_STATUS_TEXT[step.status] || step.status || "pending")}</em>
              </div>`,
            )
            .join("")}
        </div>
      </article>`,
    )
    .join("");
}

function messageRecipientLabel(message) {
  const recipients = message.to || [];
  if (!recipients.length) return "任务广播";
  return recipients.map((recipient) => recipient.name || recipient.id).join("、");
}

function workspaceConsoleMessagesHtml() {
  const messages = (S.task?.messages || []).filter((message) => message.text).slice(-100).reverse();
  if (!messages.length) return '<p class="wc-empty-line">协作消息会在这里显示来源、目标、关联工序和产物。</p>';
  return messages
    .map((message) => {
      const from = message.from || {};
      const refs = message.artifactRefs || [];
      return `<article class="wc-message-route">
        <div class="wc-message-line">
          <b>${escapeHtml(from.name || message.name || "System")}</b>
          <span>→</span>
          <strong>${escapeHtml(messageRecipientLabel(message))}</strong>
          <em>${fmtTime(message.createdAt)}</em>
        </div>
        <div class="wc-message-meta">
          <span>${escapeHtml(message.kind || "text")}</span>
          ${message.stepId ? `<span>STEP ${escapeHtml(message.stepId)}</span>` : ""}
          ${message.correlationId ? `<span>RUN ${escapeHtml(String(message.correlationId).slice(0, 8))}</span>` : ""}
          ${message.parentMessageId ? `<span>RE ${escapeHtml(String(message.parentMessageId).slice(0, 8))}</span>` : ""}
          ${refs.length ? `<span>${refs.length} ARTIFACTS</span>` : ""}
        </div>
        <p>${escapeHtml(String(message.text || "").replace(/\s+/g, " ").slice(0, 560))}</p>
      </article>`;
    })
    .join("");
}

function toolAuditEntries() {
  const events = (S.task?.events || []).filter((event) => {
    const type = String(event.type || "");
    return type.startsWith("tool.") || type.startsWith("cli.policy.");
  });
  const calls = new Map();
  for (const event of events) {
    const key = event.data?.callId || event.id;
    if (!calls.has(key)) calls.set(key, { key, start: null, end: null, denied: null, at: event.at });
    const entry = calls.get(key);
    if (event.type === "tool.call.start") entry.start = event;
    else if (event.type === "tool.call.end") entry.end = event;
    else if (event.type === "tool.policy.denied" || event.type === "cli.policy.denied") {
      entry.denied = event;
    }
    if (event.type === "cli.policy.end") entry.policyEnd = event;
    entry.at = Math.max(entry.at || 0, event.at || 0);
  }
  return [...calls.values()].sort((a, b) => b.at - a.at).slice(0, 120);
}

function workspaceConsoleAuditHtml() {
  const entries = toolAuditEntries();
  if (!entries.length) return '<p class="wc-empty-line">还没有工具调用审计。</p>';
  return entries
    .map(({ start, end, denied, policyEnd, at }) => {
      const data = end?.data || denied?.data || start?.data || {};
      const policy =
        (data.policy && typeof data.policy === "object" ? data.policy : null) ||
        policyEnd?.data ||
        (start?.data?.policy && typeof start.data.policy === "object" ? start.data.policy : null);
      const status = data.status || (end ? "ok" : denied ? "denied" : "running");
      const actor = data.principal?.name || data.agentId || "Owner UI";
      const args = data.arguments
        ? Object.entries(data.arguments)
            .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
            .join(" · ")
        : data.command
          ? [data.command, ...(data.args || [])].join(" ")
          : "";
      return `<article class="wc-audit-row" data-status="${escapeHtml(status)}">
        <div class="wc-audit-main">
          <b>${escapeHtml(data.tool || data.command || "tool")}</b>
          <span>${escapeHtml(data.operation || "call")}</span>
          <em>${escapeHtml(status)}</em>
        </div>
        <div class="wc-audit-meta">
          <span>${escapeHtml(actor)}</span>
          <span>${escapeHtml(data.source || "runtime")}</span>
          ${data.durationMs !== undefined ? `<span>${fmtMs(data.durationMs)}</span>` : ""}
          ${
            policy?.policy
              ? `<span>${escapeHtml(
                  policy.status === "enforced"
                    ? `STRICT · ${policy.sandbox}`
                    : policy.status === "unsupported"
                      ? "STRICT · BLOCKED"
                      : "INHERIT",
                )}</span>`
              : ""
          }
          <span>${fmtTime(at)}</span>
        </div>
        ${args ? `<code>${escapeHtml(args)}</code>` : ""}
        ${data.error || policy?.reason ? `<p>${escapeHtml(data.error || policy.reason)}</p>` : ""}
      </article>`;
    })
    .join("");
}

function renderWorkspaceConsoleFile() {
  const empty = $("#wcFileEmpty");
  const codeBlock = $("#wcCodeBlock");
  const code = $("#wcCode");
  const editor = $("#wcEditor");
  const data = S.workspacePreviewData;
  const path = S.workspacePreviewPath;
  if (!data || !path) {
    $("#wcFilePath").textContent = "—";
    $("#wcFileState").textContent = "选择一个文件开始";
    empty.hidden = false;
    codeBlock.hidden = true;
    editor.hidden = true;
    $("#wcEdit").hidden = true;
    $("#wcSave").hidden = true;
    $("#wcDelete").hidden = true;
    return;
  }
  $("#wcFilePath").textContent = path;
  $("#wcFileState").textContent = `${data.binary ? "BINARY" : (data.lang || "text").toUpperCase()} · ${fmtBytes(
    data.bytes,
  )} · ${data.version ? data.version.slice(0, 10) : "unversioned"}`;
  empty.hidden = true;
  code.textContent = data.binary ? "[binary file]" : data.content || "";
  const editing = !editor.hidden;
  if (!editing) editor.value = data.binary ? "" : data.content || "";
  codeBlock.hidden = data.binary ? false : editing;
  editor.hidden = data.binary || !editing;
  $("#wcEdit").hidden = !!data.binary;
  $("#wcSave").hidden = !editing;
  $("#wcDelete").hidden = false;
}

function renderWorkspaceConsole() {
  const root = $("#workspaceConsole");
  if (!root) return;
  if (!S.task) {
    S.workspace = null;
    S.workspacePreviewPath = "";
    S.workspacePreviewData = null;
    S.workspaceDiffPath = "";
    S.workspaceDiff = null;
    $("#wcTitle").textContent = "未选择任务";
    $("#wcTaskCode").textContent = "NO TASK";
    $("#wcMeta").innerHTML = "";
    $("#wcPath").textContent = "—";
    $("#wcTree").innerHTML = '<p class="hint">先选择一个任务。</p>';
    $("#wcChanges").innerHTML = '<p class="hint">暂无文件变更。</p>';
    $("#wcSearchResults").hidden = true;
    $("#wcSearchResults").innerHTML = "";
    $("#wcLanes").innerHTML = '<p class="wc-empty-line">选择任务后显示执行泳道。</p>';
    $("#wcEvents").innerHTML = '<p class="hint">选择任务后显示运行事件。</p>';
    $("#wcPlanVersions").innerHTML = '<p class="wc-empty-line">选择任务后显示计划版本。</p>';
    $("#wcMessageRoutes").innerHTML = '<p class="wc-empty-line">选择任务后显示协作消息。</p>';
    $("#wcAudit").innerHTML = '<p class="wc-empty-line">选择任务后显示工具审计。</p>';
    $("#wcContext").innerHTML = "";
    $("#wcPolicy").innerHTML = "";
    $("#wcSummary").innerHTML = "";
    $("#wcDiff").textContent = "";
    $("#wcRunStatus").textContent = "—";
    $("#wcTreeCount").textContent = "00";
    $("#wcChangeCount").textContent = "00";
    $("#wcEventCount").textContent = "00";
    $("#wcContextCount").textContent = "00";
    $("#wcPolicyCount").textContent = "00";
    $("#wcPlanCount").textContent = "V0";
    $("#wcMessageCount").textContent = "00";
    $("#wcAuditCount").textContent = "00";
    renderWorkspaceConsoleFile();
    return;
  }
  const info = S.workspace?.info || S.task.workspaceInfo;
  const summary = S.workspace?.summary || {};
  const changes = S.workspace?.changes || S.task.fileChanges || [];
  const events = S.workspace?.events || S.task.events || [];
  $("#wcTitle").textContent = S.task.title;
  $("#wcTaskCode").textContent = String(S.task.id || "").slice(0, 8).toUpperCase();
  $("#wcMeta").innerHTML = info
    ? [
        `<span>${
          info.isolation === "clone"
            ? "GIT CLONE"
            : info.isolation === "worktree"
              ? "GIT WORKTREE"
              : info.external
                ? "外部工作区"
                : "自动工作区"
        }</span>`,
        `<span>${info.isGit ? escapeHtml(info.branch || "detached") : "非 Git"}</span>`,
        info.head ? `<span>HEAD ${escapeHtml(info.head)}</span>` : "",
        info.source ? `<span title="${escapeHtml(info.source)}">源 ${escapeHtml(shortPath(info.source))}</span>` : "",
        info.isolation === "clone"
          ? `<span title="${escapeHtml(info.fallbackReason || "worktree 不可用")}">CLONE 回退</span>`
          : "",
        `<span>${summary.files || 0} files</span>`,
      ]
        .filter(Boolean)
        .join("")
    : "";
  $("#wcPath").textContent = info?.path || "—";
  $("#wcTreeCount").textContent = pad2(S.workspace?.entries || 0);
  $("#wcChangeCount").textContent = pad2(changes.length);
  $("#wcEventCount").textContent = pad2(events.length);
  $("#wcContextCount").textContent = pad2((S.task.context?.files || []).length);
  $("#wcPolicyCount").textContent = pad2(workspacePolicyAgents().length);
  $("#wcTree").innerHTML = S.workspace
    ? workspaceTreeHtml(S.workspace.tree) || '<p class="hint">工作区为空。</p>'
    : '<p class="hint">正在读取工作树…</p>';
  $("#wcChanges").innerHTML = changes.length
    ? changes.slice().reverse().map(workspaceChangeHtml).join("")
    : '<p class="hint">暂无文件变更。</p>';
  const searchResults = $("#wcSearchResults");
  const searchHtml = workspaceConsoleSearchHtml();
  searchResults.hidden = !searchHtml;
  searchResults.innerHTML = searchHtml;
  $("#wcLanes").innerHTML = workspaceConsoleLanesHtml();
  $("#wcEvents").innerHTML = events.length
    ? events.slice().reverse().slice(0, 120).map(workspaceConsoleEventHtml).join("")
    : '<p class="hint">任务运行后会记录工具调用、文件变更和运行结果。</p>';
  $("#wcPlanVersions").innerHTML = workspaceConsolePlanVersionsHtml();
  $("#wcMessageRoutes").innerHTML = workspaceConsoleMessagesHtml();
  $("#wcAudit").innerHTML = workspaceConsoleAuditHtml();
  $("#wcRunStatus").textContent = STATUS_TEXT[S.task.status] || S.task.status || "—";
  $("#wcPlanCount").textContent = `V${S.task.planVersion || 0}`;
  $("#wcMessageCount").textContent = pad2((S.task.messages || []).length);
  $("#wcAuditCount").textContent = pad2(toolAuditEntries().length);
  $("#wcContext").innerHTML = workspaceConsoleContextHtml();
  $("#wcPolicy").innerHTML = workspaceConsolePolicyHtml();
  $("#wcSummary").innerHTML = workspaceConsoleSummaryHtml();
  renderWorkspaceConsoleFile();
  setWorkspaceConsoleView(S.workspaceConsoleView, { render: false });
}

function setWorkspaceConsoleView(view, { render = true } = {}) {
  const next = ["file", "execution", "plan", "messages", "audit", "diff"].includes(view) ? view : "file";
  S.workspaceConsoleView = next;
  $$("#wcViewTabs [data-wc-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.wcView === next);
  });
  $("#wcFileView").hidden = next !== "file";
  $("#wcExecutionView").hidden = next !== "execution";
  $("#wcPlanView").hidden = next !== "plan";
  $("#wcMessagesView").hidden = next !== "messages";
  $("#wcAuditView").hidden = next !== "audit";
  $("#wcDiffView").hidden = next !== "diff";
  const stateLabel = {
    execution: "按成员查看工序、依赖与运行事件",
    plan: `计划版本 V${S.task?.planVersion || 0} · 快照不可变`,
    messages: "消息保留来源、目标、关联工序与产物",
    audit: "策略校验、参数摘要与执行结果",
    diff: "对比当前工作区与 Git 基线",
  }[next];
  if (stateLabel) $("#wcFileState").textContent = stateLabel;
  else renderWorkspaceConsoleFile();
  if (render && next === "diff") loadWorkspaceConsoleDiff();
}

async function loadWorkspaceConsoleDiff() {
  if (!S.task) return;
  const path = S.workspaceDiffPath || S.workspacePreviewPath || "";
  $("#wcDiffTitle").textContent = path || "整个工作区";
  $("#wcDiff").textContent = "正在读取 Git diff…";
  try {
    const data = await api(
      `/api/tasks/${S.task.id}/diff${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    );
    S.workspaceDiff = data;
    $("#wcDiff").textContent = data.available
      ? data.diff || "没有差异。"
      : data.reason || data.error || "当前工作区没有可用的 diff。";
  } catch (err) {
    $("#wcDiff").textContent = `读取失败：${err.message}`;
  }
}

async function replanWorkspaceTask() {
  if (!S.task) return;
  if (S.task.running || ["running", "stopping"].includes(S.task.status)) {
    toast("任务正在执行，停止后才能重规划", "err");
    return;
  }
  const button = $("#wcReplan");
  button.disabled = true;
  try {
    const data = await api(`/api/tasks/${S.task.id}/replan`, {
      method: "POST",
      body: { reason: "用户从工作区控制台重规划未完成工序" },
    });
    S.task = data.task;
    const summary = S.tasks.find((task) => task.id === S.task.id);
    if (summary) {
      summary.status = S.task.status;
      summary.planVersion = S.task.planVersion;
      summary.planVersions = S.task.planVersions?.length || 0;
      summary.steps = S.task.plan?.length || 0;
      summary.doneSteps = (S.task.plan || []).filter((step) => step.status === "done").length;
    }
    renderAll();
    await loadWorkspace({ force: true });
    toast(`已生成计划 V${S.task.planVersion}，保留 ${data.replan?.preserved?.length || 0} 个完成工序`, "ok");
  } catch (err) {
    toast(`重规划失败：${err.message}`, "err");
  } finally {
    button.disabled = false;
  }
}

function openWorkspaceConsole() {
  if (!S.task) {
    toast("先选择一个任务", "err");
    return;
  }
  S.workspaceConsoleOpen = true;
  $("#workspaceConsole").hidden = false;
  document.body.classList.add("workspace-console-open");
  renderWorkspaceConsole();
  if (!S.workspace) loadWorkspace({ force: true });
  setTimeout(() => $("#wcSearch").focus(), 40);
}

function closeWorkspaceConsole() {
  S.workspaceConsoleOpen = false;
  $("#workspaceConsole").hidden = true;
  document.body.classList.remove("workspace-console-open");
}

async function searchWorkspaceFrom(inputId = "#workspaceSearch") {
  if (!S.task) return;
  const query = $(inputId)?.value.trim() || "";
  if (query.length < 2) {
    if (S.workspace) S.workspace.search = null;
    renderWorkspaceSearch();
    renderWorkspaceConsole();
    return;
  }
  try {
    const data = await api(`/api/tasks/${S.task.id}/search?q=${encodeURIComponent(query)}`);
    if (!S.workspace) S.workspace = {};
    S.workspace.search = data;
    renderWorkspaceSearch();
    renderWorkspaceConsole();
  } catch (err) {
    toast(`搜索失败：${err.message}`, "err");
  }
}

async function loadWorkspace({ force = false } = {}) {
  const taskId = S.task?.id;
  if (!taskId || (S.workspaceLoading && !force)) return;
  S.workspaceLoading = true;
  try {
    const data = await api(`/api/tasks/${taskId}/workspace`);
    if (!S.task || S.task.id !== taskId) return;
    S.workspace = { ...(S.workspace || {}), ...data };
    renderWorkspace();
  } catch (err) {
    if (S.task?.id === taskId) toast(`工作区加载失败：${err.message}`, "err");
  } finally {
    S.workspaceLoading = false;
  }
}

function scheduleWorkspaceRefresh() {
  if (!S.task) return;
  clearTimeout(S.workspaceRefreshTimer);
  S.workspaceRefreshTimer = setTimeout(() => loadWorkspace(), 260);
}

async function searchWorkspaceFiles() {
  if (!S.task) return;
  const query = $("#workspaceSearch").value.trim();
  if (query.length < 2) {
    if (S.workspace) S.workspace.search = null;
    renderWorkspaceSearch();
    return;
  }
  try {
    const data = await api(`/api/tasks/${S.task.id}/search?q=${encodeURIComponent(query)}`);
    if (!S.workspace) S.workspace = {};
    S.workspace.search = data;
    renderWorkspaceSearch();
  } catch (err) {
    toast(`搜索失败：${err.message}`, "err");
  }
}

async function previewWorkspaceFile(rel) {
  if (!rel || !S.task) return;
  try {
    const data = await api(
      `/api/tasks/${S.task.id}/file?path=${encodeURIComponent(rel)}`,
    );
    if (!S.workspaceConsoleOpen) switchTab("workspace");
    S.workspacePreviewPath = data.path;
    S.workspacePreviewData = data;
    S.workspaceDiffPath = data.path;
    $("#workspaceFilePath").textContent = data.path;
    $("#workspaceFileCode").textContent = data.binary
      ? "[binary file]"
      : data.content;
    $("#workspaceFileEditor").value = data.binary ? "" : data.content;
    $("#workspaceFileEditor").hidden = true;
    $("#wcEditor").hidden = true;
    $("#workspaceFilePreview").hidden = false;
    $("#workspaceFileEdit").hidden = !!data.binary;
    $("#workspaceFileSave").hidden = true;
    $("#workspaceFileDelete").hidden = false;
    $("#workspaceFileView").hidden = false;
    $("#workspaceFileView").scrollIntoView({ block: "nearest" });
    renderWorkspaceConsoleFile();
  } catch (err) {
    toast(err.message, "err");
  }
}

function closeWorkspacePreview() {
  S.workspacePreviewPath = "";
  S.workspacePreviewData = null;
  $("#workspaceFileView").hidden = true;
  renderWorkspaceConsoleFile();
}

function editWorkspaceFile() {
  if (!S.workspacePreviewData || S.workspacePreviewData.binary) return;
  $("#workspaceFileCode").textContent = S.workspacePreviewData.content;
  $("#workspaceFilePreview").hidden = true;
  $("#workspaceFileEditor").hidden = false;
  $("#workspaceFileEdit").hidden = true;
  $("#workspaceFileSave").hidden = false;
  $("#workspaceFileEditor").focus();
  $("#wcCodeBlock").hidden = true;
  $("#wcEditor").hidden = false;
  $("#wcEditor").value = S.workspacePreviewData.content || "";
  $("#wcEdit").hidden = true;
  $("#wcSave").hidden = false;
  $("#wcEditor").focus();
}

async function saveWorkspaceFile() {
  if (!S.task || !S.workspacePreviewPath) return;
  const content = !$("#wcEditor").hidden ? $("#wcEditor").value : $("#workspaceFileEditor").value;
  try {
    await api(`/api/tasks/${S.task.id}/fs`, {
      method: "POST",
      body: { op: "write", path: S.workspacePreviewPath, content },
    });
    toast("文件已保存", "ok");
    await loadWorkspace({ force: true });
    await previewWorkspaceFile(S.workspacePreviewPath);
  } catch (err) {
    toast(`保存失败：${err.message}`, "err");
  }
}

async function deleteWorkspaceFile() {
  if (!S.task || !S.workspacePreviewPath) return;
  if (!window.confirm(`将「${S.workspacePreviewPath}」移入回收站？`)) return;
  try {
    await api(`/api/tasks/${S.task.id}/fs`, {
      method: "POST",
      body: { op: "delete", path: S.workspacePreviewPath },
    });
    toast("已移入回收站", "ok");
    closeWorkspacePreview();
    await loadWorkspace({ force: true });
  } catch (err) {
    toast(`删除失败：${err.message}`, "err");
  }
}

async function createWorkspaceFile() {
  if (!S.task) return;
  const rel = window.prompt("输入工作区内的相对路径");
  if (!rel?.trim()) return;
  try {
    await api(`/api/tasks/${S.task.id}/fs`, {
      method: "POST",
      body: { op: "write", path: rel.trim(), content: "" },
    });
    await loadWorkspace({ force: true });
    await previewWorkspaceFile(rel.trim());
    editWorkspaceFile();
  } catch (err) {
    toast(`新建失败：${err.message}`, "err");
  }
}

function renderStats() {
  const t = S.task;
  const grid = $("#statGrid");
  const hookUrl = `${location.origin}/api/hooks/${S.settings.hookToken || ""}`;
  $("#hookUrl").textContent = hookUrl.replace(/^https?:\/\//, "");

  if (!t) {
    grid.innerHTML = '<p class="hint">选择一个任务查看统计。</p>';
    return;
  }
  const stats = t.stats || {};
  const artifacts = t.artifacts?.length ?? t.files ?? 0;
  const gate = t.quality?.status || "pending";
  const terminal = ["done", "error", "stopped", "needs_attention"].includes(t.status);
  const gateText =
    gate === "passed"
      ? "PASS"
      : gate === "failed"
        ? "FAIL"
        : gate === "missing"
          ? "无入口"
          : gate === "skipped"
            ? "评审代判"
            : gate === "running"
              ? "运行中"
              : gate === "not-run" || (gate === "pending" && terminal)
                ? "未执行"
                : "待执行";
  const gateHint = t.quality?.reason || t.quality?.command || "任务还在跑，质量门尚未开始";
  const elapsed = stats.ms
    ? fmtMs(stats.ms)
    : t.running
      ? "进行中"
      : t.endedAt && t.createdAt
        ? fmtMs(t.endedAt - t.createdAt)
        : "—";
  const elapsedHint = stats.wallMs
    ? `墙钟 ${fmtMs(stats.wallMs)}（含排队、重试与等待）`
    : t.queueMs
      ? `排队 ${fmtMs(t.queueMs)} · 执行 ${fmtMs(t.executionMs || 0)}`
      : "尚未记录工时";
  const items = [
    [
      "累计 TOKENS",
      (stats.tokens || 0).toLocaleString(),
      stats.tokensIn === undefined
        ? "历史任务只统计了输出文本，没有记录输入提示词"
        : `输入 ${stats.tokensIn.toLocaleString()} + 输出 ${(stats.tokensOut || 0).toLocaleString()}（按字符类估算，CJK 1 字≈1 token）`,
    ],
    ["协作轮次", stats.agentRuns === undefined ? "—" : pad2(stats.agentRuns), "真实调用成员的次数"],
    ["产物文件", pad2(artifacts), "工作区里记录在案的产物数"],
    ["返工轮次", pad2(t.repairRound || 0), "评审不通过后重跑的轮数"],
    ["质量门", gateText, gateHint],
    ["总耗时", elapsed, elapsedHint],
  ];
  grid.innerHTML = items
    .map(
      ([label, value, hint]) =>
        `<div class="stat" title="${escapeHtml(hint || "")}"><div class="s-label">${label}</div><div class="s-value">${value}</div></div>`,
    )
    .join("");
  const ws = $("#workspacePath");
  if (ws) {
    ws.textContent = t ? t.workspace || "自动工作区" : "未选择任务";
    ws.title = t?.workspace || "";
  }
}

function renderContext() {
  const wrap = $("#contextList");
  const hint = $("#contextHint");
  const t = S.task;
  const context = t?.context;

  if (!context) {
    if (hint) hint.textContent = "选择任务后，这里会显示当前上下文。";
    wrap.innerHTML = "";
    return;
  }

  const files = context.files || [];
  const messages = context.messages || [];
  if (hint) {
    hint.textContent = `工作区 ${shortPath(context.workspace || "")} · ${messages.length} 条近期对话 · ${files.length} 个已知文件`;
    hint.title = context.workspace || "";
  }

  const contextFiles = files.slice(0, 12);
  const contextMessages = messages.slice(-4).reverse();
  wrap.innerHTML = `
    <div class="ctx-block">
      <div class="ctx-label">GOAL</div>
      <p>${escapeHtml(context.goal || "")}</p>
    </div>
    <div class="ctx-block">
      <div class="ctx-label">RECENT</div>
      ${
        contextMessages.length
          ? contextMessages
              .map(
                (m) =>
                  `<div class="ctx-message"><b>${escapeHtml(m.name)}</b><span>${escapeHtml(m.text)}</span></div>`,
              )
              .join("")
          : '<p class="hint">暂无近期协作摘要。</p>'
      }
    </div>
    <div class="ctx-block">
      <div class="ctx-label">FILES</div>
      ${
        contextFiles.length
          ? contextFiles
              .map(
                (f) =>
                  `<div class="ctx-file"><span>${escapeHtml(f.path)}</span><i>${fmtBytes(f.bytes)}</i></div>`,
              )
              .join("")
          : '<p class="hint">工作区还没有可读取的文件。</p>'
      }
    </div>
  `;
}

/* ---------------- 工作流设置 ---------------- */

const FLOW_MODE_KEY = "agentforge:flowMode";

const FLOW_NUM_FIELDS = [
  ["setDebateParticipants", "debateParticipants", 2, 6, 4],
  ["setDebateConcurrency", "debateConcurrency", 1, 4, 2],
  ["setDebatePoolSeats", "debatePoolSeats", 0, 3, 1],
  ["setMaxTaskConcurrency", "maxTaskConcurrency", 1, 8, 2],
  ["setMaxConcurrency", "maxConcurrency", 1, 4, 2],
  ["setMaxRepairRounds", "maxRepairRounds", 0, 3, 1],
  ["setMaxStepAttempts", "maxStepAttempts", 1, 3, 2],
];

const FLOW_PRESETS = {
  fast: { debateEnabled: false, debateParticipants: 2, debateConcurrency: 2, debatePoolSeats: 0, maxTaskConcurrency: 3, maxConcurrency: 4, maxRepairRounds: 0, maxStepAttempts: 1 },
  balanced: { debateEnabled: true, debateParticipants: 5, debateConcurrency: 2, debatePoolSeats: 1, maxTaskConcurrency: 2, maxConcurrency: 2, maxRepairRounds: 1, maxStepAttempts: 2 },
  thorough: { debateEnabled: true, debateParticipants: 6, debateConcurrency: 4, debatePoolSeats: 2, maxTaskConcurrency: 2, maxConcurrency: 4, maxRepairRounds: 3, maxStepAttempts: 3 },
};

function currentFlowSettings() {
  const s = S.settings || {};
  return {
    debateEnabled: s.debateEnabled !== false,
    debateParticipants: Number(s.debateParticipants) || 4,
    debateConcurrency: Number(s.debateConcurrency) || 2,
    debatePoolSeats: Number(s.debatePoolSeats ?? 1),
    maxTaskConcurrency: Number(s.maxTaskConcurrency) || 2,
    maxConcurrency: Number(s.maxConcurrency) || 2,
    maxRepairRounds: Number(s.maxRepairRounds ?? 1),
    maxStepAttempts: Number(s.maxStepAttempts) || 2,
  };
}

function fillFlowForm(values) {
  for (const [id, key, min, max, fallback] of FLOW_NUM_FIELDS) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.innerHTML = Array.from({ length: max - min + 1 }, (_, i) => {
      const n = min + i;
      return `<option value="${n}">${n}${n === fallback ? " · 默认" : ""}</option>`;
    }).join("");
    el.value = String(values[key] ?? fallback);
  }
  $("#setDebateEnabled").checked = values.debateEnabled !== false;
}

function readFlowForm() {
  const out = { debateEnabled: $("#setDebateEnabled").checked };
  for (const [id, key] of FLOW_NUM_FIELDS) out[key] = Number($(`#${id}`).value);
  return out;
}

function openFlowSettings() {
  fillFlowForm(currentFlowSettings());
  $("#flowSaveHint").textContent = "";
  $("#flowModal").showModal();
}

async function saveFlowSettings() {
  const btn = $("#flowSave");
  const patch = readFlowForm();
  btn.disabled = true;
  $("#flowSaveHint").textContent = "保存中…";
  try {
    const { settings } = await api("/api/settings", { method: "PATCH", body: patch });
    S.settings = settings;
    renderFlowModeControls();
    $("#flowSaveHint").textContent = "已保存，下个任务生效";
    toast("工作流设置已保存", "ok");
    setTimeout(() => $("#flowModal").close(), 450);
  } catch (err) {
    $("#flowSaveHint").textContent = `保存失败：${err.message}`;
    toast(`保存失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
  }
}

/** 开工方式选择：全局讨论关闭时，默认值也跟着变，避免"选了先讨论却没讨论"。 */
function renderFlowModeControls() {
  const globalOn = S.settings?.debateEnabled !== false;
  const mode = S.flowMode === "direct" ? "direct" : "debate";
  S.flowMode = mode;
  $$("#heroMode .fm, #composerMode .fm").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
    if (b.dataset.mode === "debate") {
      b.title = globalOn
        ? "多位成员各出方案、交叉评分，选出最优再实施"
        : "全局讨论已关闭；仍选它可为这个任务单独开启讨论";
    }
  });
  const tip = $("#composerTip");
  if (tip && !S.task) {
    tip.textContent = `自动编排 · ${mode === "direct" ? "直接开工" : "先讨论后实施"}`;
  }
}

function setFlowMode(mode) {
  S.flowMode = mode === "direct" ? "direct" : "debate";
  try {
    localStorage.setItem(FLOW_MODE_KEY, S.flowMode);
  } catch {
    /* ignore */
  }
  renderFlowModeControls();
}

/* ---------------- 渲染总入口 ---------------- */

function renderAll() {
  renderAgents();
  renderTasks();
  renderTopbar();
  renderMessages();
  renderPlan();
  renderDebate();
  renderFiles();
  renderWorkspace();
  renderStats();
  renderContext();
  renderFlow();
}

/* ---------------- 任务操作 ---------------- */

async function selectTask(id) {
  if (!id) return;
  try {
    const { task } = await api(`/api/tasks/${id}`);
    S.task = task;
    S.atBottom = true;
    S.openStep = "";
    S.workspace = null;
    S.workspacePreviewPath = "";
    S.workspacePreviewData = null;
    S.workspaceDiffPath = "";
    S.workspaceDiff = null;
    closeWorkspacePreview();
    $("#workspaceSearch").value = "";
    // 换任务时关掉上一个任务的产物预览，避免内容错位
    $("#fileView").hidden = true;
    $("#fileViewPath").textContent = "—";
    $("#fileViewCode").textContent = "";
    closeDrawers();
    renderAll();
    loadWorkspace();
  } catch (err) {
    toast(`加载任务失败：${err.message}`, "err");
  }
}

let syncingTask = false;
async function syncCurrentTask() {
  if (!S.task || syncingTask) return;
  syncingTask = true;
  const id = S.task.id;
  try {
    const { task } = await api(`/api/tasks/${id}`);
    if (!S.task || S.task.id !== id) return;
    S.task = task;
    renderAll();
    scheduleWorkspaceRefresh();
  } catch {
    /* SSE 重连后再试 */
  } finally {
    syncingTask = false;
  }
}

async function createTask(goal) {
  const text = String(goal || "").trim();
  if (text.length < 2) {
    toast("再具体一点，至少 2 个字", "err");
    return;
  }
  if (S.worktree && !S.dir) {
    toast("隔离工作树需要先选择一个 Git 项目目录", "err");
    return;
  }
  try {
    $("#heroStart").disabled = true;
    const body = { goal: text, flowMode: S.flowMode === "direct" ? "direct" : "debate" };
    if (S.dir) body.workspace = S.dir;
    if (S.dir && S.worktree) body.isolation = "worktree";
    const { task } = await api("/api/tasks", { method: "POST", body });
    S.task = task;
    S.workspace = null;
    S.workspacePreviewData = null;
    $("#workspaceSearch").value = "";
    if (!S.tasks.find((t) => t.id === task.id)) S.tasks.unshift({ ...task });
    $("#heroInput").value = "";
    $("#input").value = "";
    // 直接开工没有讨论可看，落到执行链路；先讨论则停在讨论页看提案
    switchTab(S.flowMode === "direct" ? "plan" : "debate");
    renderAll();
    loadWorkspace();
    toast(S.flowMode === "direct" ? "团队已按「直接开工」开工" : "团队已开工，先出方案再实施", "ok");
  } catch (err) {
    toast(`创建失败：${err.message}`, "err");
  } finally {
    $("#heroStart").disabled = false;
  }
}

async function sendMessage() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text) return;
  if (!S.task) {
    await createTask(text);
    return;
  }
  input.value = "";
  autosize(input);
  try {
    await api(`/api/tasks/${S.task.id}/chat`, { method: "POST", body: { text } });
  } catch (err) {
    toast(`发送失败：${err.message}`, "err");
  }
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
}

/* ---------------- 事件流 ---------------- */

function connect() {
  const es = new EventSource("/api/stream");
  es.onopen = () => {
    $("#connState").textContent = "已连接 · LIVE";
    $("#connDot").classList.add("on");
    // SSE 断线期间可能错过工序和产物事件，重连后补一次全量当前任务。
    if (S.task) syncCurrentTask();
  };
  es.onerror = () => {
    $("#connState").textContent = "重连中…";
    $("#connDot").classList.remove("on");
  };
  es.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(data);
  };
}

function handleEvent(ev) {
  const cur = S.task;

  // 停止后立刻重跑时，旧 run 的迟到事件不能覆盖新 run。
  if (ev.runId && cur && cur.id === ev.taskId && cur.runId && ev.runId !== cur.runId) return;

  switch (ev.type) {
    case "task.created": {
      if (!S.tasks.find((t) => t.id === ev.task.id)) S.tasks.unshift(ev.task);
      renderTasks();
      break;
    }
    case "task.updated":
    case "task.status":
    case "task.queue": {
      const summary = S.tasks.find((t) => t.id === ev.taskId);
      if (summary) Object.assign(summary, ev.patch);
      if (cur && cur.id === ev.taskId) {
        Object.assign(cur, ev.patch);
        renderTopbar();
        renderPlan();
        renderStats();
        renderFlow();
      }
      renderTasks();
      break;
    }
    case "providers.changed": {
      if (Array.isArray(ev.providers)) S.providers = ev.providers;
      renderProviders();
      renderProviderChoices($("#agentProvider")?.value || "local-default");
      renderAgents();
      break;
    }
    case "plan.updated": {
      if (cur && cur.id === ev.taskId) {
        cur.plan = ev.plan;
        cur.planVersion = ev.planVersion || cur.planVersion || 0;
        cur.planVersions = ev.planVersions || cur.planVersions || [];
        renderPlan();
        renderFlow();
        if (S.workspaceConsoleOpen) renderWorkspaceConsole();
        // 同步左侧历史条上的进度，否则永远停在 0/0
        const summary = S.tasks.find((t) => t.id === ev.taskId);
        if (summary) {
          summary.steps = ev.plan.length;
          summary.doneSteps = ev.plan.filter((s) => s.status === "done").length;
          renderTasks();
        }
      }
      break;
    }
    case "plan.replanned": {
      syncCurrentTask();
      break;
    }
    case "debate.updated": {
      if (cur && cur.id === ev.taskId) {
        cur.debate = ev.debate;
        renderDebate();
        renderPlan();
        renderFlow();
      }
      break;
    }
    case "settings.changed": {
      S.settings = ev.settings || {};
      renderFlowModeControls();
      break;
    }
    case "message.start": {
      if (cur && cur.id === ev.taskId) {
        const prevStage = lastStageOf(cur.messages);
        cur.messages.push(ev.message);
        if (cur.messages.length === 1) {
          renderMessages();
        } else {
          const st = stageOfMessage(ev.message);
          const sep = st && st !== prevStage ? flowSepHtml(st) : "";
          $("#timeline").insertAdjacentHTML("beforeend", sep + messageHtml(ev.message));
          scrollToBottom();
        }
        renderFlow();
      }
      break;
    }
    case "message.delta": {
      if (!cur || cur.id !== ev.taskId) break;
      const msg = cur.messages.find((m) => m.id === ev.id);
      if (!msg) break;
      msg.text += ev.delta;
      if (!S.pending.has(ev.id)) {
        S.pending.set(ev.id, true);
        requestAnimationFrame(() => {
          S.pending.delete(ev.id);
          patchMessage(msg);
          scrollToBottom();
        });
      }
      break;
    }
    case "message.replace": {
      if (!cur || cur.id !== ev.taskId) break;
      const msg = cur.messages.find((m) => m.id === ev.id);
      if (msg) {
        msg.text = ev.text;
        patchMessage(msg);
      }
      break;
    }
    case "message.end": {
      if (!cur || cur.id !== ev.taskId) break;
      const msg = cur.messages.find((m) => m.id === ev.id);
      if (msg) {
        msg.done = true;
        msg.meta = ev.meta;
        patchMessage(msg);
        renderStats();
        renderFlow();
      }
      break;
    }
    case "artifact.added": {
      if (cur && cur.id === ev.taskId) {
        const existing = cur.artifacts.find((f) => f.path === ev.file.path);
        if (existing) Object.assign(existing, ev.file);
        else cur.artifacts.push(ev.file);
        renderFiles();
        renderStats();
        scheduleWorkspaceRefresh();
        const summary = S.tasks.find((t) => t.id === ev.taskId);
        if (summary) {
          summary.files = cur.artifacts.length;
          renderTasks();
        }
      }
      break;
    }
    case "artifact.removed": {
      if (cur && cur.id === ev.taskId) {
        const artifact = cur.artifacts.find((f) => f.path === ev.file.path);
        if (artifact) Object.assign(artifact, ev.file);
        renderFiles();
        renderStats();
        scheduleWorkspaceRefresh();
      }
      break;
    }
    case "file.changed": {
      if (cur && cur.id === ev.taskId) {
        if (!cur.fileChanges) cur.fileChanges = [];
        const existing = cur.fileChanges.find((item) => item.path === ev.change.path);
        if (existing) Object.assign(existing, ev.change);
        else cur.fileChanges.push(ev.change);
        if (S.workspace) {
          if (!S.workspace.changes) S.workspace.changes = [];
          const workspaceChange = S.workspace.changes.find((item) => item.path === ev.change.path);
          if (workspaceChange) Object.assign(workspaceChange, ev.change);
          else S.workspace.changes.push(ev.change);
        }
        scheduleWorkspaceRefresh();
      }
      break;
    }
    case "task.event": {
      if (cur && cur.id === ev.taskId) {
        if (!cur.events) cur.events = [];
        cur.events.push(ev.event);
        if (cur.events.length > 160) cur.events.splice(0, cur.events.length - 160);
        if (S.workspace) {
          if (!S.workspace.events) S.workspace.events = [];
          S.workspace.events.push(ev.event);
          if (S.workspace.events.length > 160) {
            S.workspace.events.splice(0, S.workspace.events.length - 160);
          }
          renderWorkspace();
        }
        scheduleWorkspaceRefresh();
      }
      break;
    }
    case "agent.status": {
      const agent = S.agents.find((a) => a.id === ev.agentId);
      if (agent) {
        agent.status = ev.status;
        agent.activity = ev.activity;
        renderAgents();
      }
      break;
    }
    case "agents.changed": {
      refreshAgents();
      break;
    }
    case "team.updated": {
      refreshAgents();
      if (ev.seats?.length) {
        const names = [...new Set(ev.seats.map((s) => s.name))];
        toast(`执行席位已换成真实 CLI：${names.join("、")}`, "ok");
      }
      break;
    }
    case "task.deleted": {
      S.tasks = S.tasks.filter((t) => t.id !== ev.taskId);
      if (cur && cur.id === ev.taskId) {
        S.task = null;
        S.openStep = "";
        renderAll();
      }
      renderTasks();
      renderFlow();
      break;
    }
    default:
      break;
  }
}

async function refreshAgents() {
  try {
    const data = await api("/api/agents");
    S.agents = normalizeAgentSeats(data.agents);
    S.providers = data.providers || S.providers;
    S.toolCatalog = data.toolCatalog || S.toolCatalog;
    S.roleTools = data.roleTools || S.roleTools;
    S.executionPolicies = data.executionPolicies || S.executionPolicies;
    renderAgents();
    renderPlan();
    renderProviders();
  } catch {
    /* ignore */
  }
}

/* ---------------- 探测本机 CLI ---------------- */

async function probeClis() {
  const wrap = $("#probeList");
  $("#probeState").textContent = "扫描中";
  wrap.innerHTML = '<p class="hint">正在探测命令行工具…</p>';
  try {
    const { candidates } = await api("/api/probe");
    S.probe = candidates;
    const found = candidates.filter((c) => c.found);
    $("#probeState").textContent = found.length ? `${found.length} 可用` : "无";
    wrap.innerHTML = candidates
      .map((c) => {
        const tip = c.found ? `${c.path}\n${c.version}` : `未在 PATH / npm 全局目录中找到 ${c.command}`;
        const action = c.found
          ? `<button data-attach="${escapeHtml(c.command)}">接入</button>`
          : `<button data-manual="${escapeHtml(c.command)}">手动</button>`;
        return `<div class="probe-item ${c.found ? "found" : ""}" title="${escapeHtml(tip)}">
          <span class="p-name">${escapeHtml(c.command)}</span>
          ${action}
          <span class="p-state">${c.found ? "READY" : "N/A"}</span>
        </div>`;
      })
      .join("");
  } catch (err) {
    $("#probeState").textContent = "失败";
    wrap.innerHTML = `<p class="hint">探测失败：${escapeHtml(err.message)}</p>`;
  }
}

/* 一次接管所有已安装、但还没进团队的 CLI（后端按命令名去重，可重复点） */
async function adoptAll() {
  const btn = $("#adoptBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "接管中…";
  try {
    const { created, skipped } = await api("/api/agents/adopt", { method: "POST", body: {} });
    await refreshAgents();
    if (created.length) {
      const reserve = created.filter((c) => c.reserve).length;
      toast(`已接入 ${created.length} 个 CLI${reserve ? `，${reserve} 个进入工具池` : ""}`, "ok");
    } else {
      const dup = skipped.filter((s) => s.reason === "已在团队中").length;
      toast(dup ? "装了的 CLI 都已在团队里" : "没有发现可接管的新 CLI", "");
    }
    await probeClis();
  } catch (err) {
    toast(`接管失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function smartRebalance() {
  const btn = $("#rebalanceBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "分派中…";
  try {
    const { assignments } = await api("/api/agents/rebalance", { method: "POST", body: {} });
    await refreshAgents();
    if (assignments.length) {
      toast(
        `已分派 ${assignments.length} 个席位：${assignments
          .map((a) => `${ROLE_META[a.role]?.short || a.role} ${a.name}`)
          .join(" · ")}`,
        "ok",
      );
    } else {
      toast("还没有可分工的 CLI，请先扫描并接入", "");
    }
  } catch (err) {
    toast(`分工失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function attachCli(command) {
  const candidate = S.probe.find((c) => c.command === command);
  if (!candidate) return;

  // 重复点击会造出一堆一样的成员，这里直接拦住
  const target = candidate.path || candidate.command;
  const exists = S.agents.find(
    (a) => a.mode === "cli" && (a.cli?.command === target || a.cli?.command === candidate.command),
  );
  if (exists) {
    toast(`${candidate.label} 已经在团队里了（${exists.name}）`, "");
    return;
  }

  try {
    await api("/api/agents", {
      method: "POST",
      body: {
        name: candidate.label.replace(/\s*CLI$/, ""),
        role: "coder",
        title: "真实 CLI",
        color: "#ff5538",
        tagline: "调用本机命令行",
        mode: "cli",
        // 用探测到的绝对路径，避免只装在 npm 全局目录、不在 PATH 时跑不起来
        cli: { command: candidate.path || candidate.command, args: candidate.args },
      },
    });
    toast(`${candidate.label} 已加入团队`, "ok");
    await refreshAgents();
  } catch (err) {
    toast(`接入失败：${err.message}`, "err");
  }
}

/* 未安装的条目也能手动接：填绝对路径或自定义命令 */
function manualCli(command) {
  const candidate = S.probe.find((c) => c.command === command);
  openAgentModal(null, {
    name: candidate?.label?.replace(/\s*CLI$/, "") || command,
    command,
    args: (candidate?.args || []).join(" ") || "run {{prompt}}",
  });
  toast(`填写 ${command} 的实际路径，或改成任意可执行命令`, "");
}

/* ---------------- 工作目录 ---------------- */

const DIR_KEY = "agentforge:dir";
let dirBrowse = "";
let dirParent = null;

function shortPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : p;
}

function setDir(p) {
  S.dir = p || "";
  try {
    if (S.dir) localStorage.setItem(DIR_KEY, S.dir);
    else localStorage.removeItem(DIR_KEY);
  } catch {
    /* ignore */
  }
  renderDirPick();
}

function renderDirPick() {
  const btn = $("#dirPick");
  const label = $("#dirLabel");
  if (!btn || !label) return;
  label.textContent = S.dir ? shortPath(S.dir) : "自动新建工作区";
  btn.classList.toggle("on", !!S.dir);
  btn.title = S.dir || "选一个已有的项目文件夹，让所有 CLI 在里面干活";
}

async function loadDir(p) {
  const list = $("#dirList");
  list.innerHTML = '<p class="hint">读取中…</p>';
  try {
    const q = p ? `?path=${encodeURIComponent(p)}` : "";
    const data = await api(`/api/fs${q}`);
    dirBrowse = data.path || "";
    dirParent = data.parent || null;
    $("#dirPath").textContent = data.path || "我的电脑";
    $("#dirUp").disabled = !dirParent;
    list.innerHTML = data.dirs.length
      ? data.dirs
          .map(
            (d) =>
              `<button type="button" class="dir-item" data-dir="${escapeHtml(d.path)}"><span>📁 ${escapeHtml(d.name)}</span></button>`,
          )
          .join("")
      : '<p class="hint">这个目录下没有子文件夹</p>';
  } catch (err) {
    list.innerHTML = `<p class="hint">读取失败：${escapeHtml(err.message)}</p>`;
  }
}

function openDirModal() {
  $("#dirModal").showModal();
  $("#dirWorktree").checked = !!S.worktree;
  loadDir(S.dir || "");
}

/* ---------------- 日夜切换 ---------------- */

function applyShift(night) {
  $("#page").classList.toggle("night", night);
  $("#shiftBtn").setAttribute("aria-pressed", String(night));
  $("#shiftLabel").textContent = night ? "NIGHT" : "DAY";
  $(".shift-icon").textContent = night ? "☀" : "☾";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", night ? "#081c27" : "#fff4d6");
  try {
    localStorage.setItem("agentforge:night", night ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const ROLE_TITLE = {
  planner: "规划师",
  architect: "架构师",
  coder: "实现工程师",
  tester: "测试工程师",
  reviewer: "代码评审",
};

function providerName(id) {
  return S.providers.find((provider) => provider.id === id)?.name || "本机 CLI";
}

let editingProviderId = null;

function renderProviders() {
  const list = $("#providerList");
  if (!list) return;
  list.innerHTML = S.providers.length
    ? S.providers
        .map(
          (provider) => `<div class="provider-row">
            <div class="provider-row-main">
              <b>${escapeHtml(provider.name)}</b>
              <span>${escapeHtml(provider.id)} · ${escapeHtml(provider.kind)} · 并发 ${provider.maxConcurrency}${provider.model ? ` · ${escapeHtml(provider.model)}` : ""}${Object.keys(provider.cliBindings || {}).length ? ` · ${Object.keys(provider.cliBindings).length} 个 CLI 模板` : ""}${(provider.capabilities || []).length ? ` · ${escapeHtml(provider.capabilities.join("/"))}` : ""}</span>
            </div>
            <span class="provider-row-state">${provider.enabled === false ? "OFF" : "ON"}</span>
            <button type="button" class="link-btn" data-provider-edit="${escapeHtml(provider.id)}">编辑</button>
            ${
              provider.builtin
                ? ""
                : `<button type="button" class="link-btn" data-provider-delete="${escapeHtml(provider.id)}">删除</button>`
            }
          </div>`,
        )
        .join("")
    : '<p class="hint">还没有 Provider Profile。</p>';
}

function fillProviderForm(provider = null) {
  const form = $("#providerForm");
  if (!form) return;
  editingProviderId = provider?.id || null;
  const f = (name) => form.elements.namedItem(name);
  f("id").value = provider?.id || "";
  f("id").disabled = !!provider?.builtin;
  f("name").value = provider?.name || "";
  f("kind").value = provider?.kind || "cli-native";
  f("baseUrl").value = provider?.baseUrl || "";
  f("model").value = provider?.model || "";
  f("apiKeyRef").value = provider?.apiKeyRef || "";
  f("capabilities").value = (provider?.capabilities || []).join(", ");
  f("cliBindings").value = provider && Object.keys(provider.cliBindings || {}).length
    ? JSON.stringify(provider.cliBindings, null, 2)
    : "";
  f("maxConcurrency").value = provider?.maxConcurrency || 2;
  f("enabled").checked = provider?.enabled !== false;
  $("#providerFormHint").textContent = provider ? `正在编辑 ${provider.name}` : "新 Profile";
}

function openProviderModal(provider = null) {
  renderProviders();
  fillProviderForm(provider);
  $("#providerModal").showModal();
}

async function saveProvider() {
  const form = $("#providerForm");
  const fd = new FormData(form);
  let cliBindings = {};
  const bindingsText = String(fd.get("cliBindings") || "").trim();
  if (bindingsText) {
    try {
      cliBindings = JSON.parse(bindingsText);
      if (!cliBindings || typeof cliBindings !== "object" || Array.isArray(cliBindings)) {
        throw new Error("必须是 JSON 对象");
      }
    } catch (err) {
      toast(`CLI 参数模板无效：${err.message}`, "err");
      return;
    }
  }
  const payload = {
    id: String(fd.get("id") || "").trim(),
    name: String(fd.get("name") || "").trim(),
    kind: String(fd.get("kind") || "cli-native"),
    baseUrl: String(fd.get("baseUrl") || "").trim(),
    model: String(fd.get("model") || "").trim(),
    apiKeyRef: String(fd.get("apiKeyRef") || "").trim(),
    capabilities: String(fd.get("capabilities") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    cliBindings,
    maxConcurrency: Number(fd.get("maxConcurrency")) || 2,
    enabled: fd.get("enabled") === "on",
  };
  if (!payload.name) {
    toast("Provider 需要一个名称", "err");
    return;
  }
  try {
    const path = editingProviderId ? `/api/providers/${editingProviderId}` : "/api/providers";
    const result = await api(path, { method: editingProviderId ? "PATCH" : "POST", body: payload });
    const index = S.providers.findIndex((item) => item.id === result.provider.id);
    if (index >= 0) S.providers[index] = result.provider;
    else S.providers.push(result.provider);
    renderProviders();
    renderProviderChoices(result.provider.id);
    fillProviderForm(result.provider);
    toast("Provider Profile 已保存", "ok");
  } catch (err) {
    toast(`保存失败：${err.message}`, "err");
  }
}

async function deleteProvider(id) {
  if (!window.confirm("删除这个 Provider？绑定它的 Agent 会回到默认 Provider。")) return;
  try {
    await api(`/api/providers/${id}`, { method: "DELETE" });
    S.providers = S.providers.filter((provider) => provider.id !== id);
    for (const agent of S.agents) {
      if (agent.providerId === id) agent.providerId = "local-default";
    }
    renderProviders();
    renderProviderChoices("local-default");
    fillProviderForm();
    renderAgents();
    toast("Provider 已删除", "ok");
  } catch (err) {
    toast(`删除失败：${err.message}`, "err");
  }
}

function renderProviderChoices(selected = "local-default") {
  const select = $("#agentProvider");
  if (!select) return;
  const current = selected || "local-default";
  select.innerHTML = S.providers
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}" ${provider.id === current ? "selected" : ""}>${escapeHtml(
          provider.name,
        )}${provider.enabled === false ? " · 停用" : ""}</option>`,
    )
    .join("");
}

let editingId = null;

function renderAgentToolChoices(selected, role) {
  const wrap = $("#agentTools");
  if (!wrap) return;
  if (!S.toolCatalog.length) {
    wrap.innerHTML = '<p class="hint">工具目录尚未加载。</p>';
    return;
  }
  const chosen = new Set(Array.isArray(selected) ? selected : S.roleTools?.[role] || []);
  wrap.innerHTML = S.toolCatalog
    .map(
      (tool) => `<label class="tool-option">
        <input type="checkbox" name="tools" value="${escapeHtml(tool.id)}" ${
          chosen.has(tool.id) ? "checked" : ""
        } />
        <span><b>${escapeHtml(tool.label)}</b><em>${escapeHtml(tool.id)}</em></span>
      </label>`,
    )
    .join("");
}

function renderAgentPolicyPreview() {
  const form = $("#agentForm");
  const node = $("#agentPolicyPreview");
  if (!form || !node) return;
  const seq = ++S.agentPolicyPreviewSeq;
  clearTimeout(S.agentPolicyPreviewTimer);
  S.agentPolicyPreviewTimer = setTimeout(async () => {
    const tools = new FormData(form).getAll("tools").map(String);
    const policy = String(form.elements.namedItem("executionPolicy")?.value || "inherit");
    const command = String(form.elements.namedItem("command")?.value || "").trim();
    const query = new URLSearchParams({
      policy,
      command,
      tools: tools.join(","),
    });
    node.dataset.status = "checking";
    node.textContent = "正在检查 CLI 强制能力…";
    try {
      const result = await api(`/api/cli-policy?${query.toString()}`);
      if (seq !== S.agentPolicyPreviewSeq) return;
      const preview = result.policy || {};
      if (preview.status === "enforced") {
        node.dataset.status = "enforced";
        node.textContent = `${preview.adapter} · ${preview.sandbox} · ${preview.boundary}`;
      } else if (preview.status === "unsupported") {
        node.dataset.status = "blocked";
        node.textContent = `启动会被拒绝：${preview.reason}`;
      } else {
        node.dataset.status = "inherit";
        node.textContent = "沿用 CLI 自身参数，平台不强制真实子进程边界。";
      }
    } catch (err) {
      if (seq !== S.agentPolicyPreviewSeq) return;
      node.dataset.status = "blocked";
      node.textContent = `策略预检失败：${err.message}`;
    }
  }, 180);
}

/**
 * @param {object|null} agent 传对象即编辑模式
 * @param {object|null} preset 新建时预填（用于未安装 CLI 的「手动接入」）
 */
function openAgentModal(agent = null, preset = null) {
  editingId = agent?.id || null;
  const form = $("#agentForm");
  form.reset();
  const f = (n) => form.elements.namedItem(n);

  if (agent) {
    f("name").value = agent.name;
    f("role").value = agent.role;
    f("color").value = /^#[0-9a-f]{6}$/i.test(agent.color || "") ? agent.color : "#ff5538";
    f("mode").value = agent.mode === "cli" ? "cli" : "sim";
    f("command").value = agent.cli?.command || "";
    f("args").value = (agent.cli?.args || []).join(" ");
    f("executionPolicy").value = agent.executionPolicy === "strict" ? "strict" : "inherit";
    f("providerId").value = agent.providerId || "local-default";
    f("fallbackProviderIds").value = (agent.fallbackProviderIds || []).join(", ");
    f("seat").checked = agent.seat !== false;
  } else if (preset) {
    f("name").value = preset.name || "";
    f("mode").value = "cli";
    f("command").value = preset.command || "";
    f("args").value = preset.args || "run {{prompt}}";
    f("executionPolicy").value = "inherit";
    f("providerId").value = "local-default";
    f("fallbackProviderIds").value = "";
    f("seat").checked = false;
  }

  renderProviderChoices(agent?.providerId || "local-default");
  $("#agentModalTitle").textContent = agent ? `编辑 · ${agent.name}` : "接入新的智能体";
  $("#agentSubmit").textContent = agent ? "保存修改" : "加入团队";
  $("#agentDelete").hidden = !agent;
  renderAgentToolChoices(agent?.tools, f("role").value);
  renderAgentPolicyPreview();
  syncAgentMode();
  $("#agentModal").showModal();
  if (!agent) setTimeout(() => f("name").focus(), 40);
}

function syncAgentMode() {
  $("#cliFields").hidden = $("#modeSelect").value !== "cli";
}

/* ---------------- 桌面模式下退出应用 ---------------- */

function bindQuit() {
  const isApp = new URLSearchParams(location.search).has("app");
  const btn = $("#quitBtn");
  if (!isApp || !btn) return;
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    if (!window.confirm("退出 AGENTFORGE？")) return;
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch {
      /* 服务已经在退出的路上 */
    }
  });
}

/* ---------------- 抽屉 / 弹窗 ---------------- */

function openRail() {
  $("#rail").classList.add("open");
  $("#mask").classList.add("on");
}

function openInspector() {
  $("#inspector").classList.add("open");
  $("#mask").classList.add("on");
}

function closeDrawers() {
  $("#rail").classList.remove("open");
  $("#inspector").classList.remove("open");
  $("#mask").classList.remove("on");
}

function switchTab(tab) {
  S.tab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#pane-plan").hidden = tab !== "plan";
  $("#pane-context").hidden = tab !== "context";
  $("#pane-debate").hidden = tab !== "debate";
  $("#pane-workspace").hidden = tab !== "workspace";
  $("#pane-files").hidden = tab !== "files";
  $("#pane-stats").hidden = tab !== "stats";
  if (tab === "workspace" && S.task && !S.workspace) loadWorkspace();
}

/* ---------------- 绑定 ---------------- */

function bind() {
  /* 新建任务 */
  $("#newTaskBtn").addEventListener("click", () => {
    S.task = null;
    S.openStep = "";
    renderAll();
    $("#heroInput").focus();
    closeDrawers();
  });

  $("#heroStart").addEventListener("click", () => createTask($("#heroInput").value));
  $("#heroInput").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") createTask(e.target.value);
  });

  $("#suggestions").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    $("#heroInput").value = chip.textContent.trim();
    createTask(chip.textContent.trim());
  });

  /* 发送 */
  $("#sendBtn").addEventListener("click", sendMessage);
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $("#input").addEventListener("input", (e) => autosize(e.target));

  /* 提及 */
  $("#mentionList").addEventListener("click", (e) => {
    const btn = e.target.closest(".mention");
    if (!btn) return;
    const input = $("#input");
    input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}@${btn.dataset.mention} `;
    input.focus();
    autosize(input);
  });

  /* 团队 */
  $("#agentList").addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      e.stopPropagation();
      const target = S.agents.find((a) => a.id === editBtn.dataset.edit);
      if (target) openAgentModal(target);
      return;
    }
    const row = e.target.closest(".agent-row");
    if (!row) return;
    const agent = S.agents.find((a) => a.id === row.dataset.agent);
    if (!agent) return;
    const input = $("#input");
    input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}@${agent.name} `;
    input.focus();
    closeDrawers();
  });

  $("#addAgentBtn").addEventListener("click", () => openAgentModal(null));

  $("#modeSelect").addEventListener("change", syncAgentMode);
  $("#agentForm").elements.role.addEventListener("change", (e) => {
    renderAgentToolChoices(null, e.target.value);
    renderAgentPolicyPreview();
  });
  $("#agentToolsDefault").addEventListener("click", () => {
    renderAgentToolChoices(null, $("#agentForm").elements.role.value);
    renderAgentPolicyPreview();
  });
  $("#agentForm").elements.executionPolicy.addEventListener("change", renderAgentPolicyPreview);
  $("#agentForm").elements.command.addEventListener("input", renderAgentPolicyPreview);
  $("#agentTools").addEventListener("change", renderAgentPolicyPreview);

  // 关闭按钮必须是 type=button：否则会触发原生表单校验，
  // required 未填时 submit 事件根本不发生，method=dialog 也关不掉弹窗
  $$("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => $("#agentModal").close());
  });

  // 点遮罩（dialog 自身）也能关
  $("#agentModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  $("#agentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const mode = String(fd.get("mode") || "sim");
    const command = String(fd.get("command") || "").trim();
    if (mode === "cli" && !command) {
      toast("真实 CLI 模式需要填写命令", "err");
      return;
    }
    const argsStr = String(fd.get("args") || "").trim();
    const role = String(fd.get("role"));
    const payload = {
      name: String(fd.get("name") || "").trim(),
      role,
      color: String(fd.get("color") || "#ff5538"),
      title: ROLE_TITLE[role] || "自定义智能体",
      mode,
      executionPolicy: String(fd.get("executionPolicy") || "inherit"),
      providerId: String(fd.get("providerId") || "local-default"),
      fallbackProviderIds: String(fd.get("fallbackProviderIds") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      seat: fd.get("seat") === "on",
      tools: fd.getAll("tools").map(String),
      cli: { command, args: argsStr ? argsStr.split(/\s+/) : [] },
    };
    try {
      if (editingId) {
        await api(`/api/agents/${editingId}`, { method: "PATCH", body: payload });
      } else {
        await api("/api/agents", { method: "POST", body: payload });
      }
      $("#agentModal").close();
      e.target.reset();
      syncAgentMode();
      toast(editingId ? "配置已更新" : "已加入团队", "ok");
      editingId = null;
      await refreshAgents();
    } catch (err) {
      toast(`失败：${err.message}`, "err");
    }
  });

  $("#agentDelete").addEventListener("click", async () => {
    if (!editingId) return;
    const target = S.agents.find((a) => a.id === editingId);
    if (!window.confirm(`把「${target?.name || "该成员"}」移出团队？`)) return;
    try {
      await api(`/api/agents/${editingId}`, { method: "DELETE" });
      $("#agentModal").close();
      toast("已移出团队", "ok");
    } catch (err) {
      toast(`失败：${err.message}`, "err");
    }
    editingId = null;
    await refreshAgents();
  });

  /* 任务列表 */
  $("#taskList").addEventListener("click", (e) => {
    const item = e.target.closest(".task-item");
    if (item) selectTask(item.dataset.task);
  });

  /* 运行 / 停止 */
  $("#runBtn").addEventListener("click", async () => {
    if (!S.task) return;
    try {
      await api(`/api/tasks/${S.task.id}/run`, {
        method: "POST",
        body: { flowMode: S.flowMode === "direct" ? "direct" : "debate" },
      });
      toast(S.flowMode === "direct" ? "已按「直接开工」重新编排" : "已按「先讨论后实施」重新编排", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#stopBtn").addEventListener("click", async () => {
    if (!S.task) return;
    try {
      await api(`/api/tasks/${S.task.id}/stop`, { method: "POST", body: {} });
      toast("已停止", "");
    } catch (err) {
      toast(err.message, "err");
    }
  });

  /* 工作流主线：阶段跳转 / 工序展开 / 开工方式 / 参数设置 */
  $("#flowTrack").addEventListener("click", (e) => {
    const node = e.target.closest(".flow-node");
    if (node) jumpToStage(node.dataset.stage);
  });
  $("#planList").addEventListener("click", (e) => {
    const file = e.target.closest("[data-step-file]");
    if (file) {
      previewWorkspaceFile(file.dataset.stepFile);
      return;
    }
    const stepEl = e.target.closest(".step[data-step]");
    if (stepEl) {
      S.openStep = S.openStep === stepEl.dataset.step ? "" : stepEl.dataset.step;
      renderPlan();
    }
  });
  $("#heroMode").addEventListener("click", (e) => {
    const btn = e.target.closest(".fm");
    if (btn) setFlowMode(btn.dataset.mode);
  });
  $("#composerMode").addEventListener("click", (e) => {
    const btn = e.target.closest(".fm");
    if (btn) setFlowMode(btn.dataset.mode);
  });
  $("#flowSettingsBtn").addEventListener("click", openFlowSettings);
  $("#flowSave").addEventListener("click", saveFlowSettings);
  $("#flowModalClose").addEventListener("click", () => $("#flowModal").close());
  $("#flowModalCancel").addEventListener("click", () => $("#flowModal").close());
  $("#flowModal").addEventListener("click", (e) => {
    const preset = e.target.closest("[data-preset]");
    if (!preset) return;
    fillFlowForm(FLOW_PRESETS[preset.dataset.preset] || FLOW_PRESETS.balanced);
    $$("#flowModal [data-preset]").forEach((b) => b.classList.toggle("active", b === preset));
    $("#flowSaveHint").textContent = "已套用预设，点保存后生效";
  });
  $("#providerBtn").addEventListener("click", () => openProviderModal());
  $("#providerModalClose").addEventListener("click", () => $("#providerModal").close());
  $("#providerCancel").addEventListener("click", () => fillProviderForm());
  $("#providerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveProvider();
  });
  $("#providerList").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-provider-edit]");
    if (edit) {
      const provider = S.providers.find((item) => item.id === edit.dataset.providerEdit);
      if (provider) fillProviderForm(provider);
      return;
    }
    const remove = e.target.closest("[data-provider-delete]");
    if (remove) deleteProvider(remove.dataset.providerDelete);
  });
  $("#providerModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });

  /* 面板 */
  $("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) switchTab(tab.dataset.tab);
  });

  $("#fileList").addEventListener("click", (e) => {
    const item = e.target.closest(".file-item");
    if (item) previewWorkspaceFile(item.dataset.file);
  });
  $("#fileClose").addEventListener("click", () => {
    $("#fileView").hidden = true;
  });
  $("#workspaceRefresh").addEventListener("click", () => loadWorkspace({ force: true }));
  $("#workspaceSearchBtn").addEventListener("click", searchWorkspaceFiles);
  $("#workspaceNewFile").addEventListener("click", createWorkspaceFile);
  $("#workspaceSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchWorkspaceFiles();
    if (e.key === "Escape") {
      e.target.value = "";
      if (S.workspace) S.workspace.search = null;
      renderWorkspaceSearch();
    }
  });
  $("#workspaceTree").addEventListener("click", (e) => {
    const file = e.target.closest("[data-workspace-file]");
    if (!file) return;
    previewWorkspaceFile(decodeURIComponent(file.dataset.workspaceFile));
  });
  $("#workspaceSearchResults").addEventListener("click", (e) => {
    const file = e.target.closest("[data-workspace-file]");
    if (!file) return;
    previewWorkspaceFile(decodeURIComponent(file.dataset.workspaceFile));
  });
  $("#workspaceChanges").addEventListener("click", (e) => {
    const file = e.target.closest("[data-workspace-file]");
    if (!file) return;
    previewWorkspaceFile(decodeURIComponent(file.dataset.workspaceFile));
  });
  $("#workspaceFileClose").addEventListener("click", closeWorkspacePreview);
  $("#workspaceFileEdit").addEventListener("click", editWorkspaceFile);
  $("#workspaceFileSave").addEventListener("click", saveWorkspaceFile);
  $("#workspaceFileDelete").addEventListener("click", deleteWorkspaceFile);

  /* 全屏工作区控制台 */
  $("#workspaceExpand").addEventListener("click", openWorkspaceConsole);
  $("#wcClose").addEventListener("click", closeWorkspaceConsole);
  $("#wcRefresh").addEventListener("click", async () => {
    await syncCurrentTask();
    await loadWorkspace({ force: true });
  });
  $("#wcSearchBtn").addEventListener("click", () => searchWorkspaceFrom("#wcSearch"));
  $("#wcSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchWorkspaceFrom("#wcSearch");
    if (e.key === "Escape") {
      e.target.value = "";
      if (S.workspace) S.workspace.search = null;
      renderWorkspaceSearch();
      renderWorkspaceConsole();
    }
  });
  $("#wcViewTabs").addEventListener("click", (e) => {
    const button = e.target.closest("[data-wc-view]");
    if (button) setWorkspaceConsoleView(button.dataset.wcView);
  });
  $("#wcTree").addEventListener("click", (e) => {
    const file = e.target.closest("[data-workspace-file]");
    if (file) previewWorkspaceFile(decodeURIComponent(file.dataset.workspaceFile));
  });
  $("#wcSearchResults").addEventListener("click", (e) => {
    const file = e.target.closest("[data-workspace-file]");
    if (file) previewWorkspaceFile(decodeURIComponent(file.dataset.workspaceFile));
  });
  $("#wcChanges").addEventListener("click", (e) => {
    const file = e.target.closest("[data-workspace-file]");
    if (!file) return;
    S.workspaceDiffPath = decodeURIComponent(file.dataset.workspaceFile);
    previewWorkspaceFile(S.workspaceDiffPath);
  });
  $("#wcEdit").addEventListener("click", editWorkspaceFile);
  $("#wcSave").addEventListener("click", saveWorkspaceFile);
  $("#wcDelete").addEventListener("click", deleteWorkspaceFile);
  $("#wcDiffRefresh").addEventListener("click", loadWorkspaceConsoleDiff);
  $("#wcReplan").addEventListener("click", replanWorkspaceTask);

  $("#copyHook").addEventListener("click", async () => {
    const url = `${location.origin}/api/hooks/${S.settings.hookToken || ""}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("地址已复制", "ok");
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  });

  $("#showCurl").addEventListener("click", () => {
    const url = `${location.origin}/api/hooks/${S.settings.hookToken || ""}`;
    const box = $("#curlBox");
    box.textContent = `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"goal":"做一个并发安全的待办 API"}'`;
    box.hidden = !box.hidden;
  });

  /* 探测 */
  $("#probeBtn").addEventListener("click", probeClis);
  $("#adoptBtn").addEventListener("click", adoptAll);
  $("#rebalanceBtn").addEventListener("click", smartRebalance);
  $("#realTeamBtn").addEventListener("click", refreshRealTeam);

  /* 工作目录 */
  $("#dirPick").addEventListener("click", openDirModal);
  $("#dirWorktree").addEventListener("change", (e) => {
    S.worktree = !!e.target.checked;
  });
  $("#dirUp").addEventListener("click", () => {
    if (dirParent) loadDir(dirParent);
  });
  $("#dirList").addEventListener("click", (e) => {
    const item = e.target.closest("[data-dir]");
    if (item) loadDir(item.dataset.dir);
  });
  $("#dirConfirm").addEventListener("click", () => {
    if (!dirBrowse) {
      toast("先进入一个具体目录", "err");
      return;
    }
    setDir(dirBrowse);
    $("#dirModal").close();
    toast(`工作目录：${dirBrowse}`, "ok");
  });
  $("#dirReset").addEventListener("click", () => {
    setDir("");
    S.worktree = false;
    $("#dirWorktree").checked = false;
    $("#dirModal").close();
    toast("改为自动新建工作区", "");
  });
  $$("[data-close-dir]").forEach((b) => b.addEventListener("click", () => $("#dirModal").close()));
  $("#probeList").addEventListener("click", (e) => {
    const attach = e.target.closest("[data-attach]");
    if (attach) return attachCli(attach.dataset.attach);
    const manual = e.target.closest("[data-manual]");
    if (manual) manualCli(manual.dataset.manual);
  });

  /* 抽屉 */
  $("#railToggle").addEventListener("click", openRail);
  $("#inspectorToggle").addEventListener("click", openInspector);
  $("#inspectorClose").addEventListener("click", closeDrawers);
  $("#mask").addEventListener("click", closeDrawers);

  /* 日夜 */
  $("#shiftBtn").addEventListener("click", () => {
    applyShift(!$("#page").classList.contains("night"));
  });

  /* 滚动跟随 */
  $("#scroll").addEventListener("scroll", (e) => {
    const el = e.target;
    S.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  });

  /* 快捷键 */
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (S.workspaceConsoleOpen) closeWorkspaceConsole();
      closeDrawers();
    }
    if (e.key === "/" && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") {
      e.preventDefault();
      $("#input").focus();
    }
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  bind();
  bindQuit();

  try {
    S.dir = localStorage.getItem(DIR_KEY) || "";
  } catch {
    /* ignore */
  }
  try {
    const savedMode = localStorage.getItem(FLOW_MODE_KEY);
    if (savedMode === "direct" || savedMode === "debate") S.flowMode = savedMode;
  } catch {
    /* ignore */
  }
  renderDirPick();

  let night = false;
  try {
    night = localStorage.getItem("agentforge:night") === "1";
  } catch {
    /* ignore */
  }
  applyShift(night);

  try {
    const state = await api("/api/state");
    S.agents = normalizeAgentSeats(state.agents);
    S.providers = state.providers || [];
    S.toolCatalog = state.toolCatalog || [];
    S.roleTools = state.roleTools || {};
    S.executionPolicies = state.executionPolicies || [];
    S.tasks = state.tasks;
    S.settings = state.settings || {};
    S.scheduler = state.scheduler || null;
    if (state.activeTask) S.task = state.activeTask;
    S.openStep = "";
    renderFlowModeControls();
    renderAll();
    renderStats();
    if (S.task) loadWorkspace();
    connect();
    // 默认落在执行链路；支持 #debate / #settings 这类深链直接打开对应面板
    const hashTab = location.hash.replace("#", "");
    if (hashTab === "settings") openFlowSettings();
    else switchTab(["context", "debate", "plan", "workspace", "files", "stats"].includes(hashTab) ? hashTab : S.tab);
  } catch (err) {
    $("#connState").textContent = "服务未启动";
    toast(`无法连接后端：${err.message}`, "err");
  }
}

boot();
