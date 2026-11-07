import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { ShopCollector } from '../server/collector.js';

test('an authorization outage preserves the current receipt and collection progress without starting the next product', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-task-pause-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  process.env.KUA_YIPU_DESKTOP = '1'; process.env.KUA_YIPU_LOCAL_GATE = 'fixture-gate';
  let authorized = true;
  globalThis.__KUA_YIPU_AUTHORIZATION = { valid: () => authorized, canRead: () => true };
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const products = [1, 2].map((id) => ({
    id: String(id), sourceId: String(id), sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
    title: `Camera ${id}`, selected: true, status: 'ready', price: 100, origin: 'China',
    categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'],
    description: 'Camera', attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
    mainImages: [1, 2, 3, 4].map((n) => `https://example.com/${n}.jpg`), detailImages: ['https://example.com/detail.jpg'],
  }));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }]; state.products = products;
    state.groups = [{ id: 'group', name: 'Source', url: 'https://fixture.en.alibaba.com/productlist.html' }];
  });
  const originalPublish = SellerPublisher.prototype.publishProduct;
  const originalCollect = ShopCollector.prototype.collectGroup;
  let releasePublish; let releaseCollect;
  let notifyPublish; let notifyCollect;
  const publishEntered = new Promise((resolve) => { notifyPublish = resolve; });
  const collectEntered = new Promise((resolve) => { notifyCollect = resolve; });
  const calls = [];
  SellerPublisher.prototype.publishProduct = async (product) => {
    calls.push(product.id);
    if (calls.length === 1) { notifyPublish(); await new Promise((resolve) => { releasePublish = resolve; }); }
    return { status: 'drafted', message: 'Saved receipt', productId: product.id };
  };
  ShopCollector.prototype.collectGroup = async (_url, progress, options) => {
    notifyCollect(); await new Promise((resolve) => { releaseCollect = resolve; });
    progress({ current: 1, total: 2, product: { ...products[0], id: undefined, sourceId: 'collected', sourceUrl: 'https://www.alibaba.com/product-detail/fixture_123.html' } });
    assert.equal(options.shouldStop(), true);
    throw Object.assign(new Error('COLLECT_PAUSED'), { code: 'COLLECT_PAUSED' });
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = (route, body, gate = 'fixture-gate') => fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-kua-yipu-gate': gate }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const waitFor = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(condition());
  };
  try {
    const publish = await (await api('/api/publish', { ids: ['1', '2'], collectionFolderId: 'folder', mode: 'draft' })).json();
    await publishEntered;
    const collect = await (await api('/api/groups/group/collect', { collectionFolderId: 'folder' })).json();
    await collectEntered;
    authorized = false;
    await server.suspendAuthorizedWork({ graceful: true });
    assert.equal(store.read().jobs.find((job) => job.id === publish.id).status, 'pause_requested');
    assert.equal((await api('/api/state')).status, 200);
    assert.equal((await api('/api/state', null, '')).status, 401);
    assert.equal((await api(`/api/jobs/${publish.id}/resume`, {})).status, 401);
    // Cross multiple watchdog ticks: the in-flight product must still be
    // accepted even when receipt/API requests are slow on a busy computer.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(store.read().jobs.find((job) => job.id === collect.id).status, 'pause_requested');
    releasePublish(); releaseCollect();
    await waitFor(() => store.read().jobs.every((job) => job.status === 'paused'));
    const paused = store.read();
    assert.deepEqual(calls, ['1']);
    assert.equal(paused.products.find((p) => p.id === '1').status, 'drafted');
    assert.equal(paused.products.find((p) => p.id === '1').selected, false);
    assert.equal(paused.jobs.find((job) => job.id === publish.id).progress, 1);
    assert.equal(paused.jobs.find((job) => job.id === collect.id).progress, 1);
    assert.ok(paused.products.some((p) => p.sourceId === 'collected'));
    authorized = true;
    assert.equal((await api(`/api/jobs/${publish.id}/resume`, {})).status, 200);
    await waitFor(() => store.read().jobs.find((job) => job.id === publish.id).status === 'completed');
    assert.deepEqual(calls, ['1', '2']);
    assert.equal(store.read().products.find((p) => p.id === '1').publishHistory.length, 1);
  } finally {
    releasePublish?.(); releaseCollect?.();
    await server.shutdownServer();
    SellerPublisher.prototype.publishProduct = originalPublish; ShopCollector.prototype.collectGroup = originalCollect;
    delete globalThis.__KUA_YIPU_AUTHORIZATION;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
