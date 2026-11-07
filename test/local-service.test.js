import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { startLocalService } from '../electron/local-service.js';
import { JsonStore } from '../server/store.js';
import { readDiagnosticTail } from '../server/diagnostic-report.js';

test('unexpected worker exits retain exit codes and classify uncaught string and OOM errors', { timeout: 20000 }, async t => {
  for (const scenario of [
    { name: 'unrequested zero exit', source: 'process.exit(0);', exitCode: 0, code: 'LOCAL_SERVICE_STOPPED', reason: 'exit' },
    { name: 'nonzero exit', source: 'process.exit(17);', exitCode: 17, code: 'LOCAL_SERVICE_STOPPED', reason: 'exit' },
    { name: 'uncaught string limit', source: "throw new RangeError('Invalid string length PRIVATE_SOURCE');", exitCode: 1, code: 'ERR_STRING_TOO_LONG', reason: 'exception', workerException: true },
    { name: 'simulated worker OOM code', source: "throw Object.assign(new Error('PRIVATE_SOURCE'), { code: 'ERR_WORKER_OUT_OF_MEMORY' });", exitCode: 1, code: 'ERR_WORKER_OUT_OF_MEMORY', reason: 'oom', workerException: true },
  ]) await t.test(scenario.name, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-exit-'));
    const fixture = path.join(root, 'fixture.mjs');
    fs.writeFileSync(fixture, `
      export const serverReady = Promise.resolve({ address: () => ({ port: 1 }) });
      export const shutdownServer = () => {
        queueMicrotask(() => { ${scenario.source} });
        return new Promise(() => {});
      };
    `);
    const events = [];
    let exited;
    const didExit = new Promise(resolve => { exited = resolve; });
    const service = startLocalService({ entry: fixture, env: { ...process.env, DATA_DIR: root }, handlers: {},
      onEvent: (event, fields) => { events.push({ event, ...fields }); exited(); } });
    try {
      await service.ready;
      await Promise.all([assert.rejects(service.call('shutdownServer')), didExit]);
      assert.equal(service.status().status, 'stopped');
      assert.equal(service.status().code, scenario.code);
      assert.equal(service.status().exitCode, scenario.exitCode);
      assert.equal(service.status().expected, false);
      assert.deepEqual(events, [{ event: 'service-stopped', code: scenario.code, exitCode: scenario.exitCode, expected: false, reason: scenario.reason }]);
      await assert.rejects(service.call('diagnosticSummary'), { code: scenario.code });
      if (scenario.workerException) {
        const records = readDiagnosticTail(path.join(root, 'service-runtime.log'));
        assert.equal(records.at(-1).event, 'service-exception');
        assert.equal(records.at(-1).code, scenario.code);
        assert.equal(records.at(-1).memoryScope, 'worker');
        assert.doesNotMatch(JSON.stringify(records), /PRIVATE_SOURCE/);
      }
      await service.terminate();
      assert.equal(service.status().expected, false, 'cleanup must not reclassify the original failure');
      assert.equal(events.length, 1);
    } finally {
      await service.terminate();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('requested worker termination rejects pending calls but is not logged as a service failure', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-terminate-'));
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(fixture, `
    export const serverReady = Promise.resolve({ address: () => ({ port: 1 }) });
    export const diagnosticSummary = () => new Promise(() => {});
  `);
  const events = [];
  const service = startLocalService({ entry: fixture, env: { ...process.env, DATA_DIR: root }, handlers: {},
    onEvent: (event, fields) => events.push({ event, ...fields }) });
  try {
    await service.ready;
    const pending = assert.rejects(service.call('diagnosticSummary'), { code: 'LOCAL_SERVICE_TERMINATED' });
    const first = service.terminate();
    assert.equal(service.terminate(), first);
    const exitCode = await first;
    await pending;
    assert.equal(service.status().expected, true);
    assert.equal(service.status().exitCode, exitCode);
    assert.deepEqual(events, [{ event: 'service-exited', code: 'LOCAL_SERVICE_TERMINATED', exitCode, expected: true, reason: 'requested' }]);
    assert.equal(readDiagnosticTail(path.join(root, 'service-runtime.log')).length, 0);
  } finally {
    await service.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a caught API string limit reports local processing failure and its fixed route without stopping the worker', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-string-limit-'));
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(fixture, `
    import { JsonStore } from ${JSON.stringify(pathToFileURL(path.resolve('server/store.js')).href)};
    let failNextRead = false;
    const read = JsonStore.prototype.read;
    JsonStore.prototype.read = function (...args) {
      if (failNextRead) { failNextRead = false; throw new RangeError('Invalid string length PRIVATE_VALUE'); }
      return read.apply(this, args);
    };
    export const { serverReady, shutdownServer } = await import(${JSON.stringify(pathToFileURL(path.resolve('server/index.js')).href)});
    export const diagnosticSummary = () => { failNextRead = true; return true; };
  `);
  const service = startLocalService({ entry: fixture,
    env: { ...process.env, DATA_DIR: root, PORT: '0', KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'string-fixture' },
    handlers: { authorization: () => ({ valid: true, canRead: true, account: 'fixture' }) } });
  try {
    const port = await service.ready;
    await service.call('diagnosticSummary');
    const response = await fetch(`http://127.0.0.1:${port}/api/products/PRIVATE_PRODUCT?token=PRIVATE_TOKEN`, {
      headers: { 'x-kua-yipu-gate': 'string-fixture' },
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /本地数据处理失败.*字符串长度限制.*进度保留.*不要重复提交/);
    assert.doesNotMatch(body.error, /PRIVATE_|关闭其他/);
    const event = readDiagnosticTail(path.join(root, 'service-runtime.log')).filter(item => item.event === 'api-error').at(-1);
    assert.equal(event.code, 'ERR_STRING_TOO_LONG');
    assert.equal(event.route, '/api/products/:id');
    assert.equal(event.stage, 'workspace');
    assert.equal(event.memoryScope, 'worker');
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|message|body|params/);
    assert.equal(service.status().status, 'running');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await service.call('shutdownServer').catch(() => {});
    await service.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an occupied service port reports the bind failure and a fresh attempt recovers without losing saved products', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-port-'));
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => { state.products = [{ id: 'saved', title: 'Saved product', mainImages: [] }]; });
  const occupied = http.createServer((_request, response) => response.end('existing service'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  const lifecycle = [];
  const start = () => startLocalService({ entry: path.resolve('server/index.js'),
    env: { ...process.env, DATA_DIR: root, PORT: String(port), KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'diagnostic-fixture' },
    onEvent: (event, fields) => lifecycle.push({ event, ...fields }),
    handlers: { authorization: () => ({ valid: true, canRead: true, account: 'fixture' }) } });
  let service = start();
  try {
    await assert.rejects(service.ready, { code: 'EADDRINUSE' });
    assert.equal(service.status().status, 'stopped');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing service');
    await service.terminate();
    assert.equal(service.status().expected, false, 'startup failure stays unexpected even when cleaned up');
    assert.equal(service.status().code, 'EADDRINUSE');
    assert.equal(lifecycle.at(-1).stage, 'startup');
    assert.equal(lifecycle.at(-1).expected, false);
    assert.equal(lifecycle.at(-1).exitCode, 1);
    await new Promise(resolve => occupied.close(resolve));
    service = start();
    assert.equal(await service.ready, port);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal(store.read().products.find(product => product.id === 'saved').title, 'Saved product');
    const rejected = await fetch(`http://127.0.0.1:${port}/api/jobs/PRIVATE_ID/publish-page?token=PRIVATE_TOKEN`, {
      headers: { 'x-kua-yipu-gate': 'diagnostic-fixture' },
    });
    assert.equal(rejected.status, 404);
    const diagnostic = readDiagnosticTail(path.join(root, 'service-runtime.log')).filter(event => event.event === 'api-error').at(-1);
    assert.equal(diagnostic.route, '/api/jobs/:id/publish-page');
    assert.equal(diagnostic.method, 'GET');
    assert.equal(diagnostic.stage, 'publishing');
    assert.equal(diagnostic.memoryScope, 'worker');
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/);
  } finally {
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    if (service.status().status === 'running') await service.call('shutdownServer');
    await service.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing verification progress callback rejects its operation without terminating the worker', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-progress-'));
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(fixture, `
    export const serverReady = Promise.resolve({ address: () => ({ port: 1 }) });
    export const shutdownServer = () => globalThis.__KUA_YIPU_SELLER_BRIDGE.humanVerification('https://example.com/verify', {
      onWaiting: () => { throw Object.assign(new Error('Simulated full disk'), { code: 'ENOSPC' }); },
    });
  `);
  let cancelled;
  const didCancel = new Promise(resolve => { cancelled = resolve; });
  const service = startLocalService({ entry: fixture, env: process.env, handlers: {
    'seller.humanVerification': async (_url, options) => {
      options.onWaiting('waiting');
      const deadline = Date.now() + 3000;
      while (!options.shouldStop() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      cancelled(options.shouldStop());
      return false;
    },
  } });
  try {
    await service.ready;
    await assert.rejects(service.call('shutdownServer'), { code: 'ENOSPC' });
    assert.equal(await didCancel, true);
    assert.equal(service.status().status, 'running');
  } finally {
    await service.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test('a disk failure after a publish receipt keeps the API alive, stops the batch and preserves saved data', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-disk-'));
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }];
    state.products = [1, 2].map(id => ({ id: String(id), collectionFolderId: 'folder', sourcePlatform: 'alibaba.com',
      title: `Camera ${id}`, categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'],
      status: 'ready', selected: true, price: 100, stock: 100, moq: 1, origin: 'China',
      mainImages: ['https://example.com/image.jpg'], description: 'Camera', attributes: [] }));
  });
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    import { SellerPublisher } from ${JSON.stringify(pathToFileURL(path.resolve('server/publisher.js')).href)};
    SellerPublisher.prototype.publishProduct = async function (product) {
      await globalThis.__KUA_YIPU_SELLER_BRIDGE.sync();
      const write = fs.writeFileSync;
      fs.writeFileSync = function (file, ...args) {
        if (String(file).includes('workspace.json.') && String(file).endsWith('.tmp')) {
          write.call(this, file, 'partial');
          throw Object.assign(new Error('Simulated full disk'), { code: 'ENOSPC' });
        }
        return write.call(this, file, ...args);
      };
      return { status: 'drafted', message: 'Isolated test receipt', productId: product.id };
    };
    export const { serverReady, shutdownServer } = await import(${JSON.stringify(pathToFileURL(path.resolve('server/index.js')).href)});
  `);
  let calls = 0;
  const service = startLocalService({ entry: fixture,
    env: { ...process.env, DATA_DIR: root, PORT: '0', KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'disk-fixture' },
    handlers: { authorization: () => ({ valid: true, canRead: true, account: 'fixture' }),
      'seller.sync': () => { calls++; return true; }, 'seller.status': () => ({ browserOpen: false }) } });
  try {
    const port = await service.ready;
    const api = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-kua-yipu-gate': 'disk-fixture' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    const response = await api('/api/publish', { ids: ['1', '2'], collectionFolderId: 'folder', mode: 'draft' });
    assert.equal(response.status, 202);
    const job = await response.json();
    let state;
    const deadline = Date.now() + 10000;
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      state = await (await api('/api/state?view=summary')).json();
    } while (!state.service && Date.now() < deadline);
    assert.equal(state.service?.code, 'ENOSPC');
    assert.match(state.service.message, /磁盘可用空间不足/);
    assert.match(state.service.message, /核对当前商品/);
    assert.equal(state.jobs[0].status, 'paused');
    assert.equal(state.jobs[0].progress, 0);
    assert.equal(calls, 1, 'the second product must not be submitted');
    assert.equal(service.status().status, 'running');
    assert.equal((await api('/health')).status, 200);
    assert.equal((await api(`/api/jobs/${job.id}/resume`, {})).status, 507);
    assert.equal((await api('/api/publish', { ids: ['2'], mode: 'draft' })).status, 507);
    const saved = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    assert.ok(saved.products.every(product => product.status === 'ready'));
    assert.equal(saved.jobs[0].progress, 0);
    assert.equal(fs.readdirSync(root).filter(file => file.endsWith('.tmp')).length, 0);
  } finally {
    await service.call('shutdownServer').catch(() => {});
    await service.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
