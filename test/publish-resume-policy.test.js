import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';

test('changes a paused job policy only for remaining products and retains successful receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-resume-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const product = (id) => ({ id, sourceId: id, sourcePlatform: 'alibaba.com', collectionFolderId: 'folder', title: 'Toy', price: 10, stock: 100, categoryId: '2623', mainImages: ['https://example.com/image.jpg'] });
  fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ version: 6, shops: [], groups: [], collectionFolders: [{ id: 'folder', name: 'Toys' }], settings: {}, products: [product('done'), product('remaining')], jobs: [{
    id: 'paused', type: 'publish', status: 'paused', total: 2, progress: 1, results: { done: { status: 'published', message: 'receipt' } },
    metadata: { mode: 'submit', listingMode: 'complete-logistics', productIds: ['done', 'remaining'], stockPolicy: 'preserve', sellerGroup: { id: '12', name: 'Toys' } },
  }] }));
  const originalEnrich = ShopCollector.prototype.enrichProducts;
  const originalPublish = SellerPublisher.prototype.publishProduct;
  const calls = [];
  ShopCollector.prototype.enrichProducts = async (products) => products;
  SellerPublisher.prototype.publishProduct = async (...args) => { calls.push(args); return { status: 'published', message: 'new receipt' }; };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const resume = (listingMode) => fetch(`http://127.0.0.1:${listener.address().port}/api/jobs/paused/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingMode }) });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'));
  try {
    assert.equal((await resume('invalid')).status, 400);
    assert.equal(state().jobs[0].status, 'paused');
    assert.equal((await resume('inquiry')).status, 200);
    const deadline = Date.now() + 10000;
    while (state().jobs[0].status !== 'completed') {
      if (Date.now() > deadline) throw new Error('Resume did not complete');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].id, 'remaining');
    assert.equal(calls[0][6].listingMode, 'inquiry');
    assert.equal(calls[0][6].stockPolicy, 'preserve');
    assert.equal(calls[0][6].sellerGroup.id, '12');
    assert.deepEqual(state().jobs[0].results.done, { status: 'published', message: 'receipt' });
    assert.equal(state().jobs[0].progress, 2);
    assert.equal((await resume('complete-logistics')).status, 409);
  } finally {
    await server.shutdownServer();
    ShopCollector.prototype.enrichProducts = originalEnrich;
    SellerPublisher.prototype.publishProduct = originalPublish;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
