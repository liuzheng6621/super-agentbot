import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-spill-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { readSpillText, spillText } = await import('../server/fs.mjs');
const { attachmentRoot, readAttachment } = await import('../server/attachments.mjs');

function makeSymlink(target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  }
}

test('spill round trip still works inside the spill root', () => {
  const spilled = spillText({ taskId: 'task-1', name: 'note', content: 'hello spill' });
  const read = readSpillText(spilled);
  assert.equal(read.content, 'hello spill');
  assert.equal(read.sha256, spilled.sha256);
});

test('spill locator outside the root is rejected before reading', () => {
  const outside = path.join(temp, 'outside.txt');
  fs.writeFileSync(outside, 'secret', 'utf8');
  const ref = {
    locator: outside,
    sha256: crypto.createHash('sha256').update('secret').digest('hex'),
    bytes: 'secret'.length,
  };
  assert.throws(
    () => readSpillText(ref),
    (err) => {
      assert.equal(err.code, 'SPILL_OUTSIDE_ROOT');
      return true;
    },
  );
});

test('spill locator traversal is rejected', () => {
  const ref = { locator: path.join(temp, 'spill', '..', 'db.json') };
  assert.throws(
    () => readSpillText(ref),
    (err) => {
      assert.equal(err.code, 'SPILL_OUTSIDE_ROOT');
      return true;
    },
  );
});

test('spill symlink pointing outside the root is rejected', (t) => {
  const root = path.join(temp, 'spill', 'task-symlink');
  fs.mkdirSync(root, { recursive: true });
  const outside = path.join(temp, 'symlink-target.txt');
  fs.writeFileSync(outside, 'leak', 'utf8');
  const link = path.join(root, 'link.md');
  if (!makeSymlink(outside, link)) {
    t.diagnostic('symlink creation unavailable, skipping');
    return;
  }
  assert.throws(
    () => readSpillText({ locator: link }),
    (err) => {
      assert.ok(['SPILL_SYMLINK', 'SPILL_OUTSIDE_ROOT'].includes(err.code), err.code);
      return true;
    },
  );
});

test('attachment read rejects a symlinked content-addressed file', (t) => {
  const sha = 'a'.repeat(64);
  const mime = 'image/png';
  const dir = path.join(attachmentRoot(), sha.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(temp, 'attachment-target.bin');
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
    'hex',
  );
  fs.writeFileSync(target, png);
  const link = path.join(dir, `${sha}.png`);
  try {
    fs.unlinkSync(link);
  } catch {
    /* nothing planted yet */
  }
  if (!makeSymlink(target, link)) {
    t.diagnostic('symlink creation unavailable, skipping');
    return;
  }
  assert.throws(
    () => readAttachment({ sha256: sha, mime, bytes: png.length }),
    (err) => {
      assert.ok(['IMAGE_SYMLINK', 'IMAGE_OUTSIDE_ROOT'].includes(err.code), err.code);
      return true;
    },
  );
});
