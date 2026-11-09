import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverDuplicateSkuOptions } from '../server/sku-options.js';
import { extractAlibabaSourceData } from '../server/alibaba-source-data.js';
import { categoryChangePatch } from '../server/product-edit.js';
import { recordProductMutation, syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { preparePublishProduct } from '../server/publisher.js';
import { resolveReferencedSkuRows } from '../server/sku-reference.js';
import { JsonStore } from '../server/store.js';

const commerce = product => product.skus.map(({ id, price, stock, code, image, evidence, enabled }) => ({ id, price, stock, code, image, evidence, enabled }));
function changedCategory(options = ['Style B2', 'Style B3', ...Array.from({ length: 21 }, (_, index) => `Style ${index + 10}`), 'Style B2', 'Style B3']) {
  const original = {
    id: 'fixture', sourceId: 'fixture-source', sourcePlatform: 'alibaba.com', categoryId: 'source-category', priceMode: 'sku',
    variantGroups: [{ id: '10', name: 'Color', type: 'IMAGE', source: 'detailData.skuAttrs', options,
      optionIds: Object.fromEntries(options.map((name, index) => [name, String(-index - 1)])),
      optionImages: Object.fromEntries(options.map((name, index) => [name, `https://example.test/${index}.jpg`])),
    }],
    skus: options.map((Color, index) => ({ id: `sku-${index}`, name: Color, attributes: { Color }, code: `CODE-${index}`,
      price: index < 2 ? '1.71' : '3.00', image: `https://example.test/${index}.jpg`, source: 'detailData.skuInfoMap',
      evidence: { method: 'detailData.skuInfoMap', combination: `10:${-index - 1};`, exactStockPublished: false },
    })),
  };
  const product = { ...structuredClone(original), ...categoryChangePatch(original, { categoryId: 'target-category' }),
    source: { snapshot: structuredClone(original) } };
  // Saved user commerce differs from the source and must not be restored.
  product.skus = product.skus.reverse().map(sku => ({ ...sku, stock: 1 }));
  product.skus[0].price = '19.87'; product.skus[0].code = 'MANUAL'; product.skus[0].stock = 17;
  product.skus[1].enabled = false;
  return product;
}

test('repairs legacy duplicate options after a category change without restoring target property bindings', () => {
  const product = changedCategory(), before = structuredClone(product);
  const prepared = preparePublishProduct(product), group = prepared.variantGroups[0];
  assert.equal(group.id, undefined);
  assert.equal(prepared.skus.length, 25);
  assert.equal(group.options.length, 25);
  assert.equal(new Set(group.options).size, 25);
  assert.deepEqual(commerce(prepared), commerce(product));
  assert.deepEqual(prepared.source.snapshot, product.source.snapshot);
  assert.deepEqual(product, before);
  for (const sku of prepared.skus) assert.equal(group.optionImages[sku.attributes.Color], sku.image);
  const rows = resolveReferencedSkuRows(prepared, [{ name: '颜色', options: [...group.options].reverse() }],
    { appliedGroups: [{ ...group, targetName: '颜色' }] });
  assert.equal(rows.length, 25);
  for (const row of rows) {
    const original = product.skus.find(sku => sku.id === row.sku.id);
    assert.deepEqual(commerce({ skus: [row.sku] }), commerce({ skus: [original] }));
  }
});

test('retains repaired option identities and manual commerce through edit, save and reopen', () => {
  const product = changedCategory(), source = structuredClone(product.source.snapshot);
  syncProductModel(product);
  const skus = structuredClone(product.skus);
  skus[2].price = '29.83'; skus[2].stock = 31; skus[2].code = 'SECOND-EDIT'; skus[2].enabled = false;
  recordProductMutation(product, { skus }, { actor: 'user' });
  const expected = commerce(product);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-source-recovery-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    store.update(state => { state.products = [product]; });
    const reopened = new JsonStore(store.filePath).read().products[0];
    syncProductModel(reopened);
    const prepared = preparePublishProduct(reopened);
    assert.deepEqual(commerce(prepared), expected);
    assert.deepEqual(reopened.source.snapshot, source);
    assert.equal(verifySourceIntegrity(reopened).valid, true);
    assert.equal(prepared.variantGroups[0].id, undefined);
    assert.equal(new Set(prepared.skus.map(sku => sku.attributes.Color)).size, 25);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('can refine recovered labels after target language conversion while leaving category bindings cleared', () => {
  const product = changedCategory(['White 大', 'White 大', 'White 小 (1)']);
  const repaired = recoverDuplicateSkuOptions(product, { strict: true });
  const normalizeValue = value => value.replace(/[\u3400-\u9fff]/g, '').replace(/\s+/g, ' ').trim();
  const refined = recoverDuplicateSkuOptions(repaired, { strict: true, normalizeValue });
  assert.equal(new Set(refined.variantGroups[0].options.map(normalizeValue)).size, 3);
  assert.equal(refined.variantGroups[0].id, undefined);
  assert.deepEqual(commerce(refined), commerce(product));
  assert.deepEqual(refined.source.snapshot, product.source.snapshot);
});

test('refines fresh collected option identities after changing category when the snapshot already has repaired labels', () => {
  const options = ['White 大', 'White 大', 'White 小 (1)'];
  const product = extractAlibabaSourceData({ globalData: { product: { sku: {
    skuAttrs: [{ id: '10', name: 'Color', type: 'IMAGE', values: options.map((name, index) => ({
      id: String(index + 1), name, image: `https://example.test/${index}.jpg`,
    })) }],
    skuInfoMap: Object.fromEntries(options.map((name, index) => [`10:${index + 1};`, { id: `sku-${index}`, skuCode: `CODE-${index}`, price: index + 1, stock: index + 10 }])),
  } } } });
  product.categoryId = 'source-category';
  syncProductModel(product);
  const snapshot = structuredClone(product.source.snapshot), before = commerce(product);
  assert.deepEqual(snapshot.variantGroups[0].options, ['White 大 (1)', 'White 大 (2)', 'White 小 (1)']);
  Object.assign(product, categoryChangePatch(product, { categoryId: 'target-category' }));
  const prepared = preparePublishProduct(product);
  const targetNames = prepared.variantGroups[0].options.map(value => value.replace(/[\u3400-\u9fff]/g, '').replace(/\s+/g, ' ').trim());
  assert.equal(new Set(targetNames).size, 3);
  assert.equal(prepared.variantGroups[0].id, undefined);
  assert.deepEqual(commerce(prepared), before);
  assert.deepEqual(prepared.source.snapshot, snapshot);
  for (const sku of prepared.skus) assert.equal(prepared.variantGroups[0].optionImages[sku.attributes.Color], sku.image);
  for (const change of [
    copy => { copy.source.snapshot.variantGroups[0].optionIdentityMappings[0].sourceName = 'Wrong source'; },
    copy => { copy.source.snapshot.variantGroups[0].optionIdentityMappings[0].id = '2'; },
    copy => { copy.source.snapshot.skus[0].attributes.Color = 'Wrong label'; },
  ]) {
    const copy = structuredClone(product); change(copy);
    assert.throws(() => preparePublishProduct(copy), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
  }
});

test('refuses missing, conflicting or edited source identities without changing current or source data', () => {
  for (const change of [
    product => { delete product.source; },
    product => { product.source.snapshot.sourceId = 'different-product'; },
    product => { delete product.source.snapshot.variantGroups[0].id; },
    product => { product.source.snapshot.variantGroups[0].id = '20'; },
    product => { product.source.snapshot.variantGroups[0].source = 'guessed'; },
    product => { product.source.snapshot.variantGroups[0].name = 'Size'; },
    product => { product.source.snapshot.variantGroups.push(structuredClone(product.source.snapshot.variantGroups[0])); },
    product => { product.source.snapshot.variantGroups[0].optionIds['Style B2'] = '-2'; },
    product => { product.source.snapshot.skus[0].id = 'other-sku'; },
    product => { delete product.source.snapshot.skus[0].evidence; },
    product => { product.source.snapshot.skus[0].evidence.combination = '10:-2;'; },
    product => { product.source.snapshot.skus[0].attributes.Color = 'Edited source label'; },
    product => { product.skus[0].id = product.skus[1].id; },
    product => { product.skus[0].evidence.combination = '10:-1;10:-2;'; },
    product => { product.skus.pop(); },
    product => { product.variantGroups[0].options.push('Extra option'); },
    product => { product.variantGroups[0].options[2] = 'Edited option'; },
    product => { product.skus[0].attributes.Color = 'Edited SKU label'; },
    product => { product.variantGroups[0].optionImages['Style B2'] = 'https://example.test/edited.jpg'; },
  ]) {
    const product = changedCategory(); change(product);
    const before = structuredClone(product);
    assert.equal(recoverDuplicateSkuOptions(product), product);
    assert.throws(() => recoverDuplicateSkuOptions(product, { strict: true }), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
    assert.deepEqual(product, before);
  }
});
