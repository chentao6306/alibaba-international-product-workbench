import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';

test('a rejected seller group fails one item and continues the remaining batch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-queue-test-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }];
    state.products = [1, 2, 3].map((id) => ({
      id: String(id), sourceId: String(id), sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      title: `Camera ${id}`, selected: true, status: 'ready', price: 100, origin: 'China',
      categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'],
      description: 'Camera', attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
      mainImages: [1, 2, 3, 4].map((n) => `https://example.com/${n}.jpg`), detailImages: ['https://example.com/detail.jpg'],
    }));
  });
  const original = SellerPublisher.prototype.publishProduct;
  const calls = [];
  SellerPublisher.prototype.publishProduct = async (product, _url, _mode, _category, _job, _progress, options) => {
    calls.push(product.id);
    assert.equal(options.sellerGroup.id, '100');
    if (product.id === '1') throw Object.assign(new Error('国际站未接受商品分组：照相机'), { code: 'SELLER_GROUP_UNAVAILABLE' });
    return { status: 'drafted', message: 'Saved' };
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['1', '2', '3'], collectionFolderId: 'folder', mode: 'draft', sellerGroup: { id: '100', name: '照相机' } }),
    });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 10000;
    while (store.read().jobs[0]?.status !== 'completed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const state = store.read();
    assert.deepEqual(calls, ['1', '2', '3']);
    assert.equal(state.jobs[0].status, 'completed');
    assert.equal(state.jobs[0].progress, 3);
    assert.match(state.jobs[0].message, /成功 2 件，失败 1 件/);
    assert.deepEqual(state.products.map((product) => product.status), ['publish_failed', 'drafted', 'drafted']);
    assert.deepEqual(state.products.map((product) => product.selected), [true, false, false]);
  } finally {
    await server.shutdownServer();
    SellerPublisher.prototype.publishProduct = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
