import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { committedSpecificationValues, fillVariantSpecs, fillAndVerify } from '../server/publisher.js';
import { fillReferencedSkuRows } from '../server/sku-reference.js';

test('records only unique committed specification labels and rejects ranges, collisions and unexpected values', () => {
  assert.deepEqual(committedSpecificationValues({ values: ['120 W'] }, ['120w']), ['120 W']);
  assert.deepEqual(committedSpecificationValues({ values: ['有线'] }, ['Wired'], {
    valueIds: { Wired: '22' }, labels: { 22: '有线' },
  }), ['有线']);
  for (const [selected, requested] of [
    [['1200 W'], ['120w']], [['100-200 W'], ['120w']], [['120 W', '120W'], ['120w']],
    [['120 W'], ['120w', '120 W']], [['120 W', '240 W'], ['120w']], [['有线'], ['Wired']],
  ]) assert.equal(committedSpecificationValues({ values: selected }, requested), null);
});

test('retains every SKU price and stock after a native field standardizes a custom source option label', { skip: !findChromium(), timeout: 35000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    await page.setContent(`<div id="saleAttributesItems">
      <label><input type="checkbox" value="191288018" checked>功率</label>
      <label><input type="checkbox" value="210194308" checked>最高速度</label>
      <label><input type="checkbox" value="3" checked>型号</label></div>
      <div id="struct-specification">
        <div id="p-191288018"><span class="label">功率</span><label><input type="checkbox" value="11">120 W</label><label><input type="checkbox" value="12">1200 W</label></div>
        <div id="p-210194308"><span class="label">最高速度</span><label><input type="checkbox" value="-1">20-50pcs/min</label></div>
        <div id="p-3"><span class="label">型号</span><label><input type="checkbox" value="-1">Basic</label><label><input type="checkbox" value="-2">With accessory</label></div>
      </div>`);
    const product = { variantGroups: [
      { id: '191288018', name: 'power', options: ['120w'], optionIds: { '120w': '-1' } },
      { id: '210194308', name: 'max speed', options: ['20-50pcs/min'], optionIds: { '20-50pcs/min': '-1' } },
      { id: '3', name: 'model number', options: ['Basic', 'With accessory'], optionIds: { Basic: '-1', 'With accessory': '-2' } },
    ], skus: [
      { attributes: { power: '120w', 'max speed': '20-50pcs/min', 'model number': 'Basic' }, price: '17.25', stock: 3, code: 'BASIC' },
      { attributes: { power: '120w', 'max speed': '20-50pcs/min', 'model number': 'With accessory' }, price: '29.50', stock: 7, code: 'ACCESSORY' },
    ] };
    const original = structuredClone(product);
    const applied = await fillVariantSpecs(page, product);
    assert.deepEqual(applied.unmapped, []);
    assert.equal(applied.groups.find(group => group.name === 'power').appliedValues['120w'], '120 W');
    assert.equal(await page.locator('#p-191288018 input[value="11"]').isChecked(), true);
    assert.equal(await page.locator('#p-191288018 input[value="12"]').isChecked(), false);
    // Native matrix order deliberately differs from both source dimension and
    // SKU order. Values must be matched by the committed combination identity.
    await page.evaluate(() => {
      const root = document.createElement('div'); root.id = 'sku';
      const groups = [{ name: '功率', options: ['120 W'] }, { name: '型号', options: ['With accessory', 'Basic'] }, { name: '最高速度', options: ['20-50pcs/min'] }];
      root.innerHTML = '<table class="sku-header"><tr>' + groups.map(group => '<th><div class="th-saleProps-label"><span>' + group.name + '</span></div><div class="checkSelectBabel">' + group.options.map(value => '<span class="labelText">' + value + '</span>').join('') + '</div></th>').join('') + '</tr></table>'
        + '<div class="virtualized-table-scroll-wrapper"><table>' + [0, 1].map(index => '<tr><td data-name="skuOuterId" data-row="' + index + '"><input></td><td data-name="skuPrice"><input></td><td data-name="skuStock"><input></td></tr>').join('') + '</table></div>';
      document.body.append(root);
    });
    const result = await fillReferencedSkuRows(page, product, fillAndVerify, () => {}, { appliedGroups: applied.groups });
    assert.equal(result.filled, 2);
    assert.deepEqual(await page.locator('[data-name=skuOuterId] input').evaluateAll(nodes => nodes.map(node => node.value)), ['ACCESSORY', 'BASIC']);
    assert.deepEqual(await page.locator('[data-name=skuPrice] input').evaluateAll(nodes => nodes.map(node => node.value)), ['29.50', '17.25']);
    assert.deepEqual(await page.locator('[data-name=skuStock] input').evaluateAll(nodes => nodes.map(node => node.value)), ['7', '3']);
    assert.deepEqual(product, original);
  } finally { await browser.close(); }
});
