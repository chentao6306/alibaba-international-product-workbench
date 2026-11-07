import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { SellerPublisher } from '../server/publisher.js';

test('retries transient image downloads, reuses completed files and reports permanent specification download failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-retry-'));
  const original = globalThis.fetch;
  const publisher = new SellerPublisher(root);
  const product = { sourceId: 'test', sourceUrl: 'https://www.alibaba.com/' };
  const png = await sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) return new Response('', { status: 503 });
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const urls = ['https://sc04.alicdn.com/kf/test.jpg'];
    const files = await publisher.downloadImageSet(product, urls, 'spec-color-0', 1);
    assert.equal(calls, 3);
    assert.equal(files.length, 1);
    assert.deepEqual(await publisher.downloadImageSet(product, urls, 'spec-color-0', 1), files);
    assert.equal(calls, 3);
    fs.writeFileSync(files[0], Buffer.alloc(2048, 1));
    assert.deepEqual(await publisher.downloadImageSet(product, urls, 'spec-color-0', 1), files);
    assert.equal(calls, 4);
    assert.equal((await sharp(files[0]).metadata()).format, 'png');
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 404 }); };
    await assert.rejects(publisher.downloadImageSet(product, ['https://sc04.alicdn.com/kf/missing.jpg'], 'spec-color-1', 1), { code: 'SPEC_IMAGE_DOWNLOAD_FAILED' });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converts oversized valid main images and rejects corrupt downloads without inventing images', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-conversion-'));
  const original = globalThis.fetch;
  try {
    const publisher = new SellerPublisher(root);
    const product = { sourceId: 'large', sourceUrl: 'https://www.alibaba.com/' };
    const png = await sharp(randomBytes(1500 * 1500 * 3), { raw: { width: 1500, height: 1500, channels: 3 } }).png().toBuffer();
    assert.ok(png.length > 5 * 1024 * 1024);
    globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'application/octet-stream' } });
    const urls = Array.from({ length: 4 }, (_, i) => `https://sc04.alicdn.com/kf/large-${i}.png`);
    const files = await publisher.downloadImageSet(product, urls, 'main', 6);
    assert.equal(files.length, 4);
    for (const file of files) {
      assert.ok(fs.statSync(file).size < 5 * 1024 * 1024);
      assert.equal((await sharp(file).metadata()).width, 1500);
    }
    globalThis.fetch = async () => new Response('corrupt', { headers: { 'content-type': 'image/jpeg' } });
    await assert.rejects(publisher.downloadImageSet(product, urls.map((url) => url.replace('large-', 'bad-')), 'main', 6), { code: 'MAIN_IMAGE_DOWNLOAD_FAILED' });
  } finally {
    globalThis.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
