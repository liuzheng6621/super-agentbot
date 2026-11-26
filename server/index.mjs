import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { store, ROOT, DATA_DIR, WORKSPACE_DIR, TOOL_CATALOG, ROLE_TOOLS } from './store.mjs';
import { startTask, stopTask, chat, listWorkspaceFiles, buildContextPack, isRunning, workMsOf } from './orchestrator.mjs';
import { probeClis, spawnCli, clearResolveCache } from './adapters.mjs';
import { adoptInstalledClis, rebalanceTeam } from './adopt.mjs';
import { ensureRealTeam, refreshTeam, judgeHealth } from './team.mjs';
import {
  WorkspaceError,
  deleteWorkspaceEntry,
  makeWorkspaceDir,
  moveWorkspaceEntry,
  readWorkspaceFile,
  searchWorkspace,
  workspaceDiff,
  workspaceInfo,
  workspaceSnapshot,
  writeWorkspaceEntry,
} from './workspace.mjs';

const PORT = Number(process.env.PORT || 8787);
// 本地桌面场景只监听回环；被托管平台注入 PORT 时（容器 / 云沙箱）需要对外绑定
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------------------- 工具函数 ---------------------------- */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
    req.on('error', reject);
  });
}

function taskDetail(task) {
  const summary = store.taskSummary(task);
  // 老任务当时没记工时，按工序时间补算，别拿墙钟（含排队与重试等待）冒充
  if (!summary.stats?.ms) {
    const real = workMsOf(task);
    if (real) summary.stats = { ...summary.stats, ms: real };
  }
  return {
    ...summary,
    plan: task.plan,
    messages: task.messages,
    artifacts: task.artifacts,
    debate: task.debate || null,
    error: task.error || null,
    running: isRunning(task.id),
    workspace: task.workspace,
    sourceWorkspace: task.sourceWorkspace || task.workspace,
    worktree: task.worktree || null,
    workspaceInfo: workspaceInfo(task),
    external: !!task.external,
    fileChanges: task.fileChanges || [],
    events: (task.events || []).slice(-160),
    context: buildContextPack(task),
  };
}

function requireAgentTool(agentId, toolId) {
  if (!agentId) return;
  const agent = store.getAgent(agentId);
  if (!agent) throw new WorkspaceError('智能体不存在', 404);
  const allowed = new Set(Array.isArray(agent.tools) ? agent.tools : []);
  if (!allowed.has(toolId)) {
    throw new WorkspaceError(`智能体「${agent.name}」没有 ${toolId} 权限`, 403);
  }
}

/* ---------------------------- SSE ---------------------------- */

const clients = new Set();

store.subscribe((event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
});

setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 20000).unref();

/* ---------------------------- 路由 ---------------------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
  }

  try {
    /* ---- SSE ---- */
    if (pathname === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    /* ---- 工作流参数（界面可视化配置，替代手改 db.json） ---- */
    if (pathname === '/api/settings' && method === 'PATCH') {
      const body = await readBody(req);
      return json(res, 200, { settings: store.updateSettings(body || {}) });
    }

    /* ---- 全量状态 ---- */
    if (pathname === '/api/state' && method === 'GET') {
      const tasks = store.tasks.map((t) => store.taskSummary(t));
      // 优先给正在跑的那条全量详情；都没在跑时退回最新一条（tasks[0] 是最新）
      const active = store.tasks.find((t) => isRunning(t.id)) || store.tasks[0];
      return json(res, 200, {
        agents: store.agents,
        tasks,
        settings: { ...store.db.settings },
        toolCatalog: TOOL_CATALOG,
        roleTools: ROLE_TOOLS,
        activeTask: active ? taskDetail(active) : null,
      });
    }

    /* ---- 智能体 ---- */
    if (pathname === '/api/agents' && method === 'GET') {
      return json(res, 200, {
        agents: store.agents,
        toolCatalog: TOOL_CATALOG,
        roleTools: ROLE_TOOLS,
      });
    }
    if (pathname === '/api/agents' && method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: '缺少 name' });
      return json(res, 201, { agent: store.addAgent(body) });
    }
    if (pathname === '/api/probe' && method === 'GET') {
      clearResolveCache();
      return json(res, 200, { candidates: await probeClis() });
    }

    if (pathname === '/api/context-preview' && method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      const context = buildContextPack({
        goal,
        workspace: body.workspace || WORKSPACE_DIR,
        status: 'idle',
        mode: 'auto',
        messages: [],
      }, { maxMessages: 0 });
      return json(res, 200, { context });
    }

    /* ---- 目录选择器（本机服务，供「选文件夹开工」用） ---- */
    if (pathname === '/api/fs' && method === 'GET') {
      const raw = String(searchParams.get('path') || '').trim();
      if (!raw) {
        const home = process.env.USERPROFILE || process.env.HOME || ROOT;
        const dirs = [];
        if (process.platform === 'win32') {
          for (const letter of 'CDEFGH') {
            const drive = `${letter}:\\`;
            if (fs.existsSync(drive)) dirs.push({ name: `${letter}:`, path: drive });
          }
        } else {
          dirs.push({ name: '/', path: '/' });
        }
        dirs.unshift({ name: '用户目录', path: home });
        dirs.push({ name: 'AgentForge 工作区', path: WORKSPACE_DIR });
        return json(res, 200, { path: '', parent: null, dirs });
      }
      const abs = path.resolve(raw);
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        return json(res, 400, { error: `目录不存在：${abs}` });
      }
      if (!stat.isDirectory()) return json(res, 400, { error: `不是目录：${abs}` });
      let entries = [];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch (err) {
        return json(res, 400, { error: `无法读取：${err.code || err.message}` });
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        .slice(0, 400)
        .map((e) => ({ name: e.name, path: path.join(abs, e.name) }));
      const parent = path.dirname(abs);
      return json(res, 200, { path: abs, parent: parent === abs ? null : parent, dirs });
    }
    if (pathname === '/api/agents/adopt' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, await adoptInstalledClis({ dryRun: body?.dryRun === true }));
    }
    if (pathname === '/api/agents/rebalance' && method === 'POST') {
      return json(res, 200, { assignments: rebalanceTeam(), agents: store.agents });
    }
    // 把内置演示席位换成真实 CLI：ensure 只补齐内置席位，refresh 强制重体检并重组
    if (pathname === '/api/team/ensure' && method === 'POST') {
      return json(res, 200, await ensureRealTeam());
    }
    if (pathname === '/api/team/refresh' && method === 'POST') {
      clearResolveCache();
      return json(res, 200, await refreshTeam());
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([\w-]+)(\/test)?$/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const agent = store.getAgent(agentId);
      if (!agent) return json(res, 404, { error: '智能体不存在' });
      if (agentMatch[2] && method === 'POST') {
        if (!agent.cli?.command) return json(res, 400, { ok: false, message: '未配置 CLI 命令' });
        const res2 = await spawnCli(agent, '只回答两个字：在线', {
          timeout: agent.cli.healthTimeout || 60000,
          cwd: ROOT,
        });
        const health = judgeHealth(res2);
        const ok = health.ok;
        // 单个体检结果必须落回智能体，否则界面会一直挂着上一次的「不可用」
        store.updateAgent(agentId, { health });
        return json(res, 200, {
          ok,
          code: res2.code,
          ms: res2.elapsed,
          health,
          output: (res2.stdout || res2.stderr || '').trim().slice(0, 500),
        });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, { agent: store.updateAgent(agentId, body) });
      }
      if (method === 'DELETE') {
        const ok = store.removeAgent(agentId);
        if (ok) store.removeAgentReferences(agentId);
        return json(res, 200, { ok });
      }
    }

    /* ---- 任务 ---- */
    if (pathname === '/api/tasks' && method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      if (goal.length < 2) return json(res, 400, { error: '目标太短，至少 2 个字' });
      let task;
      try {
        task = store.createTask({
          goal,
          mode: body.mode === 'manual' ? 'manual' : 'auto',
          workspace: typeof body.workspace === 'string' ? body.workspace : '',
          isolation: body.isolation === 'worktree' ? 'worktree' : 'direct',
          debate: body.flowMode === 'direct' || body.flowMode === 'debate' ? body.flowMode : null,
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const speed = Number(body.speed) || 1;
      if (body.autoRun !== false) {
        setTimeout(() => startTask(task.id, { speed }).catch((e) => console.error('[startTask]', e)), 60);
      }
      return json(res, 201, { task: taskDetail(store.getTask(task.id)) });
    }

    const taskMatch = pathname.match(
      /^\/api\/tasks\/([\w-]+)(?:\/(run|stop|chat|files|file|workspace|search|events|changes|diff|fs))?$/,
    );
    if (taskMatch) {
      const task = store.getTask(taskMatch[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const action = taskMatch[2];

      if (!action && method === 'GET') return json(res, 200, { task: taskDetail(task) });
      if (!action && method === 'DELETE') {
        stopTask(task.id);
        return json(res, 200, { ok: store.removeTask(task.id) });
      }
      if (action === 'run' && method === 'POST') {
        const body = await readBody(req);
        if (isRunning(task.id)) return json(res, 409, { error: '该任务正在协作中' });
        // 重新编排时允许顺带改流程模式（先讨论 / 直接开工），不必删掉重开任务
        if (body.flowMode === 'direct' || body.flowMode === 'debate') {
          store.updateTask(task.id, { flowMode: body.flowMode });
        } else if (body.flowMode === null) {
          store.updateTask(task.id, { flowMode: null });
        }
        startTask(task.id, { speed: Number(body.speed) || 1 }).catch((e) =>
          console.error('[startTask]', e),
        );
        return json(res, 202, { ok: true });
      }
      if (action === 'stop' && method === 'POST') {
        return json(res, 200, { ok: stopTask(task.id) });
      }
      if (action === 'chat' && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: '消息为空' });
        chat(task.id, text, { speed: Number(body.speed) || 1 }).catch((e) =>
          console.error('[chat]', e),
        );
        return json(res, 202, { ok: true });
      }
      if (action === 'files' && method === 'GET') {
        requireAgentTool(searchParams.get('agentId') || '', 'workspace.read');
        return json(res, 200, { files: listWorkspaceFiles(task) });
      }
      if (action === 'workspace' && method === 'GET') {
        requireAgentTool(searchParams.get('agentId') || '', 'workspace.read');
        return json(res, 200, workspaceSnapshot(task));
      }
      if (action === 'search' && method === 'GET') {
        requireAgentTool(searchParams.get('agentId') || '', 'workspace.search');
        return json(res, 200, searchWorkspace(task, searchParams.get('q') || ''));
      }
      if (action === 'events' && method === 'GET') {
        requireAgentTool(searchParams.get('agentId') || '', 'workspace.read');
        const limit = Math.max(1, Math.min(800, Number(searchParams.get('limit')) || 160));
        return json(res, 200, { events: (task.events || []).slice(-limit) });
      }
      if (action === 'changes' && method === 'GET') {
        requireAgentTool(searchParams.get('agentId') || '', 'workspace.read');
        return json(res, 200, { changes: task.fileChanges || [] });
      }
      if (action === 'diff' && method === 'GET') {
        requireAgentTool(searchParams.get('agentId') || '', 'workspace.read');
        return json(res, 200, workspaceDiff(task, searchParams.get('path') || ''));
      }
      if (action === 'fs' && method === 'POST') {
        const body = await readBody(req);
        const op = String(body.op || '').trim();
        const meta = {
          agentId: typeof body.agentId === 'string' ? body.agentId : '',
          stepId: typeof body.stepId === 'string' ? body.stepId : '',
        };
        if (op === 'write') {
          requireAgentTool(meta.agentId, 'workspace.write');
          return json(res, 200, {
            ok: true,
            result: writeWorkspaceEntry(task, body.path, body.content, meta),
          });
        }
        if (op === 'mkdir') {
          requireAgentTool(meta.agentId, 'workspace.write');
          return json(res, 200, { ok: true, result: makeWorkspaceDir(task, body.path, meta) });
        }
        if (op === 'move') {
          requireAgentTool(meta.agentId, 'workspace.move');
          return json(res, 200, {
            ok: true,
            result: moveWorkspaceEntry(task, body.from, body.to, meta),
          });
        }
        if (op === 'delete') {
          requireAgentTool(meta.agentId, 'workspace.delete');
          return json(res, 200, {
            ok: true,
            result: deleteWorkspaceEntry(task, body.path, meta),
          });
        }
        return json(res, 400, { error: '不支持的 fs op' });
      }
      if (action === 'file' && method === 'GET') {
        requireAgentTool(searchParams.get('agentId') || '', 'workspace.read');
        const rel = searchParams.get('path') || '';
        return json(res, 200, readWorkspaceFile(task, rel));
      }
    }

    /* ---- 外部 bot webhook ---- */
    const hookMatch = pathname.match(/^\/api\/hooks\/([\w-]+)$/);
    if (hookMatch) {
      if (hookMatch[1] !== store.db.settings.hookToken) return json(res, 401, { error: 'token 无效' });
      if (method === 'GET') {
        return json(res, 200, { ok: true, tasks: store.tasks.slice(0, 5).map((t) => store.taskSummary(t)) });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const goal = String(body.goal || body.text || body.message || '').trim();
        if (!goal) return json(res, 400, { error: '需要 goal / text / message 字段' });
        const task = store.createTask({ goal });
        setTimeout(() => startTask(task.id).catch((e) => console.error('[hook]', e)), 60);
        return json(res, 202, {
          ok: true,
          taskId: task.id,
          stream: `/api/tasks/${task.id}`,
          reply: `已收到任务「${task.title}」，团队开始协作。`,
        });
      }
    }

    /* ---- 桌面模式：退出应用 ---- */
    if (pathname === '/api/shutdown' && method === 'POST') {
      const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (!['127.0.0.1', '::1'].includes(addr)) return json(res, 403, { error: '仅允许本机调用' });
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, agents: store.agents.length, tasks: store.tasks.length, uptime: process.uptime() });
    }

    return json(res, 404, { error: '接口不存在' });
  } catch (err) {
    if (err?.message === '请求体过大') return json(res, 413, { error: '请求体过大' });
    if (err instanceof WorkspaceError) {
      return json(res, err.status || 400, { error: err.message });
    }
    console.error('[api]', err);
    return json(res, 500, { error: err.message });
  }
});

/* ---------------------------- 静态资源 ---------------------------- */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const publicRoot = path.resolve(PUBLIC_DIR);
  const abs = path.resolve(publicRoot, '.' + rel);
  if (abs !== publicRoot && !abs.startsWith(publicRoot + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat || stat.isDirectory()) {
    // 带后缀的请求就是静态资源，缺了就老实 404，不要回退成首页 HTML
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    // SPA 回退
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(fs.readFileSync(index));
    }
    res.writeHead(404);
    return res.end('Not Found');
  }
  const ext = path.extname(abs).toLowerCase();
  // 桌面应用会长期常驻：脚本样式不缓存，避免更新后还跑旧前端；字体图片可以长缓存
  const cacheable = ['.woff2', '.png', '.ico', '.svg'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
    'Content-Length': stat.size,
  });
  fs.createReadStream(abs).pipe(res);
}

/* 本地常驻服务：漏网异常只记录，不让进程带着窗口一起退出 */
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const res of clients) res.end();
  clients.clear();
  server.close(() => {
    store.flush();
    process.exit(0);
  });
  setTimeout(() => {
    store.flush();
    process.exit(0);
  }, 1500).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('exit', () => store.flush());

// 端口被占用时 Node 只会抛一个裸 EADDRINUSE 并静默退出，容易误判成「启动成功但页面打不开」
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`  ✗ 端口 ${PORT} 已被占用：本机可能已有一个 AgentForge 在运行。`);
    console.error('    先关掉旧进程（或设 PORT=xxxx 换端口）再启动。');
    process.exit(2);
  }
  console.error('  ✗ 服务启动失败: ' + (err && err.message));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  AgentForge · 多智能体开发协作台');
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log(`  ➜  工作区: ${path.join(DATA_DIR, 'workspaces')}`);
  console.log('');
  // 后台把内置演示席位换成体检通过的真实 CLI；体检较慢，不阻塞服务可用
  setTimeout(() => {
    ensureRealTeam()
      .then((r) => {
        if (r.changed) {
          console.log(`  ➜  真实席位: ${r.seats.map((s) => `${s.role}→${s.name}`).join('、')}`);
          console.log(`  ➜  ${r.reason}`);
        } else {
          console.log(`  ➜  团队: ${r.reason}`);
        }
      })
      .catch((err) => console.warn('  !  组建真实团队失败: ' + err.message));
  }, 200);
});
