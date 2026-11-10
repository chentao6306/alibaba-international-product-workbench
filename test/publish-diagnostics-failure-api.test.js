import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { JsonStore } from '../server/store.js';

test('unwritable diagnostic files cannot replace failures or prevent durable draft and submit receipts', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-diagnostic-fault-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, PORT: process.env.PORT };
  Object.assign(process.env, { DATA_DIR: root, PORT: '0' });
  const file = path.join(root, 'workspace.json');
  const store = new JsonStore(file);
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'Failure isolation fixture' }];
    state.products = ['bad', 'good'].map(id => ({ id, sourceId: id, sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      title: 'Synthetic camera', price: 10, categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'] }));
  });
  let eventFailures = 0, captureFailures = 0;
  const append = fs.appendFileSync.bind(fs), write = fs.writeFileSync.bind(fs);
  t.mock.method(fs, 'appendFileSync', (target, ...args) => {
    if (String(target) === path.join(root, 'service-runtime.log')) {
      eventFailures++;
      throw Object.assign(new Error('Synthetic log access denied'), { code: 'EACCES' });
    }
    return append(target, ...args);
  });
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (String(target).startsWith(path.join(root, 'diagnostics') + path.sep)) {
      captureFailures++;
      throw Object.assign(new Error('Synthetic diagnostic access denied'), { code: 'EACCES' });
    }
    return write(target, ...args);
  });
  const calls = [];
  t.mock.method(SellerPublisher.prototype, 'publishProduct', async (product, url, mode, category, jobId, report) => {
    calls.push([product.id, mode]);
    report('填写类目属性');
    if (product.id === 'bad') throw Object.assign(new Error('Original field rejection'), { code: 'PUBLISH_FIELD_NOT_READY' });
    report(mode === 'draft' ? '保存草稿' : '提交商品');
    return { status: mode === 'draft' ? 'drafted' : 'published', message: 'Synthetic confirmed fresh receipt', productId: mode + '-receipt' };
  });
  let server;
  try {
    server = await import('../server/index.js');
    const listener = await server.serverReady;
    for (const mode of ['draft', 'submit']) {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['bad', 'good'], collectionFolderId: 'folder', mode }),
      });
      assert.equal(response.status, 202);
      const job = await response.json(), deadline = Date.now() + 5000;
      while (store.read(state => state.jobs.find(item => item.id === job.id).status) !== 'completed') {
        assert.ok(Date.now() < deadline);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const persisted = new JsonStore(file).read();
      assert.equal(persisted.products.find(item => item.id === 'bad').publishResult.message, 'Original field rejection');
      assert.equal(persisted.products.find(item => item.id === 'bad').publishResult.code, 'PUBLISH_FIELD_NOT_READY');
      assert.equal(persisted.products.find(item => item.id === 'good').publishResult.productId, mode + '-receipt');
      assert.equal(persisted.products.find(item => item.id === 'good').status, mode === 'draft' ? 'drafted' : 'published');
    }
    assert.deepEqual(calls, [['bad', 'draft'], ['good', 'draft'], ['bad', 'submit'], ['good', 'submit']]);
    assert.ok(eventFailures >= 4);
    assert.equal(captureFailures, 2);
  } finally {
    await server?.shutdownServer();
    t.mock.restoreAll();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
