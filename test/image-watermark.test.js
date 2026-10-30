import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { addWatermark, processImage, uploadImage, watermarkSettings } from '../server/image-processing.js';

const solid = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const settings = { type: 'image', imageUrl: '/media/logo.png', size: 20, opacity: 0.5, position: 'center' };
const pixels = (buffer) => sharp(buffer).ensureAlpha().raw().toBuffer();
const filePixels = (root, url) => pixels(path.join(root, path.basename(url)));
const upload = (root, buffer, format = 'png') => uploadImage(root, `data:image/${format};base64,${buffer.toString('base64')}`);

test('image watermark preserves transparent margins and multiplies the existing alpha by opacity', async () => {
  const base = await solid(100, 100, '#0000ff');
  const logo = await sharp(await solid(20, 10, { r: 0, g: 0, b: 0, alpha: 0 }))
    .composite([{ input: await solid(10, 6, { r: 255, g: 0, b: 0, alpha: 0.5 }), left: 5, top: 2 }]).png().toBuffer();
  const output = await pixels(await addWatermark(base, settings, logo));
  const at = (x, y) => [...output.subarray((y * 100 + x) * 4, (y * 100 + x + 1) * 4)];
  assert.deepEqual(at(40, 45), [0, 0, 255, 255]);
  const center = at(50, 50);
  assert.ok(center[0] >= 62 && center[0] <= 64, String(center));
  assert.ok(center[2] >= 190 && center[2] <= 193, String(center));
  assert.equal(center[3], 255);
});

test('image watermark respects five positions, aspect ratio, portrait height limit and tiny base images', async () => {
  const base = await solid(100, 100, '#ffffff'), logo = await solid(20, 10, '#ff0000');
  for (const [position, left, top] of [['northwest', 3, 3], ['northeast', 77, 3], ['center', 40, 45], ['southwest', 3, 87], ['southeast', 77, 87]]) {
    const output = await pixels(await addWatermark(base, { ...settings, opacity: 1, position }, logo));
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const painted = x >= left && x < left + 20 && y >= top && y < top + 10;
      assert.equal(output[(y * 100 + x) * 4 + 1], painted ? 0 : 255, `${position}: ${x},${y}`);
    }
  }
  const portrait = await pixels(await addWatermark(base, { ...settings, size: 60, opacity: 1 }, await solid(10, 100, '#ff0000')));
  assert.equal(Array.from(portrait).filter((value, i) => i % 4 === 1 && value === 0).length, 8 * 80);
  const tiny = await pixels(await addWatermark(await solid(1, 1, '#ffffff'), { ...settings, position: 'northwest', opacity: 1 }, logo));
  assert.deepEqual([...tiny], [255, 0, 0, 255]);
});

test('image and text watermarks replace each other without stacking, and removal works after reopening', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-logo-test-'));
  try {
    const base = await upload(root, await solid(240, 180, '#e6e6e6'));
    const logo = await upload(root, await solid(40, 20, '#ff0000'));
    const imageMark = { ...settings, imageUrl: logo };
    const textMark = { text: 'Shop', size: 10, opacity: 0.6, color: '#0000ff', position: 'southeast' };
    let url = base;
    for (const watermark of [imageMark, { ...imageMark, position: 'northwest' }, textMark, imageMark]) {
      url = (await processImage(root, { url, action: 'watermark', watermark })).url;
      const direct = await processImage(root, { url: base, action: 'watermark', watermark });
      assert.deepEqual(await filePixels(root, url), await filePixels(root, direct.url));
    }
    await fs.unlink(path.join(root, path.basename(logo)));
    assert.deepEqual(await processImage(root, { url, action: 'remove-watermark' }), { url: base, changed: true });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('repair retains the image watermark layer and removing it restores the repaired background', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-logo-repair-'));
  try {
    const clean = await solid(200, 200, '#ffffff');
    const dirty = await sharp(clean).composite([{ input: await solid(20, 20, '#000000'), left: 40, top: 40 }]).png().toBuffer();
    const base = await upload(root, dirty), logo = await upload(root, await solid(40, 20, '#ff0000'));
    const watermark = { ...settings, imageUrl: logo };
    const marked = await processImage(root, { url: base, action: 'watermark', watermark });
    const repaired = await processImage(root, { url: marked.url, action: 'repair', region: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } });
    const restored = await processImage(root, { url: repaired.url, action: 'remove-watermark' });
    assert.deepEqual(await filePixels(root, restored.url), await pixels(clean));
    assert.deepEqual(await filePixels(root, repaired.url), await pixels(await addWatermark(clean, watermark, await solid(40, 20, '#ff0000'))));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('uploaded JPEG and WebP logos are accepted while missing, remote and invisible logos are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-logo-validation-'));
  try {
    const base = await upload(root, await solid(100, 100, '#ffffff'));
    for (const format of ['jpeg', 'webp']) {
      const logo = await upload(root, await sharp(await solid(20, 10, '#ff0000')).toFormat(format).toBuffer(), format);
      assert.ok((await processImage(root, { url: base, action: 'watermark', watermark: { ...settings, imageUrl: logo } })).changed);
    }
    for (const imageUrl of ['', 'https://example.com/logo.png', '/media/../workspace.json', '/media/logo.svg']) assert.throws(() => watermarkSettings({ ...settings, imageUrl }));
    await assert.rejects(processImage(root, { url: base, action: 'watermark', watermark: settings }));
    const invisible = await solid(20, 20, { r: 255, g: 0, b: 0, alpha: 0 });
    await assert.rejects(addWatermark(await solid(100, 100, '#ffffff'), settings, invisible), /透明/);
    assert.throws(() => watermarkSettings({ ...settings, type: 'unknown' }));
    assert.throws(() => watermarkSettings({ ...settings, size: 61 }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
