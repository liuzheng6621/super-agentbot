import fs from 'node:fs';
import os from 'node:os';
import { store, ROLE_ORDER } from './store.mjs';
import { probeClis, spawnCli } from './adapters.mjs';
import { commandBaseName } from './command-key.mjs';

/** 体检只要求最短回复，避免为了探活消耗一整轮模型输出 */
export const HEALTH_PROMPT = 'Reply with exactly: OK';
export const HEALTH_TIMEOUT = 30000;

const ROLE_TITLE = {
  planner: '规划师',
  architect: '架构师',
  coder: '实现工程师',
  tester: '测试工程师',
  reviewer: '代码评审',
};

/** 角色偏好：同一 CLI 也能兼任多个席位，但尽量让不同角色用不同工具 */
const ROLE_PREFERENCES = {
  planner: ['claude', 'dsh', 'qwen', 'gemini', 'kimi', 'opencode', 'codex', 'aider'],
  architect: ['gemini', 'claude', 'dsh', 'kimi', 'qwen', 'opencode', 'codex', 'aider'],
  coder: ['codex', 'opencode', 'trae-cli', 'dsh', 'aider', 'crush', 'qwen', 'gemini', 'claude'],
  tester: ['opencode', 'dsh', 'trae-cli', 'crush', 'qwen', 'gemini', 'codex', 'aider'],
  reviewer: ['claude', 'dsh', 'trae-cli', 'kimi', 'qwen', 'gemini', 'opencode', 'codex', 'aider'],
};

const BUILTIN_NAMES = new Set(['Nova', 'Forge', 'Kilo', 'Probe', 'Lens']);

/** 命令名归一化：绝对路径 / .cmd / .exe 都折成同一个 key，避免同一工具重复占位 */
export function baseName(cmd) {
  return commandBaseName(cmd);
}

/** 内置演示席位：新数据带 builtin 标记，老数据靠虚构名字兜底 */
export function isBuiltinSeat(agent) {
  return agent?.builtin === true || (agent?.mode === 'sim' && BUILTIN_NAMES.has(agent?.name));
}

const FATAL =
  /api error|405 not allowed|401|403|unauthorized|authentication|invalid api|no providers configured|no auth type|auth method|config file not found|no llm|failed to run prompt|prompt turn ended with reason: failed|quota|rate limit|api key/i;

/** 把一次真实调用转成健康状态；纯函数，方便单测 */
export function judgeHealth(res) {
  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();
  const fatalText = (text) => FATAL.test(text) || /not allowed|unauthorized/i.test(text);
  // 体检题就是「Reply with exactly: OK」：答出 OK 即算有回复，不管它包了多少装饰（trae-cli 会打一整套表格）
  const answered = /(^|[\s│|:=])OK($|[\s│|.,;])/m.test(out);
  const hasReply = out.length > 0 && (out.length < 400 || answered);
  // stderr 里常有 Codex 的插件同步警告（例如 api key auth is not supported），
  // 只要 stdout 已经给出有效短回答，就不能让这类日志噪音把成员判死。
  const fatal = fatalText(out) || (fatalText(err) && !hasReply);
  // codex 这类 CLI 会吐完结果后继续等 stdin 直到超时：有回复就算可用，但如实标注
  const softOk = res.code === -3 && hasReply && !fatal;
  const ok = ((res.code === 0 && hasReply) || softOk) && !fatal;
  return {
    ok,
    note: ok
      ? softOk
        ? '有回复但进程未自行退出（已按超时收口）'
        : '在线'
      : (err || out || `退出码 ${res.code}`).replace(/\s+/g, ' ').slice(0, 140),
    ms: res.elapsed || 0,
    checkedAt: Date.now(),
  };
}

/**
 * 挑出 5 个主执行席位的人选。
 * 规则：体检通过 > 未体检 > 体检失败；同档按角色偏好；尽量不重复但允许复用
 * （真正能用比「每个席位工具都不同」更重要，只有一个 CLI 可用时也必须凑齐 5 席）。
 * 纯函数：candidates = [{ key, label, path, args, health }]
 */
export function pickRealTeam(candidates = []) {
  if (!candidates.length) return [];
  const grade = (c) => (c.health?.ok ? 100 : c.health ? 0 : 50);
  const used = new Set();
  const plan = [];
  for (const role of ROLE_ORDER) {
    const prefs = ROLE_PREFERENCES[role] || [];
    const prefScore = (c) => {
      const i = prefs.indexOf(c.key);
      return (i < 0 ? -10 : 10 - i) - (used.has(c.key) ? 5 : 0);
    };
    const ranked = [...candidates].sort((a, b) => {
      const g = grade(b) - grade(a);
      return g || prefScore(b) - prefScore(a) || a.key.localeCompare(b.key);
    });
    const chosen = ranked[0];
    used.add(chosen.key);
    plan.push({ role, candidate: chosen });
  }
  return plan;
}

/** 汇总本机探测结果 + 已持久化的体检缓存，按命令名去重 */
export function collectCandidates(probed, agents = store.agents, cache = store.db.settings.teamHealth) {
  const healthByKey = new Map();
  // 缓存按命令名存，不依赖「团队里恰好有没有这个成员」
  for (const [key, h] of Object.entries(cache || {})) if (h) healthByKey.set(key, h);
  for (const a of agents) {
    if (a.mode !== 'cli' || !a.cli?.command || !a.health) continue;
    const key = baseName(a.cli.command);
    healthByKey.set(key, a.health);
  }
  const map = new Map();
  for (const c of probed) {
    if (!c.found) continue;
    const key = baseName(c.command);
    if (map.has(key)) continue;
    map.set(key, {
      key,
      label: c.label,
      path: c.path || c.command,
      args: c.args,
      env: c.env,
      healthTimeout: c.healthTimeout,
      health: healthByKey.get(key) || null,
    });
  }
  return [...map.values()];
}

/** 对没有有效缓存的候选做真实调用体检（并发限制，返回带 health 的候选） */
export async function checkCandidates(candidates, { timeout = HEALTH_TIMEOUT, concurrency = 4, force = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'af-team-'));
  const need = candidates.filter((c) => force || !c.health);
  try {
    for (let i = 0; i < need.length; i += concurrency) {
      const batch = need.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (c) => {
          const res = await spawnCli(
            { cli: { command: c.path, args: c.args, env: c.env, cwd: '' } },
            HEALTH_PROMPT,
            // 慢启动的 CLI（trae-cli 这类 Python agent）自带更长的体检预算
            { timeout: c.healthTimeout || timeout, cwd: work },
          );
          c.health = judgeHealth(res);
        }),
      );
    }
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* aider 等 CLI 会在临时目录建 git 仓库，Windows 上偶发占用，交给系统清理 */
    }
  }
  return candidates;
}

/** 把体检结果写回所有同命令名的成员，作为下次启动的缓存；只广播一次 */
function persistHealth(candidates) {
  const cache = { ...(store.db.settings.teamHealth || {}) };
  let touched = 0;
  for (const c of candidates) if (c.health) cache[c.key] = c.health;
  store.db.settings.teamHealth = cache;
  for (const a of store.agents) {
    if (a.mode !== 'cli' || !a.cli?.command) continue;
    const hit = candidates.find((c) => c.key === baseName(a.cli.command));
    if (!hit?.health) continue;
    a.health = hit.health;
    touched += 1;
  }
  store.save();
  store.broadcast({ type: 'agents.changed' });
  return touched;
}

/**
 * 把内置演示席位换成真实可用的 CLI。
 * 幂等：只有还存在内置席位（或 force）时才改席位；体检结果始终刷新。
 */
export async function ensureRealTeam({ force = false, refreshHealth = false } = {}) {
  const probed = await probeClis();
  const found = probed.filter((c) => c.found);
  if (!found.length) {
    return { changed: false, reason: '本机没有检测到任何已安装的 CLI', seats: [], health: [] };
  }

  const candidates = collectCandidates(found);
  await checkCandidates(candidates, { force: refreshHealth });
  persistHealth(candidates);

  const health = candidates.map((c) => ({ key: c.key, label: c.label, ...(c.health || {}) }));
  const builtinSeats = store.agents.filter((a) => a.seat !== false && isBuiltinSeat(a));
  if (!builtinSeats.length && !force) {
    return { changed: false, reason: '执行席位已经是真实 CLI，未覆盖现有配置', seats: [], health };
  }

  const plan = pickRealTeam(candidates);
  // force（手动「体检并换席」）时席位早已是真实 CLI，改用现有执行席位做改写目标
  const targets = builtinSeats.length
    ? builtinSeats
    : ROLE_ORDER.map((role) => store.agents.find((a) => a.seat !== false && a.role === role)).filter(Boolean);
  const counts = new Map();
  for (const { candidate } of plan) counts.set(candidate.key, (counts.get(candidate.key) || 0) + 1);

  const seats = [];
  for (const { role, candidate } of plan) {
    // 优先按角色找目标席位，缺角色时借用任意剩余席位，保持 id 不变以免历史任务引用失效
    let seat = targets.find((a) => a.role === role && !a._taken) || targets.find((a) => !a._taken);
    if (!seat) continue;
    seat._taken = true;
    // 同一个 CLI 兼任多角色时给名字加角色后缀，避免界面上 5 个同名成员看着像没分工
    const name =
      counts.get(candidate.key) > 1 ? `${candidate.label} · ${ROLE_TITLE[role]}` : candidate.label;
    const patch = {
      name,
      role,
      title: `${ROLE_TITLE[role]} · ${candidate.label}`,
      tagline: `${candidate.label} 真实调用 · ${candidate.health?.ok ? '体检通过' : '待配置'}`,
      mode: 'cli',
      builtin: false,
      seat: true,
      cli: { command: candidate.path, args: candidate.args, env: candidate.env, cwd: '' },
      health: candidate.health,
    };
    store.updateAgent(seat.id, patch);
    seats.push({
      id: seat.id,
      role,
      name,
      command: candidate.path,
      healthy: !!candidate.health?.ok,
      note: candidate.health?.note || '未体检',
    });
  }
  for (const a of targets) delete a._taken;

  store.broadcast({ type: 'team.updated', seats, health });
  const healthyCount = new Set(plan.filter((p) => p.candidate.health?.ok).map((p) => p.candidate.key)).size;
  return {
    changed: seats.length > 0,
    reason:
      healthyCount === 0
        ? '已换成真实 CLI，但当前没有 CLI 通过体检（多为未配置 API Key / 鉴权），请配置后点「体检并换席」'
        : `已换成 ${healthyCount} 个体检通过的真实 CLI（可兼任多角色）`,
    seats,
    health,
  };
}

/** 手动入口：强制重新体检并重组席位（用户配置好 API Key 后用） */
export async function refreshTeam() {
  return ensureRealTeam({ force: true, refreshHealth: true });
}
