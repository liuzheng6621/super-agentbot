import fs from 'node:fs';
import path from 'node:path';
import { attachmentRoot } from './attachments.mjs';
import { spillRoot } from './fs.mjs';

const IMAGE_EXT = /\.(?:png|jpg|jpeg|webp|gif)$/i;

function collectStrings(value, visit, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, visit, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, visit, depth + 1);
  }
}

/**
 * Build the reference set from every task: spill locators (absolute paths under
 * the spill root) and content-addressed attachment hashes. Content addressing
 * means one file can back many tasks — a reference anywhere keeps it alive.
 */
export function collectReferences(tasks = [], { spill = spillRoot() } = {}) {
  const spillLocators = new Set();
  const attachmentSha256 = new Set();
  const root = path.resolve(spill);
  for (const task of tasks) {
    collectStrings(task, (text) => {
      if (text.startsWith(root)) {
        try {
          spillLocators.add(path.resolve(text));
        } catch {
          /* ignore malformed locator */
        }
      }
    });
    for (const image of task?.attachments || []) {
      const sha = String(image?.sha256 || '').toLowerCase();
      if (/^[a-f0-9]{64}$/.test(sha)) attachmentSha256.add(sha);
    }
    for (const artifact of task?.artifacts || []) {
      const sha = String(artifact?.sha256 || '').toLowerCase();
      if (/^[a-f0-9]{64}$/.test(sha)) attachmentSha256.add(sha);
    }
  }
  return { spillLocators, attachmentSha256 };
}

function walkFiles(root, visit) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(abs, visit);
    else if (entry.isFile()) visit(abs, entry);
  }
}

function shouldDelete(abs, { referenced, retentionDays, now }) {
  if (referenced) return false;
  if (retentionDays <= 0) return true;
  try {
    const { mtimeMs } = fs.statSync(abs);
    return now - mtimeMs > retentionDays * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Reference-aware GC for spill files and attachments.
 * `retentionDays > 0` keeps unreferenced files for a grace period; referenced
 * files are never removed, even when shared across tasks.
 */
export function gcStorage({
  tasks = [],
  retentionDays = 0,
  now = Date.now(),
  dryRun = false,
} = {}) {
  const spill = spillRoot();
  const attachments = attachmentRoot();
  const refs = collectReferences(tasks, { spill });
  const stats = {
    spill: { scanned: 0, removed: 0, kept: 0, bytes: 0 },
    attachments: { scanned: 0, removed: 0, kept: 0, bytes: 0 },
    retentionDays,
    dryRun,
  };

  walkFiles(spill, (abs) => {
    stats.spill.scanned += 1;
    const referenced = refs.spillLocators.has(path.resolve(abs));
    if (shouldDelete(abs, { referenced, retentionDays, now })) {
      let bytes = 0;
      try {
        bytes = fs.statSync(abs).size;
      } catch {
        /* already gone */
      }
      if (!dryRun) {
        try {
          fs.rmSync(abs, { force: true });
        } catch {
          return;
        }
      }
      stats.spill.removed += 1;
      stats.spill.bytes += bytes;
    } else {
      stats.spill.kept += 1;
    }
  });

  walkFiles(attachments, (abs) => {
    if (!IMAGE_EXT.test(abs)) return;
    stats.attachments.scanned += 1;
    const sha = path.basename(abs).slice(0, 64).toLowerCase();
    const referenced = refs.attachmentSha256.has(sha);
    if (shouldDelete(abs, { referenced, retentionDays, now })) {
      let bytes = 0;
      try {
        bytes = fs.statSync(abs).size;
      } catch {
        /* already gone */
      }
      if (!dryRun) {
        try {
          fs.rmSync(abs, { force: true });
        } catch {
          return;
        }
      }
      stats.attachments.removed += 1;
      stats.attachments.bytes += bytes;
    } else {
      stats.attachments.kept += 1;
    }
  });

  return stats;
}

/** Cascade delete for one task: its spill directory dies with the task. */
export function removeTaskSpill(taskId) {
  const id = String(taskId || '').trim();
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) return false;
  const dir = path.join(spillRoot(), id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
