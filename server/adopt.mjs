import path from 'node:path';
import { store } from './store.mjs';
import { probeClis } from './adapters.mjs';

/** 命令名归一化：绝对路径 / .cmd / .exe 都折成同一个名字，避免重复接管 */
function baseName(cmd) {
  return path
    .basename(String(cmd || ''))
    .replace(/\.(cmd|bat|exe|ps1)$/i, '')
    .toLowerCase();
}

/**
 * 把本机已安装、但还没成为成员的 CLI 一次性接管成智能体。
 * 幂等：同一条命令不会重复建成员。
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
      title: '真实 CLI',
      color: '#ff5538',
      tagline: c.version || '调用本机命令行',
      skills: [],
      mode: 'cli',
      // 用探测到的绝对路径：只装在 npm 全局目录、不在 PATH 时也能跑
      cli: { command: c.path || c.command, args: c.args, cwd: '' },
    });
    taken.add(key);
    created.push({ id: agent.id, name: agent.name, command: c.command });
  }

  return { created, skipped };
}
