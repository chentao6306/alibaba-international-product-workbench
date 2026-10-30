import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher } from '../server/publisher.js';
import { JsonStore } from '../server/store.js';

test('captures the paused hidden viewport without opening, navigating or modifying it and bounds snapshot ownership', { skip: !findChromium() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-page-view-'));
  const publisher = new SellerPublisher(root);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    await page.setContent('<input value="Preserved model"><div style="background:orange;height:200px">Open attribute options</div><input type="password" value="private">');
    publisher.page = page;
    publisher.publishingPage = { page, jobId: 'job', productId: 'product' };
    publisher.open = async () => assert.fail('A snapshot must not reopen a seller window');
    assert.equal(await publisher.capturePublishPage('job', 'product'), true);
    const snapshot = publisher.readPublishPageSnapshot('job', 'product');
    assert.match(snapshot.image, /^data:image\/jpeg;base64,/);
    const meta = await sharp(Buffer.from(snapshot.image.split(',')[1], 'base64')).metadata();
    assert.deepEqual([meta.width, meta.height], [1000, 650]);
    assert.equal(await page.locator('input').first().inputValue(), 'Preserved model');
    assert.equal(page.url(), 'about:blank');
    assert.equal(publisher.readPublishPageSnapshot('another-job', 'product'), null);
    assert.equal(publisher.readPublishPageSnapshot('job', 'another-product'), null);
    assert.equal(await publisher.capturePublishPage('job', 'another-product'), false);
    assert.equal(publisher.readPublishPageSnapshot('job', 'product'), null);
    await page.close();
    assert.equal(await publisher.capturePublishPage('job', 'product'), false);
  } finally {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discards a screenshot if the publishing page changes while capture is pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-page-race-'));
  try {
    const publisher = new SellerPublisher(root);
    let resolveCapture;
    const page = { isClosed: () => false, locator: () => ({}), screenshot: () => new Promise((resolve) => { resolveCapture = resolve; }) };
    publisher.page = page;
    publisher.publishingPage = { page, jobId: 'job', productId: 'first' };
    const capture = publisher.capturePublishPage('job', 'first');
    publisher.publishingPage = { page, jobId: 'job', productId: 'second' };
    resolveCapture(Buffer.from('snapshot'));
    assert.equal(await capture, false);
    assert.equal(publisher.publishPageSnapshot, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('serves paused screenshots only through authorized local API and never embeds images in workspace polling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-page-api-'));
  Object.assign(process.env, { DATA_DIR: root, PORT: '0', KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'snapshot-test-gate' });
  globalThis.__KUA_YIPU_AUTHORIZATION = { valid: () => true };
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => { state.jobs = [{ id: 'job', type: 'publish', status: 'paused', currentProductId: 'product' }]; });
  const original = SellerPublisher.prototype.readPublishPageSnapshot;
  let available = true;
  SellerPublisher.prototype.readPublishPageSnapshot = (jobId, productId) => available && jobId === 'job' && productId === 'product'
    ? { jobId, productId, image: 'data:image/jpeg;base64,fixture', capturedAt: new Date().toISOString() } : null;
  const service = await import('../server/index.js');
  const listener = await service.serverReady;
  const base = `http://127.0.0.1:${listener.address().port}`;
  const headers = { 'x-kua-yipu-gate': 'snapshot-test-gate' };
  try {
    assert.equal((await fetch(`${base}/api/jobs/job/publish-page`)).status, 401);
    const response = await fetch(`${base}/api/jobs/job/publish-page`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match((await response.json()).image, /fixture/);
    const state = await (await fetch(`${base}/api/state?view=summary`, { headers })).text();
    assert.doesNotMatch(state, /data:image|base64,fixture/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'), /data:image|base64,fixture/);
    available = false;
    assert.equal((await fetch(`${base}/api/jobs/job/publish-page`, { headers })).status, 410);
    store.patchJob('job', { status: 'running' });
    assert.equal((await fetch(`${base}/api/jobs/job/publish-page`, { headers })).status, 409);
    assert.equal((await fetch(`${base}/api/jobs/missing/publish-page`, { headers })).status, 404);
  } finally {
    await service.shutdownServer();
    SellerPublisher.prototype.readPublishPageSnapshot = original;
    delete globalThis.__KUA_YIPU_AUTHORIZATION;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
