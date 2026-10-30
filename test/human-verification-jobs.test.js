import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { ShopCollector } from '../server/collector.js';
import { verificationOptions, verificationPaused, waitForVerification } from '../server/human-verification.js';

test('verification waits retain collection checkpoints and pausing a publish challenge does not count a failure', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-jobs-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  process.env.KUA_YIPU_DESKTOP = '1'; process.env.KUA_YIPU_LOCAL_GATE = 'fixture-gate';
  globalThis.__KUA_YIPU_AUTHORIZATION = { valid: () => true, canRead: () => true };
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const products = [1, 2].map((id) => ({
    id: String(id), sourceId: String(id), sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
    title: `Camera ${id}`, selected: true, status: 'ready', price: 100, origin: 'China',
    categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'],
    description: 'Camera', attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
    mainImages: [1, 2, 3, 4].map((n) => `https://example.com/${n}.jpg`), detailImages: ['https://example.com/detail.jpg']
  }));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }]; state.products = products;
    state.groups = [{ id: 'group', name: 'Source', url: 'https://fixture.en.alibaba.com/productlist.html' }];
  });
  const originalPublish = SellerPublisher.prototype.publishProduct;
  const originalCollect = ShopCollector.prototype.collectGroup;
  let cancelWindow = false;
  let collected = false;
  let publishAttempts = 0;
  const collectedProduct = { ...products[0], id: undefined, sourceId: 'collected', sourceUrl: 'https://www.alibaba.com/product-detail/fixture_123.html' };
  SellerPublisher.prototype.publishProduct = async (product) => {
    if (product.id === '2' && publishAttempts++ === 0) {
      const context = verificationOptions();
      assert.equal(typeof context.onWaiting, 'function');
      await waitForVerification({ ...context, pollMs: 10, inspect: async () => {
        if (cancelWindow) throw verificationPaused();
        return { error: true };
      } });
    }
    return { status: 'drafted', message: 'Saved receipt', productId: product.id };
  };
  ShopCollector.prototype.collectGroup = async (_url, progress) => {
    progress({ current: 1, total: 2, product: collectedProduct });
    const context = verificationOptions();
    assert.equal(typeof context.shouldStop, 'function');
    await waitForVerification({ ...context, pollMs: 10, inspect: async () => ({ ready: collected, error: !collected, url: 'verified-listing' }) });
    return [collectedProduct];
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-kua-yipu-gate': 'fixture-gate' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.json();
  };
  const until = async (check) => {
    for (let i = 0; i < 200; i++) { const state = await api('/api/state'); if (check(state)) return state; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.fail('Job state did not arrive');
  };
  try {
    const publish = await api('/api/publish', { ids: ['1', '2'], collectionFolderId: 'folder', mode: 'draft' });
    const collect = await api('/api/groups/group/collect', { collectionFolderId: 'folder' });
    const waiting = await until((state) => [publish.id, collect.id].every((id) => /等待刷新/.test(state.jobs.find((job) => job.id === id)?.message)));
    for (const id of [publish.id, collect.id]) assert.equal(waiting.jobs.find((job) => job.id === id).status, 'running');
    assert.equal(waiting.jobs.find((job) => job.id === collect.id).progress, 1);
    assert.ok(waiting.products.some((product) => product.sourceId === 'collected'));
    await api(`/api/jobs/${publish.id}/pause`, {});
    cancelWindow = true;
    const paused = await until((state) => state.jobs.find((job) => job.id === publish.id).status === 'paused');
    assert.equal(paused.products.find((p) => p.id === '1').status, 'drafted');
    assert.equal(paused.products.find((p) => p.id === '2').publishHistory?.length || 0, 0);
    assert.notEqual(paused.products.find((p) => p.id === '2').status, 'publish_failed');
    assert.equal(paused.jobs.find((job) => job.id === publish.id).progress, 1);
    assert.equal(paused.jobs.find((job) => job.id === collect.id).status, 'running');
    await api(`/api/jobs/${collect.id}/pause`, {});
    await until((state) => state.jobs.find((job) => job.id === collect.id).status === 'paused');
    collected = true;
    await api(`/api/jobs/${collect.id}/resume`, {});
    await api(`/api/jobs/${publish.id}/resume`, {});
    const completed = await until((state) => [publish.id, collect.id].every((id) => state.jobs.find((job) => job.id === id).status === 'completed'));
    assert.equal(completed.products.filter((product) => product.sourceId === 'collected').length, 1);
    assert.equal(completed.products.find((p) => p.id === '1').publishHistory.length, 1);
    assert.equal(completed.products.find((p) => p.id === '2').status, 'drafted');
  } finally {
    cancelWindow = true; collected = true;
    await server.shutdownServer();
    SellerPublisher.prototype.publishProduct = originalPublish; ShopCollector.prototype.collectGroup = originalCollect;
    delete globalThis.__KUA_YIPU_AUTHORIZATION;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
