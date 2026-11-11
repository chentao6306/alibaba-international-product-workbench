import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import express from 'express';
import sharp from 'sharp';
import { load } from 'cheerio';
import { JsonStore } from '../server/store.js';
import { registerProductImageApi, imageListPatch, sourceImageDraft } from '../server/product-image-api.js';
import { editImageLists } from '../server/product-images.js';
import { imageHistory, uploadImage } from '../server/image-processing.js';
import { syncProductModel, recordProductMutation, verifySourceIntegrity } from '../server/product-model.js';
import { currentDescriptionStructure, descriptionSourceHash } from '../server/description-structure.js';
import { compileNativeDescription } from '../server/native-description-fields.js';

async function openApi(file, mediaDir) {
  const store = new JsonStore(file), app = express();
  app.use(express.json());
  registerProductImageApi(app, { store, mediaDir });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    store,
    async call(route, body, status = 200) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

const htmlImages = html => {
  const $ = load(html || '', null, false);
  return $('img').toArray().map(node => $(node).attr('src'));
};

test('collected image restoration survives reopening and preserves native galleries, manual edits and watermark provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-image-restore-'));
  const mediaDir = path.join(root, 'media'), file = path.join(root, 'workspace.json');
  await fs.mkdir(mediaDir);
  let api;
  try {
    const bytes = await sharp({ create: { width: 240, height: 180, channels: 3, background: '#ddddee' } }).png().toBuffer();
    const originals = [];
    for (let i = 0; i < 3; i++) originals.push(await uploadImage(mediaDir, `data:image/png;base64,${bytes.toString('base64')}`));
    const [main, detail, company] = originals;
    const descriptionHtml = `<p>Collected company</p><img src="${detail}"><table><tr><td>Size guide</td></tr></table><img src="${company}"><video src="https://example.com/video.mp4"></video>`;
    const product = syncProductModel({ id: 'clothing', title: 'Collected shirt', price: 10, skus: [{ price: 11, attributes: { Size: 'L' } }],
      mainImages: [main], detailImages: [detail, company], descriptionHtml,
      structuredDescription: { version: 1, sourceHtmlHash: descriptionSourceHash(descriptionHtml), modules: [
        { type: 'company', title: 'Company', text: 'Collected company' },
        { type: 'gallery', scope: 'product', title: 'Product images', images: [{ url: detail, caption: '' }] },
        { type: 'gallery', scope: 'company', title: 'Factory', images: [{ url: company, caption: '' }] },
      ] },
    });
    const sourceBytes = JSON.stringify(product.source);
    const manualHtml = descriptionHtml.replace('Collected company', 'Manual company');
    const manualStructure = structuredClone(product.structuredDescription);
    manualStructure.modules[0].text = 'Manual company';
    manualStructure.sourceHtmlHash = descriptionSourceHash(manualHtml);
    recordProductMutation(product, { title: 'My edited shirt', price: 29, skus: [{ price: 31, attributes: { Size: 'L' } }],
      descriptionHtml: manualHtml, structuredDescription: manualStructure }, { action: 'edit' });
    api = await openApi(file, mediaDir);
    api.store.update(state => { state.products = [product]; });
    let [draft] = await api.call('products/image-drafts', { ids: [product.id] });
    const marked = await api.call('media/process', { url: main, action: 'watermark', watermark: { text: 'SHOP', size: 10, color: '#ff0000', opacity: 0.8, position: 'center' } });
    await api.call('products/save-images', { items: [{ ...draft, mainImages: [marked.url], detailImages: [] }] });
    let saved = api.store.read(state => state.products[0]);
    assert.deepEqual(saved.detailImages, []);
    assert.deepEqual(htmlImages(saved.descriptionHtml), []);
    assert.deepEqual(currentDescriptionStructure(saved).modules.filter(module => module.type === 'gallery'), []);
    await api.close();
    api = await openApi(file, mediaDir);
    [draft] = await api.call('products/image-drafts', { ids: [product.id] });
    assert.deepEqual(draft.sourceImages, { mainImages: [main], detailImages: [detail, company] });
    assert.deepEqual(draft.mainImages, [marked.url]);
    assert.deepEqual(draft.detailImages, []);
    assert.deepEqual(await api.call('media/process', { url: marked.url, action: 'remove-watermark' }), { url: main, changed: true });
    await api.call('products/save-images', { items: [{ ...draft, ...editImageLists(draft, 'restore-source-detail') }] });
    saved = api.store.read(state => state.products[0]);
    assert.deepEqual(saved.mainImages, [marked.url], 'restoring details must not remove a main-image watermark');
    assert.deepEqual(htmlImages(saved.descriptionHtml), [detail, company]);
    assert.match(saved.descriptionHtml, /Manual company/);
    assert.match(saved.descriptionHtml, /Size guide/);
    assert.match(saved.descriptionHtml, /<video/);
    const native = compileNativeDescription(currentDescriptionStructure(saved), {
      companyDesc: { maxLength: 1000 },
      detailImage: { maxImageItem: 30, dataSource: [{ value: 'product', enName: 'Product images' }] },
      companyImage: { maxImageItem: 30, dataSource: [{ value: 'factory', enName: 'Factory' }] },
    });
    assert.equal(native.companyDesc, 'Manual company');
    assert.deepEqual(native.galleries.map(group => [group.rootId, group.name, group.images.map(image => image.url)]), [
      ['detailImage', 'Product images', [detail]], ['companyImage', 'Factory', [company]],
    ]);
    [draft] = await api.call('products/image-drafts', { ids: [product.id] });
    await api.call('products/save-images', { items: [{ ...draft, ...editImageLists(draft, 'restore-source-main') }] });
    saved = api.store.read(state => state.products[0]);
    assert.equal(saved.title, 'My edited shirt'); assert.equal(saved.price, 29);
    assert.deepEqual(saved.skus, [{ price: 31, attributes: { Size: 'L' } }]);
    assert.deepEqual(saved.mainImages, [main]); assert.deepEqual(saved.detailImages, [detail, company]);
    assert.equal(JSON.stringify(saved.source), sourceBytes);
    assert.equal(verifySourceIntegrity(saved).valid, true);
    assert.equal((await imageHistory(mediaDir, marked.url)).watermarkBase, main);
    assert.deepEqual(await fs.readFile(path.join(mediaDir, path.basename(main))), bytes);
    [draft] = await api.call('products/image-drafts', { ids: [product.id] });
    await api.call('products/save-images', { items: [{ ...draft, mainImages: [], detailImages: [] }] });
    [draft] = await api.call('products/image-drafts', { ids: [product.id] });
    await api.call('products/save-images', { items: [{ ...draft, ...editImageLists(draft, 'restore-source-all') }] });
    await api.close();
    api = await openApi(file, mediaDir);
    saved = api.store.read(state => state.products[0]);
    assert.deepEqual(saved.mainImages, [main]); assert.deepEqual(saved.detailImages, [detail, company]);
    assert.equal(JSON.stringify(saved.source), sourceBytes);
    assert.equal(verifySourceIntegrity(saved).valid, true);
  } finally { if (api) await api.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('restoration reports missing or corrupt source snapshots and never guesses originals or truncates image lists', () => {
  const missing = { mainImages: ['https://example.com/edited.jpg'], detailImages: [], ...sourceImageDraft({}) };
  assert.equal(missing.sourceImages, null);
  assert.throws(() => editImageLists(missing, 'restore-source-main'), /没有采集原图快照/);
  const source = syncProductModel({ mainImages: ['https://example.com/original.jpg'], detailImages: [] });
  assert.throws(() => editImageLists({ ...source, ...sourceImageDraft(source) }, 'restore-source-detail'), /没有详情图/);
  const tooMany = syncProductModel({ mainImages: Array.from({ length: 7 }, (_, i) => `https://example.com/${i}.jpg`) });
  assert.throws(() => editImageLists({ ...tooMany, ...sourceImageDraft(tooMany) }, 'restore-source-main'), /7 张.*未截断/);
  source.source.snapshot.mainImages[0] = 'https://example.com/tampered.jpg';
  const bad = sourceImageDraft(source);
  assert.equal(bad.sourceImages, null);
  assert.throws(() => editImageLists({ ...source, ...bad }, 'restore-source-main'), /校验失败/);
  assert.equal(verifySourceIntegrity(source).valid, false);
});

test('missing original media and source tampering fail image saves without changing persisted edits or snapshot fingerprints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-image-invalid-'));
  const mediaDir = path.join(root, 'media'); await fs.mkdir(mediaDir);
  const api = await openApi(path.join(root, 'workspace.json'), mediaDir);
  try {
    const product = syncProductModel({ id: 'a', mainImages: ['/media/lost.png'], detailImages: ['https://example.com/detail.jpg'] });
    recordProductMutation(product, imageListPatch(product, { mainImages: ['https://example.com/edited.jpg'], detailImages: [] }));
    api.store.update(state => { state.products = [product]; });
    let [draft] = await api.call('products/image-drafts', { ids: ['a'] });
    const result = await api.call('products/save-images', { partial: true, items: [{ ...draft, ...editImageLists(draft, 'restore-source-all') }] });
    assert.equal(result.updated, 0); assert.equal(result.failures.length, 1);
    assert.deepEqual(api.store.read(state => state.products[0]), product);
    api.store.update(state => { state.products[0].source.snapshot.detailImages = ['https://example.com/tampered.jpg']; });
    [draft] = await api.call('products/image-drafts', { ids: ['a'] });
    const before = await fs.readFile(api.store.filePath);
    const failure = await api.call('products/save-images', { items: [{ ...draft, detailImages: ['https://example.com/other.jpg'] }] }, 409);
    assert.match(failure.error, /来源快照校验失败/);
    assert.deepEqual(await fs.readFile(api.store.filePath), before);
    assert.equal(verifySourceIntegrity(api.store.read(state => state.products[0])).valid, false);
  } finally { await api.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('detail deletion respects duplicate counts and restoring a missing middle image preserves the selected order and surrounding text', () => {
  const initial = { mainImages: ['main'], detailImages: ['one', 'two', 'three'], descriptionHtml: '<p>Before</p><img src="one"><p>Middle</p><img src="two"><img src="three"><p>After</p>' };
  const removed = { ...initial, ...imageListPatch(initial, { mainImages: ['main'], detailImages: ['one', 'three'] }) };
  const restored = imageListPatch(removed, { mainImages: ['main'], detailImages: initial.detailImages });
  assert.deepEqual(htmlImages(restored.descriptionHtml), initial.detailImages);
  assert.match(restored.descriptionHtml, /Before.*Middle.*After/);
  const duplicates = { ...initial, detailImages: ['one', 'one', 'three'], descriptionHtml: '<img src="one"><img src="one"><img src="three">' };
  const patch = imageListPatch(duplicates, editImageLists(duplicates, 'delete-detail-2'));
  assert.deepEqual(htmlImages(patch.descriptionHtml), ['one', 'three']);
});
