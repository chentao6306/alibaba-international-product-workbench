import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { productCategory } from '../server/category-routing.js';

test('reference API replaces category attributes and complete SKUs, preserves target prices and immutable source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-api-'));
  process.env.DATA_DIR = root;
  process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const target = syncProductModel({ id: 'target', sourceId: '123', title: 'Target title', status: 'failed', categoryId: 'phone', categoryPath: ['Electronics', '5G smartphone'], price: 12, stock: 0, currencySymbol: '$', mainImages: ['target.jpg'], detailImages: ['detail.jpg'], descriptionHtml: '<p>Original details</p>', origin: '', packaging: { length: 20 }, skus: [{ id: 't', price: 12, stock: 0 }], publishResult: { error: 'Missing weight' } }, { captureSource: true });
  const reference = { id: 'reference', status: 'published', categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'], title: 'Reference', origin: 'China', province: 'Guangdong', brand: 'Other', compatibleBrands: ['DJI'], material: ['Aluminum Alloy', 'Rubber'], privateMold: 'Yes',
    attributes: [{ name: 'Type', value: 'Drone motor' }],
    variantGroups: [{ name: 'Color', options: ['1180kv', '1500kv'], optionImages: { '1180kv': 'spec1.jpg', '1500kv': 'spec2.jpg' } }, { name: 'Compatible Model', options: ['For DJI RC'] }, { name: 'Type', options: ['Drone motor'] }],
    packaging: { weight: 1, length: 10, width: 8, height: 5 }, mainImages: ['ref.jpg'], price: 100,
    skus: ['1180kv', '1500kv'].map((color, i) => ({ id: `r${i}`, attributes: { Color: color, 'Compatible Model': 'For DJI RC', Type: 'Drone motor' }, price: 100, code: `motor-${i}`, stock: 12 + i, enabled: !i })) };
  const uncategorized = syncProductModel({ id: 'uncategorized', sourceId: '456', sourcePlatform: '1688', title: 'Original foreign title', categoryId: '', categoryPath: [], price: 10, currencySymbol: '¥' }, { captureSource: true });
  store.update((state) => { state.products = [target, reference, uncategorized]; });
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const result = await request('/api/products/reference', { ids: ['target'], referenceId: 'reference' });
    assert.equal(result.status, 200);
    assert.equal(result.data.changed.length, 1);
    const after = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'))).products[0];
    for (const field of ['title', 'price', 'stock', 'currencySymbol', 'mainImages', 'detailImages', 'descriptionHtml', 'source']) assert.deepEqual(after[field], target[field], field);
    for (const field of ['categoryId', 'categoryPath', 'variantGroups', 'province', 'material', 'privateMold', 'compatibleBrands']) assert.deepEqual(after[field], reference[field], field);
    assert.deepEqual(after.skus.map(({ attributes, code, stock, enabled }) => ({ attributes, code, stock, enabled })), reference.skus.map(({ attributes, code, stock, enabled }) => ({ attributes, code, stock, enabled })));
    assert.deepEqual(after.skus.map((sku) => sku.price), [12, 12]);
    assert.deepEqual(after.skus.map((sku) => sku.image), ['spec1.jpg', 'spec2.jpg']);
    assert.equal(productCategory(after).id, '201346401');
    const plan = await request('/api/publish/plan', { ids: ['target'] });
    assert.equal(plan.status, 200);
    assert.equal(plan.data.groups[0].categoryId, '201346401');
    assert.equal((await request('/api/products/reference', { ids: ['target'], referenceId: 'reference' })).status, 200);
    const repeated = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'))).products[0];
    assert.deepEqual(repeated.skus, after.skus);
    assert.deepEqual(after.packaging, { length: 20, weight: 1, width: 8, height: 5 });
    assert.equal(after.origin, 'China'); assert.equal(after.status, 'ready'); assert.equal(after.publishResult, undefined);
    assert.equal(verifySourceIntegrity(after).valid, true);
    assert.equal((await request('/api/products/reference', { ids: ['uncategorized'], referenceId: 'reference' })).status, 200);
    const filled = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'))).products.find((item) => item.id === 'uncategorized');
    assert.equal(filled.categoryId, '201346401');
    assert.deepEqual(filled.categoryPath, reference.categoryPath);
    assert.equal(filled.title, uncategorized.title);
    assert.equal(filled.currencySymbol, '¥');
    assert.equal(verifySourceIntegrity(filled).valid, true);
    assert.equal((await request('/api/storage/cleanup', { scopes: ['products'] })).status, 400);
    assert.equal((await request('/api/storage/cleanup', { scopes: ['products'], confirm: true })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'))).products.length, 0);
  } finally { await server.shutdownServer(); fs.rmSync(root, { recursive: true, force: true }); }
});
