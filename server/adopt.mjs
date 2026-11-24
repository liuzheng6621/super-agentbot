import path from 'node:path';
import { store } from './store.mjs';
import { probeClis } from './adapters.mjs';

const ROLE_TITLE = {
  planner: '规划师',
  architect: '架构师',
  coder: '实现工程师',
  tester: '测试工程师',
  reviewer: '代码评审',
};

const ROLE_PREFERENCES = {
  planner: ['claude', 'qwen', 'gemini', 'kimi'],
  architect: ['gemini', 'claude', 'kimi', 'qwen'],
  coder: ['codex', 'cursor-agent', 'aider', 'trae-cli', 'opencode', 'crush', 'dsh'],
  tester: ['opencode', 'crush', 'dsh', 'codex', 'gemini'],
  reviewer: ['claude', 'kimi', 'qwen', 'gemini'],
};

/** 命令名归一化：绝对路径 / .cmd / .exe 都折成同一个名字，避免重复接管 */
function baseName(cmd) {
  return path
    .basename(String(cmd || ''))
    .replace(/\.(cmd|bat|exe|ps1)$/i, '')
    .toLowerCase();
}

/**
 * 把已接入的 CLI 分到 5 个主执行席位。
 * 优先保留角色现有人选，其次让每个角色尽量使用不同工具，避免所有 CLI 都挤在 coder。
 */
export function rebalanceTeam() {
  const available = [];
  const seenCommands = new Set();
  for (const agent of store.agents) {
    if (agent.mode !== 'cli' || !agent.cli?.command) continue;
    const key = baseName(agent.cli.command);
    if (seenCommands.has(key)) continue;
    seenCommands.add(key);
    available.push(agent);
  }

  const picked = new Set();
  const assignments = [];
  for (const role of Object.keys(ROLE_PREFERENCES)) {
    const prefs = ROLE_PREFERENCES[role];
    const ranked = [...available]
      .filter((a) => !picked.has(a.id))
      .sort((a, b) => {
        const ai = prefs.indexOf(baseName(a.cli.command));
        const bi = prefs.indexOf(baseName(b.cli.command));
        const ar = (a.role === role ? 20 : 0) + (a.seat !== false ? 8 : 0) + (ai < 0 ? -10 : 10 - ai);
        const br = (b.role === role ? 20 : 0) + (b.seat !== false ? 8 : 0) + (bi < 0 ? -10 : 10 - bi);
        return br - ar;
      });
    const chosen = ranked[0];
    if (!chosen) continue;
    picked.add(chosen.id);
    store.updateAgent(chosen.id, {
      role,
      title: ROLE_TITLE[role],
      seat: true,
    });
    assignments.push({ role, id: chosen.id, name: chosen.name, command: baseName(chosen.cli.command) });
  }
  return assignments;
}

/**
 * 把本机已安装、但还没成为成员的 CLI 一次性接管成智能体。
 * 幂等：同一条命令不会重复建成员。新成员默认进入工具池，不抢占已有执行席位。
 */
export async function adoptInstalledClis({ dryRun = false } = {}) {
  const candidates = await probeClis();
  const taken = new Set(store.agents.filter((a) => a.mode === 'cli').map((a) => baseName(a.cli?.command)));

  const created = [];
  const skipped = [];

  for (const c of candidates) {
    const key = String(c.command).toLowerCase();
    if (!c.found) {
      skipped.push({ command: c.command, reason: '未安装' });
      continue;
    }
    if (taken.has(key)) {
      skipped.push({ command: c.command, reason: '已在团队中' });
      continue;
    }
    if (dryRun) {
      created.push({ command: c.command, name: c.label });
      continue;
    }
    const agent = store.addAgent({
      name: c.label.replace(/\s*CLI$/, ''),
      role: 'coder',
      title: 'CLI 工具',
      color: '#ff5538',
      tagline: c.version || '调用本机命令行',
      skills: [],
      mode: 'cli',
      seat: false,
      // 用探测到的绝对路径：只装在 npm 全局目录、不在 PATH 时也能跑
      cli: { command: c.path || c.command, args: c.args, cwd: '' },
    });
    taken.add(key);
    created.push({ id: agent.id, name: agent.name, command: c.command, reserve: agent.seat === false });
  }

  return { created, skipped };
}
