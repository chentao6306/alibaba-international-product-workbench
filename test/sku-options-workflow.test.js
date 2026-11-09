import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { extractAlibabaSourceData } from '../server/alibaba-source-data.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { JsonStore } from '../server/store.js';
import { preparePublishProduct, fillVariantSpecs, fillColorSpec, ensureColorSpecificationReady, fillAndVerify } from '../server/publisher.js';
import { resolveReferencedSkuRows, fillReferencedSkuRows } from '../server/sku-reference.js';

function source() {
  return { globalData: { product: { sku: {
    skuAttrs: [{ id: '191288010', name: 'Color', type: 'IMAGE', values: [
      { id: '-3', name: 'Style A', image: 'https://sc04.alicdn.com/kf/fixture-a.jpg' },
      { id: '-7', name: 'Style A', image: 'https://sc04.alicdn.com/kf/fixture-b.jpg' },
      { id: '-9', name: 'Style B', image: 'https://sc04.alicdn.com/kf/fixture-c.jpg' },
    ] }],
    skuInfoMap: {
      '191288010:-3;': { id: 'sku-a', price: 2.5, stock: 4, skuCode: 'CODE-A' },
      '191288010:-7;': { id: 'sku-b', price: 3.5, stock: 6, skuCode: 'CODE-B' },
      '191288010:-9;': { id: 'sku-c', price: 4.5, stock: 8, skuCode: 'CODE-C' },
    },
  } } } };
}

test('collects equal source option labels as separate identities through save, edit, reopen and SKU mapping', () => {
  const raw = source(), original = structuredClone(raw), product = extractAlibabaSourceData(raw);
  assert.deepEqual(raw, original);
  assert.equal(product.variantGroups[0].optionValues.length, 3);
  assert.equal(new Set(product.variantGroups[0].options).size, 3);
  Object.assign(product, { id: 'fixture', sourceId: '123456', sourcePlatform: 'alibaba.com', priceMode: 'sku' });
  syncProductModel(product);
  const snapshot = structuredClone(product.source.snapshot);
  product.skus[1].price = '9.87'; product.skus[1].stock = 14; product.skus[1].code = 'MANUAL'; product.skus[0].enabled = false;
  syncProductModel(product);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-option-workflow-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    store.update(state => { state.products = [product]; });
    const reopened = new JsonStore(store.filePath).read().products[0];
    syncProductModel(reopened);
    assert.deepEqual(reopened.source.snapshot, snapshot);
    assert.equal(verifySourceIntegrity(reopened).valid, true);
    const prepared = preparePublishProduct(reopened), group = prepared.variantGroups[0];
    const rows = resolveReferencedSkuRows(prepared, [{ name: '颜色', options: [...group.options].reverse() }], { appliedGroups: [{ ...group, targetName: '颜色' }] });
    assert.deepEqual(rows.map(row => row.sku.code), ['CODE-C', 'MANUAL', 'CODE-A']);
    assert.deepEqual(rows.map(row => row.sku.stock), [8, 14, 4]);
    assert.deepEqual(rows.map(row => row.sku.price), ['4.50', '9.87', '2.50']);
    assert.equal(rows.at(-1).sku.enabled, false);
    for (const row of rows) assert.equal(group.optionImages[row.sku.attributes.Color], row.sku.image);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('writes every disambiguated option and rereads SKU commerce in reversed platform order', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(1000);
    await page.setContent(`<div id="saleAttributesItems"><label><input type="checkbox" value="191288010">颜色</label></div>
      <div id="struct-specification"><div id="p-191288010" style="display:none"><label class="label">颜色</label>
      <div class="posting-feild-color-item"><input role="colorCombobox" placeholder="请输入"></div><button role="btn-add">添加</button></div></div>
      <script>document.querySelector('[type=checkbox]').onchange=()=>document.querySelector('#p-191288010').style.display='block';
      document.querySelector('button').onclick=()=>{const row=document.querySelector('.posting-feild-color-item').cloneNode(true);row.querySelector('input').value='';document.querySelector('button').before(row);};</script>`);
    const product = preparePublishProduct({ ...extractAlibabaSourceData(source()), priceMode: 'sku' });
    product.skus[0].enabled = false;
    const applied = await fillVariantSpecs(page, product);
    assert.deepEqual(applied.unmapped, []);
    assert.ok(await ensureColorSpecificationReady(page));
    assert.equal(await fillColorSpec(page, product.variantGroups[0].options), true);
    const values = await page.locator('[role=colorCombobox]').evaluateAll(nodes => nodes.map(node => node.value));
    assert.equal(new Set(values).size, 3);
    await page.evaluate(values => {
      const root = document.createElement('div'); root.id = 'sku';
      root.innerHTML = '<table class="sku-header"><th><div class="th-saleProps-label"><span>颜色</span></div><div class="checkSelectBabel">' + values.map(v => '<span class="labelText">' + v + '</span>').join('') + '</div></th></table><div class="virtualized-table-scroll-wrapper"><table id="rows"></table></div>';
      document.body.append(root);
      root.querySelector('#rows').innerHTML = values.map((v, i) => '<tr><td data-name="skuOuterId" data-row="' + i + '"><input></td><td data-name="skuPrice"><input></td><td data-name="skuStock"><input></td><td data-name="operate"><button role="switch" aria-checked="true">Toggle</button></td></tr>').join('');
      root.querySelectorAll('button').forEach(button => button.onclick = () => button.setAttribute('aria-checked', button.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));
    }, [...values].reverse());
    const result = await fillReferencedSkuRows(page, product, fillAndVerify, () => {}, { appliedGroups: applied.groups });
    assert.equal(result.filled, 3);
    assert.deepEqual(await page.locator('[data-name=skuOuterId] input').evaluateAll(nodes => nodes.map(node => node.value)), ['CODE-C', 'CODE-B', 'CODE-A']);
    assert.deepEqual(await page.locator('[data-name=skuPrice] input').evaluateAll(nodes => nodes.map(node => node.value)), ['4.50', '3.50', '2.50']);
    assert.deepEqual(await page.locator('[data-name=skuStock] input').evaluateAll(nodes => nodes.map(node => node.value)), ['8', '6', '4']);
    assert.equal(await page.locator('#rows [role=switch]').last().getAttribute('aria-checked'), 'false');
  } finally { await browser.close(); }
});
