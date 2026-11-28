/**
 * 文件落盘的原子性与内容版本。
 *
 * 原来 writeWorkspaceFile 直接 fs.writeFileSync：进程在写一半被杀就是截断文件，
 * 原内容也没了。这里换成「同级临时文件 + fsync + rename」，rename 在同一文件系统内
 * 是原子交换，读者要么看到旧内容要么看到新内容。
 *
 * 另外提供 versionOf()：内容摘要前 16 位，比 mtime+size 可靠（等长改写也能发现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withinRoot } from './path-roots.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 跟随 AGENTFORGE_DATA_DIR（测试用临时目录），否则落在仓库 data/spill。 */
export function spillRoot() {
  const base = process.env.AGENTFORGE_DATA_DIR
    ? path.resolve(process.env.AGENTFORGE_DATA_DIR)
    : path.join(REPO_ROOT, 'data');
  return path.join(base, 'spill');
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP, 0, 0, ms);
}

function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      // Windows 上目标正被别的进程读/写时会 EPERM/EBUSY：短暂退避后重试
      if (!RETRYABLE.has(err.code) || i >= attempts) {
        try {
          fs.unlinkSync(from);
        } catch {
          /* 临时文件清理失败不影响主流程 */
        }
        throw err;
      }
      sleepSync(Math.min(25 * 2 ** i, 400));
    }
  }
}

/** 原子写。mode 必填，避免 chmod 竞态；`wx` 拒绝跟随预埋的符号链接。 */
export function writeFileAtomic(abs, content, { mode = 0o644 } = {}) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    // 内容先落盘再交换，否则 rename 之后仍可能是一个空文件
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(tmp, abs);
  return abs;
}

/** 内容版本：sha256 前 16 位；文件不存在返回 null（= 缺失观测）。 */
export function versionOf(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * 大文本落盘，返回句柄而不是内容。
 * 用途：上游产物太长时，prompt 里只放路径 + 摘录，模型需要细节自己读——
 * 比 clip() 直接丢掉中间段好，信息不会不可恢复地消失。
 */
export function spillText({ taskId, name, content }) {
  const text = String(content ?? '');
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const safeName = String(name || 'text').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'text';
  const abs = path.join(spillRoot(), String(taskId || 'misc'), `${safeName}-${sha.slice(0, 8)}.md`);
  if (!fs.existsSync(abs)) writeFileAtomic(abs, text);
  const bytes = Buffer.byteLength(text);
  const excerpt = text.length > 1600 ? `${text.slice(0, 1200)}\n\n…（已截断，共 ${text.length} 字）…\n\n${text.slice(-320)}` : text;
  return {
    locator: abs,
    bytes,
    sha256: sha,
    excerpt,
    retrievalHint: `需要细节时读取该只读路径：${abs}`,
    preview: excerpt.slice(0, 500),
  };
}

/**
 * Read a spill reference back only after validating its content hash and size.
 * A locator is a handle, not a promise that the file is still intact.
 */
export function readSpillText(ref, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const locator = String(ref?.locator || ref?.path || '');
  if (!locator) {
    const error = new Error('spill 引用缺少路径');
    error.code = 'SPILL_INVALID';
    throw error;
  }
  const abs = path.resolve(locator);
  const root = path.resolve(spillRoot());
  if (!withinRoot(abs, root)) {
    const error = new Error('spill 引用不在 spill 根目录内');
    error.code = 'SPILL_OUTSIDE_ROOT';
    throw error;
  }
  const linkStat = (() => {
    try {
      return fs.lstatSync(abs);
    } catch {
      const error = new Error('spill 引用不存在');
      error.code = 'SPILL_INVALID';
      throw error;
    }
  })();
  if (linkStat.isSymbolicLink()) {
    const error = new Error('spill 引用不能是符号链接');
    error.code = 'SPILL_SYMLINK';
    throw error;
  }
  // 目录本身可能是符号链接，解析真实路径后再判一次。
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const realAbs = fs.realpathSync(abs);
  if (!withinRoot(realAbs, realRoot)) {
    const error = new Error('spill 引用经符号链接逃逸出根目录');
    error.code = 'SPILL_OUTSIDE_ROOT';
    throw error;
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    const error = new Error('spill 引用不是普通文件');
    error.code = 'SPILL_NOT_FILE';
    throw error;
  }
  if (stat.size > maxBytes) {
    const error = new Error(`spill 文件超过读取上限：${stat.size} bytes`);
    error.code = 'SPILL_TOO_LARGE';
    throw error;
  }
  const content = fs.readFileSync(locator, 'utf8');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  if (ref?.sha256 && sha256 !== String(ref.sha256)) {
    const error = new Error('spill 文件摘要不匹配，内容可能已损坏');
    error.code = 'SPILL_HASH_MISMATCH';
    throw error;
  }
  const bytes = Buffer.byteLength(content);
  if (ref?.bytes !== undefined && Number(ref.bytes) !== bytes) {
    const error = new Error('spill 文件大小不匹配，内容可能已损坏');
    error.code = 'SPILL_SIZE_MISMATCH';
    throw error;
  }
  return { content, bytes, sha256 };
}

/**
 * Store arbitrary content as a content-addressed attachment. Used for exports,
 * binary attachments and any large payload that should not enter db.json.
 */
export function spillAttachment({ taskId, name, content, mime = 'application/octet-stream', extension = '' }) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeName = String(name || 'attachment').replace(/[^\w.-]+/g, '-').slice(0, 48) || 'attachment';
  const ext = String(extension || '').replace(/^\.+/, '').replace(/[^\w-]/g, '').slice(0, 12);
  const suffix = ext ? `.${ext}` : '';
  const abs = path.join(spillRoot(), String(taskId || 'misc'), `${safeName}-${sha.slice(0, 8)}${suffix}`);
  if (!fs.existsSync(abs)) writeFileAtomic(abs, buffer);
  return {
    locator: abs,
    bytes: buffer.length,
    sha256: sha,
    mime: String(mime || 'application/octet-stream'),
    retrievalHint: `需要时读取该只读路径：${abs}`,
  };
}

/**
 * Compact a large value into a persisted reference. The returned object keeps
 * the original shape's metadata but never the unbounded content.
 */
export function spillValue({ taskId, name, value, textKey = 'text', mime = 'application/json' }) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  const ref = spillAttachment({
    taskId,
    name,
    content: raw,
    mime,
    extension: mime.includes('json') ? 'json' : 'txt',
  });
  return {
    [textKey]: String(raw).length > 1600 ? `${String(raw).slice(0, 1200)}\n\n…（已截断，共 ${String(raw).length} 字）…\n\n${String(raw).slice(-320)}` : String(raw),
    spill: {
      locator: ref.locator,
      bytes: ref.bytes,
      sha256: ref.sha256,
      mime: ref.mime,
      retrievalHint: ref.retrievalHint,
    },
  };
}
