import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { processImage, imageHistory } from '../server/image-processing.js';

test('large photographic watermarks fit upload limits and retain dimensions, replacement history and exact removal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'large-watermark-output-'));
  try {
    const width = 900, height = 8000, raw = Buffer.alloc(width * height * 3);
    let seed = 123456;
    for (let i = 0; i < raw.length; i += 1) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i] = seed & 255; }
    const original = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 65 }).toBuffer();
    await fs.writeFile(path.join(root, 'original.jpg'), original);
    const watermark = { type: 'text', text: 'QA', color: '#ffffff', size: 6, opacity: 0.8, position: 'center' };
    const first = await processImage(root, { url: '/media/original.jpg', action: 'watermark', watermark });
    assert.match(first.url, /\.jpg$/);
    const buffer = await fs.readFile(path.join(root, path.basename(first.url)));
    assert.ok(buffer.length <= 5 * 1024 * 1024);
    const metadata = await sharp(buffer).metadata(); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
    assert.equal((await imageHistory(root, first.url)).watermarkBase, '/media/original.jpg');
    const second = await processImage(root, { url: first.url, action: 'watermark', watermark: { ...watermark, text: 'Updated' } });
    assert.equal((await imageHistory(root, second.url)).watermarkBase, '/media/original.jpg');
    const restored = await processImage(root, { url: second.url, action: 'remove-watermark' });
    assert.equal(restored.url, '/media/original.jpg');
    assert.deepEqual(await fs.readFile(path.join(root, path.basename(restored.url))), original);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('compressing a large transparent watermarked image retains its alpha and original restoration bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transparent-watermark-output-'));
  try {
    const width = 900, height = 2400, raw = Buffer.alloc(width * height * 4);
    let seed = 456789;
    for (let i = 0; i < raw.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i + channel] = seed & 255; }
      raw[i + 3] = 128;
    }
    const original = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
    assert.ok(original.length > 5 * 1024 * 1024);
    await fs.writeFile(path.join(root, 'transparent.png'), original);
    const first = await processImage(root, { url: '/media/transparent.png', action: 'watermark',
      watermark: { type: 'text', text: 'QA', color: '#ffffff', size: 6, opacity: 0.8, position: 'center' } });
    assert.match(first.url, /\.webp$/);
    const buffer = await fs.readFile(path.join(root, path.basename(first.url)));
    assert.ok(buffer.length <= 5 * 1024 * 1024);
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.width, width); assert.equal(metadata.height, height); assert.equal(metadata.hasAlpha, true);
    const corner = await sharp(buffer).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.equal(corner[3], 128);
    const restored = await processImage(root, { url: first.url, action: 'remove-watermark' });
    assert.equal(restored.url, '/media/transparent.png');
    assert.deepEqual(await fs.readFile(path.join(root, path.basename(restored.url))), original);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
