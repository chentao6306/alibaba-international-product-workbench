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
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 404 }); };
    await assert.rejects(publisher.downloadImageSet(product, ['https://sc04.alicdn.com/kf/missing.jpg'], 'spec-color-1', 1), { code: 'SPEC_IMAGE_DOWNLOAD_FAILED' });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
