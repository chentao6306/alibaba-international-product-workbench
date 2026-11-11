import test from 'node:test';
import assert from 'node:assert/strict';
import { bindReadbackSkuGroups } from '../tools/qa/sku-readback-identity.mjs';
import { resolveReferencedSkuRows } from '../server/sku-reference.js';

const fixture = () => ({
  product: {
    variantGroups: [{ id: '210218404', name: 'compatible model', options: ['For Model A', 'For Model B'] }],
    skus: [
      { attributes: { 'compatible model': 'For Model A' }, price: 12, stock: 3, code: 'A' },
      { attributes: { 'compatible model': 'For Model B' }, price: 25, stock: 7, code: 'B' },
    ],
  },
  headers: [{ name: '使用型号', options: ['For Model B', 'For Model A'] }],
  fields: [{ id: '210218404', label: '使用型号', labels: ['使用型号'], saleSpecification: true,
    disabled: false, values: ['For Model A', 'For Model B'] }],
});

test('readback binds a translated SKU header only through its unique live field and source property ID', () => {
  const { product, headers, fields } = fixture(), before = structuredClone({ product, headers, fields });
  assert.throws(() => resolveReferencedSkuRows(product, headers), { code: 'PUBLISH_SKU_COMBINATION_MISMATCH' });
  const { groups, appliedGroups } = bindReadbackSkuGroups(product, headers, fields);
  assert.deepEqual(appliedGroups, [{ id: '210218404', name: 'compatible model', targetName: '使用型号' }]);
  assert.equal(groups[0].id, '210218404');
  const rows = resolveReferencedSkuRows(product, groups, { appliedGroups });
  assert.deepEqual(rows.map(row => [row.sku.code, row.sku.price, row.sku.stock]), [['B', 25, 7], ['A', 12, 3]]);
  assert.deepEqual({ product, headers, fields }, before);
});

test('readback rejects ambiguous headers, conflicting property IDs, missing source IDs and stale header values', () => {
  const edits = [
    data => { data.fields.push({ ...data.fields[0], id: '3' }); },
    data => { data.fields[0].id = '3'; },
    data => { data.headers[0].id = '3'; },
    data => { data.fields[0].saleSpecification = false; },
    data => { data.fields[0].disabled = true; },
    data => { delete data.product.variantGroups[0].id; },
    data => { data.product.variantGroups.push({ ...data.product.variantGroups[0], name: 'Another dimension' }); },
    data => { data.headers[0].options = ['For Model A']; },
    data => { data.headers.push({ ...data.headers[0] }); },
  ];
  for (const change of edits) {
    const data = fixture(); change(data);
    assert.throws(() => bindReadbackSkuGroups(data.product, data.headers, data.fields), { code: 'QA_SKU_READBACK_IDENTITY_MISMATCH' });
  }
});

test('verified dimension identity never relaxes SKU values or drops an unmatched source combination', () => {
  const { product, headers, fields } = fixture();
  headers[0].options[0] = 'For Model C';
  fields[0].values[1] = 'For Model C';
  const { groups, appliedGroups } = bindReadbackSkuGroups(product, headers, fields);
  assert.throws(() => resolveReferencedSkuRows(product, groups, { appliedGroups }), { code: 'PUBLISH_SKU_COMBINATION_MISMATCH' });
  const single = fixture();
  single.product.variantGroups[0].options = ['For Model A'];
  single.product.skus.splice(1);
  single.headers[0].options = ['For Model A'];
  single.fields[0].values = ['For Model A'];
  const bound = bindReadbackSkuGroups(single.product, single.headers, single.fields);
  assert.equal(resolveReferencedSkuRows(single.product, bound.groups, { appliedGroups: bound.appliedGroups })[0].sku.code, 'A');
});
