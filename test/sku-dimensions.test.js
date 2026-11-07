import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { recoverDuplicateSkuDimensions } from '../server/sku-dimensions.js';
import { extractAlibabaSourceData } from '../server/alibaba-source-data.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { preparePublishProduct, buildFlattenedVariantGroup, fillVariantSpecs, fillAndVerify } from '../server/publisher.js';
import { resolveReferencedSkuRows, fillReferencedSkuRows } from '../server/sku-reference.js';

const groups = [
  { id: '101', name: 'Material', options: ['Plastic', 'pvc'], optionIds: { Plastic: '1', pvc: '-2' } },
  { id: '102', name: 'Material', options: ['Plastic', 'Nylon'], optionIds: { Plastic: '1', Nylon: '2' } },
];
const combinations = ['101:1;102:1;', '101:-2;102:1;', '101:1;102:2;', '101:-2;102:2;'];
function legacy() {
  return { variantGroups: structuredClone(groups), skus: combinations.map((combination, index) => ({
    id: `sku-${index}`, attributes: { Material: index < 2 ? 'Plastic' : 'Nylon' }, name: index < 2 ? 'Plastic' : 'Nylon',
    code: `CODE-${index}`, price: String(index + 2), stock: index * 10, enabled: index !== 0,
    evidence: { method: 'detailData.skuInfoMap', combination },
  })) };
}
const expected = [
  { 'Material (1)': 'Plastic', 'Material (2)': 'Plastic' },
  { 'Material (1)': 'pvc', 'Material (2)': 'Plastic' },
  { 'Material (1)': 'Plastic', 'Material (2)': 'Nylon' },
  { 'Material (1)': 'pvc', 'Material (2)': 'Nylon' },
];

test('collects distinct source property IDs sharing a name without overwriting any SKU dimension', () => {
  const raw = { globalData: { product: { sku: {
    skuAttrs: groups.map(group => ({ id: group.id, name: group.name, values: Object.entries(group.optionIds).map(([name, id]) => ({ name, id })) })),
    skuInfoMap: Object.fromEntries(combinations.map((combination, i) => [combination, { id: `sku-${i}`, price: i + 2, stock: i * 10 }])),
  } } } };
  const before = structuredClone(raw), product = extractAlibabaSourceData(raw);
  assert.deepEqual(product.skus.map(s => s.attributes), expected);
  assert.deepEqual(product.variantGroups.map(g => [g.id, g.sourceName, g.name]), [['101', 'Material', 'Material (1)'], ['102', 'Material', 'Material (2)']]);
  assert.deepEqual(product.skus.map(s => s.price), ['2.00', '3.00', '4.00', '5.00']);
  assert.deepEqual(raw, before);
});

test('repairs saved collapsed dimensions while preserving source snapshot, manual prices, codes and stock', () => {
  const product = legacy(), original = structuredClone(product);
  product.skus[1].price = '8.37'; product.skus[1].code = 'MANUAL'; product.skus[1].stock = 31;
  syncProductModel(product);
  assert.deepEqual(product.skus.map(s => s.attributes), expected);
  assert.deepEqual(product.source.snapshot.variantGroups, original.variantGroups);
  assert.deepEqual(product.source.snapshot.skus.map(s => s.attributes), original.skus.map(s => s.attributes));
  assert.equal(verifySourceIntegrity(product).valid, true);
  const reopened = JSON.parse(JSON.stringify(product));
  syncProductModel(reopened);
  const prepared = preparePublishProduct(reopened);
  assert.deepEqual(prepared.skus.map(s => [s.code, Number(s.price), s.stock, s.enabled]), product.skus.map(s => [s.code, Number(s.price), s.stock, s.enabled]));
  assert.deepEqual(prepared.skus.map(s => s.attributes), expected);
  assert.equal(prepared.skus[1].code, 'MANUAL');
  assert.equal(verifySourceIntegrity(reopened).valid, true);
});

test('refuses ambiguous identities and conflicting manual dimension edits without changing the product', () => {
  for (const change of [
    p => { delete p.skus[0].evidence; },
    p => { p.skus[0].attributes.Material = 'Edited value'; },
    p => { p.variantGroups[1].id = '101'; },
    p => { p.variantGroups[0].optionIds.Other = '1'; p.variantGroups[0].options.push('Other'); },
    p => { p.skus[0].evidence.combination = '101:missing;102:1;'; },
  ]) {
    const product = legacy(); change(product); const original = structuredClone(product);
    assert.equal(recoverDuplicateSkuDimensions(product), product);
    assert.throws(() => preparePublishProduct(product), { code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED' });
    assert.deepEqual(product, original);
  }
});

test('flattens both same-named source dimensions into four unique target combinations without shifting SKU data', () => {
  const product = preparePublishProduct(legacy());
  const group = buildFlattenedVariantGroup(product, '102', '材质');
  assert.deepEqual(group.options, ['Plastic / Plastic', 'pvc / Plastic', 'Plastic / Nylon', 'pvc / Nylon']);
  const rows = resolveReferencedSkuRows(product, [{ name: '材质', options: [...group.options].reverse() }], { appliedGroups: [group] });
  assert.deepEqual(rows.map(r => r.sku.code), ['CODE-3', 'CODE-2', 'CODE-1', 'CODE-0']);
  assert.deepEqual(rows.map(r => r.sku.stock), [30, 20, 10, 0]);
});

test('writes and rereads all four recovered combinations through a single native material dimension', { skip: !findChromium(), timeout: 45000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`<div id="saleAttributesItems"><label><input type="checkbox" value="102">材质</label></div>
      <div id="struct-specification"><div id="p-102" style="display:none"><label class="label">材质</label>
      <div class="posting-feild-color-item"><input role="colorCombobox" placeholder="请输入"></div><button role="btn-add">添加</button></div></div>
      <script>document.querySelector('[type=checkbox]').onchange=()=>document.querySelector('#p-102').style.display='block';
      document.querySelector('button').onclick=()=>{const row=document.querySelector('.posting-feild-color-item').cloneNode(true);row.querySelector('input').value='';document.querySelector('button').before(row);};</script>`);
    const product = preparePublishProduct(legacy());
    const applied = await fillVariantSpecs(page, product);
    assert.deepEqual(applied.unmapped, []);
    const values = await page.locator('[role=colorCombobox]').evaluateAll(nodes => nodes.map(node => node.value));
    assert.equal(new Set(values).size, 4);
    assert.deepEqual(values, ['Plastic / Plastic', 'pvc / Plastic', 'Plastic / Nylon', 'pvc / Nylon']);
    await page.evaluate(values => {
      const root=document.createElement('div');root.id='sku';
      root.innerHTML='<table class="sku-header"><th><div class="th-saleProps-label"><span>材质</span></div><div class="checkSelectBabel">'+values.map(v=>'<span class="labelText">'+v+'</span>').join('')+'</div></th></table><div class="virtualized-table-scroll-wrapper"><table id="rows"></table></div>';
      document.body.append(root);
      document.querySelector('#rows').innerHTML=values.map((v,i)=>'<tr><td data-name="skuOuterId" data-row="'+i+'"><input></td><td data-name="skuPrice"><input></td><td data-name="skuStock"><input></td><td data-name="operate"><button role="switch" aria-checked="true">Toggle</button></td></tr>').join('');
      root.querySelectorAll('button').forEach(button=>button.onclick=()=>button.setAttribute('aria-checked',button.getAttribute('aria-checked')==='true'?'false':'true'));
    }, [...values].reverse());
    assert.equal((await fillReferencedSkuRows(page, product, fillAndVerify, () => {}, { appliedGroups: applied.groups })).filled, 4);
    assert.deepEqual(await page.locator('[data-name=skuOuterId] input').evaluateAll(nodes => nodes.map(n => n.value)), ['CODE-3', 'CODE-2', 'CODE-1', 'CODE-0']);
    assert.deepEqual(await page.locator('[data-name=skuStock] input').evaluateAll(nodes => nodes.map(n => n.value)), ['30', '20', '10', '0']);
    assert.deepEqual(await page.locator('[data-name=skuPrice] input').evaluateAll(nodes => nodes.map(n => n.value)), ['5.00', '4.00', '3.00', '2.00']);
    assert.equal(await page.locator('#rows [role=switch]').last().getAttribute('aria-checked'), 'false');
  } finally { await browser.close(); }
});
