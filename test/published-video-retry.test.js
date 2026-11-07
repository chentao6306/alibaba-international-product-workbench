import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerPublishedVideoRetry } from '../server/published-video-retry.js';
import { recordPublishOutcome } from '../server/publish-progress.js';
import { combineVideoAssociations } from '../server/posting-video.js';

test('a failed video retry retains verified roles and its latest failure without changing a newer publication', async () => {
  const original = combineVideoAssociations([
    { id: '6001', role: 'main', productId: '12345', associated: false },
    { id: '6002', role: 'detail', productId: '12345', associated: false, warning: 'old failure' },
  ]);
  const receipt = { status: 'published', url: 'https://post.alibaba.com/product/success.htm?primaryId=12345', videoAssociation: original };
  const state = { products: [{ id: 'p', status: 'published', publishResult: structuredClone(receipt), publishHistory: [{ result: structuredClone(receipt) }] }],
    jobs: [{ id: 'j', type: 'publish', status: 'completed', results: { p: structuredClone(receipt) } }] };
  let mode = 'wrong-role';
  const app = express();
  registerPublishedVideoRetry(app, { store: { read: () => state, update: callback => callback(state) }, sellerBusy: () => false,
    publisher: { async retryPublishedVideo(video) {
      const partial = combineVideoAssociations(video.items.map(item => item.role === 'main'
        ? { ...item, associated: true, warning: '' } : { ...item, warning: 'latest detail control failure' }));
      if (mode === 'wrong-role') partial.items[1].role = 'main';
      if (mode === 'newer-publication') state.products[0].publishResult.url = 'https://post.alibaba.com/product/success.htm?primaryId=999';
      if (mode === 'complete') {
        assert.equal(video.items[0].associated, true);
        return combineVideoAssociations(video.items.map(item => ({ ...item, associated: true, warning: '' })));
      }
      throw Object.assign(new Error(partial.warning), { code: 'PUBLISH_VIDEO_BANK_PENDING', videoAssociation: partial });
    } } });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/api/jobs/j/video/p/retry`, { method: 'POST' });
  try {
    assert.equal((await request()).status, 500);
    assert.deepEqual(state.jobs[0].results.p.videoAssociation, original);
    mode = 'partial';
    assert.equal((await request()).status, 500);
    for (const result of [state.jobs[0].results.p, state.products[0].publishResult, state.products[0].publishHistory[0].result]) {
      assert.equal(result.status, 'published');
      assert.equal(result.videoAssociation.associated, false);
      assert.equal(result.videoAssociation.items[0].associated, true);
      assert.equal(result.videoAssociation.warning, 'latest detail control failure');
      assert.ok(Number.isFinite(Date.parse(result.videoAssociation.lastAttemptAt)));
    }
    mode = 'newer-publication';
    const before = structuredClone(state.products[0].publishResult.videoAssociation);
    assert.equal((await request()).status, 500);
    assert.deepEqual(state.products[0].publishResult.videoAssociation, before);
    mode = 'complete';
    assert.equal((await request()).status, 200);
    assert.equal(state.jobs[0].results.p.videoAssociation.associated, true);
    assert.equal(state.products[0].publishResult.videoAssociation.associated, false);
    assert.equal(state.products[0].publishHistory[0].result.videoAssociation.associated, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('single-video retries validate the video identity and reject an association in the wrong display position', async () => {
  const original = { id: '6001', role: 'detail', productId: '12345', associated: false };
  const receipt = { status: 'published', url: 'https://post.alibaba.com/product/success.htm?primaryId=12345', videoAssociation: original };
  const state = { products: [], jobs: [{ id: 'j', type: 'publish', status: 'completed', results: { p: receipt } }] };
  let calls = 0, role = 'main';
  const app = express();
  registerPublishedVideoRetry(app, { store: { read: () => state, update: callback => callback(state) }, sellerBusy: () => false,
    publisher: { async retryPublishedVideo(video) { calls++; return { ...video, role, associated: true }; } } });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/api/jobs/j/video/p/retry`, { method: 'POST' });
  try {
    for (const invalid of [{ id: '' }, { id: 'not-a-video-id' }, { role: 'other' }, { items: null }, { items: [null] }]) {
      receipt.videoAssociation = { ...original, ...invalid };
      assert.equal((await request()).status, 409);
    }
    assert.equal(calls, 0);
    receipt.videoAssociation = original;
    assert.equal((await request()).status, 409);
    assert.deepEqual(receipt.videoAssociation, original);
    assert.equal(receipt.status, 'published');
    role = 'detail';
    assert.equal((await request()).status, 200);
    assert.equal(receipt.videoAssociation.role, 'detail');
    assert.equal(receipt.videoAssociation.associated, true);
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('main and detail recovery requires all exact video roles and preserves publication on a partial or wrong result', async () => {
  const original = combineVideoAssociations([
    { id: '6001', role: 'main', productId: '12345', associated: true },
    { id: '6002', role: 'detail', productId: '12345', associated: false, warning: 'details pending' },
  ]);
  const receipt = { status: 'published', url: 'https://post.alibaba.com/product/success.htm?primaryId=12345', videoAssociation: original };
  const state = { products: [], jobs: [{ id: 'j', type: 'publish', status: 'completed', results: { p: receipt } }] };
  let mode = 'partial', calls = 0;
  const app = express();
  registerPublishedVideoRetry(app, { store: { read: () => state, update: callback => callback(state) }, sellerBusy: () => false,
    publisher: { async retryPublishedVideo(video) {
      calls++;
      assert.deepEqual(video, original);
      const items = video.items.map(item => ({ ...item, associated: true }));
      if (mode === 'partial') items[1].associated = false;
      if (mode === 'wrong-role') items[1].role = 'main';
      if (mode === 'wrong-product') items[1].productId = '999';
      return { ...combineVideoAssociations(items), associated: true };
    } } });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/api/jobs/j/video/p/retry`, { method: 'POST' });
  try {
    for (mode of ['partial', 'wrong-role', 'wrong-product']) {
      assert.equal((await request()).status, 409);
      assert.equal(receipt.status, 'published');
      assert.deepEqual(receipt.videoAssociation, original);
    }
    receipt.videoAssociation = structuredClone(original);
    receipt.videoAssociation.items[1].productId = '999';
    assert.equal((await request()).status, 409); assert.equal(calls, 3);
    receipt.videoAssociation = original;
    mode = 'complete';
    assert.equal((await request()).status, 200);
    assert.ok(receipt.videoAssociation.items.every(item => item.associated));
    assert.deepEqual(receipt.videoAssociation.items.map(item => item.role), ['main', 'detail']);
    assert.equal((await request()).status, 200); assert.equal(calls, 4);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('video recovery preserves publication and archived references, rejects concurrent work and retries without republishing', async () => {
  const receipt = { status: 'published', message: '已提交发布（视频待关联）', url: 'https://post.alibaba.com/product/success.htm?primaryId=12345',
    videoAssociation: { id: '6001', productId: '12345', associated: false, name: 'same.mp4', warning: 'pending' }, warnings: ['pending', 'other'] };
  const state = { products: [{ id: 'p', title: 'QA', status: 'published', removedFromWorkbenchAt: 'keep', publishResult: structuredClone(receipt),
    publishHistory: [{ result: structuredClone(receipt) }] }], jobs: [{ id: 'j', type: 'publish', status: 'completed' }] };
  recordPublishOutcome(state, 'j', 'p', receipt, 1);
  assert.equal(state.jobs[0].results.p.videoAssociation.productId, '12345');
  let fail = true, calls = 0, release;
  const app = express(); app.use(express.json());
  const guard = registerPublishedVideoRetry(app, { store: { read: () => state, update: callback => callback(state) }, sellerBusy: () => false,
    publisher: { async retryPublishedVideo(video) { calls++; if (fail) throw new Error('temporarily unavailable'); await new Promise(resolve => { release = resolve; }); return { ...video, associated: true }; } } });
  app.post('/api/publish', (_req, res) => res.json({ unexpected: true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  const request = async (route = '/jobs/j/video/p/retry') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, { method: 'POST' });
    return { status: response.status, body: await response.json() };
  };
  try {
    state.settings = { uploadProductVideos: false };
    const disabled = await request();
    assert.equal(disabled.status, 409);
    assert.match(disabled.body.error, /已关闭上传商品视频/);
    assert.equal(calls, 0);
    state.settings.uploadProductVideos = true;
    assert.equal((await request()).status, 500);
    assert.equal(guard.isBusy(), false);
    assert.equal(state.jobs[0].results.p.videoAssociation.associated, false);
    assert.equal(state.products[0].status, 'published');
    state.jobs.push({ type: 'publish', status: 'paused' });
    assert.equal((await request()).status, 409); state.jobs.pop();
    state.jobs[0].results.p.videoAssociation.productId = '999';
    assert.equal((await request()).status, 409); state.jobs[0].results.p.videoAssociation.productId = '12345';
    fail = false;
    const attempt = request();
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.isBusy(), true);
    assert.equal((await request()).status, 409);
    assert.equal((await request('/publish')).status, 409);
    release(); assert.equal((await attempt).status, 200);
    assert.equal((await request()).status, 200); assert.equal(calls, 2);
    assert.equal(state.jobs[0].results.p.videoAssociation.associated, true);
    assert.equal(state.products[0].removedFromWorkbenchAt, 'keep');
    assert.equal(state.products[0].publishHistory[0].result.videoAssociation.associated, true);
    assert.deepEqual(state.products[0].publishResult.warnings, ['other']);
    assert.equal(guard.isBusy(), false);
    assert.equal((await request('/jobs/j/video/missing/retry')).status, 409);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
