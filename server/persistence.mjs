import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeTextAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, value, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* Best effort cleanup; the original file remains authoritative. */
    }
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value));
}

/**
 * Cross-process file lock. `wx` guarantees only one writer creates the lock;
 * stale holders (dead pid or old lock) are reclaimed after `staleMs`.
 */
export function acquireFileLockSync(
  lockFile,
  { timeoutMs = 5000, staleMs = 15000, dataDir = path.dirname(lockFile) } = {},
) {
  fs.mkdirSync(dataDir, { recursive: true });
  const started = Date.now();
  const token = randomUUID();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
          'utf8',
        );
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const holder = readJsonFile(lockFile, null);
      let fileAge = Number.POSITIVE_INFINITY;
      try {
        fileAge = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        /* Lock disappeared between open and stat; retry immediately. */
      }
      const alive = holder?.pid ? processIsAlive(Number(holder.pid)) : false;
      if (!alive || fileAge > staleMs) {
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          /* Another contender may have removed it first. */
        }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        const error = new Error(`等待数据文件锁超时：${lockFile}`);
        error.code = 'STORE_LOCK_TIMEOUT';
        throw error;
      }
      sleepSync(15);
    }
  }
}

export function releaseFileLockSync(lockFile, token) {
  const holder = readJsonFile(lockFile, null);
  if (!holder) return false;
  if (token && holder.token !== token) return false;
  try {
    fs.rmSync(lockFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Per-task shard storage: `tasks/<id>.json` plus `tasks/index.json`.
 * A shard is written atomically, so a crash leaves either the old or the new
 * version — never a truncated task. The index is a cache; a missing or stale
 * index is rebuilt by scanning the shard directory.
 */
export class TaskShardStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.indexFile = path.join(this.dir, 'index.json');
  }

  shardFile(id) {
    const safe = String(id || '').replace(/[^\w.-]/g, '');
    if (!safe) throw new Error('任务分片缺少 id');
    return path.join(this.dir, `${safe}.json`);
  }

  listIds() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .filter((name) => name !== 'index')
      .sort();
  }

  readIndex() {
    const index = readJsonFile(this.indexFile, null);
    if (!index || !Array.isArray(index.ids)) return null;
    return index;
  }

  writeIndex(ids) {
    const unique = [...new Set((ids || []).map(String).filter(Boolean))];
    writeJsonAtomic(this.indexFile, {
      version: 1,
      updatedAt: Date.now(),
      count: unique.length,
      ids: unique,
    });
    return unique;
  }

  readShard(id) {
    return readJsonFile(this.shardFile(id), null);
  }

  writeShard(task) {
    if (!task?.id) throw new Error('任务分片缺少 id');
    writeJsonAtomic(this.shardFile(task.id), task);
    return task;
  }

  removeShard(id) {
    try {
      fs.rmSync(this.shardFile(id), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Load all shards, rebuilding the index when it is missing or stale. */
  loadAll() {
    const index = this.readIndex();
    const onDisk = this.listIds();
    const ids = [...new Set([...(index?.ids || []), ...onDisk])];
    const tasks = [];
    const live = [];
    for (const id of ids) {
      const task = this.readShard(id);
      if (task?.id) {
        tasks.push(task);
        live.push(id);
      }
    }
    const indexStale =
      !index ||
      index.ids.length !== live.length ||
      live.some((id) => !index.ids.includes(id));
    if (indexStale) this.writeIndex(live);
    return tasks;
  }

  /**
   * One-time migration from a monolithic `db.json` tasks array.
   * Returns the migrated tasks; the caller rewrites db.json without them.
   */
  migrate(tasks = [], { backupFile = '' } = {}) {
    const existing = this.loadAll();
    const byId = new Map(existing.map((task) => [task.id, task]));
    let migrated = 0;
    for (const task of tasks) {
      if (!task?.id) continue;
      if (!byId.has(task.id)) {
        this.writeShard(task);
        byId.set(task.id, task);
        migrated += 1;
      }
    }
    this.writeIndex([...byId.keys()]);
    if (backupFile) {
      try {
        if (fs.existsSync(backupFile)) fs.copyFileSync(backupFile, `${backupFile}.bak`);
      } catch {
        /* 备份失败不阻塞迁移，db.json 本身仍是完整副本 */
      }
    }
    return { tasks: [...byId.values()], migrated };
  }
}
