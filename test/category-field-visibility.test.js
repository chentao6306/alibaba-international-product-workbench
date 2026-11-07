import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { fillCategoryAttributes, fillOriginCountry, recoverRequiredAttributes, requireCategoryAttributes } from '../server/publisher.js';

test('writes and repairs the visible category row without reading limits or values from a hidden duplicate ID', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    await page.setContent(`<div hidden><div class="sell-catProp-item" id="p-123">
      <label class="label required">张数</label><input maxlength="1" value="H"></div></div>
      <div class="sell-catProp-item" id="p-123"><label class="label required">张数</label>
        <input style="display:none" value="inactive"><input disabled value="disabled"><input required maxlength="10"></div>`);
    const product = { attributes: [{ id: '123', name: 'Number of Sheets', value: '100' }] };
    const original = structuredClone(product);
    const fields = await page.evaluate(readPostingAttributeSchema);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].inputIndex, 2, 'Input index includes inactive controls inside the visible row');
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.equal(await page.locator('[id="p-123"]:visible input:enabled:visible').inputValue(), '100');
    assert.equal(await page.locator('[hidden] input').inputValue(), 'H');
    assert.equal(await page.locator('[id="p-123"]:visible input[style]').inputValue(), 'inactive');
    await page.locator('[id="p-123"]:visible input:enabled:visible').fill('');
    assert.deepEqual(await recoverRequiredAttributes(page, product, ['张数']), ['张数']);
    await requireCategoryAttributes(page, product);
    assert.deepEqual(product, original);
  } finally { await browser.close(); }
});

test('preserves literal None in the visible native origin field while an older duplicate remains hidden', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    await page.setContent(`<div class="sell-catProp-item" id="p-1" hidden><label class="label required">原产地</label><input value="China"></div>
      <div class="sell-catProp-item" id="p-1"><label class="label required">原产地</label><input required></div>`);
    assert.equal(await fillOriginCountry(page, 'None'), true);
    await requireCategoryAttributes(page, { origin: 'None', attributes: [{ id: '1', name: 'Place of Origin', value: 'None' }] });
    assert.equal(await page.locator('[id="p-1"]:visible input').inputValue(), 'None');
    assert.equal(await page.locator('[id="p-1"][hidden] input').inputValue(), 'China');
  } finally { await browser.close(); }
});

test('creates and fills repeatable native attribute controls only in the visible duplicate row', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    await page.setContent(`<div class="sell-catProp-item" id="p-99" hidden><label class="label required">OE代码</label>
        <div class="posting-field-multi-text"><input value="OLD-001"><button class="add-button">添加</button></div></div>
      <div class="sell-catProp-item" id="p-99"><label class="label required">OE代码</label>
        <div class="posting-field-multi-text"><button class="add-button">添加</button></div></div>
      <script>window.added=0;document.querySelectorAll('.add-button').forEach(button=>button.onclick=()=>{
        window.added++;button.before(document.createElement('input'));
      });</script>`);
    const product = { attributes: [{ id: '99', name: 'OE Number', value: ['OE-001', 'OE-002'] }] };
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual(await page.locator('[id="p-99"]:visible input').evaluateAll(nodes => nodes.map(node => node.value)), ['OE-001', 'OE-002']);
    assert.equal(await page.locator('[id="p-99"][hidden] input').inputValue(), 'OLD-001');
    assert.equal(await page.evaluate(() => window.added), 2);
    await fillCategoryAttributes(page, product);
    assert.equal(await page.evaluate(() => window.added), 2, 'Committed controls must not be added again on another pass');
  } finally { await browser.close(); }
});

test('resolves the newly mounted dependent field after its previous row is hidden with the same property ID', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    await page.setContent(`<div class="sell-catProp-item" id="p-501"><label class="label required">Product Type</label>
        <select required><option value="">Choose</option><option value="fresh">Fresh Flowers</option></select></div>
      <div class="sell-catProp-item" id="p-502"><label class="label required">Flower Type</label>
        <select required><option value="old" selected>Artificial Rose</option></select></div>
      <script>document.querySelector('#p-501 select').onchange=()=>{
        const old=document.querySelector('#p-502');old.hidden=true;
        const current=old.cloneNode(true);current.hidden=false;
        current.querySelector('select').innerHTML='<option value="">Choose</option><option value="rose">Fresh Rose</option>';
        old.after(current);
      };</script>`);
    const product = { attributes: [
      { id: '501', name: 'Product Type', value: 'Fresh Flowers' },
      { id: '502', name: 'Flower Type', value: 'Fresh Rose' },
    ] };
    const original = structuredClone(product);
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.equal(await page.locator('[id="p-502"]:visible select').inputValue(), 'rose');
    assert.equal(await page.locator('[id="p-502"][hidden] select').inputValue(), 'old');
    assert.deepEqual(product, original);
  } finally { await browser.close(); }
});
