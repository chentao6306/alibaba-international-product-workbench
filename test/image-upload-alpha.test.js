import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { SellerPublisher } from '../server/publisher.js';

test('upload images preserve transparent artwork on white without changing source bytes or reusing old conversions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-alpha-'));
  const publisher = new SellerPublisher(root);
  try {
    await fs.mkdir(path.join(root, 'media'), { recursive: true });
    await fs.mkdir(publisher.imageDir, { recursive: true });
    const source = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#00000000' } })
      .composite([{ input: Buffer.from('<svg width="240" height="240"><rect width="240" height="240" fill="red"/></svg>'), left: 128, top: 128 }]).png().toBuffer();
    for (const format of ['png', 'webp']) {
      const bytes = format === 'png' ? source : await sharp(source).webp({ lossless: true }).toBuffer();
      const url = `/media/art.${format}`;
      await fs.writeFile(path.join(root, url), bytes);
      for (const prefix of ['main', 'detail', 'spec-color-0']) {
        const oldPrefix = `${prefix.replace(/[^A-Za-z0-9]/g, '')}${prefix === 'detail' ? '-tall2' : ''}-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
        const oldFile = path.join(publisher.imageDir, `alpha${oldPrefix}0.jpg`);
        await sharp(bytes).jpeg().toFile(oldFile);
        const [file] = await publisher.downloadImageSet({ id: 'alpha' }, [url], prefix, 1);
        assert.ok(file && file !== oldFile);
        const metadata = await sharp(file).metadata();
        assert.equal(metadata.hasAlpha, false);
        const corner = await sharp(file).extract({ left: 2, top: 2, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        assert.ok([...corner].every(value => value > 248), 'Transparency must not turn into black');
        const center = await sharp(file).extract({ left: 200, top: 200, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        assert.ok(center[0] > 240 && center[1] < 10 && center[2] < 10);
        assert.deepEqual(await publisher.downloadImageSet({ id: 'alpha' }, [url], prefix, 1), [file]);
      }
      assert.deepEqual(await fs.readFile(path.join(root, url)), bytes);
    }
  } finally { await publisher.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
});

test('detail resizing keeps transparent margins white while ordinary JPEG bytes stay unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-alpha-large-'));
  const publisher = new SellerPublisher(root);
  try {
    await fs.mkdir(path.join(root, 'media'), { recursive: true });
    await sharp({ create: { width: 1200, height: 2400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .png().toFile(path.join(root, 'media/tall.png'));
    const [file] = await publisher.downloadImageSet({ id: 'large' }, ['/media/tall.png'], 'detail', 1);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 960); assert.equal(metadata.height, 1920);
    const pixel = await sharp(file).extract({ left: 100, top: 100, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[0] > 248 && pixel[1] > 120 && pixel[2] > 120);
    const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: 'blue' } }).jpeg().toBuffer();
    await fs.writeFile(path.join(root, 'media/opaque.jpg'), jpeg);
    const [opaque] = await publisher.downloadImageSet({ id: 'opaque' }, ['/media/opaque.jpg'], 'main', 1);
    assert.deepEqual(await fs.readFile(opaque), jpeg);
  } finally { await publisher.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
});

test('flattening transparent uploads applies EXIF orientation before removing metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-alpha-orientation-'));
  const publisher = new SellerPublisher(root);
  try {
    await fs.mkdir(path.join(root, 'media'), { recursive: true });
    await sharp({ create: { width: 240, height: 120, channels: 4, background: '#ff000080' } })
      .withMetadata({ orientation: 6 }).png().toFile(path.join(root, 'media/rotated.png'));
    const [file] = await publisher.downloadImageSet({ id: 'rotated' }, ['/media/rotated.png'], 'detail', 1);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 120); assert.equal(metadata.height, 240);
    assert.equal(metadata.orientation, undefined); assert.equal(metadata.hasAlpha, false);
  } finally { await publisher.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
});
