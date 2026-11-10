import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReferencedSkuRows } from '../server/sku-reference.js';

// Reduced from a machine-category failure: a standard option changes the
// display spelling, while both model combinations must keep their own commerce.
function machineFixture() {
  const product = { skus: [
    { attributes: { power: '120w', 'max speed': '20-50pcs/min', 'model number': 'Basic' }, price: '17.25', stock: 3, code: 'BASIC' },
    { attributes: { power: '120w', 'max speed': '20-50pcs/min', 'model number': 'With accessory' }, price: '29.50', stock: 7, code: 'ACCESSORY' },
  ] };
  const groups = [
    { name: '功率', options: ['120 W'] },
    { name: '型号', options: ['With accessory', 'Basic'] },
    { name: '最高速度', options: ['20-50pcs/min'] },
  ];
  const appliedGroups = [
    { id: '191288018', name: 'power', targetName: '功率', appliedValues: { '120w': '120w' } },
    { id: '210194308', name: 'max speed', targetName: '最高速度', appliedValues: { '20-50pcs/min': '20-50pcs/min' } },
    { id: '3', name: 'model number', targetName: '型号', appliedValues: { Basic: 'Basic', 'With accessory': 'With accessory' } },
  ];
  return { product, groups, appliedGroups };
}

test('records the committed option spelling mismatch and resolves every price only with verified writer labels', () => {
  const { product, groups, appliedGroups } = machineFixture();
  const original = structuredClone(product);
  assert.throws(() => resolveReferencedSkuRows(product, groups, { appliedGroups }), error => {
    assert.equal(error.code, 'PUBLISH_SKU_COMBINATION_MISMATCH');
    assert.equal(error.diagnostics.reason, 'source-combinations-unmatched');
    assert.equal(error.diagnostics.sourceSkuCount, 2);
    assert.equal(error.diagnostics.matchedSkuCount, 0);
    assert.deepEqual(error.diagnostics.unmatchedSourceIndices, [0, 1]);
    assert.deepEqual(error.diagnostics.targetGroups[0].options, ['120 W']);
    assert.deepEqual(error.diagnostics.appliedGroups[0].appliedValues, [{ source: '120w', target: '120w' }]);
    return true;
  });
  appliedGroups[0].appliedValues['120w'] = '120 W';
  const rows = resolveReferencedSkuRows(product, groups, { appliedGroups });
  assert.deepEqual(rows.map(row => [row.sku.code, row.sku.price, row.sku.stock]), [
    ['ACCESSORY', '29.50', 7], ['BASIC', '17.25', 3],
  ]);
  assert.deepEqual(product, original);
  appliedGroups[0].appliedValues['120w'] = '1200 W';
  assert.throws(() => resolveReferencedSkuRows(product, groups, { appliedGroups }), { code: 'PUBLISH_SKU_COMBINATION_MISMATCH' });
  assert.deepEqual(product, original, 'mismatches must not merge rows or rewrite source commerce');
});

test('distinguishes invalid target matrices, ambiguous dimensions and conflicting source assignments', () => {
  const product = { skus: [{ attributes: { Color: 'Blue' }, code: 'ONLY' }] };
  const cases = [
    [product, [], 'target-matrix-empty'],
    [product, [{ name: 'Color', options: Array.from({ length: 5001 }, (_, index) => String(index)) }], 'target-matrix-limit'],
    [product, [{ name: 'Color', options: ['Blue'] }, { name: ' color ', options: ['Blue'] }], 'duplicate-target-dimensions'],
    [{ skus: [{ attributes: { type: 'A' } }] }, [{ name: 'Product Type', options: ['A'] }, { name: '类型', options: ['A'] }], 'ambiguous-target-dimension'],
    [{ skus: [{ attributes: { Model: 'A', 'Model Number': 'B' } }] }, [{ name: '型号', options: ['A', 'B'] }], 'conflicting-target-assignment'],
    [product, [{ name: 'Color', options: ['Red'] }], 'source-combinations-unmatched'],
  ];
  for (const [source, groups, reason] of cases) {
    const original = structuredClone(source);
    assert.throws(() => resolveReferencedSkuRows(source, groups), error => {
      assert.equal(error.code, 'PUBLISH_SKU_COMBINATION_MISMATCH');
      assert.equal(error.diagnostics.reason, reason);
      assert.equal(error.fieldName, '规格表');
      return true;
    });
    assert.deepEqual(source, original);
  }
});

test('diagnoses duplicate source and target combinations without collapsing prices, codes or stock', () => {
  const product = { skus: [
    { attributes: { Color: 'Blue' }, code: 'FIRST', price: 10, stock: 1 },
    { attributes: { Color: 'Blue' }, code: 'SECOND', price: 20, stock: 2 },
  ] };
  const original = structuredClone(product);
  assert.throws(() => resolveReferencedSkuRows(product, [{ name: 'Color', options: ['Blue'] }]), error => {
    assert.match(error.message, /重复规格组合/);
    assert.equal(error.diagnostics.reason, 'duplicate-source-combination');
    return true;
  });
  assert.throws(() => resolveReferencedSkuRows({ skus: [product.skus[0]] }, [{ name: 'Color', options: ['Blue', 'BLUE'] }]), error => {
    assert.equal(error.diagnostics.reason, 'duplicate-target-combination');
    assert.equal(error.diagnostics.matchedSkuCount, 1);
    assert.equal(error.diagnostics.matchedRowCount, 2);
    return true;
  });
  assert.deepEqual(product, original);
});

test('bounds matrix diagnostics so a large label set cannot crowd out the failure report', () => {
  const options = Array.from({ length: 100 }, (_, index) => `Option ${index} ${'x'.repeat(5000)}`);
  const groups = Array.from({ length: 20 }, (_, index) => ({ name: `Dimension ${index} ${'x'.repeat(5000)}`, options }));
  const appliedGroups = groups.map(group => ({ ...group, targetName: group.name,
    sourceGroups: groups.map(item => item.name), appliedValues: Object.fromEntries(options.map(value => [value, value])) }));
  assert.throws(() => resolveReferencedSkuRows({ skus: [] }, groups, { appliedGroups }), error => {
    assert.equal(error.diagnostics.reason, 'target-matrix-limit');
    assert.ok(Buffer.byteLength(JSON.stringify(error.diagnostics)) < 24000);
    assert.equal(error.diagnostics.targetGroups.length, 6);
    assert.equal(error.diagnostics.targetGroups[0].optionCount, 100);
    assert.equal(error.diagnostics.targetGroups[0].options.length, 8);
    assert.equal(error.diagnostics.appliedGroups.length, 6);
    return true;
  });
});
