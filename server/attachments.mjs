import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './fs.mjs';

export const ATTACHMENT_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxPixels: 4_000_000,
  maxDim: 2048,
});

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class AttachError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AttachError';
    this.code = code;
    this.status = status;
  }
}

export function attachmentRoot() {
  const base = process.env.AGENTFORGE_DATA_DIR
    ? path.resolve(process.env.AGENTFORGE_DATA_DIR)
    : path.resolve(import.meta.dirname, '..', 'data');
  return path.join(base, 'attachments');
}

function sniff(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG' &&
    buffer.subarray(4, 8).equals(Buffer.from([13, 10, 26, 10]))
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  return null;
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifSize(buffer) {
  if (buffer.length < 10) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function webpSize(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (offset + 9 > buffer.length) return null;
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function imageSize(buffer, mime) {
  if (mime === 'image/png') return pngSize(buffer);
  if (mime === 'image/jpeg') return jpegSize(buffer);
  if (mime === 'image/webp') return webpSize(buffer);
  if (mime === 'image/gif') return gifSize(buffer);
  return null;
}

export function attachmentAbsolutePath(image) {
  const sha = String(image?.sha256 || '');
  const ext = MIME_EXT[String(image?.mime || '')];
  if (!/^[a-f0-9]{64}$/i.test(sha) || !ext) {
    throw new AttachError('IMAGE_INVALID_REFERENCE', '图片附件引用无效');
  }
  return path.join(attachmentRoot(), sha.slice(0, 2), `${sha}.${ext}`);
}

export function attachmentUrl(image) {
  const ext = MIME_EXT[String(image?.mime || '')];
  const sha = String(image?.sha256 || '');
  if (!/^[a-f0-9]{64}$/i.test(sha) || !ext) return '';
  return `/api/attachments/${sha}.${ext}`;
}

export function admitImage(buffer, options = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const maxBytes = Math.max(1, Number(options.maxBytes) || ATTACHMENT_LIMITS.maxBytes);
  const maxPixels = Math.max(1, Number(options.maxPixels) || ATTACHMENT_LIMITS.maxPixels);
  const maxDim = Math.max(1, Number(options.maxDim) || ATTACHMENT_LIMITS.maxDim);
  if (!bytes.length) throw new AttachError('IMAGE_EMPTY', '图片内容为空');
  if (bytes.length > maxBytes) {
    throw new AttachError(
      'IMAGE_TOO_LARGE',
      `图片超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 限制`,
      413,
    );
  }
  const kind = sniff(bytes);
  if (!kind) {
    throw new AttachError(
      'IMAGE_UNSUPPORTED_FORMAT',
      '只接受 PNG / JPEG / WebP / GIF，且必须与文件签名一致',
      415,
    );
  }
  const size = imageSize(bytes, kind.mime);
  if (!size?.width || !size?.height) {
    throw new AttachError('IMAGE_INVALID_DIMENSIONS', '无法读取图片尺寸，文件可能已损坏');
  }
  if (size.width > maxDim || size.height > maxDim) {
    throw new AttachError(
      'IMAGE_DIMENSION_TOO_LARGE',
      `图片单边不能超过 ${maxDim}px（当前 ${size.width}×${size.height}）`,
    );
  }
  if (size.width * size.height > maxPixels) {
    throw new AttachError(
      'IMAGE_PIXELS_TOO_LARGE',
      `图片像素不能超过 ${maxPixels}（当前 ${size.width}×${size.height}）`,
    );
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const image = {
    id: sha256.slice(0, 16),
    sha256,
    mime: kind.mime,
    width: size.width,
    height: size.height,
    bytes: bytes.length,
  };
  const abs = attachmentAbsolutePath(image);
  if (!fs.existsSync(abs)) writeFileAtomic(abs, bytes);
  return image;
}

export function readAttachment(image, { maxBytes = ATTACHMENT_LIMITS.maxBytes } = {}) {
  const abs = attachmentAbsolutePath(image);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new AttachError('IMAGE_NOT_FOUND', '图片附件不存在或已被清理', 404);
  }
  if (!stat.isFile()) throw new AttachError('IMAGE_NOT_FOUND', '图片附件不是普通文件', 404);
  if (stat.size > maxBytes) {
    throw new AttachError('IMAGE_TOO_LARGE', '图片附件超过读取上限', 413);
  }
  const buffer = fs.readFileSync(abs);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (
    sha256 !== image.sha256 ||
    (image.bytes !== undefined && image.bytes !== null && buffer.length !== Number(image.bytes))
  ) {
    throw new AttachError('IMAGE_HASH_MISMATCH', '图片附件摘要或大小不匹配', 409);
  }
  return { buffer, bytes: buffer.length, sha256, path: abs };
}

export function imageDataUrl(image) {
  const { buffer } = readAttachment(image);
  return `data:${image.mime};base64,${buffer.toString('base64')}`;
}

export function publicImageRef(image) {
  if (!image?.sha256) return null;
  return {
    id: String(image.id || image.sha256.slice(0, 16)),
    sha256: String(image.sha256),
    mime: String(image.mime),
    width: Number(image.width) || 0,
    height: Number(image.height) || 0,
    bytes: Number(image.bytes) || 0,
  };
}

export function supportsVision(provider) {
  return Array.isArray(provider?.capabilities) && provider.capabilities.includes('vision');
}
