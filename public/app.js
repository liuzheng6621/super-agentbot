/* =========================================================
   AGENTFORGE · 前端逻辑
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  agents: [],
  tasks: [],
  task: null,
  settings: {},
  probe: [],
  dir: "",
  flowMode: "debate",
  tab: "plan",
  atBottom: true,
  pending: new Map(),
  openStep: "",
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

function agentRowHtml(a, reserve = false) {
  const role = reserve ? "工具" : ROLE_META[a.role]?.short || "工具";
  const command = (a.cli?.command || "").split(/[\\/]/).pop();
  const detail =
    a.status === "working" && a.activity
      ? a.activity
      : reserve
        ? command || a.title || "可随时接席"
        : a.title || a.role;
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
      </span>
      <span class="agent-role">${escapeHtml(detail)}</span>
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

function renderTasks() {
  $("#taskList").innerHTML = S.tasks.length
    ? S.tasks
        .map(
          (t) => `<div class="task-item ${S.task?.id === t.id ? "active" : ""}" data-task="${t.id}">
            <span class="t-title">${escapeHtml(t.title)}</span>
            <span class="t-meta"><span>${STATUS_TEXT[t.status] || t.status}</span><span>${t.doneSteps}/${t.steps || 0}</span><span>${t.files}F</span></span>
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
    ? t.external && t.workspace
      ? `${t.goal} · 📁 ${shortPath(t.workspace)}`
      : t.goal
    : "描述一个目标，团队会自己分工";
  $("#topbarSub").title = t ? t.workspace || "" : "";
  $("#topbarCode").textContent = t
    ? t.status === "running"
      ? "RUNNING"
      : t.status === "stopping"
        ? "STOPPING"
        : t.id.slice(0, 6).toUpperCase()
    : "IDLE";

  const pill = $("#statusPill");
  pill.dataset.status = t ? t.status : "idle";
  pill.textContent = t ? STATUS_TEXT[t.status] || t.status : "待命";

  // 只认 status：taskDetail.running 是首次拉取时的快照，任务结束后不会自动失效
  const busy = !!t && (t.status === "running" || t.status === "stopping");
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
        <div class="bubble" style="--c:${color}">${md(m.text || "")}</div>
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
    else if (any((s) => ["error", "blocked", "stopped"].includes(s.status))) st.status = "error";
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
    deliver.status = t.status === "error" || t.status === "stopped" ? "error" : "done";
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
    current: stages.find((s) => s.status === "active" || s.status === "error") || null,
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
  if (!t || (!t.plan?.length && !t.messages?.length)) {
    bar.hidden = true;
    if (ticker) ticker.hidden = false;
    return;
  }
  bar.hidden = false;
  // 有任务时用真实阶段条替代装饰性跑马灯，减少噪音
  if (ticker) ticker.hidden = true;
  const flow = deriveFlow(t);
  const mark = { done: "✓", active: "●", error: "!", skipped: "–", pending: "" };
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
    <span class="now-dot" data-status="${cur?.status || "pending"}"></span>
    <span class="now-text">${
      cur
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
          ? `<span class="po-decision" title="方案讨论结果">采纳方案 ${t.debate.decision.winnerId}</span>`
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
  skipped: "已跳过",
  failed: "讨论失败",
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
  head.innerHTML = `
    <div class="debate-status" data-status="${d.status}">
      <b>${DEBATE_STATUS[d.status] || d.status}</b>
      <span>${d.participants.length} 位提案人</span>
      ${dec ? `<em>${dec.average == null ? "无评分" : `${dec.average} 分`}</em>` : ""}
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
        ? `<div class="debate-winner">
            <span class="dw-tag">裁决</span>
            <div class="dw-main">
              <b>方案 ${dec.winnerId} · ${escapeHtml(dec.angleLabel)}</b>
              <span>${escapeHtml(dec.winnerName)} 提出 · 平均 ${dec.average ?? "—"} 分 · ${dec.votes} 票</span>
              <span class="dw-judge">主持人 ${escapeHtml(dec.judgeName)}</span>
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
            : `${p.votes?.length || 0} 票${win ? " · 已采纳" : ""}`
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
                <span>${escapeHtml(c.note || (c.ok ? "已完成评分" : "质询失败"))}</span>
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

async function previewWorkspaceFile(rel) {
  if (!rel || !S.task) return;
  try {
    const { path, content } = await api(
      `/api/tasks/${S.task.id}/file?path=${encodeURIComponent(rel)}`,
    );
    switchTab("files");
    $("#fileViewPath").textContent = path;
    $("#fileViewCode").textContent = content;
    $("#fileView").hidden = false;
  } catch (err) {
    toast(err.message, "err");
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
  ["setMaxConcurrency", "maxConcurrency", 1, 4, 2],
  ["setMaxRepairRounds", "maxRepairRounds", 0, 3, 1],
  ["setMaxStepAttempts", "maxStepAttempts", 1, 3, 2],
];

const FLOW_PRESETS = {
  fast: { debateEnabled: false, debateParticipants: 2, debateConcurrency: 2, debatePoolSeats: 0, maxConcurrency: 4, maxRepairRounds: 0, maxStepAttempts: 1 },
  balanced: { debateEnabled: true, debateParticipants: 5, debateConcurrency: 2, debatePoolSeats: 1, maxConcurrency: 2, maxRepairRounds: 1, maxStepAttempts: 2 },
  thorough: { debateEnabled: true, debateParticipants: 6, debateConcurrency: 4, debatePoolSeats: 2, maxConcurrency: 4, maxRepairRounds: 3, maxStepAttempts: 3 },
};

function currentFlowSettings() {
  const s = S.settings || {};
  return {
    debateEnabled: s.debateEnabled !== false,
    debateParticipants: Number(s.debateParticipants) || 4,
    debateConcurrency: Number(s.debateConcurrency) || 2,
    debatePoolSeats: Number(s.debatePoolSeats ?? 1),
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
    // 换任务时关掉上一个任务的产物预览，避免内容错位
    $("#fileView").hidden = true;
    $("#fileViewPath").textContent = "—";
    $("#fileViewCode").textContent = "";
    closeDrawers();
    renderAll();
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
  try {
    $("#heroStart").disabled = true;
    const body = { goal: text, flowMode: S.flowMode === "direct" ? "direct" : "debate" };
    if (S.dir) body.workspace = S.dir;
    const { task } = await api("/api/tasks", { method: "POST", body });
    S.task = task;
    if (!S.tasks.find((t) => t.id === task.id)) S.tasks.unshift({ ...task });
    $("#heroInput").value = "";
    $("#input").value = "";
    // 直接开工没有讨论可看，落到执行链路；先讨论则停在讨论页看提案
    switchTab(S.flowMode === "direct" ? "plan" : "debate");
    renderAll();
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
    case "task.status": {
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
    case "plan.updated": {
      if (cur && cur.id === ev.taskId) {
        cur.plan = ev.plan;
        renderPlan();
        renderFlow();
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
        const summary = S.tasks.find((t) => t.id === ev.taskId);
        if (summary) {
          summary.files = cur.artifacts.length;
          renderTasks();
        }
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
    const { agents } = await api("/api/agents");
    S.agents = normalizeAgentSeats(agents);
    renderAgents();
    renderPlan();
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

let editingId = null;

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
    f("seat").checked = agent.seat !== false;
  } else if (preset) {
    f("name").value = preset.name || "";
    f("mode").value = "cli";
    f("command").value = preset.command || "";
    f("args").value = preset.args || "run {{prompt}}";
    f("seat").checked = false;
  }

  $("#agentModalTitle").textContent = agent ? `编辑 · ${agent.name}` : "接入新的智能体";
  $("#agentSubmit").textContent = agent ? "保存修改" : "加入团队";
  $("#agentDelete").hidden = !agent;
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
  $("#pane-files").hidden = tab !== "files";
  $("#pane-stats").hidden = tab !== "stats";
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
      seat: fd.get("seat") === "on",
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
    if (e.key === "Escape") closeDrawers();
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
    S.tasks = state.tasks;
    S.settings = state.settings || {};
    if (state.activeTask) S.task = state.activeTask;
    S.openStep = "";
    renderFlowModeControls();
    renderAll();
    renderStats();
    connect();
    // 默认落在执行链路；支持 #debate / #settings 这类深链直接打开对应面板
    const hashTab = location.hash.replace("#", "");
    if (hashTab === "settings") openFlowSettings();
    else switchTab(["context", "debate", "plan", "files", "stats"].includes(hashTab) ? hashTab : S.tab);
  } catch (err) {
    $("#connState").textContent = "服务未启动";
    toast(`无法连接后端：${err.message}`, "err");
  }
}

boot();
