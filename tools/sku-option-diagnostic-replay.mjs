// Offline replay only. Customer reports stay private; output contains counts
// and invariants, never their product titles, images, account or SKU codes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { preparePublishProduct, fillColorSpec, fillAndVerify } from '../server/publisher.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { resolveReferencedSkuRows, fillReferencedSkuRows } from '../server/sku-reference.js';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = input.report || input;
const matches = (report.failures || []).filter(failure => /重复规格组合/.test(failure.error?.message || ''));
assert.ok(matches.length, 'Expected a duplicate SKU report');
const cases = [];
for (const failure of matches) {
  const product = structuredClone(failure.product), original = structuredClone(product);
  const prepared = preparePublishProduct(product);
  assert.deepEqual(product, original, 'Publishing preparation cannot mutate source or user data');
  const groups = prepared.variantGroups.map(group => ({ name: group.name, options: [...group.options].reverse() }));
  const rows = resolveReferencedSkuRows(prepared, groups, { appliedGroups: prepared.variantGroups });
  assert.equal(rows.filter(row => row.sku).length, product.skus.length);
  const originals = new Map(product.skus.map(sku => [sku.id, sku]));
  const imageGroups = prepared.variantGroups.filter(group => group.type === 'IMAGE');
  for (const { sku } of rows.filter(row => row.sku)) {
    const before = originals.get(sku.id);
    assert.ok(before);
    assert.equal(Number(sku.price), Number(before.price));
    for (const key of ['stock', 'code', 'enabled', 'image', 'evidence']) assert.deepEqual(sku[key], before[key]);
    if (imageGroups.length === 1 && before.image) {
      const group = imageGroups[0];
      assert.equal(group.optionImages[sku.attributes[group.name]], before.image);
    }
  }
  const persisted = structuredClone(product);
  syncProductModel(persisted);
  const reopened = JSON.parse(JSON.stringify(persisted));
  syncProductModel(reopened);
  assert.equal(verifySourceIntegrity(reopened).valid, true);
  assert.deepEqual(reopened.source.snapshot.variantGroups, original.variantGroups);
  assert.deepEqual(reopened.source.snapshot.skus, original.skus);
  assert.deepEqual(preparePublishProduct(reopened).variantGroups, prepared.variantGroups);
  let browserRows;
  if (process.argv.includes('--browser')) {
    assert.equal(prepared.variantGroups.length, 1, 'Browser replay expects a single captured color dimension');
    const group = prepared.variantGroups[0];
    assert.match(group.name, /^colou?r$/i);
    const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<div id="saleAttributesItems"><label><input type="checkbox" value="191288010" checked>Color</label></div>
        <div id="struct-specification"><div id="p-191288010"><label>Color</label>
        <div class="posting-feild-color-item"><input role="colorCombobox"></div><button role="btn-add">Add</button></div></div>
        <script>document.querySelector('button').onclick=()=>{const row=document.querySelector('.posting-feild-color-item').cloneNode(true);row.querySelector('input').value='';document.querySelector('button').before(row);};</script>`);
      assert.equal(await fillColorSpec(page, group.options), true);
      const actual = await page.locator('[role=colorCombobox]').evaluateAll(nodes => nodes.map(node => node.value));
      assert.deepEqual(actual, group.options);
      await page.evaluate(values => {
        const root = document.createElement('div'); root.id = 'sku';
        root.innerHTML = '<table class="sku-header"><th><div class="th-saleProps-label"><span>Color</span></div><div class="checkSelectBabel"></div></th></table><div class="virtualized-table-scroll-wrapper"><table id="rows"></table></div>';
        document.body.append(root);
        values.forEach((value, index) => {
          const label = document.createElement('span'); label.className = 'labelText'; label.textContent = value;
          root.querySelector('.checkSelectBabel').append(label);
          const row = document.createElement('tr');
          row.innerHTML = '<td data-name="skuOuterId" data-row="' + index + '"><input></td><td data-name="skuPrice"><input></td><td data-name="skuStock"><input></td><td data-name="operate"><button role="switch" aria-checked="true">Toggle</button></td>';
          row.querySelector('button').onclick = event => event.target.setAttribute('aria-checked', event.target.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          root.querySelector('#rows').append(row);
        });
      }, [...actual].reverse());
      const result = await fillReferencedSkuRows(page, prepared, fillAndVerify, () => {}, { appliedGroups: [group] });
      assert.equal(result.filled, prepared.skus.length);
      const expected = resolveReferencedSkuRows(prepared, [{ name: 'Color', options: [...actual].reverse() }], { appliedGroups: [group] });
      for (const [field, key] of [['skuOuterId', 'code'], ['skuStock', 'stock']]) {
        const values = await page.locator(`[data-name=${field}] input`).evaluateAll(nodes => nodes.map(node => node.value));
        assert.deepEqual(values, expected.map(row => String(row.sku[key] ?? '')));
      }
      browserRows = result.filled;
    } finally { await browser.close(); }
  }
  cases.push({ sourceSkus: product.skus.length, resolvedSkus: rows.filter(row => row.sku).length,
    uniqueOptions: prepared.variantGroups.map(group => new Set(group.options).size),
    repairedLabels: prepared.variantGroups.reduce((count, group) => count + (group.optionIdentityMappings || []).filter(option => option.name !== option.sourceName).length, 0),
    commercePreserved: true, imagesPreserved: true, originalSnapshotPreserved: true, reopenPassed: true,
    ...(browserRows ? { browserRows, browserScope: 'isolated fixture, not the platform' } : {}) });
}
console.log(JSON.stringify({ ok: true, clientVersion: report.appVersion, cases, scope: 'offline diagnostic replay; no live publication' }));
