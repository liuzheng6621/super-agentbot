import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { store } from './store.mjs';
import { writeFileAtomic, versionOf } from './fs.mjs';
import {
  invalidateWorkspaceIndex,
  rememberWorkspaceIndexAdd,
  rememberWorkspaceIndexMove,
} from './workspace-index.mjs';

const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_DEPTH = 10;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 3000;
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 120;
const TRASH_DIR = '.agentforge/trash';
const RESERVED_DIRS = new Set(['.git', '.agentforge']);
const POOL_DIR = '.agentforge/pool';
const SKIP_DIRS = new Set([
  '.git',
  '.agentforge',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);
const SENSITIVE =
  /^(\.env(?:\.|$)|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|.*\.(?:pem|key|p12|pfx|jks|keystore)$)/i;
const READ_RECEIPT_TTL_MS = 30 * 60 * 1000;
const readReceipts = new Map();

export class WorkspaceError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
    this.code = code;
  }
}

function fail(message, status = 400, code = '') {
  throw new WorkspaceError(message, status, code);
}

function rootOf(task) {
  if (!task?.workspace) fail('任务没有工作区', 400);
  return path.resolve(task.workspace);
}

function poolRootOf(task) {
  const explicit = String(task?.workspacePoolRoot || '').trim();
  if (explicit) return path.resolve(explicit);
  // Managed workspaces are task-private and are removed with the task. Reusing
  // them as a cross-task pool would make the data disappear with that task.
  if (!task?.external && !task?.worktree) return '';
  const source = String(task?.sourceWorkspace || '').trim();
  return source ? path.resolve(source) : '';
}

function poolPolicy(agent) {
  const policy = agent?.workspacePolicy || {};
  if (policy.crossTask !== true) return null;
  const mode = policy.mode === 'private' ? 'private' : 'shared';
  const sharedDir = normalizeRelPath(policy.sharedDir || 'Shared');
  const privateDir = normalizeRelPath(policy.privateDir || 'Agents');
  for (const rel of [sharedDir, privateDir]) {
    if (RESERVED_DIRS.has(rel.split('/')[0].toLowerCase())) {
      fail('工作区池不能使用内部目录', 403);
    }
  }
  const relative = mode === 'private' ? `${privateDir}/${agent.id}` : sharedDir;
  return { mode, relative, sharedDir, privateDir, agentId: agent.id };
}

function poolPath(task, agent) {
  const policy = poolPolicy(agent);
  if (!policy) return null;
  const root = poolRootOf(task);
  if (!root) return null;
  const abs = path.resolve(root, policy.relative);
  assertInside(root, abs);
  if (path.basename(abs) === '.git' || policy.relative.split('/').includes('.git')) {
    fail('工作区池不能指向 Git 元数据目录', 403);
  }
  const metadataDir = path.join(root, POOL_DIR);
  const leaseFile = path.join(metadataDir, 'leases.json');
  return {
    root,
    abs,
    relative: policy.relative,
    mode: policy.mode,
    agentId: agent.id,
    leaseFile,
  };
}

function ensurePoolPath(task, agent) {
  const pool = poolPath(task, agent);
  if (!pool) return null;
  fs.mkdirSync(pool.abs, { recursive: true });
  fs.mkdirSync(path.dirname(pool.leaseFile), { recursive: true });
  let leases = [];
  try {
    leases = JSON.parse(fs.readFileSync(pool.leaseFile, 'utf8'));
    if (!Array.isArray(leases)) leases = [];
  } catch {
    leases = [];
  }
  const key = `${pool.relative}:${task.id}:${agent.id}`;
  if (!leases.some((lease) => lease.key === key)) {
    leases.push({
      key,
      taskId: task.id,
      agentId: agent.id,
      path: pool.relative,
      mode: pool.mode,
      createdAt: Date.now(),
    });
    fs.writeFileSync(pool.leaseFile, JSON.stringify(leases.slice(-500), null, 2));
  }
  return {
    ...pool,
    leaseFile: path.relative(pool.root, pool.leaseFile).replace(/\\/g, '/'),
  };
}

function pooledPath(task, rel, agent) {
  const pool = ensurePoolPath(task, agent);
  if (!pool) return null;
  const normalized = normalizeRelPath(rel);
  const abs = path.resolve(pool.abs, normalized);
  assertInside(pool.abs, abs);
  assertNoSymlink(pool.abs, abs);
  return { ...pool, rel: path.posix.join(pool.relative, normalized), abs };
}

export function workspacePoolPath(task, relPath, agent = null) {
  const pooled = pooledPath(task, relPath, agent);
  if (!pooled) fail('该 Agent 未开启可用的跨任务工作区池', 400);
  return pooled.abs;
}

export function workspacePoolInfo(task, agent = null) {
  const policy = agent ? poolPolicy(agent) : null;
  if (!policy) {
    return {
      enabled: false,
      reason: '当前 Agent 未开启 crossTask 工作区复用',
      taskWorkspace: rootOf(task),
    };
  }
  const pool = poolPath(task, agent);
  if (!pool) {
    return {
      enabled: false,
      reason: '任务没有独立源项目，跨任务工作区池未启用',
      taskWorkspace: rootOf(task),
      requested: {
        mode: policy.mode,
        agentId: policy.agentId,
      },
    };
  }
  const leaseFile = path.relative(pool.root, pool.leaseFile).replace(/\\/g, '/');
  return {
    enabled: true,
    root: pool.root,
    path: pool.abs,
    relativePath: pool.relative,
    mode: pool.mode,
    agentId: policy.agentId,
    leaseFile,
    initialized: fs.existsSync(pool.abs),
    leased: fs.existsSync(pool.leaseFile),
    cleanup: '任务删除不会删除跨任务池目录；租约保留在 .agentforge/pool/leases.json',
  };
}

function normalizeRelPath(value, { allowEmpty = false } = {}) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) {
    if (allowEmpty) return '';
    fail('路径不能为空', 400);
  }
  if (raw.includes('\0')) fail('路径包含非法字符', 400);
  if (path.isAbsolute(raw) || /^[a-z]:\//i.test(raw)) fail('只允许工作区内的相对路径', 403);
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, '');
  if (normalized === '..' || normalized.startsWith('../')) fail('路径越出工作区', 403);
  return normalized;
}

function assertInside(base, abs) {
  const rel = path.relative(base, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  fail('路径越出工作区', 403);
}

function assertNoSymlink(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (stat.isSymbolicLink()) fail('工作区工具不跟随符号链接', 403);
  }
}

function safePath(task, rel, { allowEmpty = false, mustExist = false } = {}) {
  const root = rootOf(task);
  const normalized = normalizeRelPath(rel, { allowEmpty });
  if (normalized && RESERVED_DIRS.has(normalized.split('/')[0].toLowerCase())) {
    fail('工作区内部目录禁止通过文件 API 访问', 403);
  }
  const abs = path.resolve(root, normalized);
  assertInside(root, abs);
  assertNoSymlink(root, abs);
  if (mustExist && !fs.existsSync(abs)) fail(`路径不存在：${normalized}`, 404);
  return { root, rel: normalized, abs };
}

function isSensitive(rel) {
  return SENSITIVE.test(path.basename(rel));
}

function langOf(rel) {
  return path.extname(rel).slice(1).toLowerCase() || 'text';
}

function isBinary(buffer) {
  if (!buffer.length) return false;
  let control = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length > 0.1;
}

function changeMap(task) {
  return new Map((task.fileChanges || []).map((change) => [change.path, change]));
}

function statFile(abs, rel, changes) {
  const stat = fs.statSync(abs, { bigint: true });
  return {
    type: 'file',
    name: path.basename(rel),
    path: rel,
    bytes: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    lang: langOf(rel),
    sensitive: isSensitive(rel),
    status: changes.get(rel)?.status || '',
  };
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export function listWorkspaceTree(
  task,
  { maxEntries = MAX_TREE_ENTRIES, maxDepth = MAX_TREE_DEPTH } = {},
) {
  const root = rootOf(task);
  const changes = changeMap(task);
  let count = 0;
  let truncated = false;

  const walk = (dir, prefix = '', depth = 0) => {
    if (depth > maxDepth || count >= maxEntries) {
      truncated = true;
      return [];
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (count >= maxEntries) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += 1;
        out.push({
          type: 'dir',
          name: entry.name,
          path: rel,
          status: changes.get(rel)?.status || '',
          children: walk(abs, rel, depth + 1),
        });
      } else if (entry.isFile()) {
        count += 1;
        try {
          out.push(statFile(abs, rel, changes));
        } catch {
          /* A single unreadable file must not hide the rest of the tree. */
        }
      }
    }
    return sortEntries(out);
  };

  const tree = walk(root);
  return {
    root,
    entries: count,
    truncated,
    tree,
  };
}

export function listWorkspaceDirectory(
  task,
  relPath = '',
  { maxEntries = MAX_TREE_ENTRIES } = {},
) {
  const { root, rel, abs } = safePath(task, relPath, {
    allowEmpty: true,
    mustExist: true,
  });
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    fail(`路径不存在：${rel || '.'}`, 404);
  }
  if (!stat.isDirectory()) fail('路径不是目录', 404);
  const changes = changeMap(task);
  let raw = [];
  try {
    raw = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { root, path: rel, entries: 0, truncated: false, tree: [] };
  }

  const tree = [];
  let truncated = false;
  for (const entry of raw) {
    if (tree.length >= maxEntries) {
      truncated = true;
      break;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      tree.push({
        type: 'dir',
        name: entry.name,
        path: childRel,
        status: changes.get(childRel)?.status || '',
        children: [],
        hasChildren: true,
      });
    } else if (entry.isFile()) {
      try {
        tree.push(statFile(childAbs, childRel, changes));
      } catch {
        /* A single unreadable file must not hide the rest of the directory. */
      }
    }
  }

  return {
    root,
    path: rel,
    entries: tree.length,
    truncated,
    tree: sortEntries(tree),
  };
}

function flattenTree(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'file') out.push(node);
    if (node.children) flattenTree(node.children, out);
  }
  return out;
}

function runGit(root, args, timeout = 1200) {
  const res = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return {
    ok: res.status === 0,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
  };
}

function untrackedDiff(root, relPath = '', limit = 40) {
  const args = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (relPath) args.push('--', relPath);
  const listed = runGit(root, args, 5000);
  if (!listed.ok) return [];
  const paths = String(listed.stdout || '')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !rel.split('/').some((part) => SKIP_DIRS.has(part)))
    .filter((rel) => !isSensitive(rel))
    .slice(0, limit);
  const chunks = [];
  for (const rel of paths) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const header = [
      `diff --git a/${rel} b/${rel}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${rel}`,
    ].join('\n');
    if (stat.size > MAX_SEARCH_BYTES) {
      chunks.push(`${header}\nBinary files /dev/null and b/${rel} differ`);
      continue;
    }
    let buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isBinary(buffer)) {
      chunks.push(`${header}\nBinary files /dev/null and b/${rel} differ`);
      continue;
    }
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length) {
      chunks.push(header);
      continue;
    }
    const body = lines.map((line) => `+${line}`).join('\n');
    chunks.push(`${header}\n@@ -0,0 +1,${lines.length} @@\n${body}`);
  }
  return chunks;
}

const infoCache = new Map();

export function workspaceInfo(task) {
  const root = rootOf(task);
  const cached = infoCache.get(root);
  if (cached && Date.now() - cached.at < 5000) return { ...cached.info };

  const isGit = fs.existsSync(path.join(root, '.git'));
  let branch = '';
  let head = '';
  if (isGit) {
    const branchResult = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branchResult.ok) branch = branchResult.stdout;
    const headResult = runGit(root, ['rev-parse', '--short', 'HEAD']);
    if (headResult.ok) head = headResult.stdout;
  }
  const info = {
    path: root,
    name: path.basename(task.worktree?.source || root) || root,
    kind: task.worktree
      ? task.worktree.mode === 'clone'
        ? 'clone'
        : 'worktree'
      : task.external
        ? 'external'
        : 'managed',
    external: !!task.external,
    worktree: !!task.worktree,
    isolation: task.worktree?.mode || '',
    fallbackReason: task.worktree?.fallbackReason || '',
    source: task.worktree?.source || '',
    isGit,
    branch,
    head,
  };
  infoCache.set(root, { at: Date.now(), info });
  return { ...info };
}

export function readWorkspaceFile(
  task,
  relPath,
  { maxBytes = MAX_PREVIEW_BYTES, agent = null, principal = null } = {},
) {
  const pooled = agent ? pooledPath(task, relPath, agent) : null;
  const { rel, abs } = pooled || safePath(task, relPath, { mustExist: true });
  if (pooled && !fs.existsSync(abs)) fail(`路径不存在：${pooled.rel}`, 404);
  if (isSensitive(rel)) fail('该文件被标记为敏感文件，禁止预览', 403);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) fail('路径不是文件', 404);
  if (stat.size > maxBytes) fail(`文件过大，仅支持 ${Math.round(maxBytes / 1024 / 1024)}MB 以内的文本预览`, 413);
  const buffer = fs.readFileSync(abs);
  const binary = isBinary(buffer);
  const version = versionOf(abs) || '';
  rememberReadReceipt({ task, rel, abs, version, principal, agent });
  return {
    path: rel,
    bytes: stat.size,
    version,
    lang: langOf(rel),
    binary,
    content: binary ? '' : buffer.toString('utf8'),
  };
}

function readReceiptKey({ taskId, principal, agentId, rel, abs }) {
  const actorKind = principal?.kind === 'system' ? 'agent' : principal?.kind || (agentId ? 'agent' : 'owner');
  const actorId = String(principal?.id || agentId || 'owner');
  return `${taskId}:${actorKind}:${actorId}:${rel}:${abs}`;
}

function rememberReadReceipt({ task, rel, abs, version, principal, agent }) {
  if (!version) return;
  const key = readReceiptKey({
    taskId: task.id,
    principal,
    agentId: agent?.id || '',
    rel,
    abs,
  });
  readReceipts.set(key, { version, at: Date.now() });
  if (readReceipts.size <= 2000) return;
  const cutoff = Date.now() - READ_RECEIPT_TTL_MS;
  for (const [entryKey, receipt] of readReceipts) {
    if (receipt.at < cutoff) readReceipts.delete(entryKey);
  }
}

function expectedVersionOf(meta) {
  return String(meta.expectedVersion ?? meta.arguments?.expectedVersion ?? '').trim();
}

function verifyWriteVersion({ task, rel, abs, beforeVersion, meta, agent }) {
  if (!beforeVersion) return;
  const principalKind = meta.principal?.kind || (agent?.id ? 'agent' : 'owner');
  if (principalKind === 'system') return;
  const expectedVersion = expectedVersionOf(meta);
  const actorId = String(meta.principal?.id || agent?.id || meta.agentId || 'owner');
  if (principalKind === 'agent') {
    // Tool Gateway wraps orchestrator writes in the system principal. A prior
    // workspace.read by that agent still counts as its real read receipt.
    const receiptPrincipal = { kind: 'agent', id: agent?.id || actorId };
    const key = readReceiptKey({
      taskId: task.id,
      principal: receiptPrincipal,
      agentId: agent?.id || '',
      rel,
      abs,
    });
    const receipt = readReceipts.get(key);
    if (!receipt || Date.now() - receipt.at > READ_RECEIPT_TTL_MS) {
      fail(`写入被拒绝：Agent ${actorId} 必须先读取 ${rel} 的当前版本`, 409);
    }
    if (receipt.version !== beforeVersion) {
      fail(
        `写入冲突：${rel} 在读取后已被修改（读取版本 ${receipt.version}，当前版本 ${beforeVersion}）`,
        409,
      );
    }
    if (expectedVersion && expectedVersion !== beforeVersion) {
      fail(
        `写入冲突：${rel} 的期望版本 ${expectedVersion} 与当前版本 ${beforeVersion} 不一致`,
        409,
      );
    }
    return;
  }
  if (!expectedVersion) {
    fail(`写入被拒绝：修改 ${rel} 必须提交 expectedVersion`, 409);
  }
  if (expectedVersion !== beforeVersion) {
    fail(
      `写入冲突：${rel} 已被其他成员修改（期望版本 ${expectedVersion}，当前版本 ${beforeVersion}）`,
      409,
    );
  }
}

export function searchWorkspace(task, query, { maxFiles = MAX_SEARCH_FILES, maxResults = MAX_SEARCH_RESULTS } = {}) {
  const needle = String(query || '').trim();
  if (needle.length < 2) fail('搜索词至少需要 2 个字符', 400);
  const snapshot = listWorkspaceTree(task);
  const files = flattenTree(snapshot.tree).filter((file) => !file.sensitive);
  const results = [];
  let scanned = 0;
  for (const file of files.slice(0, maxFiles)) {
    if (file.bytes > MAX_SEARCH_BYTES) continue;
    scanned += 1;
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(snapshot.root, file.path));
    } catch {
      continue;
    }
    if (isBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const at = line.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
      if (at < 0) continue;
      results.push({
        path: file.path,
        line: index + 1,
        column: at + 1,
        text: line.trim().slice(0, 240),
      });
      if (results.length >= maxResults) {
        return { query: needle, results, scanned, truncated: true };
      }
    }
  }
  return { query: needle, results, scanned, truncated: files.length > maxFiles };
}

export function workspaceSnapshot(task) {
  const listed = listWorkspaceTree(task);
  const files = flattenTree(listed.tree);
  const changes = task.fileChanges || [];
  const events = (task.events || []).slice(-160);
  return {
    info: workspaceInfo(task),
    tree: listed.tree,
    files,
    changes,
    events,
    entries: listed.entries,
    truncated: listed.truncated,
    summary: {
      files: files.length,
      directories: listed.entries - files.length,
      added: changes.filter((change) => change.status === 'A').length,
      modified: changes.filter((change) => change.status === 'M').length,
      deleted: changes.filter((change) => change.status === 'D').length,
      renamed: changes.filter((change) => change.status === 'R').length,
    },
  };
}

export function workspaceDirectorySnapshot(task, relPath = '') {
  const listed = listWorkspaceDirectory(task, relPath);
  const files = listed.tree.filter((entry) => entry.type === 'file');
  const directories = listed.tree.filter((entry) => entry.type === 'dir');
  const changes = task.fileChanges || [];
  const events = (task.events || []).slice(-160);
  return {
    info: workspaceInfo(task),
    path: listed.path,
    lazy: true,
    tree: listed.tree,
    changes,
    events,
    entries: listed.entries,
    truncated: listed.truncated,
    summary: {
      files: files.length,
      directories: directories.length,
      added: changes.filter((change) => change.status === 'A').length,
      modified: changes.filter((change) => change.status === 'M').length,
      deleted: changes.filter((change) => change.status === 'D').length,
      renamed: changes.filter((change) => change.status === 'R').length,
    },
  };
}

function recordOperation(task, type, data = {}) {
  store.addTaskEvent(task.id, {
    type,
    runId: task.runId || null,
    agentId: data.agentId || '',
    stepId: data.stepId || '',
    data,
  });
}

function workspaceQuotaBytes() {
  return Math.max(0, Math.round(Number(store.db.settings.workspaceQuotaBytes) || 0));
}

function workspaceTrashRetentionDays() {
  return Math.max(0, Math.round(Number(store.db.settings.workspaceTrashRetentionDays) || 0));
}

function fileBytes(abs) {
  try {
    const stat = fs.statSync(abs);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function managedArtifactBytes(task) {
  return (task?.artifacts || []).reduce((sum, artifact) => {
    if (artifact.status === 'D') return sum;
    return sum + Math.max(0, Number(artifact.bytes) || 0);
  }, 0);
}

/**
 * Quota accounting uses the platform artifact ledger, not a recursive scan of
 * user-owned external projects. Files created outside the platform remain
 * visible in the workspace tree but are not silently counted as managed bytes.
 */
export function workspaceUsage(task, { pendingBytes = 0 } = {}) {
  const usedBytes = managedArtifactBytes(task);
  const limitBytes = workspaceQuotaBytes();
  const projectedBytes = usedBytes + Math.max(0, Number(pendingBytes) || 0);
  return {
    usedBytes,
    pendingBytes: Math.max(0, Number(pendingBytes) || 0),
    projectedBytes,
    limitBytes,
    remainingBytes: limitBytes > 0 ? Math.max(0, limitBytes - usedBytes) : null,
    overQuota: limitBytes > 0 && projectedBytes > limitBytes,
    enforcement: limitBytes > 0 ? 'platform-artifacts' : 'unlimited',
  };
}

function assertWorkspaceQuota(task, rel, abs, pendingBytes) {
  const usage = workspaceUsage(task, { pendingBytes });
  if (!usage.overQuota) return usage;
  const projected = usage.projectedBytes;
  recordOperation(task, 'fs.quota.denied', {
    path: rel,
    usedBytes: usage.usedBytes,
    pendingBytes: usage.pendingBytes,
    projectedBytes: projected,
    limitBytes: usage.limitBytes,
    actualFileBytes: fileBytes(abs),
  });
  fail(
    `工作区配额不足：${projected}/${usage.limitBytes} bytes，写入 ${rel} 被拒绝`,
    413,
    'workspace-quota-exceeded',
  );
}

export function pruneWorkspaceTrash(task, { now = Date.now(), dryRun = false } = {}) {
  const retentionDays = workspaceTrashRetentionDays();
  if (retentionDays <= 0) {
    return { retentionDays, scanned: 0, removed: 0, bytes: 0, dryRun: !!dryRun };
  }
  const root = rootOf(task);
  const trashRoot = path.join(root, TRASH_DIR);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let scanned = 0;
  let removed = 0;
  let bytes = 0;
  const removeExpired = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeExpired(abs);
        try {
          if (!fs.readdirSync(abs).length) fs.rmdirSync(abs);
        } catch {
          /* Another cleanup may have removed it. */
        }
        continue;
      }
      scanned += 1;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.mtimeMs > cutoff) continue;
      bytes += stat.size;
      removed += 1;
      if (!dryRun) {
        try {
          fs.rmSync(abs, { force: true });
        } catch {
          removed -= 1;
          bytes -= stat.size;
        }
      }
    }
  };
  removeExpired(trashRoot);
  if (removed > 0 && !dryRun) {
    recordOperation(task, 'fs.trash.prune', {
      retentionDays,
      scanned,
      removed,
      bytes,
    });
  }
  return { retentionDays, scanned, removed, bytes, dryRun: !!dryRun };
}

export function writeWorkspaceEntry(task, relPath, content, meta = {}, agent = null) {
  const pooled = agent ? pooledPath(task, relPath, agent) : null;
  const { rel, abs } = pooled || safePath(task, relPath);
  if (isSensitive(rel)) fail('该文件被标记为敏感文件，禁止平台写入', 403);
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_WRITE_BYTES) fail('写入内容超过 2MB', 413);
  let existing = null;
  try {
    existing = fs.statSync(abs);
  } catch {
    existing = null;
  }
  if (existing?.isDirectory()) fail('目标是目录，不能写入文件', 400);
  const previousBytes = existing ? fileBytes(abs) : 0;
  assertWorkspaceQuota(task, rel, abs, Math.max(0, bytes - previousBytes));
  const beforeVersion = existing ? versionOf(abs) : '';
  verifyWriteVersion({ task, rel, abs, beforeVersion, meta, agent });
  writeFileAtomic(abs, text);
  const afterVersion = versionOf(abs) || '';
  const principal = meta.principal || null;
  const expectedVersion = expectedVersionOf(meta);
  const artifact = {
    path: rel,
    bytes,
    mtimeMs: Date.now(),
    version: afterVersion,
    lang: langOf(rel),
    agentId: meta.agentId || '',
    stepId: meta.stepId || '',
    executionId: meta.executionId || '',
    beforeVersion,
    expectedVersion,
    principalKind: principal?.kind || (agent?.id ? 'agent' : 'owner'),
    principalId: principal?.id || meta.agentId || (agent?.id ? agent.id : 'owner'),
    source: 'platform',
  };
  store.addArtifact(task.id, artifact);
  recordOperation(task, 'fs.write', {
    ...meta,
    ...(pooled
      ? {
          workspacePool: {
            mode: pooled.mode,
            relativePath: pooled.relative,
            leaseFile: pooled.leaseFile,
          },
        }
      : {}),
    path: rel,
    bytes,
    beforeVersion,
    afterVersion,
    expectedVersion,
    principalKind: principal?.kind || (agent?.id ? 'agent' : 'owner'),
    principalId: principal?.id || meta.agentId || (agent?.id ? agent.id : 'owner'),
  });
  if (!pooled) {
    invalidateWorkspaceIndex(task, rel);
    rememberWorkspaceIndexAdd(task, rel);
  }
  if (existing) {
    const receiptPrincipal =
      principal?.kind === 'system' && (agent?.id || meta.agentId)
        ? { kind: 'agent', id: agent?.id || meta.agentId }
        : principal;
    const key = readReceiptKey({
      taskId: task.id,
      principal: receiptPrincipal,
      agentId: agent?.id || '',
      rel,
      abs,
    });
    readReceipts.delete(key);
  }
  return { path: rel, bytes, version: afterVersion, beforeVersion };
}

export function makeWorkspaceDir(task, relPath, meta = {}, agent = null) {
  const pooled = agent ? pooledPath(task, relPath, agent) : null;
  const { rel, abs } = pooled || safePath(task, relPath);
  if (fs.existsSync(abs)) {
    if (!fs.statSync(abs).isDirectory()) fail('同名路径已存在且不是目录', 409);
  } else {
    fs.mkdirSync(abs, { recursive: true });
  }
  recordOperation(task, 'fs.mkdir', {
    ...meta,
    ...(pooled ? { workspacePool: { mode: pooled.mode, relativePath: pooled.relative } } : {}),
    path: rel,
  });
  return { path: rel };
}

export function moveWorkspaceEntry(task, fromPath, toPath, meta = {}, agent = null) {
  const fromPooled = agent ? pooledPath(task, fromPath, agent) : null;
  const toPooled = agent ? pooledPath(task, toPath, agent) : null;
  const from = fromPooled || safePath(task, fromPath, { mustExist: true });
  const to = toPooled || safePath(task, toPath);
  if (from.abs === to.abs) fail('源路径和目标路径相同', 400);
  if (fs.existsSync(to.abs)) fail('目标路径已存在', 409);
  fs.mkdirSync(path.dirname(to.abs), { recursive: true });
  fs.renameSync(from.abs, to.abs);
  const isDirectory = fs.statSync(to.abs).isDirectory();
  const moved = [];
  for (const artifact of task.artifacts || []) {
    if (artifact.path !== from.rel && !artifact.path.startsWith(`${from.rel}/`)) continue;
    const nextPath = artifact.path === from.rel
      ? to.rel
      : `${to.rel}${artifact.path.slice(from.rel.length)}`;
    const oldPath = artifact.path;
    artifact.path = nextPath;
    artifact.updatedAt = Date.now();
    moved.push({ from: oldPath, to: nextPath });
    store.addFileChange(task.id, {
      path: nextPath,
      previousPath: oldPath,
      status: 'R',
      agentId: meta.agentId || '',
      stepId: meta.stepId || '',
    });
  }
  if (!moved.length) {
    store.addFileChange(task.id, {
      path: to.rel,
      previousPath: from.rel,
      status: 'R',
      agentId: meta.agentId || '',
      stepId: meta.stepId || '',
    });
  }
  store.addTaskEvent(task.id, {
    type: 'fs.move',
    runId: task.runId || null,
    agentId: meta.agentId || '',
    stepId: meta.stepId || '',
    data: { from: from.rel, to: to.rel, directory: isDirectory, moved },
  });
  if (fromPooled || toPooled) invalidateWorkspaceIndex(task);
  if (!fromPooled && !toPooled) {
    invalidateWorkspaceIndex(task, [from.rel, to.rel]);
    rememberWorkspaceIndexMove(task, from.rel, to.rel);
  }
  store.save();
  return { from: from.rel, to: to.rel, directory: isDirectory, moved };
}

export function deleteWorkspaceEntry(task, relPath, meta = {}, agent = null) {
  const pooled = agent ? pooledPath(task, relPath, agent) : null;
  const target = pooled || safePath(task, relPath, { mustExist: true });
  const root = target.root;
  if (target.abs === root) fail('不能删除工作区根目录', 403);
  const isDirectory = fs.statSync(target.abs).isDirectory();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashRel = path.posix.join(TRASH_DIR, `${stamp}-${randomUUID().slice(0, 8)}`, target.rel);
  const trashAbs = path.resolve(root, trashRel);
  assertInside(root, trashAbs);
  fs.mkdirSync(path.dirname(trashAbs), { recursive: true });
  fs.renameSync(target.abs, trashAbs);

  const affected = (task.artifacts || []).filter(
    (artifact) => artifact.path === target.rel || artifact.path.startsWith(`${target.rel}/`),
  );
  for (const artifact of affected) {
    store.markArtifactDeleted(task.id, artifact.path, {
      agentId: meta.agentId || '',
      stepId: meta.stepId || '',
      trashPath: trashRel,
    });
  }
  if (!affected.length) {
    store.addFileChange(task.id, {
      path: target.rel,
      status: 'D',
      agentId: meta.agentId || '',
      stepId: meta.stepId || '',
      trashPath: trashRel,
    });
  }
  recordOperation(task, 'fs.delete', {
    ...meta,
    path: target.rel,
    directory: isDirectory,
    trashPath: trashRel,
  });
  if (!pooled) invalidateWorkspaceIndex(task, target.rel);
  return { path: target.rel, directory: isDirectory, trashPath: trashRel };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function restoreJson(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, cloneJson(snapshot));
}

function restorePath(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) {
    fail(`事务回滚失败：目标路径已存在 ${to}`, 409);
  }
  fs.renameSync(from, to);
}

/**
 * Applies a batch as one logical operation. Validation happens before the
 * first mutation; runtime failures restore both real paths and task metadata.
 */
export function applyWorkspaceTransaction(task, operations, meta = {}, agent = null) {
  if (!Array.isArray(operations) || !operations.length) {
    fail('事务至少需要一个操作', 400);
  }
  if (operations.length > 100) fail('事务最多支持 100 个操作', 413);
  const transactionId = String(meta.transactionId || randomUUID());
  const plan = operations.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(`事务第 ${index + 1} 步必须是对象`, 400);
    }
    const op = String(raw.op || '');
    if (!['write', 'mkdir', 'move', 'delete'].includes(op)) {
      fail(`事务第 ${index + 1} 步不支持操作：${op || '(empty)'}`, 400);
    }
    const stepMeta = {
      ...meta,
      expectedVersion: String(raw.expectedVersion || '').trim(),
      transactionId,
      transactionIndex: index + 1,
    };
    const resolvePath = (rel) => {
      const pooled = agent ? pooledPath(task, rel, agent) : null;
      return pooled || safePath(task, rel);
    };
    return { raw, index, op, stepMeta };
  });
  const preflight = plan.map(({ raw, index, op, stepMeta }) => {
    const resolvePath = (rel) => {
      const pooled = agent ? pooledPath(task, rel, agent) : null;
      return pooled || safePath(task, rel);
    };
    if (op === 'move') {
      if (!String(raw.from || '').trim() || !String(raw.to || '').trim()) {
        fail(`事务第 ${index + 1} 步缺少 from/to`, 400);
      }
      const from = resolvePath(raw.from);
      const to = resolvePath(raw.to);
      if (from.abs === to.abs) fail(`事务第 ${index + 1} 步源和目标相同`, 400);
      if (fs.existsSync(to.abs)) fail(`事务第 ${index + 1} 步目标路径已存在：${raw.to}`, 409);
      return {
        op,
        index,
        from,
        to,
        rawFrom: String(raw.from),
        rawTo: String(raw.to),
        meta: stepMeta,
      };
    }
    if (!String(raw.path || '').trim()) fail(`事务第 ${index + 1} 步缺少 path`, 400);
    const target = resolvePath(raw.path);
    if (op === 'delete' && target.abs === target.root) {
      fail('不能删除工作区根目录', 403);
    }
    if (op === 'mkdir' && fs.existsSync(target.abs) && !fs.statSync(target.abs).isDirectory()) {
      fail(`事务第 ${index + 1} 步同名路径不是目录`, 409);
    }
    if (op === 'write') {
      if (isSensitive(target.rel)) fail('该文件被标记为敏感文件，禁止平台写入', 403);
      const bytes = Buffer.byteLength(String(raw.content ?? ''));
      if (bytes > MAX_WRITE_BYTES) fail(`事务第 ${index + 1} 步写入超过 2MB`, 413);
      if (fs.existsSync(target.abs) && fs.statSync(target.abs).isDirectory()) {
        fail(`事务第 ${index + 1} 步目标是目录，不能写入文件`, 400);
      }
      if (fs.existsSync(target.abs)) {
        verifyWriteVersion({
          task,
          rel: target.rel,
          abs: target.abs,
          beforeVersion: versionOf(target.abs) || '',
          meta: stepMeta,
          agent,
        });
      }
    }
    return {
      op,
      index,
      target,
      rawPath: String(raw.path),
      content: String(raw.content ?? ''),
      meta: stepMeta,
    };
  });

  for (const step of preflight) {
    if (step.op === 'move' && !fs.existsSync(step.from.abs)) {
      fail(`事务第 ${step.index + 1} 步源路径不存在：${step.rawFrom}`, 404);
    }
  }
  const artifactsBefore = cloneJson(task.artifacts || []);
  const changesBefore = cloneJson(task.fileChanges || []);
  const statsBefore = cloneJson(task.stats || {});
  const receiptsBefore = new Map(
    [...readReceipts.entries()].filter(([key]) => key.startsWith(`${task.id}:`)),
  );
  const undo = [];
  const applied = [];
  const txMeta = { ...meta, transactionId };
  const runStep = (step) => {
    if (step.op === 'write') {
      const existing = fs.existsSync(step.target.abs);
      if (existing && fs.statSync(step.target.abs).isDirectory()) {
        fail(`事务第 ${step.index + 1} 步目标是目录，不能写入文件`, 400);
      }
      const before = existing ? fs.readFileSync(step.target.abs) : null;
      const existedBefore = existing;
      const result = writeWorkspaceEntry(
        task,
        step.rawPath,
        step.content,
        step.meta,
        agent,
      );
      undo.push(() => {
        if (before) {
          fs.mkdirSync(path.dirname(step.target.abs), { recursive: true });
          fs.writeFileSync(step.target.abs, before);
        } else if (!existedBefore) fs.rmSync(step.target.abs, { force: true });
      });
      return result;
    }
    if (step.op === 'mkdir') {
      const existed = fs.existsSync(step.target.abs);
      const result = makeWorkspaceDir(task, step.rawPath, step.meta, agent);
      if (!existed) undo.push(() => fs.rmSync(step.target.abs, { recursive: true, force: true }));
      return result;
    }
    if (step.op === 'move') {
      const result = moveWorkspaceEntry(task, step.rawFrom, step.rawTo, step.meta, agent);
      undo.push(() => restorePath(step.to.abs, step.from.abs));
      return result;
    }
    const result = deleteWorkspaceEntry(task, step.rawPath, step.meta, agent);
    undo.push(() => restorePath(path.resolve(step.target.root, result.trashPath), step.target.abs));
    return result;
  };

  try {
    for (const step of preflight) {
      applied.push({ op: step.op, result: runStep(step) });
    }
  } catch (err) {
    if (!applied.length && err?.status && err.status < 500) {
      // All preflight checks run before the first mutation, so validation
      // failures need no rollback and must not create a misleading audit entry.
      throw err;
    }
    const rollbackErrors = [];
    for (const restore of undo.reverse()) {
      try {
        restore();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    restoreJson(task.artifacts, artifactsBefore);
    restoreJson(task.fileChanges, changesBefore);
    restoreJson(task.stats, statsBefore);
    if (!Array.isArray(task.events)) task.events = [];
    task.events = task.events.filter(
      (event) => String(event.data?.transactionId || '') !== transactionId,
    );
    for (const key of [...readReceipts.keys()]) {
      if (key.startsWith(`${task.id}:`)) readReceipts.delete(key);
    }
    for (const [key, receipt] of receiptsBefore) readReceipts.set(key, receipt);
    store.save({ tasks: [task.id] });
    recordOperation(task, 'fs.transaction.rollback', {
      ...txMeta,
      transactionId,
      failedAt: applied.length + 1,
      error: err.message,
      rolledBack: applied.length,
      rollbackErrors,
    });
    invalidateWorkspaceIndex(task);
    if (rollbackErrors.length) {
      fail(`事务失败且回滚不完整：${rollbackErrors.join('; ')}`, 500);
    }
    throw err;
  }

  recordOperation(task, 'fs.transaction.commit', {
    ...txMeta,
    transactionId,
    operations: applied.length,
  });
  store.save({ tasks: [task.id] });
  return { transactionId, operations: applied };
}

export function workspaceDiff(task, relPath) {
  const info = workspaceInfo(task);
  const { rel } = safePath(task, relPath, { mustExist: false, allowEmpty: true });
  if (!info.isGit) {
    return { available: false, reason: '当前工作区不是 Git 仓库，暂无基线 diff', path: rel };
  }
  const hasHead = runGit(info.path, ['rev-parse', '--verify', 'HEAD'], 5000).ok;
  const args = ['diff', '--no-ext-diff', '--unified=3'];
  if (hasHead) args.push('HEAD');
  if (rel) args.push('--', rel);
  const result = runGit(info.path, args, 5000);
  const untracked = untrackedDiff(info.path, rel);
  const diff = [result.stdout, ...untracked].filter(Boolean).join('\n\n');
  return {
    available: true,
    path: rel,
    diff,
    untracked: untracked.length,
    error: result.ok || diff ? '' : result.stderr,
  };
}

export { MAX_PREVIEW_BYTES, MAX_WRITE_BYTES };
