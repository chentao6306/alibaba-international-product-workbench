import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import sharp from 'sharp';
import { SellerPublisher } from '../server/publisher.js';
import { ImageDownloadQueue } from '../server/image-download-queue.js';

const urls = Array.from({ length: 30 }, (_, index) => `https://sc04.alicdn.com/kf/cancel-${index}.png`);
const paused = () => Object.assign(new Error('Fixture task paused'), { code: 'PUBLISH_PAUSED' });
const product = () => ({ id: 'cancel-test', title: 'Drone camera', price: 10, minOrder: 1, stock: 10,
  origin: 'China', packaging: { weight: 0.5 }, categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'],
  attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
  mainImages: urls.slice(0, 4), detailImages: urls, description: 'Camera' });
const postingUrl = 'https://post.alibaba.com/product/publish.htm?catId=201346401';
const png = () => sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
const waitForAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('cancelling a detail set aborts its active request and queued work while retaining completed cache for a fresh attempt', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cancel-cache-')), originalFetch = globalThis.fetch;
  try {
    const publisher = new SellerPublisher(root), controller = new AbortController(), reason = paused();
    publisher.imageDownloads.limit = 1;
    const image = await png(), calls = [];
    let activeSignal, notify;
    const entered = new Promise(resolve => { notify = resolve; });
    globalThis.fetch = async (url, options) => {
      calls.push(url);
      if (calls.length === 1) return new Response(image);
      activeSignal = options.signal; notify();
      return waitForAbort(options.signal);
    };
    const pending = publisher.downloadImageSet(product(), urls, 'detail', urls.length, { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error === reason);
    await entered; controller.abort(reason); await rejected; await nextTurn();
    assert.equal(activeSignal.aborted, true);
    assert.equal(calls.length, 2);
    assert.equal(publisher.imageDownloads.waiting.length, 0);
    assert.equal(publisher.imageDownloads.pending.size, 0);
    calls.length = 0;
    globalThis.fetch = async url => { calls.push(url); return new Response(image); };
    const files = await publisher.downloadImageSet(product(), urls, 'detail', urls.length, { signal: new AbortController().signal });
    assert.equal(files.length, 30);
    assert.equal(calls.length, 29);
    assert.ok(!calls.includes(urls[0]));
  } finally { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancellation interrupts a transport retry delay and queued cancellation does not wait for an unrelated active image', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cancel-retry-')), originalFetch = globalThis.fetch;
  try {
    const publisher = new SellerPublisher(root), controller = new AbortController(), reason = paused();
    let calls = 0, notify;
    const entered = new Promise(resolve => { notify = resolve; });
    globalThis.fetch = async () => { calls++; notify(); return new Response('', { status: 503 }); };
    const pending = publisher.downloadImageSet(product(), [urls[0]], 'detail', 1, { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error === reason);
    await entered; await delay(20); controller.abort(reason); await rejected;
    assert.equal(calls, 1);
    const queue = new ImageDownloadQueue(1), queuedController = new AbortController();
    let release;
    const first = queue.run('unrelated', () => new Promise(resolve => { release = resolve; }));
    await nextTurn();
    const queued = queue.run('cancelled', () => assert.fail('Cancelled image must not start'), { signal: queuedController.signal });
    const queuedRejected = assert.rejects(queued, error => error === reason);
    queuedController.abort(reason); await queuedRejected;
    assert.equal(queue.waiting.length, 0);
    release('done'); await first;
    assert.equal(queue.abortGroups.size, 0);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
});

test('task cancellation reaches prefetch and form image requests without replacing the pause reason', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-media-cancel-')), originalFetch = globalThis.fetch;
  try {
    const publisher = new SellerPublisher(root), controller = new AbortController(), reason = paused(), signals = [];
    let notify;
    const entered = new Promise(resolve => { notify = resolve; });
    globalThis.fetch = async (url, options) => { signals.push(options.signal); notify(); return waitForAbort(options.signal); };
    publisher.publishPreparedProduct = async function (item) {
      await entered;
      await this.downloadImageSet(item, item.detailImages, 'detail', item.detailImages.length);
      assert.fail('Cancelled form must not complete');
    };
    const pending = publisher.publishProduct(product(), postingUrl, 'draft', '', 'cancel-job', () => {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error === reason);
    await entered; controller.abort(reason); await rejected; await nextTurn();
    assert.ok(signals.length > 0 && signals.length <= publisher.imageDownloads.limit);
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(publisher.imageDownloads.waiting.length, 0);
    assert.equal(publisher.imageDownloads.pending.size, 0);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
});

test('form failure cancels speculative media and a later product gets a fresh signal without replaying an unknown receipt', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-media-failure-')), originalFetch = globalThis.fetch;
  try {
    const publisher = new SellerPublisher(root), signals = [], failure = Object.assign(new Error('Unknown save receipt'), { code: 'PUBLISH_RESULT_UNKNOWN' });
    let notify, attempts = 0;
    const entered = new Promise(resolve => { notify = resolve; });
    globalThis.fetch = async (url, options) => { signals.push(options.signal); notify(); return waitForAbort(options.signal); };
    publisher.publishPreparedProduct = async () => { attempts++; await entered; throw failure; };
    await assert.rejects(publisher.publishProduct(product(), postingUrl), error => error === failure);
    assert.equal(attempts, 1);
    assert.ok(signals.length > 0 && signals.every(signal => signal.aborted));
    const image = await png();
    globalThis.fetch = async (url, options) => { assert.equal(options.signal.aborted, false); return new Response(image); };
    const receipt = { status: 'drafted', draftId: 'new-attempt' };
    publisher.publishPreparedProduct = async function (item) {
      assert.equal((await this.downloadImageSet(item, item.detailImages, 'detail', item.detailImages.length)).length, 30);
      return receipt;
    };
    assert.deepEqual(await publisher.publishProduct(product(), postingUrl), receipt);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
});
