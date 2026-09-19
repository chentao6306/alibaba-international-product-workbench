import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';
import { JsonStore } from '../server/store.js';

test('applies saved delays between products and resumes paused waits without duplicating successful products', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-delay-jobs-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.version = 6;
    state.collectionFolders = [{ id: 'folder', name: 'Test' }];
    state.products = ['1', '2', '3'].map((id) => ({ id, sourceId: id, sourcePlatform: 'alibaba.com',
      collectionFolderId: 'folder', title: `Toy ${id}`, price: 10, stock: 100, categoryId: '2623',
      mainImages: ['https://example.com/image.jpg'] }));
  });
  const originals = { enrich: ShopCollector.prototype.enrichProducts, publish: SellerPublisher.prototype.publishProduct };
  const calls = [];
  ShopCollector.prototype.enrichProducts = async (products) => products;
  SellerPublisher.prototype.publishProduct = async (product) => { calls.push({ id: product.id, at: Date.now() }); return { status: 'drafted', message: 'Saved fixture draft' }; };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = async (route, body, method = 'POST', expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, expected, route);
    return response.json();
  };
  const until = async (check) => {
    const deadline = Date.now() + 5000;
    while (!check(store.read())) {
      if (Date.now() >= deadline) throw new Error('Job did not reach expected state');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return store.read();
  };
  try {
    await api('/api/settings', { publishDelayMinSeconds: 300, publishDelayMaxSeconds: 300 }, 'PATCH');
    assert.equal(store.read().settings.publishDelayMinSeconds, 300);
    await api('/api/publish', { ids: ['1', '2'], collectionFolderId: 'folder', publishDelayMinSeconds: 8, publishDelayMaxSeconds: 2 }, 'POST', 400);
    assert.equal(store.read().jobs.length, 0);
    const job = await api('/api/publish', { ids: ['1', '2'], collectionFolderId: 'folder', mode: 'draft' }, 'POST', 202);
    await until((state) => state.jobs.find((item) => item.id === job.id)?.waitingForDelay);
    assert.deepEqual(calls.map((call) => call.id), ['1']);
    await api(`/api/jobs/${job.id}/pause`, {});
    const paused = await until((state) => state.jobs.find((item) => item.id === job.id).status === 'paused');
    assert.equal(paused.jobs[0].progress, 1);
    assert.equal(paused.jobs[0].results['1'].status, 'drafted');
    await api(`/api/jobs/${job.id}/resume`, { publishDelayMinSeconds: -1, publishDelayMaxSeconds: 0 }, 'POST', 400);
    assert.equal(store.read().jobs[0].status, 'paused');
    await api(`/api/jobs/${job.id}/resume`, { publishDelayMinSeconds: 0, publishDelayMaxSeconds: 0 });
    await until((state) => state.jobs.find((item) => item.id === job.id).status === 'completed');
    assert.deepEqual(calls.map((call) => call.id), ['1', '2']);
    assert.equal(store.read().settings.publishDelayMaxSeconds, 0);
    calls.length = 0;
    const timed = await api('/api/publish', { ids: ['2', '3'], collectionFolderId: 'folder', mode: 'draft',
      publishDelayMinSeconds: 0.5, publishDelayMaxSeconds: 0.5 }, 'POST', 202);
    await until((state) => state.jobs.find((item) => item.id === timed.id).status === 'completed');
    assert.deepEqual(calls.map((call) => call.id), ['2', '3']);
    assert.ok(calls[1].at - calls[0].at >= 490);
    assert.equal(store.read().settings.publishDelayMinSeconds, 0.5);
  } finally {
    await server.shutdownServer();
    ShopCollector.prototype.enrichProducts = originals.enrich;
    SellerPublisher.prototype.publishProduct = originals.publish;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
