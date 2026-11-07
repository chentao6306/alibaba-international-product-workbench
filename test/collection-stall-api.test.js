import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';
import { CollectionCheckpoint } from '../server/collection-checkpoint.js';
import { trackCollectionPage } from '../server/collection-control.js';

test('a collection stuck after 17 products pauses, resumes or cancels without late writes or a blocked queue', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-stall-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const original = ShopCollector.prototype.collectGroup;
  let release, lateDone, attempts = 0, closed = 0, lateCompleted = 0;
  const late = new Promise(resolve => { lateDone = resolve; });
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'Fixture' }];
    state.groups = [{ id: 'group', name: 'Lights', url: 'https://fixture.en.alibaba.com/productlist.html' },
      { id: 'orphan', name: 'Old orphan', status: 'collecting', activeJobId: 'missing', collectedCount: 17 }];
    state.jobs = [{ id: 'old-running', type: 'collect', status: 'running', progress: 17, total: 1578, metadata: { groupId: 'group', collectionFolderId: 'folder' } }];
  });
  ShopCollector.prototype.collectGroup = async (_url, progress, options) => {
    attempts++;
    const products = Array.from({ length: 18 }, (_, index) => ({ sourceId: String(index + 1), title: `Lamp ${index + 1}`,
      sourceUrl: `https://www.alibaba.com/product-detail/fixture_${100000000 + index}.html` }));
    const completed = new Set(options.checkpoint?.completedIds || []);
    for (const product of products) {
      if (completed.has(product.sourceId)) continue;
      if (product.sourceId === '18' && [1, 3].includes(attempts)) {
        trackCollectionPage({ close: async () => { closed++; await new Promise(() => {}); } });
        await new Promise(resolve => { release = resolve; });
        assert.throws(() => progress({ stage: 'detail', current: 18, total: 18, product }), { code: 'COLLECT_PAUSED' });
        assert.throws(() => options.onCheckpoint({ completedIds: ['late'] }), { code: 'COLLECT_PAUSED' });
        lateCompleted++; lateDone(); return products;
      }
      progress({ stage: 'detail', current: completed.size + 1, total: 18, product });
      completed.add(product.sourceId);
      options.onCheckpoint({ version: 1, scope: 'fixture', stage: 'detail', page: 1, nextUrl: '', visited: [], products, completedIds: [...completed] });
    }
    return products;
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = async (route, method = 'POST', body = {}) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
      method, headers: { 'content-type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const until = async check => {
    const deadline = Date.now() + 8000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), 'Expected collection state did not arrive');
  };
  try {
    const startup = await api('/api/state', 'GET');
    assert.equal(startup.jobs[0].status, 'paused'); assert.equal(startup.jobs[0].progress, 17);
    assert.equal(startup.groups.find(group => group.id === 'orphan').status, 'ready');
    await api('/api/jobs/old-running/cancel');
    const job = await api('/api/groups/group/collect', 'POST', { collectionFolderId: 'folder' });
    const current = () => store.read(state => state.jobs.find(item => item.id === job.id));
    await until(() => Boolean(release));
    assert.equal(current().progress, 17);
    await api(`/api/jobs/${job.id}/pause`);
    await until(() => current().status === 'paused');
    assert.equal(closed, 1); assert.equal(store.read(state => state.products.length), 17);
    assert.equal(new CollectionCheckpoint(root, job.id).read().completedIds.length, 17);
    assert.equal(store.read(state => state.groups.find(group => group.id === 'group').status), 'ready');
    await api(`/api/jobs/${job.id}/resume`);
    await until(() => current().status === 'completed');
    assert.equal(current().progress, 18); assert.equal(store.read(state => state.products.length), 18);
    release(); await late;
    assert.equal(current().status, 'completed'); assert.equal(current().progress, 18);
    assert.equal(new CollectionCheckpoint(root, job.id).read(), null);
    assert.equal(store.read(state => state.products.length), 18);
    // Cancellation must also unlock a run whose current page never returned.
    release = null;
    const queued = await api('/api/groups/group/collect', 'POST', { collectionFolderId: 'folder' });
    await until(() => Boolean(release));
    await api(`/api/jobs/${queued.id}/pause`);
    await until(() => store.read(state => state.jobs.find(item => item.id === queued.id).status) === 'paused');
    await api(`/api/jobs/${queued.id}/cancel`);
    release(); await until(() => lateCompleted === 2);
    assert.equal(store.read(state => state.jobs.find(item => item.id === queued.id).status), 'cancelled');
    assert.equal(new CollectionCheckpoint(root, queued.id).read(), null);
    assert.equal(store.read(state => state.products.length), 18);
    const next = await api('/api/groups/group/collect', 'POST', { collectionFolderId: 'folder' });
    await until(() => store.read(state => state.jobs.find(item => item.id === next.id).status) === 'completed');
    assert.equal(store.read(state => state.products.length), 18);
  } finally {
    release?.(); await server.shutdownServer(); ShopCollector.prototype.collectGroup = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
