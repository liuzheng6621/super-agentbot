import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-attachments-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const {
  ATTACHMENT_LIMITS,
  AttachError,
  admitImage,
  attachmentAbsolutePath,
  readAttachment,
} = await import('../server/attachments.mjs');
const { store } = await import('../server/store.mjs');
const { buildContextPack, buildPrompt, chat } = await import('../server/orchestrator.mjs');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function makePng(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < width; x += 1) rows.push(Buffer.from([255, 0, 0, 255]));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND'),
  ]);
}

function makeGif(width = 1, height = 1) {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function makeJpeg(width = 1, height = 1) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function makeWebp(width = 1, height = 1) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBPVP8X', 8, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

test('图片按文件签名识别、内容寻址去重并校验尺寸', () => {
  for (const [name, buffer, mime] of [
    ['red.png', makePng(), 'image/png'],
    ['red.jpg', makeJpeg(), 'image/jpeg'],
    ['red.webp', makeWebp(), 'image/webp'],
    ['red.gif', makeGif(), 'image/gif'],
  ]) {
    const image = admitImage(buffer, { name });
    assert.equal(image.mime, mime);
    assert.equal(image.width, 1);
    assert.equal(image.height, 1);
    assert.equal(image.bytes, buffer.length);
    assert.ok(fs.existsSync(attachmentAbsolutePath(image)));
    assert.equal(readAttachment(image).bytes, buffer.length);
  }

  const first = admitImage(makePng(), { name: 'one.png' });
  const second = admitImage(makePng(), { name: 'two.png' });
  assert.equal(first.sha256, second.sha256);
  assert.equal(attachmentAbsolutePath(first), attachmentAbsolutePath(second));
  assert.equal(
    fs.readdirSync(path.dirname(attachmentAbsolutePath(first))).length,
    1,
    '相同内容只落一个对象',
  );

  assert.throws(
    () => admitImage(Buffer.from('not an image'), { name: 'fake.png' }),
    (err) => err instanceof AttachError && err.code === 'IMAGE_UNSUPPORTED_FORMAT',
  );
  assert.throws(
    () => admitImage(makePng(2, 2), { name: 'too-many-pixels.png', maxPixels: 3 }),
    (err) => err.code === 'IMAGE_PIXELS_TOO_LARGE',
  );
  assert.throws(
    () => admitImage(makePng(2, 2), { name: 'too-wide.png', maxDim: 1 }),
    (err) => err.code === 'IMAGE_DIMENSION_TOO_LARGE',
  );
  assert.throws(
    () => admitImage(makePng(), { name: 'too-big.png', maxBytes: 20 }),
    (err) => err.code === 'IMAGE_TOO_LARGE',
  );
  assert.equal(ATTACHMENT_LIMITS.maxBytes, 8 * 1024 * 1024);
});

test('持久消息只保存附件引用，不保存 base64 或本地绝对路径', () => {
  const task = store.createTask({ goal: '图片附件样本' });
  const image = admitImage(makePng(), { name: 'red.png' });
  const provider = store.addProvider({
    id: 'vision-test',
    name: 'Vision Test',
    capabilities: ['chat', 'vision'],
  });
  const message = store.addImageMessage(
    task.id,
    {
      agentId: 'user',
      name: '你',
      role: 'user',
      title: 'Owner',
      color: '#94a3b8',
      kind: 'image',
      text: '请分析这张图',
    },
    image,
    { provider },
  );
  assert.equal(store.taskHasAttachment(task.id, image.sha256, image.mime), true);
  assert.equal(store.taskHasAttachment(task.id, image.sha256, 'image/jpeg'), false);
  const persisted = store.getTask(task.id).messages.find((item) => item.id === message.id);
  assert.equal(persisted.kind, 'image');
  assert.equal(persisted.image.sha256, image.sha256);
  assert.equal(persisted.image.path, undefined);
  assert.equal(persisted.image.abs, undefined);
  const serialized = JSON.stringify(persisted);
  assert.ok(!serialized.includes('base64'));
  assert.ok(!serialized.includes(temp));

  const pack = buildContextPack(store.getTask(task.id), { files: [] });
  assert.equal(pack.images.length, 1);
  assert.equal(pack.images[0].sha256, image.sha256);
  const cliPrompt = buildPrompt(
    { goal: '图片附件样本' },
    { name: 'Codex', title: '实现工程师', role: 'coder', mode: 'cli', tools: [] },
    null,
    '无',
    pack,
  );
  assert.doesNotMatch(cliPrompt, /data:image\/png;base64,/);
  assert.ok(cliPrompt.includes(attachmentAbsolutePath(image)));

  const simPrompt = buildPrompt(
    { goal: '图片附件样本' },
    { name: 'Sim', title: '实现工程师', role: 'coder', mode: 'sim', tools: [] },
    null,
    '无',
    pack,
  );
  assert.match(simPrompt, /data:image\/png;base64,/);
});

test('图片消息按实际目标成员的视觉 Provider 校验', async () => {
  const task = store.createTask({ goal: '按目标成员选择视觉 Provider' });
  const planner = store.findAgentByRole('planner');
  const provider = store.addProvider({
    id: 'planner-vision',
    name: 'Planner Vision',
    capabilities: ['chat', 'vision'],
  });
  store.updateAgent(planner.id, { providerId: provider.id, mode: 'sim' });
  const image = admitImage(makePng(), { name: 'red.png' });
  store.addTaskAttachment(task.id, image);

  const pending = chat(task.id, '看一下这张图', { speed: 20, image });
  const persisted = store.getTask(task.id).messages.find((item) => item.kind === 'image');
  assert.ok(persisted, '视觉 Provider 有效时应写入图片消息');
  await pending;
});

test('不支持视觉的 Provider 明确拒绝图片且消息不落库', () => {
  const task = store.createTask({ goal: '视觉能力门禁' });
  const provider = store.getProvider('local-default');
  const before = task.messages.length;
  assert.equal(provider.capabilities.includes('vision'), false);
  const image = admitImage(makePng(), { name: 'red.png' });
  assert.throws(
    () =>
      store.addImageMessage(
        task.id,
        {
          agentId: 'user',
          name: '你',
          role: 'user',
          kind: 'image',
          text: '看图',
        },
        image,
        { provider },
      ),
    (err) => err.code === 'IMAGE_UNSUPPORTED_MODEL',
  );
  assert.equal(store.getTask(task.id).messages.length, before);
});
