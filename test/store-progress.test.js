import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { publishCounts, recordPublishOutcome } from '../server/publish-progress.js';

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
