import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';

test('collection stays in its job folder and publishing captures only that folder and seller group', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-api-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const originalCollect = ShopCollector.prototype.collectLinks;
  const originalEnrich = ShopCollector.prototype.enrichProducts;
  const originalPublish = SellerPublisher.prototype.publishProduct;
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  let published;
  ShopCollector.prototype.collectLinks = async function (links, progress) {
    if (++requests === 1) { started(); await gate; }
    const product = { sourceId: links[0].sourceId, sourceUrl: links[0].url, sourcePlatform: 'alibaba.com', title: 'Original product', price: 12, stock: null, minOrder: 180, categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'], mainImages: ['https://example.com/product.jpg'] };
    progress({ stage: 'detail', current: 1, total: 1, key: `alibaba.com:${product.sourceId}`, product });
    return [product];
  };
  ShopCollector.prototype.enrichProducts = async (products) => products;
  SellerPublisher.prototype.publishProduct = async (...args) => { published = args; return { status: 'drafted', message: 'QA' }; };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const request = async (route, body, method = 'POST') => {
    const result = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json() };
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'));
  const wait = async (check) => {
    const deadline = Date.now() + 10000;
    while (!check()) { if (Date.now() > deadline) throw new Error('Job did not finish'); await new Promise((resolve) => setTimeout(resolve, 20)); }
  };
  const collect = { urls: 'https://www.alibaba.com/product-detail/Original_1601637470777.html', platform: 'alibaba.com', method: 'product', delaySeconds: 0 };
  try {
    assert.equal((await request('/api/collect/links', collect)).status, 400);
    const a = (await request('/api/collection-folders', { name: 'A' })).data;
    const b = (await request('/api/collection-folders', { name: 'B' })).data;
    await request('/api/collect/links', { ...collect, collectionFolderId: a.id });
    await startedPromise;
    await request(`/api/collection-folders/${b.id}/select`);
    assert.equal((await request(`/api/collection-folders/${a.id}`, null, 'DELETE')).status, 409);
    release();
    await wait(() => state().jobs.every((job) => job.status === 'completed'));
    assert.equal(state().products[0].collectionFolderId, a.id);
    await request('/api/collect/links', { ...collect, collectionFolderId: b.id });
    await wait(() => state().jobs.every((job) => job.status === 'completed'));
    const products = state().products;
    assert.equal(products.length, 2);
    assert.notEqual(products[0].id, products[1].id);
    assert.equal((await request('/api/publish', { ids: products.map((p) => p.id), collectionFolderId: a.id })).status, 400);
    const target = products.find((p) => p.collectionFolderId === b.id);
    assert.equal(target.stock, 180);
    assert.equal(target.source.snapshot.stock, null);
    assert.equal((await request(`/api/products/${target.id}`, { stock: 75 }, 'PATCH')).status, 200);
    const group = { id: '912305019', name: 'dev', path: 'dev' };
    const result = await request('/api/publish', { ids: [target.id], collectionFolderId: b.id, sellerGroup: group, mode: 'draft' });
    assert.equal(result.status, 202);
    await wait(() => state().jobs.every((job) => job.status === 'completed'));
    const { onCategorySchema, signal, ...publishOptions } = published[6];
    assert.equal(typeof onCategorySchema, 'function');
    assert.equal(signal instanceof AbortSignal, true);
    assert.deepEqual(publishOptions, { sellerGroup: group, listingMode: 'auto', stockPolicy: 'minimum-order', defaultStock: 100, allowPolicyWarningPublish: false });
    assert.equal(published[0].collectionFolderId, b.id);
    assert.equal(published[0].stock, 75);
    assert.equal(published[0].stockProvenance.stock, 'manual');
    assert.equal(state().products.find((p) => p.collectionFolderId === a.id).status, 'ready');
    assert.deepEqual(result.data.metadata.sellerGroup, group);
    assert.equal(result.data.metadata.listingMode, 'auto');
    assert.equal(result.data.metadata.stockPolicy, 'minimum-order');
    assert.equal(result.data.metadata.defaultStock, 100);
  } finally {
    release(); await server.shutdownServer();
    ShopCollector.prototype.collectLinks = originalCollect;
    ShopCollector.prototype.enrichProducts = originalEnrich;
    SellerPublisher.prototype.publishProduct = originalPublish;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
