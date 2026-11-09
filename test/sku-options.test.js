import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverDuplicateSkuOptions } from '../server/sku-options.js';
import { resolveReferencedSkuRows } from '../server/sku-reference.js';

const style = 'Style B2 Colour Random';
function legacy() {
  return {
    variantGroups: [{ id: '10', name: 'Color', type: 'IMAGE', options: [style, style, 'Blue'],
      optionIds: { [style]: '2', Blue: '3' },
      optionImages: { [style]: 'https://example.test/2.jpg', Blue: 'https://example.test/3.jpg' } }],
    skus: [1, 2, 3].map(id => ({ id: `sku-${id}`, attributes: { Color: id < 3 ? style : 'Blue' },
      name: id < 3 ? style : 'Blue', code: `CODE-${id}`, price: String(2.5 * id), stock: id * 7,
      enabled: id !== 2, image: `https://example.test/${id}.jpg`,
      evidence: { method: 'detailData.skuInfoMap', combination: `10:${id};` } })),
  };
}
function collected() {
  const product = legacy();
  product.variantGroups[0].optionValues = [1, 2, 3].map(id => ({ id: String(id), name: id < 3 ? style : 'Blue', image: `https://example.test/${id}.jpg` }));
  return product;
}
const labels = [`${style} (1)`, `${style} (2)`, 'Blue'];
const commerce = product => product.skus.map(({ id, code, price, stock, enabled, image, evidence }) => ({ id, code, price, stock, enabled, image, evidence }));

test('distinguishes source option IDs sharing a label without losing SKU commerce or images', () => {
  const product = collected(), original = structuredClone(product);
  const repaired = recoverDuplicateSkuOptions(product, { strict: true });
  assert.deepEqual(repaired.variantGroups[0].options, labels);
  assert.deepEqual(repaired.skus.map(sku => sku.attributes.Color), labels);
  assert.deepEqual(repaired.skus.map(sku => sku.name), labels);
  assert.deepEqual(repaired.variantGroups[0].optionImages, Object.fromEntries(labels.map((label, i) => [label, `https://example.test/${i + 1}.jpg`])));
  assert.deepEqual(repaired.variantGroups[0].optionValues, product.variantGroups[0].optionValues);
  assert.deepEqual(repaired.variantGroups[0].sourceOptions, [style, style, 'Blue']);
  assert.deepEqual(repaired.variantGroups[0].optionIdentityMappings.map(value => [value.id, value.sourceName]), [['1', style], ['2', style], ['3', 'Blue']]);
  assert.deepEqual(commerce(repaired), commerce(original));
  assert.deepEqual(product, original);
  assert.equal(recoverDuplicateSkuOptions(repaired, { strict: true }), repaired);
});

test('recovers legacy overwritten maps by source combination IDs independently of SKU row order', () => {
  const product = legacy();
  product.source = { snapshot: structuredClone(product) };
  product.skus.reverse();
  product.skus[1].price = '19.83'; product.skus[1].code = 'MANUAL'; product.skus[1].stock = 21;
  const original = structuredClone(product), repaired = recoverDuplicateSkuOptions(product, { strict: true });
  assert.deepEqual(repaired.variantGroups[0].options, labels);
  assert.deepEqual(repaired.skus.map(sku => sku.attributes.Color), [...labels].reverse());
  assert.deepEqual(commerce(repaired), commerce(original));
  assert.deepEqual(repaired.source, original.source);
  assert.deepEqual(product, original);
  assert.deepEqual(recoverDuplicateSkuOptions(JSON.parse(JSON.stringify(repaired)), { strict: true }), repaired);
  const rows = resolveReferencedSkuRows(repaired, [{ name: 'Color', options: [...labels].reverse() }]);
  assert.deepEqual(rows.map(row => row.sku.code), ['CODE-3', 'MANUAL', 'CODE-1']);
});

function multidimensional() {
  const product = legacy();
  product.variantGroups.push({ id: '20', name: 'Size', options: ['S', 'M'], optionIds: { S: '1', M: '2' } });
  product.skus = product.skus.flatMap(sku => ['S', 'M'].map((size, i) => ({ ...structuredClone(sku),
    id: `${sku.id}-${size}`, attributes: { ...sku.attributes, Size: size }, name: `${sku.name} / ${size}`,
    code: `${sku.code}-${size}`, evidence: { ...sku.evidence, combination: `${sku.evidence.combination}20:${i + 1};` } })));
  return product;
}

test('keeps option identities and image associations consistent across a second dimension', () => {
  const product = multidimensional(), original = structuredClone(product);
  const repaired = recoverDuplicateSkuOptions(product, { strict: true });
  assert.deepEqual(repaired.skus.map(sku => sku.attributes.Color), labels.flatMap(label => [label, label]));
  assert.deepEqual(repaired.skus.map(sku => sku.attributes.Size), ['S', 'M', 'S', 'M', 'S', 'M']);
  assert.deepEqual(repaired.variantGroups[1], product.variantGroups[1]);
  assert.deepEqual(commerce(repaired), commerce(original));
  const rows = resolveReferencedSkuRows(repaired, [{ name: 'Color', options: [...labels].reverse() }, { name: 'Size', options: ['M', 'S'] }]);
  assert.deepEqual(rows.map(row => row.sku.code), ['CODE-3-M', 'CODE-3-S', 'CODE-2-M', 'CODE-2-S', 'CODE-1-M', 'CODE-1-S']);
});

test('refuses missing identities, partial coverage and conflicting edits without modifying input', () => {
  for (const change of [
    product => { delete product.skus[0].evidence; },
    product => { product.skus[0].evidence.method = 'guessed'; },
    product => { product.skus[0].evidence.combination = '10:1;10:2;'; },
    product => { product.skus[0].evidence.combination = '11:1;'; },
    product => { product.variantGroups.push({ id: '10', name: 'Size', options: ['S'] }); },
    product => { product.skus.pop(); },
    product => { product.skus[0].attributes.Color = 'Unconfirmed edit'; },
    product => { product.variantGroups[0].optionImages[style] = 'https://example.test/wrong.jpg'; },
    product => { product.source = { snapshot: structuredClone(product) }; [product.skus[0].attributes.Color, product.skus[2].attributes.Color] = [product.skus[2].attributes.Color, product.skus[0].attributes.Color]; },
  ]) {
    const product = legacy(); change(product); const original = structuredClone(product);
    assert.equal(recoverDuplicateSkuOptions(product), product);
    assert.throws(() => recoverDuplicateSkuOptions(product, { strict: true }), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
    assert.deepEqual(product, original);
  }
});

test('refuses stale collector metadata rather than overwriting a manually edited option', () => {
  const product = collected();
  product.variantGroups[0].options[2] = 'Edited blue';
  product.skus[2].attributes.Color = 'Edited blue';
  const original = structuredClone(product);
  assert.throws(() => recoverDuplicateSkuOptions(product, { strict: true }), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
  assert.deepEqual(product, original);
});

test('refuses inconsistent images for the same legacy option ID and ambiguous image dimensions', () => {
  const conflict = multidimensional();
  conflict.skus[1].image = 'https://example.test/conflict.jpg';
  assert.throws(() => recoverDuplicateSkuOptions(conflict, { strict: true }), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
  const ambiguous = multidimensional();
  ambiguous.variantGroups[1].optionImages = { S: 'https://example.test/size.jpg' };
  assert.throws(() => recoverDuplicateSkuOptions(ambiguous, { strict: true }), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
  // Fresh collection has per-option images, so SKU.image need not be guessed
  // as the image for each of several dimensions.
  ambiguous.variantGroups[0].optionValues = collected().variantGroups[0].optionValues;
  const repaired = recoverDuplicateSkuOptions(ambiguous, { strict: true });
  assert.deepEqual(repaired.variantGroups[0].options, labels);
  assert.deepEqual(commerce(repaired), commerce(ambiguous));
});

test('does not deduplicate genuine duplicate SKU combinations sharing one source option ID', () => {
  const product = { variantGroups: [{ id: '10', name: 'Color', options: ['Blue'], optionIds: { Blue: '3' } }],
    skus: [legacy().skus[2], { ...legacy().skus[2], code: 'DIFFERENT', price: '99' }] };
  assert.equal(recoverDuplicateSkuOptions(product, { strict: true }), product);
  assert.throws(() => resolveReferencedSkuRows(product, [{ name: 'Color', options: ['Blue'] }]), /重复规格组合/);
  const invalid = collected();
  invalid.variantGroups[0].optionValues[0].id = '2';
  assert.throws(() => recoverDuplicateSkuOptions(invalid, { strict: true }), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
});

test('avoids generated option label collisions with existing source labels', () => {
  const product = collected();
  const group = product.variantGroups[0];
  group.options[2] = `${style} (1)`;
  group.optionValues[2].name = `${style} (1)`;
  group.optionIds = { [style]: '2', [`${style} (1)`]: '3' };
  group.optionImages = { [style]: 'https://example.test/2.jpg', [`${style} (1)`]: 'https://example.test/3.jpg' };
  product.skus[2].attributes.Color = `${style} (1)`;
  const repaired = recoverDuplicateSkuOptions(product, { strict: true });
  assert.deepEqual(repaired.variantGroups[0].options, [`${style} (2)`, `${style} (3)`, `${style} (1)`]);
});
