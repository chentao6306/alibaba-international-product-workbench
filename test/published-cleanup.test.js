import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';

test('automatic workbench cleanup persists its switch and preserves drafts, failures, history and references', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-cleanup-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  assert.equal(store.read().settings.autoRemovePublishedProducts, false);
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'QA' }];
    state.products = ['off', 'success', 'draft', 'failed'].map((id, index) => ({ id, title: id, sourceId: String(12345678901 + index), sourcePlatform: 'alibaba.com',
      categoryId: '201346401', collectionFolderId: 'folder', status: 'ready', mainImages: ['https://example.test/1.jpg'], attributes: [] }));
  });
  const original = SellerPublisher.prototype.publishProduct;
  SellerPublisher.prototype.publishProduct = async product => {
    if (product.id === 'failed') throw new Error('fixture rejection');
    return { status: product.id === 'draft' ? 'drafted' : 'published', message: 'fixture receipt', url: 'https://post.alibaba.com/product/success.htm?primaryId=123456' };
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const publish = async ids => {
    const { data: job } = await api('/api/publish', { ids, collectionFolderId: 'folder', mode: 'submit' });
    const end = Date.now() + 5000;
    while (store.read().jobs.find(row => row.id === job.id)?.status !== 'completed' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
    const saved = store.read().jobs.find(row => row.id === job.id);
    assert.equal(saved.status, 'completed'); return saved;
  };
  try {
    await publish(['off']);
    assert.equal(store.read().products.find(row => row.id === 'off').removedFromWorkbenchAt, undefined);
    assert.equal((await api('/api/settings', { autoRemovePublishedProducts: 'true' }, 'PATCH')).status, 400);
    assert.equal((await api('/api/settings', { autoRemovePublishedProducts: true }, 'PATCH')).status, 200);
    assert.equal(new JsonStore(store.filePath).read().settings.autoRemovePublishedProducts, true);
    const job = await publish(['success', 'draft', 'failed']);
    assert.equal(job.results.success.removedFromWorkbench, true);
    assert.equal(job.results.success.title, 'success');
    assert.equal(job.results.failed.status, 'failed');
    for (const route of ['/api/state', '/api/state?view=summary']) {
      const products = (await api(route, null, 'GET')).data.products;
      assert.deepEqual(products.map(row => row.id).sort(), ['draft', 'failed', 'off']);
    }
    const references = (await api('/api/references', null, 'GET')).data.references;
    assert.ok(references.some(row => row.id === 'success'));
    assert.equal(store.read().products.find(row => row.id === 'success').publishHistory[0].result.status, 'published');
    await api('/api/products/select', { all: true, selected: true });
    assert.equal(store.read().products.find(row => row.id === 'success').selected, false);
    assert.equal((await api('/api/publish', { ids: ['success'], collectionFolderId: 'folder', mode: 'submit' })).status, 400);
    await api('/api/settings', { autoRemovePublishedProducts: false }, 'PATCH');
    assert.equal(new JsonStore(store.filePath).read().settings.autoRemovePublishedProducts, false);
    assert.equal((await api('/api/state', null, 'GET')).data.products.some(row => row.id === 'success'), false);
  } finally {
    await server.shutdownServer(); SellerPublisher.prototype.publishProduct = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
