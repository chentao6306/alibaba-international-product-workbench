import fs from 'node:fs';
import assert from 'node:assert/strict';
import { preparePublishProduct, buildFlattenedVariantGroup } from '../server/publisher.js';
import { resolveReferencedSkuRows } from '../server/sku-reference.js';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = input.report || input;
const matches = (report.failures || []).filter(f => /重复规格组合/.test(f.error?.message || ''));
assert.ok(matches.length, 'Expected a duplicated SKU combination report');
const cases = [];
for (const failure of matches) {
  const product = structuredClone(failure.product), before = structuredClone(product);
  const prepared = preparePublishProduct(product);
  const ids = (failure.page?.fields || []).filter(field => field.type === 'checkbox'
    && prepared.variantGroups.some(group => String(group.id) === String(field.value))).map(field => field.value);
  assert.equal(new Set(ids).size, 1, 'Fixture requires a single captured target dimension');
  const targetId = ids[0];
  const group = buildFlattenedVariantGroup(prepared, targetId, 'Material');
  assert.equal(group.options.length, prepared.skus.length);
  const rows = resolveReferencedSkuRows(prepared, [{ name: 'Material', options: [...group.options].reverse() }], { appliedGroups: [group] });
  const expected = new Map(product.skus.map(sku => [sku.id, sku]));
  for (const { sku } of rows) {
    const original = expected.get(sku.id);
    assert.ok(original);
    assert.equal(Number(sku.price), Number(original.price));
    for (const key of ['stock', 'code', 'enabled']) assert.equal(sku[key], original[key]);
  }
  assert.deepEqual(product, before);
  cases.push({ sourceDimensions: prepared.variantGroups.length, targetDimensions: 1, sourceSkus: product.skus.length,
    resolvedSkus: rows.length, uniqueCombinations: new Set(group.options).size, originalUnchanged: true, commercePreserved: true });
}
console.log(JSON.stringify({ ok: true, clientVersion: report.appVersion, cases, scope: 'offline diagnostic replay; no live publication' }));
