import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

test('reference API accepts different categories and preserves commercial data through cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-api-'));
  process.env.DATA_DIR = root;
  process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const target = syncProductModel({ id: 'target', sourceId: '123', title: 'Target title', status: 'failed', categoryId: 'phone', categoryPath: ['Electronics', '5G smartphone'], price: 12, stock: 0, currencySymbol: '$', mainImages: ['target.jpg'], detailImages: ['detail.jpg'], descriptionHtml: '<p>Original details</p>', origin: '', packaging: { length: 20 }, skus: [{ id: 't', price: 12, stock: 0 }], publishResult: { error: 'Missing weight' } }, { captureSource: true });
  const reference = { id: 'reference', status: 'published', categoryId: 'headphone', categoryPath: ['Electronics', 'Headphones'], title: 'Reference', origin: 'China', packaging: { weight: 1, length: 10, width: 8, height: 5 }, mainImages: ['ref.jpg'], price: 100, skus: [{ id: 'r', price: 100 }] };
  store.update((state) => { state.products = [target, reference]; });
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
    for (const field of ['title', 'price', 'stock', 'currencySymbol', 'mainImages', 'detailImages', 'descriptionHtml', 'skus', 'categoryId', 'categoryPath', 'source']) assert.deepEqual(after[field], target[field], field);
    assert.deepEqual(after.packaging, { length: 20, weight: 1, width: 8, height: 5 });
    assert.equal(after.origin, 'China'); assert.equal(after.status, 'ready'); assert.equal(after.publishResult, undefined);
    assert.equal(verifySourceIntegrity(after).valid, true);
    assert.equal((await request('/api/storage/cleanup', { scopes: ['products'] })).status, 400);
    assert.equal((await request('/api/storage/cleanup', { scopes: ['products'], confirm: true })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'))).products.length, 0);
  } finally { await server.shutdownServer(); fs.rmSync(root, { recursive: true, force: true }); }
});
