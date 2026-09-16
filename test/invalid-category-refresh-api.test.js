import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { ShopCollector } from '../server/collector.js';

test('invalid source category refreshes only taxonomy once and leaves manual categories and product content intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-category-refresh-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const categoryPath = ['Consumer Electronics', 'Drones Accessories'];
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }];
    state.products = [1, 2, 3].map((id) => ({ id: String(id), sourceId: String(id), sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      sourceUrl: `https://www.alibaba.com/product-detail/camera_${id}.html`,
      title: `Camera ${id}`, selected: true, status: 'ready', price: 100, origin: 'China',
      categoryId: '201346400', sourceCategoryId: '201346400', categoryPath, sourceCategoryPath: categoryPath,
      ...(id === 3 ? { categoryReference: { categoryId: '201346400' } } : {}), description: 'Camera',
      attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
      mainImages: [1, 2, 3, 4].map((n) => `https://example.com/${n}.jpg`), detailImages: ['https://example.com/detail.jpg'] }));
  });
  const originalPublish = SellerPublisher.prototype.publishProduct;
  const originalEnrich = ShopCollector.prototype.enrichProducts;
  const attempts = []; const refreshes = [];
  SellerPublisher.prototype.publishProduct = async (product, url) => {
    attempts.push([product.id, product.categoryId]);
    assert.ok(url.includes(`catId=${product.categoryId}`));
    if (product.categoryId !== '201346401') throw Object.assign(new Error('Category invalid'), { code: 'PUBLISH_CATEGORY_INVALID' });
    return { status: 'drafted', message: 'Saved receipt' };
  };
  ShopCollector.prototype.enrichProducts = async ([product]) => {
    refreshes.push(product.id);
    return [{ ...product, title: 'Do not copy title', price: 999,
      sourceCategoryId: '201346401', sourceCategoryPath: categoryPath }];
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
    await until(() => store.read().jobs[0].status === 'paused');
    assert.deepEqual(refreshes, ['1', '2']);
    assert.deepEqual(attempts, [['1', '201346400'], ['1', '201346401'], ['2', '201346400'], ['2', '201346401'], ['3', '201346400']]);
    const state = store.read();
    assert.equal(state.jobs[0].progress, 2);
    for (const product of state.products) { assert.equal(product.title, `Camera ${product.id}`); assert.equal(product.price, 100); }
    assert.equal(state.products[2].publishHistory?.length || 0, 0);
    assert.equal(state.products[0].auditTrail[0].action, 'refresh-invalid-source-category');
    await api(`/api/jobs/${task.id}/resume`, {});
    await until(() => store.read().jobs[0].status === 'paused');
    assert.deepEqual(refreshes, ['1', '2']);
    assert.equal(store.read().jobs[0].progress, 2);
  } finally {
    await server.shutdownServer(); SellerPublisher.prototype.publishProduct = originalPublish;
    ShopCollector.prototype.enrichProducts = originalEnrich;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
