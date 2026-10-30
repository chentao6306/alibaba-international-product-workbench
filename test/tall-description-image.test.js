import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { SellerPublisher } from '../server/publisher.js';

test('detail upload keeps long-page content readable instead of shrinking the entire height to a thumbnail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tall-description-'));
  const publisher = new SellerPublisher(root);
  try {
    const media = path.join(root, 'media'); await fs.mkdir(media, { recursive: true });
    const image = sharp({ create: { width: 1200, height: 15000, channels: 3, background: '#eeeeee' } });
    const footer = await sharp({ create: { width: 1200, height: 1000, channels: 3, background: '#00ff00' } }).png().toBuffer();
    await image.composite([{ input: footer, left: 0, top: 14000 }]).jpeg().toFile(path.join(media, 'long.jpg'));
    const [file] = await publisher.downloadImageSet({ id: 'tall' }, ['/media/long.jpg'], 'detail', 1);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 960); assert.equal(metadata.height, 12000);
    const bottom = await sharp(file).extract({ left: 100, top: 11900, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(bottom[1] > 240 && bottom[0] < 20, 'The end of the long page must remain present');
    assert.ok((await fs.stat(file)).size <= 5 * 1024 * 1024);
    assert.deepEqual(await publisher.downloadImageSet({ id: 'tall' }, ['/media/long.jpg'], 'detail', 1), [file]);
  } finally { await publisher.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
});
