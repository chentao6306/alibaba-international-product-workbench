import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { JsonStore } from '../server/store.js';
import { createWorkbenchStateReader, summarizeJob } from '../server/workbench-state.js';
import { productPublishDisplay, publishCounts, publishJobMessage } from '../server/publish-progress.js';

function fixture(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'large-workspace-'));
  try { return action(new JsonStore(path.join(root, 'workspace.json'))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function syntheticState() {
  return {
    version: 2, shops: [], groups: [], collectionFolders: [], settings: {},
    products: Array.from({ length: 4662 }, (_, index) => ({
      id: `p${index}`, title: `Synthetic electronics ${index}`, status: 'ready', categoryId: 'test-leaf',
      description: 'Synthetic body '.repeat(120), descriptionHtml: '<p>Synthetic</p>'.repeat(120),
      source: { snapshot: { html: 'Original synthetic '.repeat(100), attributes: [{ name: 'Material', value: 'ABS' }] } },
      attributes: Array.from({ length: 12 }, (_, field) => ({ name: `Field ${field}`, value: `Value ${field}` })),
      skus: Array.from({ length: 6 }, (_, sku) => ({ code: `${index}-${sku}`, price: '5', stock: 10 })),
      publishHistory: [{ result: { status: 'drafted', message: 'Saved synthetic' } }],
    })),
    jobs: Array.from({ length: 2348 }, (_, index) => ({
      id: `j${index}`, type: 'publish', status: index === 0 ? 'running' : 'completed', progress: 30, total: 50,
      createdAt: '2026-10-31T00:00:00Z',
      metadata: { mode: 'draft', collectionFolderId: 'f1', sourcePlatforms: ['alibaba.com'],
        productIds: Array.from({ length: 50 }, (_, product) => `p${(index + product) % 4662}`),
        options: { sourceHtml: 'Unused options '.repeat(200) } },
      results: Object.fromEntries(Array.from({ length: 30 }, (_, product) => [`p${(index + product) % 4662}`,
        { status: product % 2 ? 'drafted' : 'failed', message: 'Synthetic validation detail '.repeat(30) }])),
    })),
  };
}

test('4662 products and 2348 task records poll without transferring captures or historical per-product receipts', t => fixture(store => {
  store.write(syntheticState());
  const snapshot = store.snapshot();
  const fullJobsBytes = Buffer.byteLength(JSON.stringify(snapshot.jobs));
  const read = createWorkbenchStateReader(store);
  const started = performance.now();
  const first = read();
  const initialMs = performance.now() - started;
  assert.equal(first.products.length, 4662);
  assert.equal(first.jobs.length, 2348);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 8 * 1024 * 1024);
  assert.deepEqual(publishCounts(first.jobs[1000]), { success: 15, failed: 15, skipped: 0, remaining: 20 });
  assert.equal(first.jobs[1000].metadata.options, undefined);
  assert.deepEqual(first.jobs[1000].metadata.productIds, snapshot.jobs[1000].metadata.productIds);
  assert.deepEqual(first.jobs[1000].results, {});
  assert.equal(first.jobs[0].results.p0.status, 'failed');
  assert.equal(productPublishDisplay(first.products[30], first.jobs).status, 'publishing');
  assert.equal(productPublishDisplay(first.products[31], first.jobs).status, 'publish_queued');
  const patchStarted = performance.now();
  store.patchJob('j0', { progress: 31, currentProductId: 'p31', message: 'Next synthetic item' });
  const patchMs = performance.now() - patchStarted;
  assert.equal(store.snapshot().products, snapshot.products, 'Updating one job must reuse all saved products');
  assert.equal(store.snapshot().jobs[1000], snapshot.jobs[1000], 'Unchanged task history is reused');
  const pollStarted = performance.now();
  const poll = read(first.revision);
  const pollMs = performance.now() - pollStarted;
  const pollBytes = Buffer.byteLength(JSON.stringify(poll));
  assert.equal(poll.unchanged, true);
  assert.equal(poll.products, undefined);
  assert.equal(poll.jobs.length, 2348);
  assert.equal(poll.jobs[0].progress, 31);
  assert.equal(publishCounts(poll.jobs[0]).remaining, 19);
  assert.ok(pollBytes < fullJobsBytes / 20, 'Poll payload must not scale with saved result messages/captures');
  assert.ok(pollBytes < 4 * 1024 * 1024);
  const reopened = new JsonStore(store.filePath);
  assert.equal(reopened.read(state => state.jobs[0].progress), 31);
  assert.equal(reopened.read(state => state.jobs[1000].results[Object.keys(state.jobs[1000].results)[0]].message), 'Synthetic validation detail '.repeat(30));
  assert.equal(reopened.read(state => state.products[4661].source.snapshot.html), 'Original synthetic '.repeat(100));
  assert.equal(reopened.read(state => state.products[4661].skus.length), 6);
  t.diagnostic(JSON.stringify({ products: 4662, jobs: 2348, fullJobsBytes, pollBytes, initialMs, patchMs, pollMs }));
}));

test('task summaries retain pause controls, counts, failed source links and actionable video association', () => {
  const job = {
    id: 'task', type: 'publish', status: 'paused', total: 5, progress: 4, verificationState: 'waiting',
    message: 'Paused', currentProductId: 'last', pauseAfterCurrent: false,
    metadata: { mode: 'submit', listingMode: 'inquiry', stockPolicy: 'fixed', publishDelay: { minSeconds: 1, maxSeconds: 3 },
      sellerGroup: { id: 'group', path: 'Electronics' }, productIds: ['one', 'two', 'three', 'four', 'last'],
      failures: [{ url: 'https://example.test/product/1', source: 'one', error: 'Timed out', capture: 'Large capture' }],
      links: [{ url: 'https://example.test/product/1' }], completedKeys: ['one'], options: { html: 'Capture' } },
    results: { one: { status: 'published', title: 'Product one', url: 'https://example.test/published/1',
      videoAssociation: { associated: false, warning: 'Retry available', requests: ['Large traces'] } },
    two: { status: 'published', videoAssociation: { associated: true } },
    three: { status: 'failed', message: 'Long failure capture' }, four: { status: 'skipped' } },
  };
  const summary = summarizeJob(job);
  assert.deepEqual(publishCounts(summary), publishCounts(job));
  assert.equal(summary.currentProductId, 'last');
  assert.equal(summary.pauseAfterCurrent, false);
  assert.deepEqual(summary.metadata.sellerGroup, job.metadata.sellerGroup);
  assert.deepEqual(summary.metadata.publishDelay, job.metadata.publishDelay);
  assert.equal(summary.metadata.stockPolicy, 'fixed');
  assert.equal(summary.metadata.stockPolicy || 'minimum-order', 'fixed', 'An active task retains its frozen stock rule when the global setting changes');
  assert.deepEqual(summary.metadata.failures, [{ url: 'https://example.test/product/1', source: 'one', error: 'Timed out' }]);
  assert.equal(summary.metadata.completedKeys, undefined);
  assert.equal(summary.results.one.title, 'Product one');
  assert.equal(summary.results.one.videoAssociation.warning, 'Retry available');
  assert.equal(summary.results.one.videoAssociation.requests, undefined);
  assert.equal(publishJobMessage({ ...summary, status: 'running' }), '等待人工验证，请在验证窗口完成操作，或暂停任务');
  const finished = summarizeJob({ ...job, status: 'completed' });
  assert.deepEqual(Object.keys(finished.results), ['one']);
  assert.equal(publishCounts(finished).failed, 1);
  assert.equal(Object.keys(job.results).length, 4);
});

test('job updates and cached summaries stay detached, observe external writes and do not alter previous snapshots', () => fixture(store => {
  store.update(state => { state.products = [{ id: 'p', title: 'Before', attributes: [{ name: 'Type', value: 'One' }] }]; });
  const metadata = { productIds: ['p'], mode: 'draft' };
  const job = store.createJob('publish', metadata);
  metadata.productIds.push('external'); job.metadata.productIds.push('external');
  assert.deepEqual(store.read(state => state.jobs[0].metadata.productIds), ['p']);
  const read = createWorkbenchStateReader(store);
  const first = read();
  first.products[0].attributes[0].value = 'External edit';
  first.jobs[0].metadata.productIds.push('external');
  const previous = store.snapshot();
  store.patchJob(job.id, { message: 'Waiting' });
  assert.equal(previous.jobs[0].message, '等待处理');
  assert.equal(read(first.revision).jobs[0].message, 'Waiting');
  const patch = { metadata: { productIds: ['p'], mode: 'submit' }, status: 'paused' };
  const result = store.patchJob(job.id, patch);
  patch.metadata.productIds.push('external'); result.metadata.productIds.push('external');
  assert.deepEqual(read(first.revision).jobs[0].metadata.productIds, ['p']);
  assert.equal(read().products[0].attributes[0].value, 'One');
  const other = new JsonStore(store.filePath);
  other.updateProducts(['p'], products => { products[0].title = 'External disk edit'; });
  const changed = read(first.revision);
  assert.equal(changed.products[0].title, 'External disk edit');
  assert.equal(changed.jobs[0].status, 'paused');
  assert.equal(store.patchJob('missing', { progress: 99 }), null);
}));

test('readiness summaries expire without a task or product write', t => fixture(store => {
  const now = Date.now();
  let currentTime = now;
  t.mock.method(Date, 'now', () => currentTime);
  store.update(state => { state.products = [{ id: 'p', categoryId: 'cat',
    postingRequirements: { categoryId: 'cat', capturedAt: new Date(now).toISOString(), fields: [{ label: 'Material', required: true }] },
    attributes: [{ name: 'Material', value: 'ABS' }] }]; });
  const read = createWorkbenchStateReader(store);
  const first = read();
  assert.equal(first.products[0].categoryReadiness.status, 'covered');
  currentTime += 8 * 24 * 60 * 60 * 1000;
  const expired = read(first.revision);
  assert.equal(expired.products[0].categoryReadiness.status, 'stale');
  assert.notEqual(expired.revision, first.revision);
}));

test('job checkpoints serialize each saved product once and a disk limit mid-write preserves the last snapshot', t => fixture(store => {
  store.update(state => { state.products = [{ id: 'p', description: 'Synthetic original'.repeat(1000) }]; });
  const job = store.createJob('publish', { productIds: ['p'] });
  const product = store.snapshot().products[0];
  const stringify = JSON.stringify;
  let serializations = 0;
  const serializer = t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value === product) serializations++;
    return stringify(value, ...args);
  });
  store.patchJob(job.id, { progress: 1, results: { p: { status: 'drafted', message: 'Saved' } } });
  assert.equal(serializations, 1, 'Sizing must not reserialize the entire workspace before writing it');
  serializer.mock.restore();
  const durable = fs.readFileSync(store.filePath);
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 64 * 1024 * 1024 + 500, bsize: 1 }));
  assert.throws(() => store.patchJob(job.id, { progress: 2 }), { code: 'ENOSPC', status: 507 });
  assert.deepEqual(fs.readFileSync(store.filePath), durable);
  assert.deepEqual(fs.readdirSync(path.dirname(store.filePath)), ['workspace.json']);
  assert.equal(store.read(state => state.jobs[0].progress), 1);
  assert.equal(store.read(state => state.jobs[0].results.p.status), 'drafted');
}));
