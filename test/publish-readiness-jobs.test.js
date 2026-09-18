import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { SOURCE_ATTRIBUTE_SCHEMA_VERSION } from '../server/category-attributes.js';

test('login and unavailable forms pause at the same product without counting failures or processing the remainder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-readiness-jobs-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }];
    state.products = [1, 2, 3].map((id) => ({ id: String(id), sourceId: String(id), sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      title: `Camera ${id}`, selected: true, status: 'ready', price: 100, origin: 'China',
      categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'], description: 'Camera',
      attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
      mainImages: [1, 2, 3, 4].map((n) => `https://example.com/${n}.jpg`), detailImages: ['https://example.com/detail.jpg'] }));
    Object.assign(state.products[0], { detailImages: [], categoryReference: { id: 'reference' },
      variantGroups: [{ name: 'Type', options: ['Motor'] }], skus: [{ attributes: { Type: 'Motor' }, code: 'KEPT', stock: 5 }] });
    state.products[1].publishResult = { status: 'failed', message: '国际站必填属性或规格未填写：年龄段、原产地' };
  });
  const original = SellerPublisher.prototype.publishProduct;
  const originalEnrich = SellerPublisher.prototype.enrichSourceProducts;
  let enrichmentCalls = 0;
  SellerPublisher.prototype.enrichSourceProducts = async ([product]) => {
    enrichmentCalls++;
    return [{ ...product, title: 'Source title', price: 1, categoryId: '999999999', variantGroups: [], skus: [],
      attributes: [...product.attributes, { id: '123', name: 'Age Range', value: '3-6 years' }], sourceAttributeSchemaVersion: SOURCE_ATTRIBUTE_SCHEMA_VERSION,
      detailImages: ['https://example.com/recovered-detail.jpg'] }];
  };
  const attempts = [];
  let blockingCode = 'LOGIN_REQUIRED';
  let categoryCorrected = false;
  SellerPublisher.prototype.publishProduct = async (product) => {
    attempts.push(product.id);
    if (product.id === '1') {
      assert.equal(product.title, 'Camera 1');
      assert.equal(product.price, 100);
      assert.equal(product.categoryId, '201346401');
      assert.equal(product.skus[0].code, 'KEPT');
      assert.deepEqual(product.detailImages, ['https://example.com/recovered-detail.jpg']);
    }
    if (product.id === '1' && blockingCode) throw Object.assign(new Error(blockingCode), { code: blockingCode });
    if (product.id === '2') assert.equal(product.attributes.find((item) => item.name === 'Age Range')?.value, '3-6 years');
    if (product.id === '2' && !categoryCorrected) throw Object.assign(new Error('当前类目不可用，请重新选择有效类目'), { code: 'PUBLISH_CATEGORY_INVALID' });
    return { status: 'drafted', message: 'Saved receipt', productId: product.id };
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  };
  const until = async (condition) => {
    const deadline = Date.now() + 10000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), 'Expected task state did not arrive');
  };
  try {
    const task = await api('/api/publish', { ids: ['1', '2', '3'], collectionFolderId: 'folder', mode: 'draft' });
    for (const code of ['LOGIN_REQUIRED', 'PUBLISH_EDITOR_NOT_READY', 'PUBLISH_FORM_NOT_READY', 'PUBLISH_FIELD_NOT_READY', 'PUBLISH_BROWSER_NOT_READY', 'PUBLISH_LANGUAGE_NOT_READY']) {
      blockingCode = code;
      if (code !== 'LOGIN_REQUIRED') await api(`/api/jobs/${task.id}/resume`, {});
      await until(() => store.read().jobs[0].status === 'paused');
      const state = store.read();
      assert.equal(state.jobs[0].progress, 0);
      assert.equal(Object.keys(state.jobs[0].results || {}).length, 0);
      assert.equal(state.products[0].publishHistory?.length || 0, 0);
      assert.notEqual(state.products[0].status, 'publish_failed');
      assert.equal(attempts.every((id) => id === '1'), true);
    }
    blockingCode = '';
    await api(`/api/jobs/${task.id}/resume`, {});
    await until(() => store.read().jobs[0].status === 'paused');
    assert.equal(store.read().jobs[0].progress, 1);
    assert.equal(store.read().products[1].publishHistory?.length || 0, 0);
    assert.equal(attempts.includes('3'), false);
    categoryCorrected = true;
    await api(`/api/jobs/${task.id}/resume`, {});
    await until(() => store.read().jobs[0].status === 'completed');
    const state = store.read();
    assert.deepEqual(attempts, ['1', '1', '1', '1', '1', '1', '1', '2', '2', '3']);
    assert.equal(state.products[0].publishHistory.length, 1);
    assert.equal(state.products[0].status, 'drafted');
    assert.equal(state.products[1].status, 'drafted');
    assert.equal(state.products[2].status, 'drafted');
    assert.match(state.jobs[0].message, /成功 3 件，失败 0 件/);
    assert.equal(enrichmentCalls, 2);
  } finally {
    await server.shutdownServer(); SellerPublisher.prototype.publishProduct = original;
    SellerPublisher.prototype.enrichSourceProducts = originalEnrich;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
