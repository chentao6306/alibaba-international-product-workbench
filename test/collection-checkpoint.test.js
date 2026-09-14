import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';

test('group completion does not resave stale products over an already checkpointed edit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-checkpoint-'));
  process.env.DATA_DIR = root;
  process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }];
    state.groups = [{ id: 'group', name: 'Cameras', url: 'https://example.alibaba.com/productgrouplist-1/Cameras.html' }];
  });
  const original = ShopCollector.prototype.collectGroup;
  ShopCollector.prototype.collectGroup = async (_url, onProgress) => {
    onProgress({ stage: 'listing', page: 1, found: 24, storeTotal: 24 });
    assert.equal(store.read().jobs[0].progress, 0, 'Discovered links are not saved products');
    assert.equal(store.read().jobs[0].discovered, 24);
    onProgress({ stage: 'detail', current: 0, total: 24, found: 24 });
    assert.equal(store.read().jobs[0].progress, 0);
    assert.equal(store.read().jobs[0].total, 24, 'Detail total must be visible before the first product or CAPTCHA');
    const product = { sourceId: '123', title: 'Collected camera', mainImages: ['https://example.com/main.jpg'], sourcePlatform: 'alibaba.com' };
    onProgress({ stage: 'detail', current: 1, total: 1, product });
    store.update((state) => { state.products[0].title = 'User edited title'; });
    return [product];
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/groups/group/collect`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collectionFolderId: 'folder' }),
    });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 10000;
    while (store.read((state) => state.jobs[0]?.status) !== 'completed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const state = store.read();
    assert.equal(state.jobs[0].status, 'completed');
    assert.equal(state.jobs[0].metadata.options.allPages, true);
    assert.equal(state.jobs[0].metadata.options.endPage, null);
    assert.match(state.jobs[0].message, /全部页读取完成/);
    assert.equal(state.products.length, 1);
    assert.equal(state.products[0].title, 'User edited title');
  } finally {
    await server.shutdownServer();
    ShopCollector.prototype.collectGroup = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
