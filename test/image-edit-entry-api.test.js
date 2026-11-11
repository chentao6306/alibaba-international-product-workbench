import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity, mergeSourceDataForPublish } from '../server/product-model.js';
import { currentDescriptionStructure, descriptionSourceHash } from '../server/description-structure.js';

test('single and batch editor APIs synchronize image deletions, retain submitted text and restore verified originals without recapturing edits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-edit-entry-'));
  process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
  const service = await import('../server/index.js'), listener = await service.serverReady;
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const call = async (route, body, method = 'POST', status = 200) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/${route}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  const make = (id, native = false) => {
    const main = `https://example.com/${id}-main.jpg`, detail = `https://example.com/${id}-detail.jpg`;
    const descriptionHtml = `<p>Collected ${id}</p><img src="${detail}"><table><tr><td>Size chart</td></tr></table>`;
    const product = { id, title: id, price: 12, skus: [{ price: 14 }], mainImages: [main], images: [main], mainImage: main,
      detailImages: [detail], descriptionHtml };
    if (native) product.structuredDescription = { version: 1, sourceHtmlHash: descriptionSourceHash(descriptionHtml), modules: [
      { type: 'company', title: 'Company', text: `Collected ${id}` },
      { type: 'gallery', scope: 'company', title: 'Factory', images: [{ url: detail, caption: '' }] },
    ] };
    return native ? syncProductModel(product) : product;
  };
  try {
    const originals = ['single', 'batch', 'missing'].map(id => make(id));
    const native = make('native', true), nativeSource = structuredClone(native.source);
    const legacyDeleted = make('legacy-deleted', true);
    legacyDeleted.detailImages = []; // A previously saved clear without an edit marker.
    store.update(state => { state.products = [...originals, native, legacyDeleted]; });
    await call('products/single', { mainImages: [], detailImages: [], price: 25,
      descriptionHtml: `<p>My new text</p><img src="${originals[0].detailImages[0]}"><table><tr><td>My table</td></tr></table>` }, 'PATCH');
    let single = store.read(state => state.products.find(product => product.id === 'single'));
    assert.deepEqual(single.mainImages, []); assert.deepEqual(single.images, []); assert.equal(single.mainImage, '');
    assert.deepEqual(single.detailImages, []); assert.deepEqual(single.imageEdits, { main: true, detail: true });
    assert.match(single.descriptionHtml, /My new text/); assert.match(single.descriptionHtml, /My table/);
    assert.doesNotMatch(single.descriptionHtml, /<img|Collected/);
    assert.deepEqual(single.source.snapshot.mainImages, originals[0].mainImages);
    assert.deepEqual(single.source.snapshot.detailImages, originals[0].detailImages);
    assert.equal(single.source.snapshot.descriptionHtml, originals[0].descriptionHtml);
    assert.equal(single.source.snapshot.price, 12); assert.equal(single.price, 25);
    assert.equal(verifySourceIntegrity(single).valid, true);
    assert.deepEqual(mergeSourceDataForPublish(single, { ...single, ...single.source.snapshot }).detailImages, []);

    await call('products/batch-update', { ids: ['batch'], patch: { images: [], detailImages: [], price: 27,
      descriptionHtml: `<p>Batch new text</p><img src="${originals[1].detailImages[0]}">` } });
    let batch = store.read(state => state.products.find(product => product.id === 'batch'));
    assert.deepEqual(batch.mainImages, []); assert.deepEqual(batch.images, []); assert.equal(batch.mainImage, '');
    assert.deepEqual(batch.detailImages, []); assert.deepEqual(batch.imageEdits, { main: true, detail: true });
    assert.match(batch.descriptionHtml, /Batch new text/); assert.doesNotMatch(batch.descriptionHtml, /<img|Collected/);
    assert.deepEqual(batch.source.snapshot.mainImages, originals[1].mainImages);
    assert.deepEqual(batch.source.snapshot.detailImages, originals[1].detailImages);
    assert.equal(batch.source.snapshot.descriptionHtml, originals[1].descriptionHtml);
    assert.equal(verifySourceIntegrity(batch).valid, true);
    const snapshots = [single.source, batch.source];
    await call('products/batch-update', { ids: ['single', 'batch'], patch: { imageOperation: 'restore-source-all' } });
    [single, batch] = store.read(state => state.products.filter(product => ['single', 'batch'].includes(product.id)));
    for (const [index, restored] of [single, batch].entries()) {
      assert.deepEqual(restored.mainImages, originals[index].mainImages);
      assert.deepEqual(restored.detailImages, originals[index].detailImages);
      assert.deepEqual(restored.source, snapshots[index]);
      assert.deepEqual(restored.skus, [{ price: 14 }]);
      assert.equal(verifySourceIntegrity(restored).valid, true);
    }
    assert.equal(single.price, 25); assert.equal(batch.price, 27);
    assert.match(single.descriptionHtml, /My new text/); assert.match(batch.descriptionHtml, /Batch new text/);

    await call('products/native', { detailImages: [] }, 'PATCH');
    let savedNative = store.read(state => state.products.find(product => product.id === 'native'));
    assert.deepEqual(currentDescriptionStructure(savedNative).modules.filter(module => module.type === 'gallery'), []);
    await call('products/batch-update', { ids: ['native'], patch: { imageOperation: 'restore-source-detail' } });
    savedNative = store.read(state => state.products.find(product => product.id === 'native'));
    assert.deepEqual(currentDescriptionStructure(savedNative).modules.find(module => module.type === 'gallery').images, [{ url: native.detailImages[0], caption: '' }]);
    assert.deepEqual(savedNative.source, nativeSource);
    await call('products/legacy-deleted', { detailImages: [] }, 'PATCH');
    const confirmedClear = store.read(state => state.products.find(product => product.id === 'legacy-deleted'));
    assert.equal(confirmedClear.imageEdits.detail, true);
    assert.doesNotMatch(confirmedClear.descriptionHtml, /<img/);
    assert.deepEqual(currentDescriptionStructure(confirmedClear).modules.filter(module => module.type === 'gallery'), []);
    assert.deepEqual(confirmedClear.source, legacyDeleted.source);
    const before = fs.readFileSync(store.filePath);
    await call('products/batch-update', { ids: ['missing'], patch: { imageOperation: 'restore-source-main' } }, 'POST', 400);
    assert.deepEqual(fs.readFileSync(store.filePath), before, 'a missing snapshot must not be invented from already-edited working images');
  } finally { await service.shutdownServer(); fs.rmSync(root, { recursive: true, force: true }); }
});
