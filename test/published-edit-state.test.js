import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { createPublishSnapshot, recordProductMutation, syncProductModel } from '../server/product-model.js';
import { publishedReference, referenceTemplate } from '../server/reference-workflow.js';

function publishedProduct(withHistory = true) {
  const product = syncProductModel({ id: 'published', sourceId: '123456', sourcePlatform: 'alibaba.com',
    title: 'Published title', status: 'published', price: 12, categoryId: '201346401',
    attributes: [{ name: 'Model', value: 'Old accepted model' }], mainImages: ['https://example.test/old.jpg'],
    publishResult: { status: 'published', url: 'https://post.alibaba.com/product/success.htm?primaryId=123456' },
  });
  if (withHistory) product.publishHistory = [{ ...createPublishSnapshot(product, { mode: 'submit' }), result: structuredClone(product.publishResult) }];
  return product;
}

for (const [name, patch, context] of [
  ['single edit', { attributes: [{ name: 'Model', value: 'New unsubmitted model' }] }, {}],
  ['batch price edit', { price: 18, status: 'ready' }, {}],
  ['image watermark', { mainImages: ['http://127.0.0.1/media/watermarked.jpg'], status: 'ready' }, { changedFieldsOnly: true }],
  ['description template', { description: 'New description', status: 'ready' }, {}],
]) test(`${name} invalidates only the working receipt and preserves the accepted reference`, () => {
  const product = publishedProduct(); const source = structuredClone(product.source);
  recordProductMutation(product, patch, context);
  assert.equal(product.status, 'ready'); assert.equal(product.publishResult, undefined);
  assert.equal(product.publishHistory.length, 1); assert.equal(product.publishHistory[0].result.status, 'published');
  assert.equal(product.publishHistory[0].data.price, 12);
  assert.equal(publishedReference(product), true);
  assert.equal(referenceTemplate(product).attributes[0].value, 'Old accepted model');
  assert.deepEqual(product.source, source);
});

test('editing legacy published data retains its receipt with the pre-edit accepted data', () => {
  const product = publishedProduct(false);
  recordProductMutation(product, { attributes: [{ name: 'Model', value: 'Unsubmitted' }] });
  assert.equal(product.publishResult, undefined); assert.equal(product.publishHistory.length, 1);
  assert.equal(product.publishHistory[0].data.attributes[0].value, 'Old accepted model');
  assert.equal(product.publishHistory[0].data.price, 12);
  assert.equal(referenceTemplate(product).attributes[0].value, 'Old accepted model');
});

test('selection and unchanged form saves do not invalidate a successful publication', () => {
  const product = publishedProduct(); const receipt = structuredClone(product.publishResult);
  recordProductMutation(product, { selected: true });
  recordProductMutation(product, { title: product.title, attributes: structuredClone(product.attributes) });
  assert.equal(product.status, 'published'); assert.deepEqual(product.publishResult, receipt);
  assert.equal(product.publishHistory.length, 1);
});

test('saved published-product edits survive API restart without reverting to published or losing the reference', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-edit-restart-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => { state.collectionFolders = [{ id: 'folder', name: 'QA' }]; state.products = [{ ...publishedProduct(), collectionFolderId: 'folder' }]; });
  let server = await import('../server/index.js');
  try {
    let listener = await server.serverReady;
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/products/published`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: 17, mainImages: ['https://example.test/edited.jpg'] }),
    });
    assert.equal(response.status, 200); const saved = await response.json();
    assert.equal(saved.status, 'ready');
    await server.shutdownServer();
    server = await import('../server/index.js?published-edit-restart');
    listener = await server.serverReady;
    const reopened = await (await fetch(`http://127.0.0.1:${listener.address().port}/api/products/published`)).json();
    assert.equal(reopened.price, 17); assert.deepEqual(reopened.mainImages, ['https://example.test/edited.jpg']);
    assert.equal(reopened.status, 'ready'); assert.equal(reopened.publishResult, undefined);
    assert.equal(reopened.publishHistory[0].data.price, 12);
    assert.equal(referenceTemplate(reopened).attributes[0].value, 'Old accepted model');
  } finally {
    await server.shutdownServer(); fs.rmSync(root, { recursive: true, force: true });
  }
});
