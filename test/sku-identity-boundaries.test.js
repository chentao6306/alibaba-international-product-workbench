import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverDuplicateSkuOptions } from '../server/sku-options.js';
import { extractAlibabaSourceData } from '../server/alibaba-source-data.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { findSkuAttributeEntry, resolveReferencedSkuRows } from '../server/sku-reference.js';
import { preparePublishProduct, buildFlattenedVariantGroup } from '../server/publisher.js';

const normalizeValue = value => String(value).replace(/[\u3400-\u9fff]/g, ' ').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
const commerce = product => product.skus.map(({ code, price, stock, enabled, image, evidence }) => ({ code, price, stock, enabled, image, evidence }));
function optionFixture(options) {
  return {
    variantGroups: [{ id: '10', name: 'Color', type: 'IMAGE', options,
      optionValues: options.map((name, i) => ({ id: String(i + 1), name, image: `https://example.test/${i + 1}.jpg` })),
      optionIds: Object.fromEntries(options.map((name, i) => [name, String(i + 1)])),
      optionImages: Object.fromEntries(options.map((name, i) => [name, `https://example.test/${i + 1}.jpg`])),
    }],
    skus: options.map((Color, i) => ({ id: `sku-${i}`, name: Color, attributes: { Color },
      code: `CODE-${i}`, price: i + 1, stock: i * 10, enabled: i !== 1, image: `https://example.test/${i + 1}.jpg`,
      evidence: { method: 'detailData.skuInfoMap', combination: `10:${i + 1};` },
    })),
  };
}

test('keeps source option identities distinct after the target language conversion', () => {
  const product = optionFixture(['White 大', 'White 小', 'White (1)']), original = structuredClone(product);
  const prepared = preparePublishProduct(product);
  assert.deepEqual(prepared.variantGroups[0].options, ['White 大 (2)', 'White 小 (3)', 'White (1)']);
  assert.deepEqual(prepared.variantGroups[0].optionValues, original.variantGroups[0].optionValues);
  const rows = resolveReferencedSkuRows(prepared, [{ name: '颜色', options: ['White (1)', 'White (3)', 'White (2)'] }], { normalizeValue });
  assert.deepEqual(rows.map(row => row.sku.code), ['CODE-2', 'CODE-1', 'CODE-0']);
  for (const row of rows) assert.equal(prepared.variantGroups[0].optionImages[row.sku.attributes.Color], row.sku.image);
  assert.deepEqual(product, original);
});

test('can refine an earlier source-label repair without losing original option metadata', () => {
  const product = optionFixture(['White 大', 'White 大', 'White 小 (1)']), original = structuredClone(product);
  const collected = recoverDuplicateSkuOptions(product, { strict: true });
  const prepared = recoverDuplicateSkuOptions(collected, { strict: true, normalizeValue });
  assert.equal(new Set(prepared.variantGroups[0].options.map(normalizeValue)).size, 3);
  assert.deepEqual(commerce(prepared), commerce(original));
  assert.deepEqual(prepared.variantGroups[0].optionValues, original.variantGroups[0].optionValues);
  assert.deepEqual(prepared.variantGroups[0].optionIdentityMappings.map(row => row.sourceName), original.variantGroups[0].options);
  assert.equal(recoverDuplicateSkuOptions(prepared, { strict: true, normalizeValue }), prepared);
  const incomplete = optionFixture(['White 大', 'White 小']);
  delete incomplete.skus[0].evidence;
  assert.throws(() => recoverDuplicateSkuOptions(incomplete, { strict: true, normalizeValue }), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
});

function aliasProduct() {
  return { variantGroups: [{ id: '101', name: 'Model', options: ['A', 'B'] }, { id: '102', name: 'Model Number', options: ['B', 'A'] }],
    skus: [
      { attributes: { Model: 'A', 'Model Number': 'B' }, code: 'A-B', price: 12, stock: 10, image: 'https://example.test/ab.jpg' },
      { attributes: { Model: 'B', 'Model Number': 'A' }, code: 'B-A', price: 23, stock: 20, image: 'https://example.test/ba.jpg' },
    ] };
}

test('uses exact dimension names before aliases so flattened prices cannot swap between pictures', () => {
  const product = aliasProduct(), before = structuredClone(product);
  const flat = buildFlattenedVariantGroup(product, '999', 'Specification');
  assert.deepEqual(flat.options, ['A / B', 'B / A']);
  assert.deepEqual(flat.optionImages, { 'A / B': product.skus[0].image, 'B / A': product.skus[1].image });
  const rows = resolveReferencedSkuRows(product, [{ name: 'Specification', options: [...flat.options].reverse() }], { appliedGroups: [flat] });
  assert.deepEqual(rows.map(row => [row.sku.code, row.sku.price, row.sku.stock]), [['B-A', 23, 20], ['A-B', 12, 10]]);
  for (const row of rows) assert.equal(flat.optionImages[row.attributes.Specification], row.sku.image);
  assert.deepEqual(product, before);
});

test('resolves separate alias-named target dimensions without dropping either source value', () => {
  const product = aliasProduct();
  const groups = [{ name: 'Model Number', options: ['A', 'B'] }, { name: 'Model', options: ['B', 'A'] }];
  const rows = resolveReferencedSkuRows(product, groups, { appliedGroups: product.variantGroups });
  assert.deepEqual(rows.map(row => row.sku?.code), ['B-A', undefined, undefined, 'A-B']);
  assert.deepEqual(findSkuAttributeEntry({ Model: 'A', 'Model Number': 'B' }, 'Model'), ['Model', 'A']);
  assert.throws(() => findSkuAttributeEntry({ Model: 'A', 'Model Number': 'B' }, '型号'), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
  assert.throws(() => resolveReferencedSkuRows(product, [{ name: '型号', options: ['A', 'B'] }]), /规格组合不一致/);
  assert.deepEqual(resolveReferencedSkuRows({ skus: [{ attributes: { Color: 'Blue' }, code: 'BLUE' }] }, [{ name: '颜色', options: ['Blue'] }]).map(row => row.sku.code), ['BLUE']);
});

function doubleCollision() {
  return { globalData: { product: { sku: {
    skuAttrs: [
      { id: '101', name: 'Material', type: 'IMAGE', values: [{ id: '1', name: 'Plastic', image: 'https://example.test/p1.jpg' }, { id: '2', name: 'Plastic', image: 'https://example.test/p2.jpg' }] },
      { id: '102', name: 'Material', values: [{ id: '3', name: 'Cotton' }, { id: '4', name: 'Nylon' }] },
    ],
    skuInfoMap: Object.fromEntries(['101:1;102:3;', '101:2;102:3;', '101:1;102:4;', '101:2;102:4;'].map((key, i) => [key, { id: `sku-${i}`, price: i + 2, stock: i + 10, skuCode: `CODE-${i}` }])),
  } } } };
}

test('recovers duplicate dimensions and duplicate option names together when per-option IDs are retained', () => {
  const raw = doubleCollision(), before = structuredClone(raw);
  const product = extractAlibabaSourceData(raw);
  assert.deepEqual(product.variantGroups.map(group => group.name), ['Material (1)', 'Material (2)']);
  assert.deepEqual(product.variantGroups[0].options, ['Plastic (1)', 'Plastic (2)']);
  syncProductModel(product);
  const snapshot = structuredClone(product.source.snapshot);
  product.skus[1].price = '19.87'; product.skus[1].code = 'EDITED'; product.skus[1].enabled = false;
  syncProductModel(product);
  const reopened = JSON.parse(JSON.stringify(product));
  syncProductModel(reopened);
  assert.equal(verifySourceIntegrity(reopened).valid, true);
  assert.deepEqual(reopened.source.snapshot, snapshot);
  const prepared = preparePublishProduct(reopened);
  const flat = buildFlattenedVariantGroup(prepared, '999', 'Material');
  const rows = resolveReferencedSkuRows(prepared, [{ name: 'Material', options: [...flat.options].reverse() }], { appliedGroups: [flat] });
  assert.deepEqual(rows.map(row => row.sku.code), ['CODE-3', 'CODE-2', 'EDITED', 'CODE-0']);
  for (const row of rows) assert.equal(flat.optionImages[row.attributes.Material], row.sku.image);
  assert.equal(prepared.skus[1].price, '19.87');
  assert.equal(prepared.skus[1].enabled, false);
  assert.deepEqual(raw, before);
});

test('refuses inconsistent option identities for a duplicate source dimension', () => {
  const product = extractAlibabaSourceData(doubleCollision());
  // Reconstruct the old collapsed display keys but retain per-option records.
  product.variantGroups.forEach(group => { group.name = 'Material'; group.options = group.optionValues.map(value => value.name); });
  product.skus.forEach(sku => { sku.attributes = { Material: sku.attributes['Material (2)'] }; });
  product.variantGroups[0].optionValues[0].id = '2';
  const original = structuredClone(product);
  assert.throws(() => preparePublishProduct(product), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
  assert.deepEqual(product, original);
});
