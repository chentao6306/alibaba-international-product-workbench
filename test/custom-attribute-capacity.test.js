import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillCustomAttributes, readCustomAttributes } from '../server/custom-attributes.js';
import { SellerPublisher, fillAndVerify, requirePublicAttributeTransfer } from '../server/publisher.js';

const row = '<div class="item"><div class="attr-title"><input></div><div class="attr-value"><input></div></div>';

test('custom attributes wait for the add control and row without confusing loading with a capacity limit', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="customMoreProperty"><div class="list"></div></div><script>
      window.additions=0;
      setTimeout(()=>{
        const button=document.createElement('button');button.textContent='添加自定义属性';
        button.onclick=()=>{window.additions++;setTimeout(()=>document.querySelector('.list').innerHTML=${JSON.stringify(row)},250);};
        document.querySelector('#customMoreProperty').append(button);
      },200);</script>`);
    const product = { customAttributes: [{ name: 'Finish', value: 'Matte' }] };
    await fillCustomAttributes(page, product, fillAndVerify);
    await fillCustomAttributes(page, product, fillAndVerify);
    assert.deepEqual(await readCustomAttributes(page), [{ name: 'Finish', value: 'Matte' }]);
    assert.equal(await page.evaluate(() => window.additions), 1);
    await page.setContent('<div id="customMoreProperty"><button class="add-attr-btn" disabled>Add</button></div>');
    await assert.rejects(fillCustomAttributes(page, product, fillAndVerify, { timeoutMs: 250 }), error => {
      assert.doesNotMatch(error.message, /超过当前类目允许/);
      assert.equal(error.diagnostics.existingRows, 0);
      return error.code === 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED';
    });
  } finally { await browser.close(); }
});

test('the full stable field flow enables color before allocating ten supplier custom attributes', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    await page.setContent(`<p>当前商品类型：商机品</p>
      <div id="saleAttributesItems"><label>Color<input type="checkbox" value="191288010"></label></div>
      <div id="struct-specification"></div>
      <div class="sell-catProp-item" id="struct-p-200183266"><label class="label">输出</label><input value="5V/2.4A"></div>
      <div id="customMoreProperty"><div class="list"></div><button class="add-attr-btn">Add</button></div>
      <script>
      document.querySelector('input').onchange=function(){document.querySelector('#struct-specification').innerHTML=this.checked
        ? '<div id="p-191288010"><label>Color</label><div class="posting-field-color-select"><input role="colorCombobox" placeholder="Please enter"></div></div>' : '';};
      document.querySelector('button').onclick=function(){document.querySelector('.list').insertAdjacentHTML('beforeend',${JSON.stringify(row)});this.disabled=document.querySelectorAll('.item').length>=10;};
      </script>`);
    const customAttributes = Array.from({ length: 10 }, (_, i) => ({ name: `Supplier ${i + 1}`, value: `Value ${i + 1}` }));
    const product = { title: 'Test item', attributes: [{ name: 'Color', value: 'Black' },
      { id: '200183266', name: 'output', value: '5V/2.4A' }, { name: 'Output', value: '5V/2.4A', isCustom: true }], customAttributes,
      variantGroups: [{ id: '191288010', name: 'Color', type: 'TEXT', options: ['Black'] }] };
    const before = structuredClone(product);
    const publisher = new SellerPublisher('unused-custom-capacity-fixture');
    const result = await publisher.fillStableProductFields(page, product);
    assert.equal(result.customAttributes.length, 10);
    assert.ok(result.mappedAttributes.includes('Output'));
    assert.ok(!result.unmappedAttributes.includes('Output'));
    assert.equal((await readCustomAttributes(page)).length, 10);
    const receipts = await requirePublicAttributeTransfer(page, product);
    assert.equal(receipts.find(item => item.name === 'Color').destination, 'specification');
    assert.deepEqual(product, before);
  } finally { await browser.close(); }
});

test('waits for a custom row after a delayed add click instead of reporting the previous seven rows', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="customMoreProperty"><div class="list">${row.repeat(7)}</div>
      <button class="add-attr-btn">Add</button></div><div id="loading" style="position:fixed;inset:0;background:white"></div>
      <script>window.additions=0;
      document.querySelectorAll('.item').forEach((item,i)=>{item.querySelector('.attr-title input').value='Existing '+i;item.querySelector('.attr-value input').value='Value '+i;});
      document.querySelector('button').onclick=()=>{window.additions++;setTimeout(()=>document.querySelector('.list').insertAdjacentHTML('beforeend',${JSON.stringify(row)}),200);};
      </script>`);
    // The actual click consumes most of the original 350ms field budget.
    await page.evaluate(() => setTimeout(() => document.querySelector('#loading').remove(), 160));
    const product = { customAttributes: [{ name: 'Usage', value: 'Home Use' }] };
    await fillCustomAttributes(page, product, fillAndVerify, { timeoutMs: 350 });
    await fillCustomAttributes(page, product, fillAndVerify, { timeoutMs: 350 });
    assert.equal(await page.evaluate(() => window.additions), 1);
    const actual = await readCustomAttributes(page);
    assert.equal(actual.length, 8);
    assert.deepEqual(actual.at(-1), { name: 'Usage', value: 'Home Use' });
    assert.deepEqual(actual.slice(0, 7), Array.from({ length: 7 }, (_, i) => ({ name: `Existing ${i}`, value: `Value ${i}` })));
  } finally { await browser.close(); }
});

test('never adds a second custom row when the first add has no confirmed result', { skip: !findChromium(), timeout: 10000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="customMoreProperty"><button class="add-attr-btn" onclick="window.additions++">Add</button></div><script>window.additions=0</script>');
    let reads = 0;
    const slowPage = new Proxy(page, { get(target, name) {
      if (name === 'evaluate') return async (...args) => {
        // A slow browser round trip must not leave a one-millisecond click
        // budget, or allow repeated additions when no new row is committed.
        if (!reads++) await new Promise(resolve => setTimeout(resolve, 250));
        return target.evaluate(...args);
      };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(fillCustomAttributes(slowPage, { customAttributes: [{ name: 'Usage', value: 'Home Use' }] }, fillAndVerify, { timeoutMs: 200 }), error => {
      assert.equal(error.diagnostics.addDispatched, true);
      assert.equal(error.diagnostics.existingRows, 0);
      return error.code === 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED';
    });
    assert.equal(await page.evaluate(() => window.additions), 1);
  } finally { await browser.close(); }
});
