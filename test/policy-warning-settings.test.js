import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';

test('policy setting requires confirmation, persists, and reaches subsequent publishing attempts without changing other settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-settings-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  assert.equal(store.read().settings.allowPolicyWarningPublish, false);
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'QA' }];
    state.settings.priceMarkup = 12;
    state.products = [{ id: 'p1', sourceId: '12345678901', sourcePlatform: 'alibaba.com', title: 'Test propeller', categoryId: '201346401',
      collectionFolderId: 'folder', status: 'ready', mainImages: ['https://example.com/1.jpg'], attributes: [] }];
  });
  const original = SellerPublisher.prototype.publishProduct;
  const attempts = [];
  SellerPublisher.prototype.publishProduct = async (_product, _url, _mode, _category, _job, _progress, options) => {
    attempts.push(options.allowPolicyWarningPublish);
    return { status: 'drafted', message: 'fixture draft' };
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = async (route, body, method = 'PATCH') => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const publish = async () => {
    const { value: job } = await api('/api/publish', { ids: ['p1'], collectionFolderId: 'folder', mode: 'draft' }, 'POST');
    const deadline = Date.now() + 5000;
    while (store.read().jobs.find(item => item.id === job.id)?.status !== 'completed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.read().jobs.find(item => item.id === job.id).status, 'completed');
  };
  try {
    assert.equal((await api('/api/settings', { allowPolicyWarningPublish: 'true', confirmPolicyWarningPublish: true })).status, 400);
    assert.equal((await api('/api/settings', { allowPolicyWarningPublish: true })).status, 400);
    assert.equal(store.read().settings.allowPolicyWarningPublish, false);
    await publish();
    assert.equal((await api('/api/settings', { allowPolicyWarningPublish: true, confirmPolicyWarningPublish: true })).status, 200);
    assert.equal(new JsonStore(store.filePath).read().settings.allowPolicyWarningPublish, true);
    assert.ok(store.read().settings.policyWarningPublishConfirmedAt);
    await publish();
    assert.equal((await api('/api/settings', { allowPolicyWarningPublish: false })).status, 200);
    await publish();
    assert.deepEqual(attempts, [false, true, false]);
    assert.equal(store.read().settings.priceMarkup, 12);
    assert.equal((await api('/api/settings', { allowPolicyWarningPublish: true })).status, 400);
  } finally {
    await server.shutdownServer();
    SellerPublisher.prototype.publishProduct = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
