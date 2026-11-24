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
  tab: "plan",
  atBottom: true,
  pending: new Map(),
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
  return `<div class="agent-row ${reserve ? "reserve" : "seated"}" data-agent="${a.id}">
    <span class="avatar" style="--c:${a.color}">${initials(a.name)}<i class="dot ${a.status}"></i></span>
    <span class="agent-meta">
      <span class="agent-name">${escapeHtml(a.name)}
        <i class="tag role" data-role="${reserve ? "tool" : a.role}">${role}</i>
        <i class="tag ${a.mode === "cli" ? "cli" : ""}">${a.mode === "cli" ? "CLI" : "SIM"}</i>
      </span>
      <span class="agent-role">${escapeHtml(detail)}</span>
    </span>
    <span class="agent-right">
      <span class="runs">${pad2(a.stats?.runs || 0)}</span>
      <button class="agent-edit" data-edit="${a.id}" title="编辑配置">⚙</button>
    </span>
  </div>`;
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
    : `自动编排 · ${S.agents.filter((a) => a.seat !== false).length} 个席位`;
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
  return `<div class="msg ${isUser ? "user" : ""} ${m.done ? "" : "streaming"}" data-msg="${m.id}">
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
  wrap.innerHTML = t.messages.map(messageHtml).join("");
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
      return `<div class="step" data-status="${step.status}" data-role="${step.role}">
        <span class="step-num">${icon}</span>
        <div class="step-title"><i class="step-role">${role}</i>${escapeHtml(step.title)}</div>
        <div class="step-sub">
          ${agent ? `<span class="s-owner" style="--c:${agent.color}">${escapeHtml(agent.name)}</span>` : "<span>未指派</span>"}
          <span>·</span>
          <span>${escapeHtml(step.note || STEP_STATUS_TEXT[step.status] || "")}</span>
        </div>
        ${extras.length ? `<div class="step-deps">${extras.map((e) => `<span>${escapeHtml(e)}</span>`).join("")}</div>` : ""}
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
    .map(
      (f) => `<div class="file-item" data-file="${escapeHtml(f.path)}">
        <span class="ext">${escapeHtml((f.lang || "txt").slice(0, 3))}</span>
        <span class="file-name">${escapeHtml(f.path)}</span>
        <span class="file-size">${fmtBytes(f.bytes)}</span>
      </div>`,
    )
    .join("");
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
  const items = [
    ["累计 TOKENS", (t.stats?.tokens || 0).toLocaleString()],
    ["协作轮次", pad2(t.stats?.agentRuns || t.messages?.filter((m) => m.agentId !== "user").length || 0)],
    ["产物文件", pad2(t.artifacts?.length || 0)],
    ["返工轮次", pad2(t.repairRound || 0)],
    [
      "质量门",
      t.quality?.status === "passed"
        ? "PASS"
        : t.quality?.status === "failed"
          ? "FAIL"
          : t.quality?.status === "skipped"
            ? "评审代判"
            : "待执行",
    ],
    ["总耗时", fmtMs(t.stats?.ms || (t.endedAt && t.createdAt ? t.endedAt - t.createdAt : 0))],
  ];
  grid.innerHTML = items
    .map(([label, value]) => `<div class="stat"><div class="s-label">${label}</div><div class="s-value">${value}</div></div>`)
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
}

/* ---------------- 任务操作 ---------------- */

async function selectTask(id) {
  if (!id) return;
  try {
    const { task } = await api(`/api/tasks/${id}`);
    S.task = task;
    S.atBottom = true;
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
    const body = { goal: text };
    if (S.dir) body.workspace = S.dir;
    const { task } = await api("/api/tasks", { method: "POST", body });
    S.task = task;
    if (!S.tasks.find((t) => t.id === task.id)) S.tasks.unshift({ ...task });
    $("#heroInput").value = "";
    $("#input").value = "";
    renderAll();
    toast("团队已开工", "ok");
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
      }
      renderTasks();
      break;
    }
    case "plan.updated": {
      if (cur && cur.id === ev.taskId) {
        cur.plan = ev.plan;
        renderPlan();
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
      }
      break;
    }
    case "message.start": {
      if (cur && cur.id === ev.taskId) {
        cur.messages.push(ev.message);
        if (cur.messages.length === 1) renderMessages();
        else {
          $("#timeline").insertAdjacentHTML("beforeend", messageHtml(ev.message));
          scrollToBottom();
        }
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
    case "task.deleted": {
      S.tasks = S.tasks.filter((t) => t.id !== ev.taskId);
      if (cur && cur.id === ev.taskId) {
        S.task = null;
        renderAll();
      }
      renderTasks();
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
      await api(`/api/tasks/${S.task.id}/run`, { method: "POST", body: {} });
      toast("已重新编排", "ok");
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

  /* 面板 */
  $("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) switchTab(tab.dataset.tab);
  });

  $("#fileList").addEventListener("click", async (e) => {
    const item = e.target.closest(".file-item");
    if (!item || !S.task) return;
    try {
      const { path, content } = await api(
        `/api/tasks/${S.task.id}/file?path=${encodeURIComponent(item.dataset.file)}`,
      );
      $("#fileViewPath").textContent = path;
      $("#fileViewCode").textContent = content;
      $("#fileView").hidden = false;
    } catch (err) {
      toast(err.message, "err");
    }
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
    renderAll();
    renderStats();
    connect();
    // 支持 #debate 这类深链，方便直接打开方案讨论
    const hashTab = location.hash.replace("#", "");
    if (["context", "debate", "plan", "files", "stats"].includes(hashTab)) switchTab(hashTab);
  } catch (err) {
    $("#connState").textContent = "服务未启动";
    toast(`无法连接后端：${err.message}`, "err");
  }
}

boot();
