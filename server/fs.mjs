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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 跟随 AGENTFORGE_DATA_DIR（测试用临时目录），否则落在仓库 data/spill。 */
function spillRoot() {
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
  return { locator: abs, bytes: Buffer.byteLength(text), sha256: sha };
}
