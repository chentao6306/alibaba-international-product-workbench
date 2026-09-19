import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { ShopCollector } from '../server/collector.js';

test('reports missing saved data without collecting source pages and continues both draft and direct batches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'required-data-refresh-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Toys' }];
    state.products = ['refresh', 'absent', 'ready', 'unrelated'].map((id) => ({ id, sourceId: id, sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      sourceUrl: `https://www.alibaba.com/product-detail/toy_${id}.html`, title: `Original ${id}`, selected: true,
      status: id === 'unrelated' ? 'published' : 'ready', price: 10, origin: 'China', categoryId: '100001762', sourceCategoryId: '100001762',
      categoryPath: ['Toys', 'Slot Toys'], description: 'Actual description',
      attributes: [{ name: 'Type', value: 'Car' }, { name: 'Brand', value: 'CJ' }, ...(id === 'unrelated' ? [{ name: 'Scale', value: '1:8' }] : [])],
      mainImages: [1, 2, 3, 4].map((n) => `https://example.test/${n}.jpg`), detailImages: ['https://example.test/detail.jpg'],
    }));
  });
  const originalPublish = SellerPublisher.prototype.publishProduct, originalEnrich = ShopCollector.prototype.enrichProducts;
  const attempts = [], refreshes = [];
  SellerPublisher.prototype.publishProduct = async (product) => {
    attempts.push(product.id);
    if (product.id === 'ready' || product.attributes.some((item) => item.name === 'Scale')) return { status: 'drafted', message: 'Saved receipt' };
    throw Object.assign(new Error('来源缺少必填资料：比例'), { code: 'PUBLISH_REQUIRED_DATA_MISSING', requiredFields: ['比例'], missingSourceFields: ['比例'] });
  };
  ShopCollector.prototype.enrichProducts = async ([product]) => {
    refreshes.push(product.id);
    return [{ ...product, title: 'Source title must not overwrite edit', price: 999,
      attributes: [...product.attributes, ...(product.id === 'refresh' ? [{ name: 'Scale', value: '1:16' }] : [])] }];
  };
  const server = await import('../server/index.js'); const listener = await server.serverReady;
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  };
  try {
    await api('/api/products/ready', { logisticsAttributes: ['普货'] }, 'PATCH');
    assert.deepEqual(store.read().products.find((p) => p.id === 'ready').logisticsAttributes, ['普货']);
    for (const mode of ['draft', 'submit']) {
      attempts.length = 0;
      await api('/api/publish', { ids: ['refresh', 'absent', 'ready'], collectionFolderId: 'folder', mode });
      const deadline = Date.now() + 10000;
      while (store.read().jobs[0].status !== 'completed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const state = store.read();
      assert.equal(state.jobs[0].status, 'completed'); assert.equal(state.jobs[0].progress, 3);
      assert.deepEqual(refreshes, []);
      assert.deepEqual(attempts, ['refresh', 'absent', 'ready']);
      const absent = state.products.find((p) => p.id === 'absent');
      assert.equal(absent.status, 'publish_failed');
      assert.deepEqual(absent.publishResult.missingSourceFields, ['比例']);
      assert.equal(absent.attributes.some((a) => a.name === 'Scale'), false);
      assert.equal(state.products.find((p) => p.id === 'refresh').price, 10);
      assert.equal(state.products.find((p) => p.id === 'refresh').title, 'Original refresh');
    }
    await api('/api/products/refresh/refresh-detail', {});
    assert.deepEqual(refreshes, ['refresh'], 'The user can still explicitly refresh a source product');
    assert.equal(store.read().products.find((p) => p.id === 'refresh').attributes.find((a) => a.name === 'Scale')?.value, '1:16');
  } finally {
    await server.shutdownServer(); SellerPublisher.prototype.publishProduct = originalPublish; ShopCollector.prototype.enrichProducts = originalEnrich;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
