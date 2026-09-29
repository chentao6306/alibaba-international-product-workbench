import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { syncProductModel } from '../server/product-model.js';
import { productCategory } from '../server/category-routing.js';

test('catalog API works without seller login and single/batch leaf changes preserve saved merchandise', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'category-api-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const makeProduct = (id) => syncProductModel({ id, sourceId: id, title: 'Plush toy', sourcePlatform: 'alibaba.com',
    categoryId: '201774004', categoryPath: ['Mother, Kids & Toys', 'Stuffed Animals & Plush Toys', 'Plush Keychains Toys'],
    categoryReference: { categoryId: '201774004' }, publishCategoryId: '201774004',
    postingRequirements: { categoryId: '201774004', attributes: [{ name: 'Old requirement' }] },
    attributes: [{ id: '7', name: 'Material', value: 'Cotton', valueId: '8' }],
    variantGroups: [{ id: '9', name: 'Color', options: ['Pink'], optionIds: { Pink: '10' } }],
    skus: [{ id: 'sku1', attributes: { Color: 'Pink' }, code: 'KEEP', price: 5, stock: 0 }],
    mainImages: ['https://example.com/product.jpg'], price: 5, stock: 0, packaging: { weight: 1 },
  }, { captureSource: true });
  const originals = ['single', 'batch', 'untouched'].map(makeProduct);
  store.update((state) => { state.products = structuredClone(originals); });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    const catalog = await request('/api/categories/catalog');
    assert.equal(catalog.rootCount, 50);
    assert.ok(catalog.leafCount > 7000);
    const patch = { categoryId: '135', categoryPath: ['Agriculture', 'Other Agriculture Products'] };
    await request('/api/products/single', 'PATCH', patch);
    await request('/api/products/batch-update', 'POST', { ids: ['batch'], patch });
    const state = store.read();
    for (const index of [0, 1]) {
      const saved = state.products[index], before = originals[index];
      assert.equal(productCategory(saved).id, '135');
      assert.equal(saved.categoryReference, null);
      assert.equal(saved.publishCategoryId, null);
      assert.equal(saved.postingRequirements, undefined);
      assert.deepEqual(saved.attributes, [{ name: 'Material', value: 'Cotton' }]);
      assert.equal(saved.variantGroups[0].id, undefined);
      for (const field of ['source', 'skus', 'mainImages', 'price', 'stock', 'packaging']) assert.deepEqual(saved[field], before[field], field);
    }
    assert.deepEqual(state.products[2], originals[2]);
    await request('/api/products/untouched', 'PATCH', { categoryId: '201774004', title: 'Edited title' });
    assert.equal(store.read().products[2].attributes[0].id, '7');
  } finally { await server.shutdownServer(); fs.rmSync(root, { recursive: true, force: true }); }
});
