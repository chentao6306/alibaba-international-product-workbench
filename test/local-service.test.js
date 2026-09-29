import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLocalService } from '../electron/local-service.js';
import { JsonStore } from '../server/store.js';

test('publishing runs off the window thread while authorization, encrypted sessions, verification and checkpoints still work', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-'));
  const file = path.join(root, 'workspace.json');
  const store = new JsonStore(file);
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }];
    state.products = [1, 2].map((id) => ({ id: String(id), collectionFolderId: 'folder', sourcePlatform: 'alibaba.com',
      title: `Camera ${id}`, categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'],
      status: 'ready', selected: true, price: 100, stock: 100, moq: 1, origin: 'China',
      mainImages: ['https://example.com/image.jpg'], description: 'Camera', attributes: [] }));
  });
  const publisherUrl = pathToFileURL(path.resolve('server/publisher.js')).href;
  const serverUrl = pathToFileURL(path.resolve('server/index.js')).href;
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(fixture, `
    import { SellerPublisher } from ${JSON.stringify(publisherUrl)};
    SellerPublisher.prototype.publishProduct = async function (product) {
      const secure = globalThis.__KUA_YIPU_SECURE_STORAGE;
      if (secure.decrypt(secure.encrypt('private test value')) !== 'private test value') throw Error('Encryption roundtrip failed');
      await globalThis.__KUA_YIPU_SELLER_BRIDGE.sync();
      // Reproduce a long synchronous database/JSON operation in the backend.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      let stopped = false;
      const timer = setTimeout(() => { stopped = true; }, 100);
      try {
        await globalThis.__KUA_YIPU_SELLER_BRIDGE.humanVerification('https://www.alibaba.com/verify', {
          shouldStop: () => stopped, onWaiting: () => {}, requestCookies: [], userAgent: 'fixture'
        });
      } finally { clearTimeout(timer); }
      return { status: 'drafted', message: 'Saved receipt', productId: product.id };
    };
    export const { serverReady, shutdownServer, suspendAuthorizedWork } = await import(${JSON.stringify(serverUrl)});
  `);
  let authorized = false;
  let ticks = 0;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  let verificationCancelled = false;
  const service = startLocalService({ entry: fixture,
    env: { ...process.env, DATA_DIR: root, PORT: '0', KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'fixture-gate' },
    handlers: {
      authorization: () => ({ valid: authorized, canRead: true, account: 'fixture' }),
      'secure.encrypt': (value) => Buffer.from(value),
      'secure.decrypt': (value) => Buffer.from(value).toString(),
      'seller.sync': () => { calls++; ticks = 0; started(); return true; },
      'seller.status': () => ({ browserOpen: false }),
      'seller.humanVerification': async (_url, options) => {
        const deadline = Date.now() + 3000;
        options.onWaiting('Waiting for verification');
        while (!options.shouldStop() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        verificationCancelled = options.shouldStop();
        return false;
      },
    } });
  const timer = setInterval(() => { ticks++; }, 20);
  try {
    const port = await service.ready;
    const api = (route, body, gate = 'fixture-gate') => fetch(`http://127.0.0.1:${port}${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-kua-yipu-gate': gate },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await api('/api/state', null, '')).status, 401);
    assert.equal((await api('/api/products/1')).status, 401);
    authorized = true;
    assert.equal((await api('/api/products/1')).status, 200);
    const initial = await (await api('/api/state?view=summary')).json();
    assert.equal(initial.products[0].source, undefined);
    const detail = await (await api('/api/products/1')).json();
    assert.ok(detail.source.snapshot);
    const response = await api('/api/publish', { ids: ['1', '2'], collectionFolderId: 'folder', mode: 'draft' });
    assert.equal(response.status, 202);
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(ticks >= 5, `Window thread stalled (${ticks} ticks)`);
    authorized = false;
    await service.call('suspendAuthorizedWork', { graceful: true });
    const deadline = Date.now() + 10000;
    let state;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await (await api('/api/state?view=summary')).json();
    } while (state.jobs[0].status !== 'paused' && Date.now() < deadline);
    assert.equal(state.jobs[0].status, 'paused');
    assert.equal(state.jobs[0].progress, 1);
    assert.equal(state.products[0].status, 'drafted');
    assert.equal(calls, 1);
    assert.equal(verificationCancelled, true);
    assert.equal((await api('/api/publish', {})).status, 401);
  } finally {
    clearInterval(timer);
    await service.call('shutdownServer').catch(() => {});
    await service.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
