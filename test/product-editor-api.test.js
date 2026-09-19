import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';

test('editor API preserves both video roles, validates MP4 uploads and rejects stale references atomically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-api-'));
  process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
  const server = await import('../server/index.js'); const listener = await server.serverReady;
  const endpoint = `http://127.0.0.1:${listener.address().port}`;
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const call = async (url, body, method = 'POST') => {
    const response = await fetch(endpoint + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    store.update((state) => { state.products = [{ id: 'target', title: 'Original', price: 10, categoryId: '201346401', status: 'publish_failed' }, { id: 'ref', title: 'Reference', categoryId: '201346401', status: 'published', attributes: [{ name: 'Brand', value: 'Other' }] }]; });
    const invalid = await fetch(endpoint + '/api/media/video', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: 'not a video' });
    assert.equal(invalid.status, 400);
    const buffer = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
    const uploaded = await fetch(endpoint + '/api/media/video', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: buffer });
    assert.equal(uploaded.status, 201); const { url } = await uploaded.json();
    const publisher = new SellerPublisher(root);
    const file = await publisher.downloadProductVideo({ videoUrl: url }); assert.ok(fs.readFileSync(file).equals(buffer));
    const videos = [{ role: 'main', url }, { role: 'detail', url: 'https://example.com/detail.mp4' }];
    assert.equal((await call('/api/products/target', { videos, videoUrl: url }, 'PATCH')).status, 200);
    assert.deepEqual(store.read().products[0].videos, videos);
    const review = { ids: ['target'], referenceId: 'ref', editorDraft: { title: 'Unsaved title' } };
    const preview = await call('/api/products/reference/preview', review); assert.equal(preview.status, 200);
    assert.equal(store.read().products[0].title, 'Original');
    store.update((state) => { state.products[1].attributes[0].value = 'New brand'; });
    const before = store.read().products[0];
    const rejected = await call('/api/products/target', { title: 'Final edit', referenceReview: { ...review, previewToken: preview.data.token } }, 'PATCH');
    assert.equal(rejected.status, 409); assert.deepEqual(store.read().products[0], before);
  } finally { await server.shutdownServer(); fs.rmSync(root, { recursive: true, force: true }); }
});
