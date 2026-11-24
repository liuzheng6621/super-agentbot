/**
 * 纯 Node 生成应用图标（无第三方依赖）
 * 输出：public/icon-256.png（网页图标） + desktop/icon.ico（Windows 快捷方式图标）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 画布 ---------------- */

const W = 256;
const H = 256;
const canvas = Buffer.alloc(W * H * 4);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const CREAM = hex('#fff4d6');
const INK = hex('#173d3b');
const ORANGE = hex('#ff5538');
const LEAF = hex('#b8d94f');

function set(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  canvas[i] = r;
  canvas[i + 1] = g;
  canvas[i + 2] = b;
  canvas[i + 3] = a;
}

function rect(x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, color);
}

const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);

function tri(p1, p2, p3, color) {
  const minX = Math.max(0, Math.floor(Math.min(p1[0], p2[0], p3[0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p1[0], p2[0], p3[0])));
  const minY = Math.max(0, Math.floor(Math.min(p1[1], p2[1], p3[1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p1[1], p2[1], p3[1])));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d1 = sign(px, py, p1[0], p1[1], p2[0], p2[1]);
      const d2 = sign(px, py, p2[0], p2[1], p3[0], p3[1]);
      const d3 = sign(px, py, p3[0], p3[1], p1[0], p1[1]);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) set(x, y, color);
    }
  }
}

function scaleAbout(p, c, k, dy = 0) {
  return [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k + dy];
}

/* 底板 */
rect(0, 0, W, H, CREAM);

/* 墨绿描边框 */
const B = 12;
rect(0, 0, W, B, INK);
rect(0, H - B, W, B, INK);
rect(0, 0, B, H, INK);
rect(W - B, 0, B, H, INK);

/* 中间色块 */
rect(B, H - B - 18, W - B * 2, 6, LEAF);

/* 山形徽标：外描边 → 橙色 → 内部挖空 */
const A = [128, 46];
const L = [40, 200];
const R = [216, 200];
const C = [(A[0] + L[0] + R[0]) / 3, (A[1] + L[1] + R[1]) / 3];

tri(A, L, R, INK);
const a1 = scaleAbout(A, C, 0.84);
const l1 = scaleAbout(L, C, 0.84);
const r1 = scaleAbout(R, C, 0.84);
tri(a1, l1, r1, ORANGE);

const a2 = scaleAbout(A, C, 0.46, 12);
const l2 = scaleAbout(L, C, 0.46, 12);
const r2 = scaleAbout(R, C, 0.46, 12);
tri(a2, l2, r2, CREAM);

/* 中间方块亮点 */
rect(116, 146, 24, 24, INK);
rect(120, 150, 16, 16, LEAF);

/* 输出 */
const png = encodePng(W, H, canvas);
fs.writeFileSync(path.join(ROOT, 'public', 'icon-256.png'), png);

/* ICO：单个 256x256 PNG 条目（Vista+ 支持） */
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; // 256
entry[1] = 0;
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);

fs.mkdirSync(path.join(ROOT, 'desktop'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'desktop', 'icon.ico'), Buffer.concat([header, entry, png]));

console.log(`icon-256.png  ${png.length} B`);
console.log(`icon.ico      ${png.length + 22} B`);
