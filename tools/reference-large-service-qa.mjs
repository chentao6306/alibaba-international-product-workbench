import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { Worker } from 'node:worker_threads';
import { JsonStore } from '../server/store.js';

// Synthetic, isolated real HTTP + durable storage check. Run with a bounded
// Node heap; no customer workspace, seller window or external listing is used.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-large-service-'));
process.env.DATA_DIR = root;
process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const count = 1886;
const capture = 'synthetic source '.repeat(10240);
const ids = Array.from({ length: count }, (_, index) => `large-${index}`);
let seed = new JsonStore(path.join(root, 'workspace.json'));
seed.update(state => {
  state.products = [{ id: 'reference', title: 'Synthetic accepted template', categoryId: '201346401',
    status: 'published', attributes: [{ name: 'Material', value: 'ABS' }] }, ...ids.map((id, index) => ({
    id, title: `Synthetic original ${index}`, categoryId: '201346401', status: 'publish_failed',
    price: 20 + index, stock: 10, attributes: [{ name: 'Material', value: 'Metal' }],
    source: { snapshot: { title: `Original ${index}`, html: capture } },
  }))];
});
const originalBytes = fs.statSync(seed.filePath).size;
assert.ok(2 * capture.length * count > 512 * 1024 * 1024);
seed = null;
const server = await import('../server/index.js');
const listener = await server.serverReady;
const base = `http://127.0.0.1:${listener.address().port}`;
const samples = [], healthSamples = [];
// An independent client is necessary: a timer in the API's own event loop
// cannot detect that synchronous batch work is preventing requests arriving.
const healthWorker = new Worker(`
  const { parentPort, workerData } = require('node:worker_threads');
  let phase = 'starting';
  parentPort.on('message', value => { phase = value; });
  async function probe() {
    const current = phase, start = Date.now();
    try {
      const response = await fetch(workerData + '/health', { signal: AbortSignal.timeout(3000) });
      parentPort.postMessage({ phase: current, ok: response.status === 200, ms: Date.now() - start });
    } catch (error) {
      parentPort.postMessage({ phase: current, ok: false, ms: Date.now() - start, error: error.name });
    }
    setTimeout(probe, 500);
  }
  parentPort.postMessage('ready');
  probe();
`, { eval: true, workerData: base });
await new Promise(resolve => healthWorker.once('message', resolve));
healthWorker.on('message', result => { if (result !== 'ready') healthSamples.push(result); });
async function post(route, body) {
  healthWorker.postMessage(route);
  const start = performance.now();
  const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  samples.push({ route, ms: Math.round(performance.now() - start), responseBytes: Buffer.byteLength(JSON.stringify(result)),
    heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss });
  assert.equal((await fetch(base + '/health', { signal: AbortSignal.timeout(5000) })).status, 200);
  return result;
}
try {
  const plan = await post('/api/publish/plan', { ids });
  assert.equal(plan.total, count);
  assert.equal(plan.groups.length, 1);
  const body = { ids, referenceId: 'reference', options: { scope: 'attributes' } };
  const preview = await post('/api/products/reference/preview', body);
  assert.equal(preview.items.length, 30);
  assert.equal(preview.totalChanged, count);
  assert.ok(samples.at(-1).responseBytes < 1024 * 1024);
  const last = await post('/api/products/reference/preview', { ...body, page: 63 });
  assert.equal(last.token, preview.token);
  assert.equal(last.items.length, 26);
  const saved = await post('/api/products/reference', { ...body, previewToken: preview.token });
  assert.equal(saved.changed.length, count);
  await healthWorker.terminate();
  for (const route of ['/api/products/reference/preview', '/api/products/reference']) {
    const during = healthSamples.filter(sample => sample.phase === route);
    assert.ok(during.length > 0, `Missing concurrent health observations for ${route}`);
    assert.ok(during.every(sample => sample.ok), `API stopped responding during ${route}`);
  }
  const reopened = new JsonStore(path.join(root, 'workspace.json'));
  const check = reopened.read(state => ({ count: state.products.length,
    unchangedReference: state.products[0].attributes[0].value === 'ABS' && state.products[0].status === 'published',
    everySaved: state.products.slice(1).every((product, index) => product.status === 'ready'
      && product.attributes[0].value === 'ABS' && product.price === 20 + index && product.stock === 10
      && product.source.snapshot.html === capture && product.source.snapshot.title === `Original ${index}`) }));
  assert.deepEqual(check, { count: count + 1, unchangedReference: true, everySaved: true });
  const result = { ok: true, products: count, originalBytes, savedBytes: fs.statSync(reopened.filePath).size,
    heapLimit: v8.getHeapStatistics().heap_size_limit, samples, healthSamples, verification: check };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, root }));
} finally {
  await healthWorker.terminate();
  await server.shutdownServer();
  // Keep the tiny evidence report, discard only this tool's synthetic database.
  fs.rmSync(path.join(root, 'workspace.json'), { force: true });
}
