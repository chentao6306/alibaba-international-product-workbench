import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';
import { CollectionCheckpoint } from '../server/collection-checkpoint.js';

test('paused 100-page collection can finish only discovered products and resume details without reading further pages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-discovered-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Test' }];
    state.groups = [{ id: 'group', name: 'Test', url: 'https://fixture.en.alibaba.com/productlist.html' }];
  });
  const originalPage = ShopCollector.prototype.withPage;
  const originalDetails = SellerPublisher.prototype.enrichSourceProducts;
  const visited = []; const details = [];
  let releasePage; let releaseDetail; let detailBlocked = false;
  let listingSettled = false; let detailSettled = false;
  ShopCollector.prototype.withPage = async function (callback) {
    let current;
    try {
      return await callback({ isClosed: () => false, evaluate: async () => false, waitForTimeout: async () => {}, waitForLoadState: async () => {},
        url: () => `https://fixture.en.alibaba.com/productlist-${current}.html`,
        goto: async (url) => {
          current = Number(url.match(/productlist-(\d+)/)?.[1] || 1); visited.push(current);
          if (current === 4) await new Promise((resolve) => { releasePage = resolve; });
        },
        locator: () => ({ evaluateAll: async () => ({ pageNav: { currentPage: current, totalLines: 200, pageLines: 2,
          formatString: 'https://fixture.en.alibaba.com/productlist-{0}.html' }, products: [1, 2].map((i) => ({
          id: String((current - 1) * 2 + i), subject: 'Fixture', url: `https://www.alibaba.com/product-detail/item_${current}${i}.html`
        })) }) }) });
    } finally { listingSettled = true; }
  };
  SellerPublisher.prototype.enrichSourceProducts = async (products, progress) => {
    try {
      for (const [index, product] of products.entries()) {
        if (index === 1 && !detailBlocked) { detailBlocked = true; await new Promise((resolve) => { releaseDetail = resolve; }); }
        details.push(product.sourceId);
        if (progress(index + 1, products.length, product) === false) throw Object.assign(new Error('COLLECT_PAUSED'), { code: 'COLLECT_PAUSED' });
      }
      return products;
    } finally { detailSettled = true; }
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const request = async (route, body = {}, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const until = async (condition) => {
    const deadline = Date.now() + 10000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), 'Expected task state did not arrive');
  };
  const job = () => store.read().jobs[0];
  try {
    await request('/api/groups/group/collect', { collectionFolderId: 'folder', delaySeconds: 0, startPage: 1, endPage: 100 }, 202);
    await until(() => Boolean(releasePage));
    const id = job().id;
    const disk = new CollectionCheckpoint(root, id);
    await request(`/api/jobs/${id}/collect-discovered`, {}, 409);
    await request(`/api/jobs/${id}/pause`);
    await until(() => job().status === 'paused');
    assert.equal(disk.read().page, 3); assert.equal(job().discovered, 6);
    releasePage(); await until(() => listingSettled);
    assert.equal(disk.read().page, 3, 'The unfinished page must not overwrite the paused checkpoint');
    await request(`/api/jobs/${id}/collect-discovered`);
    await until(() => Boolean(releaseDetail));
    assert.equal(job().total, 6); assert.equal(job().progress, 1);
    assert.equal(disk.read().discoveredOnly, true);
    await request(`/api/jobs/${id}/pause`);
    await until(() => job().status === 'paused');
    releaseDetail(); await until(() => detailSettled);
    assert.equal(store.read().products.length, 1, 'The late detail must not be saved after pause');
    // Reconstruct from disk, just as after a process restart.
    assert.equal(new CollectionCheckpoint(root, id).read().discoveredOnly, true);
    assert.equal(disk.read().stage, 'detail');
    await request(`/api/jobs/${id}/collect-discovered`, {}, 409);
    await request(`/api/jobs/${id}/resume`);
    await until(() => job().status === 'completed');
    assert.deepEqual(visited, [1, 2, 3, 4]);
    assert.deepEqual(details, ['1', '2', '2', '3', '4', '5', '6']);
    assert.deepEqual(store.read().products.map(product => product.sourceId).sort(), ['1', '2', '3', '4', '5', '6']);
    assert.equal(job().progress, 6); assert.equal(job().total, 6);
    assert.match(job().message, /已发现的 6 件商品采集完成/);
    assert.doesNotMatch(job().message, /100/);
    assert.equal(disk.read(), null);
  } finally {
    releasePage?.(); releaseDetail?.(); await server.shutdownServer();
    ShopCollector.prototype.withPage = originalPage; SellerPublisher.prototype.enrichSourceProducts = originalDetails;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
