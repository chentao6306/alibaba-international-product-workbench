import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { createWorkbenchStateReader } from '../server/workbench-state.js';

test('task polling omits detail captures and resends product lists only when visible data changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-state-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    store.update((state) => {
      state.products = [{ id: 'a', title: 'Camera', status: 'ready', descriptionHtml: '<p>Details</p>',
        source: { snapshot: { title: 'Original camera', payload: 'x'.repeat(2000000) } },
        skus: [{ code: 'sku' }], publishHistory: [{ result: { status: 'published' }, snapshot: { payload: 'x'.repeat(2000000) } }] }];
    });
    const read = createWorkbenchStateReader(store);
    const first = read();
    assert.ok(JSON.stringify(first).length < 5000);
    assert.equal(first.products[0].skuCount, 1);
    assert.equal(first.products[0].hasDescription, true);
    assert.equal(first.products[0].publishedSuccessfully, true);
    const job = store.createJob('publish');
    store.patchJob(job.id, { progress: 1 });
    const next = read(first.revision);
    assert.equal(next.unchanged, true);
    assert.equal(next.products, undefined);
    assert.equal(next.jobs[0].progress, 1);
    store.patchJob(job.id, { message: 'New transient stage' });
    assert.equal(read(first.revision).jobs[0].message, 'New transient stage');
    store.update((state) => { state.products[0].title = 'Changed'; });
    assert.equal(read(first.revision).products[0].title, 'Changed');
    assert.equal(store.read((state) => state.products[0].source.snapshot.title), 'Original camera');
    assert.equal(store.read((state) => state.products[0].publishHistory[0].snapshot.payload.length), 2000000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
