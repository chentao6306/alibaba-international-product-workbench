import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSkuRows, importSkuRows, transformProductPrices } from '../server/batch-commerce.js';
import { convertProductPrices } from '../server/source-platform.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { JsonStore } from '../server/store.js';

const products = () => ['one', 'two'].map((id, index) => ({ id, sourceId: String(index + 100), title: 'Same product name', currencySymbol: '$', price: 10,
  skus: [{ id: `${id}-red`, code: `${id}-code`, attributes: { Color: 'Red' }, price: 10 + index, stock: 0, image: '/media/red.png', enabled: false },
    { id: `${id}-blue`, code: `${id}-blue-code`, attributes: { Color: 'Blue' }, price: 20 + index, stock: 50, image: '/media/blue.png' }] }));

test('SKU spreadsheet round trip keeps two same-title products separate with prices, IDs, images and disabled stock', () => {
  const original = products(); const rows = exportSkuRows(original);
  rows[0].price = 12.5; rows[2].price = 22.5;
  const imported = importSkuRows(original, rows);
  assert.deepEqual([...imported.keys()], ['one', 'two']);
  assert.deepEqual(imported.get('one').map((sku) => sku.price), [12.5, 20]);
  assert.deepEqual(imported.get('two').map((sku) => sku.price), [22.5, 21]);
  assert.equal(imported.get('one')[0].stock, 0); assert.equal(imported.get('one')[0].enabled, false);
  assert.equal(imported.get('two')[1].id, 'two-blue'); assert.equal(imported.get('two')[1].image, '/media/blue.png');
});

test('ambiguous legacy spreadsheets and invalid rows stop before overwriting any SKU', () => {
  const original = products();
  for (const rows of [[{ price: 4 }], [{ product: 'Same product name', price: 4 }], [{ productId: 'missing', price: 4 }],
    [{ productId: 'one', price: 'NaN' }], [{ productId: 'one', stock: -1 }], [{ productId: 'one', currencySymbol: '¥', price: 4 }]]) {
    assert.throws(() => importSkuRows(original, rows), { status: 400 });
  }
  assert.equal(importSkuRows([original[0]], [{ Color: 'Red', price: 4 }]).get('one')[0].price, 4);
  const legacy = [{ ...original[0], title: 'Unique name' }, original[1]];
  assert.equal(importSkuRows(legacy, [{ product: 'Unique name', price: 5 }]).get('one')[0].price, 5);
});

test('SKU attributes named like reserved spreadsheet columns survive export and import', () => {
  const product = products()[0]; product.skus[0].attributes = { price: 'Retail', id: 'Model A', Color: 'Red' };
  const result = importSkuRows([product], exportSkuRows([product]));
  assert.deepEqual(result.get('one')[0].attributes, product.skus[0].attributes);
});

test('currency conversion then batch markup preserves distinct SKU and FOB prices and unknown values', () => {
  const product = { ...products()[0], currencySymbol: '¥', priceTiers: [{ minQuantity: 5, price: 10 }], fobPrice: { minPrice: 10, maxPrice: 20, tiers: [{ minQuantity: 5, price: 10 }] } };
  product.skus.push({ id: 'unknown', price: '', stock: '' });
  const converted = { ...product, ...convertProductPrices(product, 0.5) };
  const next = transformProductPrices(converted, { percent: 20, fixed: 1 });
  assert.equal(next.price, '7.00'); assert.deepEqual(next.skus.map((sku) => sku.price), ['7.00', '13.00', '']);
  assert.equal(next.fobPrice.maxPrice, '13.00'); assert.equal(next.fobPrice.tiers[0].price, '7.00');
  assert.equal(next.priceTiers[0].price, '7.00'); assert.equal(product.skus[0].price, 10);
  assert.throws(() => transformProductPrices(product, { percent: -110 }), { status: 400 });
});

test('batch commerce API preserves product boundaries and refuses active-job edits while find preview never writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-commerce-'));
  process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
  const server = await import('../server/index.js'); const listener = await server.serverReady;
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const endpoint = `http://127.0.0.1:${listener.address().port}`;
  const call = async (route, body, method = 'POST') => {
    const response = await fetch(endpoint + route, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    store.update((state) => { state.products = products().map(syncProductModel); });
    const before = fs.readFileSync(path.join(root, 'workspace.json'), 'utf8');
    assert.equal((await call('/api/products/find-replace', { ids: ['one'], search: 'Same', replacement: 'Edited', dryRun: true })).status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'), before);
    const rows = exportSkuRows(products()); rows[0].price = 12;
    assert.equal((await call('/api/products/batch-update', { ids: ['one', 'two'], patch: { skuRows: rows, priceTransform: { percent: 10, fixed: 1 } } })).status, 200);
    assert.deepEqual(store.read((s) => s.products.map((p) => p.skus.map((sku) => sku.price))), [['14.20', '23.00'], ['13.10', '24.10']]);
    assert.ok(store.read((s) => s.products.every((p) => verifySourceIntegrity(p).valid)));
    store.update((state) => { state.jobs = [{ id: 'job', type: 'publish', status: 'running', metadata: { productIds: ['one'] } }]; });
    for (const [route, body, method] of [
      ['/api/products/one', { title: 'Blocked' }, 'PATCH'],
      ['/api/products/batch-update', { ids: ['one', 'two'], patch: { price: 99 } }],
      ['/api/products/find-replace', { ids: ['one'], search: 'Same', replacement: 'Blocked' }],
    ]) assert.equal((await call(route, body, method)).status, 409);
    assert.equal((await call('/api/products/two', { title: 'Free to edit' }, 'PATCH')).status, 200);
    store.update((state) => { state.jobs[0].status = 'paused'; });
    assert.equal((await call('/api/products/one', { title: 'Paused edit' }, 'PATCH')).status, 200);
    const persisted = store.read((s) => s.products);
    assert.equal((await call('/api/products/batch-update', { ids: ['one', 'two'], patch: { skuRows: [{ price: 9 }] } })).status, 400);
    assert.deepEqual(store.read((s) => s.products), persisted);
  } finally { await server.shutdownServer(); fs.rmSync(root, { recursive: true, force: true }); }
});
