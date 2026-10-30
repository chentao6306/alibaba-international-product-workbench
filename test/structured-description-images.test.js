import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { prepareStructuredDescriptionImages } from '../server/structured-description-images.js';
import { SellerPublisher } from '../server/publisher.js';

test('native galleries preserve valid wide originals and pad small edges without stretching or cropping source pixels', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-gallery-size-'));
  const publisher = new SellerPublisher(root);
  try {
    await fs.mkdir(path.join(root, 'media'));
    const dimensions = [[1200, 600], [900, 250], [300, 900], [250, 250], [600, 600], [600, 9000]];
    const urls = [], sources = [];
    for (const [i, [width, height]] of dimensions.entries()) {
      const source = await sharp({ create: { width, height, channels: 3, background: '#e00000' } }).png().toBuffer();
      sources.push(source); urls.push(`/media/source-${i}.png`);
      await fs.writeFile(path.join(root, 'media', `source-${i}.png`), source);
    }
    const downloaded = await publisher.downloadImageSet({ id: 'native' }, urls, 'structured-detail', urls.length);
    assert.equal((await sharp(downloaded[0]).metadata()).width, 1200);
    const result = await prepareStructuredDescriptionImages(downloaded);
    assert.equal(result.files.length, dimensions.length);
    assert.deepEqual(result.adjustments.map(a=>a.index), [1, 2, 3]);
    for (const [i, file] of result.files.entries()) {
      const actual = await sharp(await fs.readFile(file)).metadata(), [width, height] = dimensions[i];
      assert.equal(actual.width, Math.max(600, width)); assert.equal(actual.height, Math.max(600, height));
      assert.ok((await fs.stat(file)).size <= 5 * 1024 * 1024);
      assert.deepEqual(await fs.readFile(path.join(root, 'media', `source-${i}.png`)), sources[i]);
      const pixel = await sharp(await fs.readFile(file)).extract({ left: Math.floor(actual.width / 2), top: Math.floor(actual.height / 2), width: 1, height: 1 }).raw().toBuffer();
      assert.ok(pixel[0] > 210 && pixel[1] < 10 && pixel[2] < 10);
    }
    const padding = await sharp(await fs.readFile(result.files[3])).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.ok([...padding].every(value=>value > 245));
    assert.deepEqual((await prepareStructuredDescriptionImages(downloaded)).files, result.files);
    await fs.writeFile(result.files[3], 'interrupted');
    assert.equal((await sharp((await prepareStructuredDescriptionImages(downloaded)).files[3]).metadata()).width, 600);
  } finally { await publisher.shutdown(); await fs.rm(root, {recursive:true,force:true}); }
});

test('native gallery preparation compresses oversized images, normalizes EXIF orientation and rejects corrupt files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-gallery-bytes-'));
  try {
    const large = path.join(root, 'large.png'), oriented = path.join(root, 'oriented.jpg'), corrupt = path.join(root, 'corrupt.jpg');
    await sharp(randomBytes(1500*1500*3), {raw:{width:1500,height:1500,channels:3}}).png().toFile(large);
    assert.ok((await fs.stat(large)).size > 5*1024*1024);
    await sharp({create:{width:400,height:800,channels:3,background:'#00dd00'}}).jpeg().withMetadata({orientation:6}).toFile(oriented);
    const result = await prepareStructuredDescriptionImages([large,oriented]);
    const big = await sharp(result.files[0]).metadata(), rotated = await sharp(result.files[1]).metadata();
    assert.equal(big.width,1500); assert.equal(big.height,1500);
    assert.ok((await fs.stat(result.files[0])).size <= 5*1024*1024);
    assert.equal(rotated.width,800); assert.equal(rotated.height,600); assert.ok(!rotated.orientation);
    await fs.writeFile(corrupt,'not an image');
    await assert.rejects(prepareStructuredDescriptionImages([large,corrupt]), error=>error.code==='PUBLISH_DESCRIPTION_IMAGE_INVALID' && error.diagnostics.index===1);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
