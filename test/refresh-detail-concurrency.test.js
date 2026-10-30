import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';

test('source refresh protects in-flight publication, newer edits, deletion and duplicate requests', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-concurrency-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'QA' }];
    state.products = ['active', 'edited', 'deleted', 'duplicate', 'warning', 'error'].map(id => ({
      id, sourceId: id, sourcePlatform: 'alibaba.com', title: id, status: 'ready',
      collectionFolderId: 'folder', categoryId: '201346401', mainImages: ['https://example.test/source.jpg'],
    }));
  });
  const original = ShopCollector.prototype.enrichProducts;
  const pending = new Map();
  ShopCollector.prototype.enrichProducts = ([product]) => new Promise((resolve, reject) => pending.set(product.id, {
    resolve: (patch = {}) => resolve([{ ...product, title: 'Refreshed source', ...patch }]), reject,
  }));
  const server = await import('../server/index.js'); const listener = await server.serverReady;
  const api = async (route, body = {}, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const start = async id => {
    const response = api(`/api/products/${id}/refresh-detail`);
    for (let i = 0; !pending.has(id) && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(pending.has(id)); return { response, complete: pending.get(id).resolve };
  };
  try {
    await t.test('cannot refresh a product owned by an active publish task', async () => {
      store.update(state => { state.jobs = [{ id: 'active-job', type: 'publish', status: 'running', metadata: { productIds: ['active'] } }]; });
      const request = api('/api/products/active/refresh-detail');
      // Release an incorrectly started collector so a regression cannot hang the test.
      await new Promise(resolve => setTimeout(resolve, 60));
      pending.get('active')?.resolve();
      assert.equal((await request).status, 409);
      assert.equal(pending.has('active'), false);
    });
    store.update(state => { state.jobs = []; });
    await t.test('does not overwrite an edit saved during collection', async () => {
      const task = await start('edited');
      assert.equal((await api('/api/products/edited', { title: 'User saved title', price: 17 }, 'PATCH')).status, 200);
      task.complete(); assert.equal((await task.response).status, 409);
      const product = store.read().products.find(row => row.id === 'edited');
      assert.equal(product.title, 'User saved title'); assert.equal(product.price, 17);
    });
    await t.test('does not recreate or crash on a product deleted during collection', async () => {
      const task = await start('deleted');
      assert.equal((await api('/api/products/deleted', {}, 'DELETE')).status, 200);
      task.complete(); assert.equal((await task.response).status, 409);
      assert.equal(store.read().products.some(row => row.id === 'deleted'), false);
    });
    await t.test('blocks duplicate refresh, publication and updates until refresh finishes', async () => {
      const task = await start('duplicate');
      assert.equal((await api('/api/products/duplicate/refresh-detail')).status, 409);
      assert.equal((await api('/api/publish', { ids: ['duplicate'], collectionFolderId: 'folder' })).status, 409);
      store.update(state => { state.jobs = [{ id: 'resume-job', type: 'publish', status: 'paused', progress: 0, metadata: { productIds: ['duplicate'] } }]; });
      assert.equal((await api('/api/jobs/resume-job/resume')).status, 409);
      assert.equal(store.read().jobs[0].status, 'paused');
      store.update(state => { state.jobs = []; });
      assert.throws(() => server.prepareForUpdate());
      task.complete(); assert.equal((await task.response).status, 200);
      assert.equal(store.read().products.find(row => row.id === 'duplicate').title, 'Refreshed source');
    });
    await t.test('unsuccessful refresh preserves the previous successful receipt and data', async () => {
      store.update(state => { const product = state.products.find(row => row.id === 'warning'); product.status = 'published'; product.publishResult = { status: 'published', url: 'https://post.alibaba.com/product/success.htm?primaryId=123456' }; });
      const task = await start('warning'); task.complete({ collectWarning: 'Source temporarily unavailable' });
      assert.equal((await task.response).status, 200);
      const product = store.read().products.find(row => row.id === 'warning');
      assert.equal(product.title, 'warning'); assert.equal(product.status, 'published');
      assert.equal(product.publishResult.status, 'published');
    });
    await t.test('collector failure releases the lock for a successful retry', async () => {
      const task = await start('error'); pending.get('error').reject(new Error('Collection transport failure'));
      assert.equal((await task.response).status, 500); pending.delete('error');
      const retry = await start('error'); retry.complete(); assert.equal((await retry.response).status, 200);
    });
  } finally {
    for (const task of pending.values()) task.resolve();
    await server.shutdownServer(); ShopCollector.prototype.enrichProducts = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
