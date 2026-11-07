import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { syncProductModel, recordProductMutation, verifySourceIntegrity } from '../server/product-model.js';
import { imageListPatch } from '../server/product-image-api.js';
import { createRuntimeDiagnostics } from '../server/runtime-diagnostics.js';

test('selected image updates preserve unrelated data, rollback on failure and cannot leak mutable references', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selected-images-'));
  try {
    const file = path.join(root, 'workspace.json'), store = new JsonStore(file);
    store.update(state => { state.products = [{ id: 'a', mainImages: ['old'] }, { id: 'b', source: { snapshot: { description: '保留原始资料' } } }]; });
    const before = fs.readFileSync(file);
    assert.throws(() => store.updateProducts(['a'], products => { products[0].mainImages = ['not-saved']; throw Error('stop'); }), /stop/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(store.read(state => state.products[0].mainImages[0]), 'old');
    const originalWrite = fs.writeFileSync;
    let partialBytes = 0, attemptedBytes = 0;
    const failing = t.mock.method(fs, 'writeFileSync', (target, data, ...args) => {
      if (typeof target === 'number') {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        attemptedBytes = bytes.length;
        // Fail after actual partial I/O, independently of serialization chunk
        // size or the number of buffered writes used by the store.
        originalWrite(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        partialBytes = fs.fstatSync(target).size;
        throw Object.assign(Error('full'), { code: 'ENOSPC' });
      }
      return originalWrite(target, data, ...args);
    });
    assert.throws(() => store.updateProducts(['a'], products => { products[0].mainImages = ['disk-failure']; }), { code: 'ENOSPC' });
    assert.ok(partialBytes > 0 && partialBytes < attemptedBytes, 'The disk failure must occur after a partial snapshot was written');
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(store.read(state => state.products[0].mainImages[0]), 'old');
    assert.deepEqual(fs.readdirSync(root), ['workspace.json']);
    failing.mock.restore();
    let retained;
    const result = store.updateProducts(['a'], products => { retained = products[0]; products[0].mainImages = ['saved']; return products[0]; });
    retained.mainImages.push('leak'); result.mainImages.push('other-leak');
    assert.deepEqual(store.read(state => state.products[0].mainImages), ['saved']);
    assert.deepEqual(new JsonStore(file).read(), store.read());
    assert.equal(store.read(state => state.products[1].source.snapshot.description), '保留原始资料');
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('all three image scopes retain source and precise edit history without copying unrelated large fields', () => {
  for (const scope of ['main', 'detail', 'both']) {
    const product = syncProductModel({ id: scope, title: '耳机', price: 5, mainImages: ['main'], detailImages: ['detail'],
      descriptionHtml: '<p>保留文字</p><img src="detail">', skus: [{ price: 7 }], sourceStructuredEvidence: { details: 'x'.repeat(100000) } });
    const source = structuredClone(product.source);
    const old = { id: 'legacy', before: { title: '旧标题' }, after: { title: '耳机' } };
    product.auditTrail.push(old);
    for (let i = 0; i < 3; i++) {
      const patch = imageListPatch(product, { mainImages: scope === 'detail' ? product.mainImages : [`main-${i}`], detailImages: scope === 'main' ? product.detailImages : [`detail-${i}`] });
      const previous = structuredClone(product);
      recordProductMutation(product, patch, { action: 'image-edit', changedFieldsOnly: true });
      const entry = product.auditTrail[0];
      for (const key of Object.keys(patch)) { assert.deepEqual(entry.before[key], previous[key]); assert.deepEqual(entry.after[key], product[key]); }
      assert.equal(entry.after.sourceStructuredEvidence, undefined);
      assert.equal(entry.after.skus, undefined);
      assert.deepEqual(product.source, source);
      assert.equal(verifySourceIntegrity(product).valid, true);
    }
    assert.deepEqual(product.auditTrail.at(-1), old);
    assert.deepEqual(product.skus, [{ price: 7 }]);
    assert.match(product.descriptionHtml, /保留文字/);
    if (scope === 'main') assert.equal(product.descriptionHtml, source.snapshot.descriptionHtml);
    if (scope === 'detail') assert.deepEqual(product.mainImages, source.snapshot.mainImages);
  }
});

test('runtime diagnostics stay bounded, omit customer data and cannot fail the save', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diagnostics-'));
  try {
    const file = path.join(root, 'events.log'), log = createRuntimeDiagnostics(file);
    for (let i = 0; i < 600; i++) log('image-save-complete', { count: 25, updated: 25, title: 'PRIVATE TITLE', url: 'SECRET URL', body: 'PASSWORD' });
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(content) < 64 * 1024);
    assert.doesNotMatch(content, /PRIVATE|SECRET|PASSWORD/);
    assert.equal(JSON.parse(content.trim().split('\n').at(-1)).updated, 25);
    t.mock.method(fs, 'appendFileSync', () => { throw Error('no disk'); });
    assert.doesNotThrow(() => log('image-save-failed', { code: 'ENOSPC' }));
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});
