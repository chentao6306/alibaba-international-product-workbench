import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalService } from '../electron/local-service.js';
import { JsonStore } from '../server/store.js';
import { readDiagnosticTail } from '../server/diagnostic-report.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function idleService(t, handlers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-service-idle-'));
  const file = path.join(root, 'workspace.json');
  const store = new JsonStore(file);
  store.update(state => {
    state.products = [{ id: 'idle-product', title: 'Saved fixture', selected: false, source: { title: 'Original fixture' } }];
  });
  const service = startLocalService({ entry: fileURLToPath(new URL('../server/index.js', import.meta.url)),
    env: { ...process.env, DATA_DIR: root, PORT: '0', KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'idle-fixture' },
    handlers: { authorization: () => ({ valid: true, canRead: true, account: 'fixture' }),
      'seller.status': () => ({ browserOpen: false }), ...handlers } });
  t.after(async () => {
    // Terminate directly: a regression in a synchronous bridge must not keep
    // teardown waiting for the same blocked worker's shutdown RPC.
    await service.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = await service.ready;
  const api = (url, body, gate = 'idle-fixture') => fetch(`http://127.0.0.1:${port}${url}`, {
    headers: { 'x-kua-yipu-gate': gate, 'content-type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(6000),
  });
  const health = () => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
  return { service, root, file, api, health };
}

for (const method of ['authorization', 'seller.status']) {
  test(`idle ${method} stalls stay bounded while the real API responds and the next read recovers`, { timeout: 20000 }, async t => {
    let blocked = false, entered, reply;
    const normal = method === 'authorization' ? { valid: true, canRead: true, account: 'fixture' } : { browserOpen: false };
    const { service, root, file, api, health } = await idleService(t, {
      [method]: () => {
        if (!blocked) return normal;
        entered.resolve();
        return reply.promise;
      },
    });
    const initial = fs.readFileSync(file);
    let previous;
    for (let cycle = 0; cycle < 2; cycle++) {
      blocked = true; entered = deferred(); reply = deferred();
      const pending = api('/api/state?view=summary');
      await entered.promise;
      assert.equal((await health()).status, 200, 'idle bridge waits must not freeze the service event loop');
      const response = await pending;
      assert.equal(response.status, 503);
      const failure = await response.json();
      assert.equal(failure.code, 'LOCAL_SERVICE_DESKTOP_TIMEOUT');
      assert.match(failure.error, /桌面状态暂未响应/);
      assert.equal(service.status().status, 'running');
      assert.deepEqual(fs.readFileSync(file), initial, 'failed progress reads must never mutate products or jobs');
      previous = reply;
      blocked = false;
      const recovered = await api('/api/state?view=summary');
      assert.equal(recovered.status, 200);
      const state = await recovered.json();
      assert.equal(state.products[0].title, 'Saved fixture');
      assert.equal(state.jobs.length, 0);
      previous.resolve(method === 'authorization' ? { valid: false, canRead: false } : { browserOpen: true });
      const fresh = await api(`/api/state?view=summary&revision=${encodeURIComponent(state.revision)}`);
      assert.equal(fresh.status, 200, 'a stale bridge response must not replace fresh authorization or browser state');
      const unchanged = await fresh.json();
      assert.equal(unchanged.unchanged, true);
      assert.equal(unchanged.browser.browserOpen, false);
    }
    const records = readDiagnosticTail(path.join(root, 'service-runtime.log')).filter(event => event.event === 'api-error');
    assert.equal(records.length, 2);
    assert.ok(records.every(event => event.code === 'LOCAL_SERVICE_DESKTOP_TIMEOUT'));
    assert.doesNotMatch(JSON.stringify(records), /idle-fixture|idle-product|Original fixture/);
  });
}

test('fresh authorization remains mandatory for mutations after an idle bridge timeout or a late reply', { timeout: 15000 }, async t => {
  let access = { valid: true, canRead: true, account: 'fixture' }, waiting = false, calls = 0;
  const entered = deferred(), reply = deferred();
  const { file, api, health } = await idleService(t, { authorization: () => {
    calls++;
    if (!waiting) return access;
    entered.resolve();
    return reply.promise;
  } });
  const initial = fs.readFileSync(file);
  assert.equal((await api('/api/state', null, '')).status, 401);
  assert.equal(calls, 0, 'requests without the local gate must not reach the desktop bridge');
  waiting = true;
  const mutation = api('/api/products/select', { ids: ['idle-product'], selected: true });
  await entered.promise;
  assert.equal((await health()).status, 200);
  assert.equal((await mutation).status, 503);
  waiting = false; access = { valid: false, canRead: false, account: 'fixture' };
  reply.resolve({ valid: true, canRead: true, account: 'fixture' });
  assert.equal((await api('/api/state')).status, 401);
  assert.equal((await api('/api/products/select', { ids: ['idle-product'], selected: true })).status, 401);
  access.canRead = true;
  const readOnly = await api('/api/state');
  assert.equal(readOnly.status, 200);
  assert.equal((await readOnly.json()).products[0].source.title, 'Original fixture');
  assert.equal((await api('/api/products/select', { ids: ['idle-product'], selected: true })).status, 401);
  assert.deepEqual(fs.readFileSync(file), initial);
  access.valid = true;
  assert.equal((await api('/api/products/select', { ids: ['idle-product'], selected: true })).status, 200);
  assert.equal(new JsonStore(file).read().products[0].selected, true);
});
