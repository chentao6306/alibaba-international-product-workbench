import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';
import { CollectionCheckpoint } from '../server/collection-checkpoint.js';

test('API pauses mid-listing and mid-detail, retries an interrupted page and completes without resetting counters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-resume-api-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Test' }];
    state.groups = [{ id: 'group', name: 'Test', url: 'https://fixture.en.alibaba.com/productlist.html' }];
  });
  const originalPage = ShopCollector.prototype.withPage;
  const originalDetails = SellerPublisher.prototype.enrichSourceProducts;
  let releasePage; let releaseDetail; let listingBlocked = false; let detailBlocked = false;
  let injectFailure = true;
  const visited = []; const details = [];
  ShopCollector.prototype.withPage = async function (callback) {
    let current;
    const page = { isClosed: () => false, evaluate: async () => false, waitForTimeout: async () => {}, waitForLoadState: async () => {},
      url: () => `https://fixture.en.alibaba.com/productlist-${current}.html`,
      goto: async (url) => {
        current = Number(url.match(/productlist-(\d+)/)?.[1] || 1); visited.push(current);
        if (current === 2 && !listingBlocked) { listingBlocked = true; await new Promise((resolve) => { releasePage = resolve; }); }
        if (current === 3 && injectFailure) { injectFailure = false; throw new Error('Page interrupted'); }
      },
      locator: () => ({ evaluateAll: async () => ({ pageNav: { currentPage: current, totalLines: 6, pageLines: 2,
        formatString: 'https://fixture.en.alibaba.com/productlist-{0}.html' }, products: [1, 2].map((i) => ({ id: String((current - 1) * 2 + i), subject: 'Fixture', url: `https://www.alibaba.com/product-detail/item_${current}${i}.html` })) }) }) };
    return callback(page);
  };
  SellerPublisher.prototype.enrichSourceProducts = async (products, progress) => {
    for (const [index, product] of products.entries()) {
      if (index === 1 && !detailBlocked) { detailBlocked = true; await new Promise((resolve) => { releaseDetail = resolve; }); }
      details.push(product.sourceId);
      if (progress(index + 1, products.length, product) === false) throw Object.assign(new Error('COLLECT_PAUSED'), { code: 'COLLECT_PAUSED' });
    }
    return products;
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const request = async (route, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.text());
  };
  const until = async (condition) => {
    const deadline = Date.now() + 10000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), 'Expected task state did not arrive');
  };
  const job = () => store.read().jobs[0];
  try {
    await request('/api/groups/group/collect', { collectionFolderId: 'folder', delaySeconds: 0 });
    await until(() => Boolean(releasePage));
    const id = job().id;
    const disk = new CollectionCheckpoint(root, id);
    await request(`/api/jobs/${id}/pause`); releasePage();
    await until(() => job().status === 'paused');
    assert.equal(disk.read().page, 2); assert.equal(job().discovered, 4); assert.equal(job().progress, 0);
    await request(`/api/jobs/${id}/resume`);
    await until(() => job().status === 'paused');
    assert.match(job().message, /Page interrupted/); assert.equal(disk.read().page, 2);
    await request(`/api/jobs/${id}/resume`);
    await until(() => Boolean(releaseDetail));
    assert.equal(job().progress, 1); assert.equal(job().total, 6);
    await request(`/api/jobs/${id}/pause`); releaseDetail();
    await until(() => job().status === 'paused');
    assert.equal(job().progress, 2); assert.deepEqual(disk.read().completedIds, ['1', '2']);
    await request(`/api/jobs/${id}/resume`);
    await until(() => job().status === 'completed');
    assert.deepEqual(visited, [1, 2, 3, 3]);
    assert.deepEqual(details, ['1', '2', '3', '4', '5', '6']);
    assert.equal(store.read().products.length, 6); assert.equal(job().progress, 6); assert.equal(job().total, 6);
    assert.equal(disk.read(), null);
    assert.equal(JSON.stringify(job()).includes('nextUrl'), false, 'Listing queue must not be sent in polling responses');
  } finally {
    releasePage?.(); releaseDetail?.(); await server.shutdownServer();
    ShopCollector.prototype.withPage = originalPage; SellerPublisher.prototype.enrichSourceProducts = originalDetails;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
