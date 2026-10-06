import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';

test('persists supplier groups and resumes detail collection without overwriting saved edits or replaying completed products', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mic-group-jobs-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  process.env.KUA_YIPU_DESKTOP = '1'; process.env.KUA_YIPU_LOCAL_GATE = 'fixture-gate';
  globalThis.__KUA_YIPU_AUTHORIZATION = { valid: () => true, canRead: () => true };
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const origin = 'https://supplier.en.made-in-china.com';
  store.update(state => { state.collectionFolders = [{ id: 'folder', name: 'Test' }]; });
  const originalGroups = ShopCollector.prototype.listGroups;
  const originalCollect = ShopCollector.prototype.collectMadeInChinaShop;
  const handled = [];
  let stopFirst = true;
  ShopCollector.prototype.listGroups = async () => ({ shopUrl: origin + '/', shopName: 'Hardware', sourcePlatform: 'made-in-china', groups: [{ externalId: 'Bolts123', name: 'Bolts', url: origin + '/product-group/Bolts123/Bolts-catalog-1.html' }] });
  ShopCollector.prototype.collectMadeInChinaShop = async (_link, progress, options) => {
    assert.equal(options.maxProducts, null); assert.equal(options.allPages, true);
    for (const id of ['ProductA', 'ProductB']) {
      const key = `made-in-china:${id}`;
      if (options.completedKeys.includes(key)) continue;
      handled.push(id);
      progress({ product: { sourcePlatform: 'made-in-china', sourceId: id, sourceUrl: `${origin}/product/${id}/China-Bolt.html`, title: `Bolt ${id}`, price: 2 }, key, stage: 'detail', total: 2, current: handled.length });
      if (stopFirst) {
        while (!options.shouldStop()) await new Promise(resolve => setTimeout(resolve, 10));
        throw Object.assign(new Error('Paused'), { code: 'COLLECT_PAUSED' });
      }
    }
    return [];
  };
  const server = await import('../server/index.js'); const listener = await server.serverReady;
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kua-yipu-gate': 'fixture-gate' }, body: JSON.stringify(body || {}) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const until = async check => { for (let i = 0; i < 200; i++) { if (check(store.read())) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Expected job state'); };
  try {
    const read = await api('/api/shops/read-groups', { url: origin, platform: 'made-in-china' });
    const group = read.groups[0];
    const job = await api(`/api/groups/${group.id}/collect`, { collectionFolderId: 'folder', allPages: true });
    await until(state => state.products.length === 1);
    await api(`/api/jobs/${job.id}/pause`);
    await until(state => state.jobs[0].status === 'paused');
    store.update(state => { state.products[0].title = 'My saved title'; });
    await api('/api/shops/read-groups', { url: origin, platform: 'made-in-china' });
    assert.equal(store.read().groups.length, 1);
    stopFirst = false;
    await api(`/api/jobs/${job.id}/resume`);
    await until(state => state.jobs[0].status === 'completed');
    assert.deepEqual(handled, ['ProductA', 'ProductB']);
    const state = store.read();
    assert.equal(state.products.find(p => p.sourceId === 'ProductA').title, 'My saved title');
    assert.ok(state.products.every(p => p.groupId === group.id && p.shopId === read.shop.id));
    assert.equal(state.groups[0].status, 'done'); assert.equal(state.groups[0].collectedCount, 2);
  } finally {
    stopFirst = false; await server.shutdownServer();
    ShopCollector.prototype.listGroups = originalGroups; ShopCollector.prototype.collectMadeInChinaShop = originalCollect;
    delete globalThis.__KUA_YIPU_AUTHORIZATION;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
