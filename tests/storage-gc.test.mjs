import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-gc-'));
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_SKIP_TEAM_BOOTSTRAP = '1';

const { spillText, spillRoot } = await import('../server/fs.mjs');
const { attachmentRoot } = await import('../server/attachments.mjs');
const { collectReferences, gcStorage, removeTaskSpill } = await import('../server/gc.mjs');

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may keep a handle briefly. */
  }
});

function writeAttachment(sha) {
  const dir = path.join(attachmentRoot(), sha.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha}.png`);
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return file;
}

test('collectReferences finds spill locators and content-addressed hashes', () => {
  const spilled = spillText({ taskId: 'ref-task', name: 'note', content: 'referenced' });
  const sha = 'b'.repeat(64);
  const refs = collectReferences([
    {
      id: 'ref-task',
      messages: [{ text: { locator: spilled.locator } }],
      attachments: [{ sha256: sha, mime: 'image/png' }],
    },
  ]);
  assert.equal(refs.spillLocators.has(path.resolve(spilled.locator)), true);
  assert.equal(refs.attachmentSha256.has(sha), true);
});

test('gc removes unreferenced files and keeps shared content-addressed ones', () => {
  const kept = spillText({ taskId: 'keep-task', name: 'note', content: 'keep me' });
  const orphan = spillText({ taskId: 'orphan-task', name: 'note', content: 'delete me' });
  const keptSha = 'c'.repeat(64);
  const orphanSha = 'd'.repeat(64);
  const keptFile = writeAttachment(keptSha);
  const orphanFile = writeAttachment(orphanSha);

  const tasks = [
    {
      id: 'keep-task',
      messages: [{ text: { locator: kept.locator } }],
      attachments: [{ sha256: keptSha, mime: 'image/png' }],
    },
  ];
  const stats = gcStorage({ tasks, retentionDays: 0 });
  assert.equal(fs.existsSync(kept.locator), true, '被引用的 spill 必须保留');
  assert.equal(fs.existsSync(orphan.locator), false, '无引用的 spill 必须清理');
  assert.equal(fs.existsSync(keptFile), true);
  assert.equal(fs.existsSync(orphanFile), false);
  assert.ok(stats.spill.removed >= 1);
  assert.ok(stats.attachments.removed >= 1);
});

test('retention keeps fresh orphans until they age out', () => {
  const fresh = spillText({ taskId: 'fresh-task', name: 'note', content: 'fresh orphan' });
  const stats = gcStorage({ tasks: [], retentionDays: 30 });
  assert.equal(fs.existsSync(fresh.locator), true);
  assert.equal(stats.spill.removed, 0);

  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  fs.utimesSync(fresh.locator, new Date(old), new Date(old));
  gcStorage({ tasks: [], retentionDays: 30 });
  assert.equal(fs.existsSync(fresh.locator), false, '超过保留期后可清理');
});

test('dry run reports without deleting, task spill cascade removes its directory', () => {
  const spilled = spillText({ taskId: 'cascade-task', name: 'note', content: 'cascade' });
  const dry = gcStorage({ tasks: [], retentionDays: 0, dryRun: true });
  assert.equal(fs.existsSync(spilled.locator), true);
  assert.ok(dry.spill.removed >= 1);

  assert.equal(removeTaskSpill('cascade-task'), true);
  assert.equal(fs.existsSync(path.join(spillRoot(), 'cascade-task')), false);
  assert.equal(removeTaskSpill('../escape'), false, '非法任务 id 不能删除目录');
});
