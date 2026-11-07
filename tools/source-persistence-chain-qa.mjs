// Read live collection artifacts, then exercise only an isolated local store.
// No publication, account data or customer payloads are written to this tool.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JsonStore } from '../server/store.js';
import { syncProductModel, recordProductMutation, verifySourceIntegrity } from '../server/product-model.js';
import { createEditorForm, editorPayload } from '../src/product-editor-model.js';
import { preparePublishProduct } from '../server/publisher.js';

const root = path.resolve(process.argv[2]);
const output = path.join(root, 'persistence-chain.json');
assert.equal(fs.existsSync(output), false, 'Use a fresh QA run');
const storePath = path.join(fs.mkdtempSync(path.join(root, 'persistence-')), 'workspace.json');
const store = new JsonStore(storePath);
const results = [];
for (const file of fs.readdirSync(root).filter(name => name.endsWith('-fresh-source.json'))) {
  const source = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.ok(source.product && !source.error, 'Collection must succeed before persistence QA');
  const raw = source.product;
  const product = syncProductModel({ ...structuredClone(raw), id: `qa-${raw.sourceId}`,
    sourcePlatform: 'alibaba.com', title: raw.sourceOriginalTitle, status: 'ready' }, { captureSource: true });
  const original = structuredClone(product);
  store.update(state => { state.products.push(product); });
  const saved = new JsonStore(storePath).read().products.find(item => item.id === product.id);
  assert.deepEqual(saved, product);
  const form = createEditorForm(saved);
  form.title += ' [local QA edit]';
  const patch = editorPayload(form);
  store.update(state => recordProductMutation(state.products.find(item => item.id === product.id), patch, { actor: 'user', action: 'qa-edit' }));
  const reopened = new JsonStore(storePath).read().products.find(item => item.id === product.id);
  assert.equal(reopened.title, form.title);
  assert.deepEqual(reopened.source.snapshot, original.source.snapshot);
  assert.equal(reopened.source.snapshotHash, original.source.snapshotHash);
  assert.equal(verifySourceIntegrity(reopened).valid, true);
  for (const key of ['mainImages', 'detailImages', 'descriptionHtml', 'structuredDescription']) assert.deepEqual(reopened[key], original[key], key);
  const prepared = preparePublishProduct(reopened), ids = new Set(prepared.skus.map(sku => sku.id));
  assert.equal(ids.size, original.skus.length);
  for (const sku of original.skus) {
    const next = prepared.skus.find(item => item.id === sku.id);
    for (const key of ['price', 'stock', 'code', 'enabled']) {
      if (sku[key] == null || sku[key] === '') continue;
      if (key === 'price' || key === 'stock') assert.equal(Number(next[key]), Number(sku[key]), `SKU ${key}`);
      else assert.deepEqual(next[key], sku[key], `SKU ${key}`);
    }
  }
  // The source can publish only quantity-tier/range prices, with no exact
  // per-SKU prices or stock. Keep that evidence; working defaults are not
  // evidence that the source exposed an exact price for every combination.
  assert.equal(prepared.priceMode, original.priceMode);
  assert.deepEqual(prepared.sourceTradeAvailability, original.sourceTradeAvailability);
  assert.deepEqual(reopened.source.snapshot, original.source.snapshot);
  results.push({ sourceId: raw.sourceId, categoryId: raw.categoryId, sourceAttributes: raw.attributes.length,
    customAttributes: form.customAttributes.length, mainImages: raw.mainImages.length, detailImages: raw.detailImages.length,
    videos: raw.videos.length, skuCount: raw.skus.length, sourceUnchanged: true, saveReopenEditPrepare: true,
    sourceAttributeCaptureSettled: raw.sourceAttributeCapture?.settled,
    exactSkuPricesPublished: raw.sourceTradeAvailability?.exactSkuPricesPublished,
    exactSkuStockPublished: raw.sourceTradeAvailability?.exactSkuStockPublished });
}
assert.ok(results.length);
const result = { ok: true, version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  scope: 'real collected data, isolated local persistence/edit/publish preparation; no platform draft or submission', results };
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
