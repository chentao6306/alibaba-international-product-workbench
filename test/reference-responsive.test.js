import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { previewProductReference, previewProductReferenceAsync, applyReferencePreviewAsync } from '../server/reference-workflow.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(count = 2) {
  return { jobs: [], products: [{ id: 'reference', title: 'Reference', categoryId: '201346401', status: 'published',
    attributes: [{ name: 'Material', value: 'ABS' }] }, ...Array.from({ length: count }, (_, index) => ({
    id: `p-${index}`, title: `Original ${index}`, categoryId: '201346401', status: 'publish_failed',
    attributes: [{ name: 'Material', value: 'Metal' }], price: index + 1, stock: 17,
    source: { snapshot: { title: `Source ${index}`, html: 'preserved evidence '.repeat(4000) } },
  }))] };
}
function stored(t, count) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-responsive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'workspace.json'));
  store.write(fixture(count));
  return store;
}
const requestFor = state => ({ ids: state.products.slice(1).map(p => p.id), referenceId: 'reference', options: { scope: 'attributes' } });

test('large reference previews yield to other requests without changing tokens or any source data', async () => {
  const state = fixture(400), request = requestFor(state);
  const expected = previewProductReference(state, request);
  let intervened = false;
  setImmediate(() => { intervened = true; });
  const actual = await previewProductReferenceAsync(state, request);
  assert.equal(intervened, true);
  assert.deepEqual(actual, expected);
  assert.ok(state.products.slice(1).every(p => p.attributes[0].value === 'Metal' && p.source.snapshot.html.length === 76000));
});

test('cooperative reference saves commit all selected products and preserve original facts on reopening', async t => {
  const store = stored(t, 80), original = store.read(), request = requestFor(original);
  const preview = await previewProductReferenceAsync(store.snapshot(), request);
  const result = await store.updateProductsAsync(request.ids, (products, snapshot) => {
    const selected = new Map(products.map(p => [p.id, p]));
    return applyReferencePreviewAsync({ ...snapshot, products: snapshot.products.map(p => selected.get(p.id) || p) },
      { ...request, previewToken: preview.token });
  });
  assert.equal(result.changed.length, 80);
  const reopened = new JsonStore(store.filePath).read();
  assert.deepEqual(reopened.products[0], original.products[0]);
  for (let index = 1; index < reopened.products.length; index++) {
    const product = reopened.products[index], before = original.products[index];
    assert.equal(product.attributes[0].value, 'ABS');
    assert.equal(product.status, 'ready');
    assert.equal(product.stock, before.stock);
    assert.equal(product.price, before.price);
    assert.deepEqual(product.source.snapshot, before.source.snapshot);
  }
});

test('a concurrent edit cancels a prepared reference save without reverting that edit', async t => {
  const store = stored(t, 2), entered = deferred(), release = deferred();
  const pending = store.updateProductsAsync(['p-0'], async products => {
    products[0].title = 'Uncommitted reference'; entered.resolve(); await release.promise;
  });
  await entered.promise;
  store.updateProducts(['p-1'], products => { products[0].price = 999; });
  release.resolve();
  await assert.rejects(pending, { code: 'WORKSPACE_CHANGED', status: 409 });
  const reopened = new JsonStore(store.filePath).read();
  assert.equal(reopened.products[1].title, 'Original 0');
  assert.equal(reopened.products[2].price, 999);
});

test('readers see committed data during an asynchronous disk save and a later edit wins', async t => {
  const store = stored(t, 8), entered = deferred(), release = deferred();
  const open = fs.promises.open.bind(fs.promises);
  let intercepted = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (!intercepted && String(args[0]).endsWith('.tmp')) {
      intercepted = true;
      const write = handle.writeFile.bind(handle);
      let first = true;
      handle.writeFile = async (...values) => {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return write(...values);
      };
    }
    return handle;
  });
  const pending = store.updateProductsAsync(['p-0'], products => { products[0].title = 'Uncommitted'; });
  await entered.promise;
  assert.equal(store.read(s => s.products[1].title), 'Original 0');
  store.updateProducts(['p-1'], products => { products[0].title = 'Another saved edit'; });
  release.resolve();
  await assert.rejects(pending, { code: 'WORKSPACE_CHANGED' });
  const reopened = new JsonStore(store.filePath).read();
  assert.equal(reopened.products[1].title, 'Original 0');
  assert.equal(reopened.products[2].title, 'Another saved edit');
  assert.deepEqual(fs.readdirSync(path.dirname(store.filePath)), ['workspace.json']);
});

test('an asynchronous storage failure preserves the durable workspace and removes only its temporary file', async t => {
  const store = stored(t, 2), original = fs.readFileSync(store.filePath);
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    handle.writeFile = async () => { throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }); };
    return handle;
  });
  await assert.rejects(store.updateProductsAsync(['p-0'], products => { products[0].title = 'Uncommitted'; }),
    { code: 'ENOSPC', status: 507, storageFailure: true });
  assert.deepEqual(fs.readFileSync(store.filePath), original);
  assert.equal(store.read(s => s.products[1].title), 'Original 0');
  assert.deepEqual(fs.readdirSync(path.dirname(store.filePath)), ['workspace.json']);
});
