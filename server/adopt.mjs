import { store } from './store.mjs';
import { probeClis } from './adapters.mjs';
import { commandKey } from './command-key.mjs';

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
  tester: ['opencode', 'crush', 'codex', 'gemini', 'dsh'],
  // 评审要读全量产物再下结论，慢的 CLI（trae-cli 一次评审能跑满 300s）不能占这个席位
  reviewer: ['dsh', 'claude', 'kimi', 'qwen', 'gemini'],
};

/**
 * 把已接入的 CLI 分到 5 个主执行席位。
 * 优先保留角色现有人选，其次让每个角色尽量使用不同工具，避免所有 CLI 都挤在 coder。
 */
export function rebalanceTeam() {
  const available = [];
  const seenCommands = new Set();
  for (const agent of store.agents) {
    if (agent.mode !== 'cli' || !agent.cli?.command) continue;
    const key = commandKey(agent.cli.command);
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
        const ai = prefs.indexOf(commandKey(a.cli.command));
        const bi = prefs.indexOf(commandKey(b.cli.command));
        // 现有人选只做微弱加权，让 ROLE_PREFERENCES 说了算。seat 标志不参与打分：
        // 它由上一次编排写入，拿它加权等于把上一轮的结果当成理由（tester 被 dsh 粘住、
        // reviewer 被 trae-cli 粘住就是这么来的）。
        const ar = (a.role === role ? 2 : 0) + (ai < 0 ? -10 : 10 - ai);
        const br = (b.role === role ? 2 : 0) + (bi < 0 ? -10 : 10 - bi);
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
    assignments.push({ role, id: chosen.id, name: chosen.name, command: commandKey(chosen.cli.command) });
  }
  return assignments;
}

/**
 * 把本机已安装、但还没成为成员的 CLI 一次性接管成智能体。
 * 幂等：同一条命令不会重复建成员。新成员默认进入工具池，不抢占已有执行席位。
 */
export async function adoptInstalledClis({ dryRun = false, probe = probeClis } = {}) {
  const candidates = await probe();
  const taken = new Set(
    store.agents
      .filter((a) => a.mode === 'cli')
      .map((a) => commandKey(a.cli?.command))
      .filter(Boolean),
  );

  const created = [];
  const skipped = [];

  for (const c of candidates) {
    const key = commandKey(c.path || c.command);
    if (!key) {
      skipped.push({ command: c.command, reason: '无法识别命令名' });
      continue;
    }
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
