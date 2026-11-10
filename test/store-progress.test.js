import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { publishCounts, recordPublishOutcome } from '../server/publish-progress.js';

function stored(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'store-progress-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'workspace.json'));
  const job = store.createJob('publish', { productIds: ['a', 'b', 'c'] });
  return { store, job, directory };
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('stage updates avoid disk rewrites while item checkpoints persist and independent writers invalidate cached state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'store-progress-'));
  try {
    const file = path.join(directory, 'workspace.json');
    const store = new JsonStore(file);
    const job = store.createJob('publish', { productIds: ['a', 'b', 'c'] });
    store.patchJob(job.id, { total: 3 });
    const before = store.revision();
    store.patchJob(job.id, { message: 'Uploading images 3/6' });
    assert.equal(store.revision(), before);
    assert.equal(store.read((state) => state.jobs[0].message), 'Uploading images 3/6');
    const snapshot = store.read(); snapshot.jobs[0].status = 'corrupted';
    assert.equal(store.read((state) => state.jobs[0].status), 'queued');
    store.update((state) => recordPublishOutcome(state, job.id, 'a', { status: 'drafted' }, 1));
    const other = new JsonStore(file);
    assert.equal(other.read((state) => state.jobs[0].message), 'Uploading images 3/6');
    assert.deepEqual(publishCounts(other.read((state) => state.jobs[0])), { success: 1, failed: 0, skipped: 0, remaining: 2 });
    other.update((state) => recordPublishOutcome(state, job.id, 'b', { status: 'failed' }, 2));
    assert.equal(publishCounts(store.read((state) => state.jobs[0])).failed, 1);
    store.update((state) => recordPublishOutcome(state, job.id, 'b', { status: 'drafted' }, 2));
    assert.deepEqual(publishCounts(other.read((state) => state.jobs[0])), { success: 2, failed: 0, skipped: 0, remaining: 1 });
    other.patchJob(job.id, { status: 'paused' });
    assert.equal(store.read((state) => state.jobs[0].status), 'paused');
    // Same-size writes can occur in the same clock tick on Windows.
    const fixed = new Date(1700000000000);
    for (const status of ['queued', 'paused', 'queued', 'paused']) {
      other.patchJob(job.id, { status }); fs.utimesSync(file, fixed, fixed);
      assert.equal(store.read((state) => state.jobs[0].status), status);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('publish progress with unchanged verification state stays transient until the next durable item result', t => {
  const { store, job } = stored(t);
  store.patchJob(job.id, { verificationState: '', status: 'running', total: 3, message: 'Item started' });
  const before = store.revision();
  for (const stage of ['Opening form', 'Uploading images', 'Checking submitted values']) {
    store.patchJob(job.id, { verificationState: '', message: stage });
    assert.equal(store.revision(), before, 'the actual publisher progress shape must not rewrite the workspace');
    assert.equal(store.read(state => state.jobs[0].message), stage);
  }
  const reopenedBeforeCheckpoint = new JsonStore(store.filePath).read(state => state.jobs[0]);
  assert.equal(reopenedBeforeCheckpoint.message, 'Item started');
  assert.equal(reopenedBeforeCheckpoint.progress, 0);
  store.update(state => recordPublishOutcome(state, job.id, 'a', { status: 'drafted' }, 1));
  const reopened = new JsonStore(store.filePath).read(state => state.jobs[0]);
  assert.equal(reopened.message, 'Checking submitted values');
  assert.equal(reopened.verificationState, '');
  assert.equal(reopened.progress, 1);
  assert.deepEqual(publishCounts(reopened), { success: 1, failed: 0, skipped: 0, remaining: 2 });
});

test('verification initialization, waiting, error and clearing remain durable while repeated states avoid writes', t => {
  const { store, job } = stored(t);
  assert.equal(Object.hasOwn(store.read(state => state.jobs[0]), 'verificationState'), false);
  for (const verificationState of ['', 'waiting', 'error', '']) {
    const before = store.revision();
    store.patchJob(job.id, { verificationState, message: `Changed: ${verificationState}` });
    assert.notEqual(store.revision(), before, 'a missing verification state is not the same as an initialized empty state');
    assert.equal(new JsonStore(store.filePath).read(state => state.jobs[0].verificationState), verificationState);
    const committed = store.revision();
    store.patchJob(job.id, { verificationState, message: `Repeated: ${verificationState}` });
    assert.equal(store.revision(), committed);
  }
});

test('checkpoints, results and task controls still commit when bundled with unchanged verification state', t => {
  const { store, job } = stored(t);
  store.patchJob(job.id, { verificationState: '', status: 'running' });
  const patches = [
    { total: 3, progress: 1 },
    { currentProductId: 'b', waitingForDelay: true },
    { metadata: { productIds: ['a', 'b', 'c'], checkpoint: { productId: 'b', submitted: true } } },
    { results: { a: { status: 'drafted', url: 'https://example.invalid/draft/a' } } },
    { status: 'pause_requested' },
    { status: 'paused', waitingForDelay: false },
    { status: 'cancelled' },
    { progress: 1 },
  ];
  for (const patch of patches) {
    const before = store.revision();
    const result = store.patchJob(job.id, { verificationState: '', message: 'Control or checkpoint', ...patch });
    assert.notEqual(store.revision(), before, 'only stage text and repeated verification state may skip persistence');
    const reopened = new JsonStore(store.filePath).read(state => state.jobs[0]);
    for (const [key, value] of Object.entries(patch)) assert.deepEqual(reopened[key], value);
    assert.deepEqual(reopened, result);
  }
});

test('failed verification and pause writes preserve the last durable state and transient progress until storage recovers', t => {
  const { store, job, directory } = stored(t);
  store.patchJob(job.id, { verificationState: '', status: 'running', message: 'Saved checkpoint' });
  const saved = fs.readFileSync(store.filePath);
  try {
    const failing = t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }); });
    store.patchJob(job.id, { verificationState: '', message: 'Current stage' });
    assert.equal(failing.mock.callCount(), 0);
    for (const patch of [{ verificationState: 'waiting' }, { status: 'paused', verificationState: '' }]) {
      assert.throws(() => store.patchJob(job.id, { message: 'Must commit', ...patch }),
        { code: 'ENOSPC', status: 507, storageFailure: true });
      assert.deepEqual(fs.readFileSync(store.filePath), saved);
      const current = store.read(state => state.jobs[0]);
      assert.equal(current.verificationState, '');
      assert.equal(current.status, 'running');
      assert.equal(current.message, 'Current stage');
      assert.deepEqual(fs.readdirSync(directory), ['workspace.json']);
    }
    assert.equal(new JsonStore(store.filePath).read(state => state.jobs[0].message), 'Saved checkpoint');
    failing.mock.restore();
    store.patchJob(job.id, { verificationState: 'waiting', message: 'Waiting for verification' });
    assert.equal(new JsonStore(store.filePath).read(state => state.jobs[0].verificationState), 'waiting');
  } finally { t.mock.restoreAll(); }
});

test('transient publisher progress invalidates an in-flight reference save before it can overwrite newer state', async t => {
  const { store, job, directory } = stored(t);
  store.update(state => { state.products = [{ id: 'a', title: 'Original product' }]; });
  store.patchJob(job.id, { verificationState: '', status: 'running', message: 'Saved checkpoint' });
  const entered = deferred(), release = deferred();
  const open = fs.promises.open.bind(fs.promises);
  let intercepted = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (!intercepted && String(args[0]).endsWith('.tmp')) {
      intercepted = true;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => { entered.resolve(); await release.promise; return write(...values); };
    }
    return handle;
  });
  const pending = store.updateProductsAsync(['a'], products => { products[0].title = 'Uncommitted reference'; });
  try {
    await entered.promise;
    const before = store.revision();
    store.patchJob(job.id, { verificationState: '', message: 'Newer stage' });
    assert.equal(store.revision(), before);
    release.resolve();
    await assert.rejects(pending, { code: 'WORKSPACE_CHANGED', status: 409 });
    assert.equal(store.read(state => state.jobs[0].message), 'Newer stage');
    assert.equal(store.read(state => state.products[0].title), 'Original product');
    const reopened = new JsonStore(store.filePath).read();
    assert.equal(reopened.products[0].title, 'Original product');
    assert.equal(reopened.jobs[0].message, 'Saved checkpoint');
    assert.deepEqual(fs.readdirSync(directory), ['workspace.json']);
  } finally { release.resolve(); t.mock.restoreAll(); }
});

test('publisher progress observes an external pause and verification change before deciding whether to persist', t => {
  const { store, job } = stored(t);
  store.patchJob(job.id, { verificationState: '', status: 'running' });
  const other = new JsonStore(store.filePath);
  store.patchJob(job.id, { verificationState: '', message: 'Unsaved stage' });
  other.patchJob(job.id, { verificationState: 'waiting', status: 'paused', message: 'Paused externally' });
  const pausedRevision = other.revision();
  store.patchJob(job.id, { verificationState: 'waiting', message: 'Observed verification' });
  assert.equal(store.revision(), pausedRevision);
  assert.equal(store.read(state => state.jobs[0].status), 'paused');
  assert.equal(other.read(state => state.jobs[0].message), 'Paused externally');
  store.patchJob(job.id, { verificationState: '', message: 'Verification cleared' });
  const reopened = new JsonStore(store.filePath).read(state => state.jobs[0]);
  assert.equal(reopened.status, 'paused');
  assert.equal(reopened.verificationState, '');
});
