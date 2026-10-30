import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import express from 'express';
import sharp from 'sharp';
import { JsonStore } from '../server/store.js';
import { registerProductImageApi } from '../server/product-image-api.js';
import { registerDescriptionTemplateApi } from '../server/description-templates.js';
import { processImage, uploadImage } from '../server/image-processing.js';
import { chunks, processImageTargets } from '../src/batch-operations.js';

test('image queue bounds concurrency, shares downloads, preserves successes and retries only failures', async () => {
  const targets = Array.from({ length: 451 }, (_, i) => ({ id: String(i), key: 'mainImages', index: 0, url: `image-${i % 9}` }));
  let active = 0, maximum = 0; const calls = [], progress = [];
  const results = await processImageTargets(targets, async (target) => {
    calls.push(target.url); active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    if (target.url === 'image-2') throw new Error('图片损坏');
    return { url: target.url + '-marked', changed: true };
  }, (done) => progress.push(done));
  assert.equal(maximum, 2); assert.equal(calls.length, 9);
  assert.equal(results.filter((r) => r.result).length, 401);
  const failed = results.filter((r) => r.error).map((r) => r.target);
  assert.equal(failed.length, 50); assert.equal(failed[0].id, '2');
  assert.equal(progress.at(-1), 451);
  let retryCalls = 0;
  const retried = await processImageTargets(failed, async () => { retryCalls++; return { url: 'repaired', changed: true }; });
  assert.equal(retryCalls, 1); assert.ok(retried.every((r) => r.result));
  assert.deepEqual(chunks(targets).map((batch) => batch.length), [100, 100, 100, 100, 51]);
});

test('large source images shrink proportionally for logos and restore the untouched original', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'large-image-'));
  try {
    const input = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#cceedd' } }).jpeg().toBuffer();
    await fs.writeFile(path.join(root, 'large.jpg'), input);
    const logo = await sharp({ create: { width: 100, height: 60, channels: 4, background: '#ff0000' } }).png().toBuffer();
    const imageUrl = await uploadImage(root, `data:image/png;base64,${logo.toString('base64')}`);
    const result = await processImage(root, { url: '/media/large.jpg', action: 'watermark', watermark: { type: 'image', imageUrl, size: 20, opacity: 0.8, position: 'southeast' } });
    const meta = await sharp(path.join(root, path.basename(result.url))).metadata();
    assert.ok(meta.width * meta.height <= 16000000);
    assert.ok(Math.abs(meta.width / meta.height - 1.25) < 0.001);
    assert.deepEqual(await processImage(root, { url: result.url, action: 'remove-watermark' }), { url: '/media/large.jpg', changed: true });
    assert.deepEqual(await fs.readFile(path.join(root, 'large.jpg')), input);
    const uploaded = await uploadImage(root, `data:image/jpeg;base64,${input.toString('base64')}`);
    const uploadMeta = await sharp(path.join(root, path.basename(uploaded))).metadata();
    assert.ok(uploadMeta.width * uploadMeta.height <= 16000000);
    await assert.rejects(uploadImage(root, `data:image/png;base64,${Buffer.from('broken image').toString('base64')}`), /图片损坏|图片内容/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('451 products save in chunks and report stale, busy or missing-image products without blocking others', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-scaling-'));
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const mediaDir = path.join(root, 'media'); await fs.mkdir(mediaDir);
  store.update((s) => {
    s.products = Array.from({ length: 451 }, (_, i) => ({ id: String(i), title: `商品 ${i}`, mainImages: ['https://example.com/a.jpg'], detailImages: [], descriptionHtml: '<p>Original</p>' }));
    s.descriptionTemplates = [{ id: 'template', name: 'Company', version: 1, html: '<p>{{title}}</p><p>Company information</p>' }];
    s.jobs = [{ id: 'busy', type: 'publish', status: 'running', metadata: { productIds: ['2'] } }];
  });
  const app = express(); app.use(express.json({ limit: '12mb' }));
  registerProductImageApi(app, { store, mediaDir }); registerDescriptionTemplateApi(app, { store, mediaDir });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  try {
    const ids = store.read((s) => s.products.map((p) => p.id));
    const drafts = [];
    for (const batch of chunks(ids)) drafts.push(...await call('products/image-drafts', { ids: batch }));
    assert.equal(drafts.length, 451);
    assert.equal(drafts[0].descriptionHtml, undefined);
    drafts.forEach((p) => { p.mainImages = ['https://example.com/edited.jpg']; });
    drafts[1].revision = 'stale'; drafts[3].mainImages = ['/media/missing.png'];
    const saved = [], failures = [];
    for (const items of chunks(drafts)) {
      const result = await call('products/save-images', { items, partial: true });
      saved.push(...result.saved); failures.push(...result.failures);
    }
    assert.equal(saved.length, 448); assert.deepEqual(failures.map((p) => p.id).sort(), ['1', '2', '3']);
    assert.equal(store.read((s) => s.products[450].mainImages[0]), 'https://example.com/edited.jpg');
    assert.equal(store.read((s) => s.products[1].mainImages[0]), 'https://example.com/a.jpg');
    const options = { templateId: 'template', version: 1, mode: 'append', partial: true };
    const previews = [];
    for (const batch of chunks(ids)) {
      const result = await call('description-templates/preview', { ...options, ids: batch, summary: true });
      assert.equal(result.items[0].patch, undefined); assert.equal(result.items[0].beforeHtml, undefined);
      previews.push(...result.items);
    }
    store.update((s) => { s.products[1].descriptionHtml = '<p>Concurrent edit</p>'; });
    let applied = 0; const rejected = [];
    for (const batch of chunks(previews)) {
      const result = await call('description-templates/apply', { ...options, ids: batch.map((p) => p.id), revisions: Object.fromEntries(batch.map((p) => [p.id, p.revision])) });
      applied += result.updated; rejected.push(...result.failures);
    }
    assert.equal(applied, 449); assert.deepEqual(rejected.map((p) => p.id), ['1', '2']);
    assert.match(store.read((s) => s.products[450].descriptionHtml), /Original.*Company information/);
    assert.equal(store.read((s) => s.products[1].descriptionHtml), '<p>Concurrent edit</p>');
  } finally { await new Promise((resolve) => listener.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
