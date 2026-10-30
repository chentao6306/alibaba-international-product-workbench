import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import express from 'express';
import { once } from 'node:events';
import { JsonStore } from '../server/store.js';
import { editImageLists } from '../server/product-images.js';
import { imageListPatch, registerProductImageApi } from '../server/product-image-api.js';
import { processImage, uploadImage, repairWatermark, watermarkSettings, isPublicImageAddress, readImage } from '../server/image-processing.js';
import { mergeSourceDataForPublish, syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { sanitizeCollectedProduct, SellerPublisher } from '../server/publisher.js';

const fixture = () => sharp({ create: { width: 240, height: 180, channels: 3, background: '#e6e6e6' } }).png().toBuffer();
const mark = { text: '店铺 TEST & <新>', size: 10, opacity: 0.8, color: '#ff0000', position: 'center' };

test('delete slots preserve duplicate indices and never fill deleted detail images from main images', () => {
  const p = { mainImages: ['a', 'a', 'b'], detailImages: ['x', 'x', 'y'] };
  assert.deepEqual(editImageLists(p, 'delete-detail-2').detailImages, ['x', 'y']);
  assert.deepEqual(editImageLists(p, 'delete-main-2').mainImages, ['a', 'b']);
  assert.deepEqual(editImageLists(p, 'clear-detail'), { mainImages: p.mainImages, detailImages: [] });
  assert.deepEqual(editImageLists({ ...p, detailImages: [] }, 'dedupe').detailImages, []);
  assert.throws(() => editImageLists(p, 'delete-main-0'));
  assert.deepEqual(p.detailImages, ['x', 'x', 'y']);
});

test('saved image edits remove stale HTML while preserving text, and preflight never restores removed images', async () => {
  const p = syncProductModel({ id: 'a', sourcePlatform: 'alibaba.com', mainImages: ['https://example.com/main.jpg'], images: ['https://example.com/main.jpg'],
    detailImages: ['https://example.com/detail.jpg'], descriptionHtml: '<p>Keep description</p><img data-src="https://example.com/detail.jpg">',
    structuredDescription: { html: '<table><tr><td>Keep table</td></tr></table><img src="https://example.com/detail.jpg">', images: ['https://example.com/detail.jpg'] },
  });
  const source = structuredClone(p.source);
  const patch = imageListPatch(p, { mainImages: [], detailImages: [] });
  const edited = { ...p, ...patch };
  const merged = mergeSourceDataForPublish(edited, p);
  assert.deepEqual(merged.mainImages, []); assert.deepEqual(merged.detailImages, []);
  assert.equal(merged.mainImage, ''); assert.match(merged.descriptionHtml, /Keep description/);
  assert.doesNotMatch(merged.descriptionHtml, /<img/); assert.match(merged.structuredDescription.html, /Keep table/);
  assert.deepEqual(merged.structuredDescription.images, []);
  assert.deepEqual(sanitizeCollectedProduct(edited).detailImages, []);
  assert.deepEqual(p.source, source); assert.equal(verifySourceIntegrity(p).valid, true);
  assert.equal(await SellerPublisher.prototype.uploadLegacyDetailImages.call({}, null, edited), 0);
});

test('watermarks replace their own layer and removal restores exact pre-watermark image across calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-test-'));
  try {
    const buffer = await fixture();
    const url = await uploadImage(root, `data:image/png;base64,${buffer.toString('base64')}`);
    const first = await processImage(root, { url, action: 'watermark', watermark: mark });
    assert.notEqual(first.url, url);
    const marked = await fs.readFile(path.join(root, path.basename(first.url)));
    assert.notDeepEqual(await sharp(marked).raw().toBuffer(), await sharp(buffer).raw().toBuffer());
    const second = await processImage(root, { url: first.url, action: 'watermark', watermark: { ...mark, text: 'Updated' } });
    const direct = await processImage(root, { url, action: 'watermark', watermark: { ...mark, text: 'Updated' } });
    assert.deepEqual(await sharp(path.join(root, path.basename(second.url))).raw().toBuffer(), await sharp(path.join(root, path.basename(direct.url))).raw().toBuffer());
    assert.deepEqual(await processImage(root, { url: second.url, action: 'remove-watermark' }), { url, changed: true });
    assert.deepEqual(await processImage(root, { url, action: 'remove-watermark' }), { url, changed: false });
    await assert.rejects(uploadImage(root, `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`));
    await assert.rejects(readImage(root, '/media/../workspace.json'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('source watermark repair reconstructs flat background and changes only the selected region', async () => {
  const clean = await fixture();
  const dirty = await sharp(clean).composite([{ input: await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer(), left: 100, top: 80 }]).png().toBuffer();
  const region = { x: 100 / 240, y: 80 / 180, width: 40 / 240, height: 20 / 180 };
  const repaired = await repairWatermark(dirty, region);
  assert.deepEqual(await sharp(repaired).removeAlpha().raw().toBuffer(), await sharp(clean).raw().toBuffer());
  await assert.rejects(repairWatermark(dirty, { x: 0, y: 0, width: 1, height: 1 }), /25%/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-layer-'));
  try {
    const url = await uploadImage(root, `data:image/png;base64,${dirty.toString('base64')}`);
    const marked = await processImage(root, { url, action: 'watermark', watermark: mark });
    const result = await processImage(root, { url: marked.url, action: 'repair', region });
    const restored = await processImage(root, { url: result.url, action: 'remove-watermark' });
    assert.deepEqual(await sharp(path.join(root, path.basename(restored.url))).removeAlpha().raw().toBuffer(), await sharp(clean).raw().toBuffer());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('image processing rejects invalid settings and local-network source addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '100.64.0.1']) assert.equal(isPublicImageAddress(address), false, address);
  assert.equal(isPublicImageAddress('8.8.8.8'), true);
  for (const value of [{ ...mark, size: NaN }, { ...mark, text: '' }, { ...mark, color: 'url(http://localhost)' }, { ...mark, opacity: 2 }]) assert.throws(() => watermarkSettings(value));
});

test('updating detail-image URLs preserves image placement inside text and tables', () => {
  const p = { mainImages: ['main'], detailImages: ['one', 'two'], descriptionHtml: '<p>Before</p><table><tr><td><picture><source srcset="stale"><img data-src="one"></picture></td></tr></table><p>Middle</p><img src="two"><p>After</p>' };
  const changed = imageListPatch(p, { mainImages: ['main'], detailImages: ['/media/one.png', '/media/two.png'] });
  assert.match(changed.descriptionHtml, /<td><picture><img src="\/media\/one.png"><\/picture><\/td>/);
  assert.match(changed.descriptionHtml, /<p>Middle<\/p><img src="\/media\/two.png"><p>After<\/p>/);
  assert.doesNotMatch(changed.descriptionHtml, /srcset|data-src/);
});

test('image API stages processing, saves atomically, detects conflicts, protects active jobs and immutable source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-api-'));
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const mediaDir = path.join(root, 'media'); await fs.mkdir(mediaDir);
  const image = await uploadImage(mediaDir, `data:image/png;base64,${(await fixture()).toString('base64')}`);
  const make = (id) => syncProductModel({ id, title: id, mainImages: [image], detailImages: [image], descriptionHtml: `<p>Keep</p><img src="${image}">`, price: 2, skus: [{ price: 5 }], status: 'ready' });
  const products = ['a', 'b'].map(make); store.update((s) => { s.products = products; });
  const app = express(); app.use(express.json({ limit: '12mb' })); registerProductImageApi(app, { store, mediaDir });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const call = async (route, body, status = 200) => { const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data; };
  try {
    const drafts = await call('/api/products/image-drafts', { ids: ['a', 'b'] });
    const result = await call('/api/media/process', { url: image, action: 'watermark', watermark: mark });
    assert.deepEqual(store.read().products, products, 'processing must not save drafts');
    drafts[0].mainImages = [result.url]; drafts[0].detailImages = [];
    drafts[1].detailImages = [];
    await call('/api/products/save-images', { items: [{ ...drafts[0], revision: 'stale' }, drafts[1]] }, 409);
    assert.deepEqual(store.read().products, products, 'no partial save on conflicts');
    store.update((s) => { s.jobs = [{ id: 'job', type: 'publish', status: 'running', metadata: { productIds: ['a'] } }]; });
    await call('/api/products/save-images', { items: drafts }, 409);
    store.update((s) => { s.jobs = []; });
    await call('/api/products/save-images', { items: drafts });
    const saved = store.read().products;
    assert.equal(saved[0].mainImage, result.url); assert.deepEqual(saved[0].images, [result.url]);
    for (let i = 0; i < saved.length; i++) { assert.deepEqual(saved[i].detailImages, []); assert.deepEqual(saved[i].source, products[i].source); assert.equal(verifySourceIntegrity(saved[i]).valid, true); assert.deepEqual(saved[i].skus, products[i].skus); }
    await call('/api/products/save-images', { items: drafts }, 409);
    await call('/api/media/process', { url: 'https://example.com/unowned.png', action: 'repair' }, 400);
    await call('/api/products/save-images', { items: [{ ...drafts[0], mainImages: Array(7).fill(image) }] }, 400);
    const newDrafts = await call('/api/products/image-drafts', { ids: ['a'] });
    const base = await call('/api/media/process', { url: newDrafts[0].mainImages[0], action: 'remove-watermark' });
    newDrafts[0].mainImages = [base.url]; await call('/api/products/save-images', { items: newDrafts });
    assert.equal(store.read().products[0].mainImages[0], image);
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
