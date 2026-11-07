import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { attributeValueList } from '../server/attribute-values.js';
import { attributeFieldMatchesValue, fillChoice, fillVariantSpecs, variantTransferFailure } from '../server/publisher.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';

test('distinguishes unavailable fixed SKU choices from rejected controls without substituting another capacity', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const product = { variantGroups: [{ id: '210188933', name: 'storage capacity', options: ['32MB+32MB'], optionIds: { '32MB+32MB': '-3' } }] };
    const original = structuredClone(product);
    await page.setContent(`<div id="struct-specification"><div id="p-210188933">
      <span class="label required">存储容量</span><div class="sell-sequential-combocheckbox">
      <label><input type="checkbox" value="1">16 GB</label><label><input type="checkbox" value="2">32 GB</label>
      </div></div></div>`);
    const result = await fillVariantSpecs(page, product);
    assert.deepEqual(result.unmapped, ['storage capacity: 32MB+32MB']);
    assert.equal(result.failures[0].reason, 'option-unavailable');
    assert.deepEqual(result.failures[0].availableOptions, ['16 GB', '32 GB']);
    assert.deepEqual(result.failures[0].committedValues, []);
    assert.equal(await page.locator('input:checked').count(), 0);
    const error = variantTransferFailure(result.failures[0]);
    assert.equal(error.code, 'PUBLISH_SPECIFICATION_OPTION_UNAVAILABLE');
    assert.match(error.message, /没有匹配选项或自定义入口/);
    assert.deepEqual(error.requiredFields, ['存储容量']);
    assert.equal(error.diagnostics.specification.targetId, '210188933');
    assert.deepEqual(product, original);

    // The option is present but a controlled form rejects the click. This is
    // not a missing option and must not be described as a platform restriction.
    await page.setContent(`<div id="struct-specification"><div id="p-210188933">
      <span class="label required">存储容量</span><div class="sell-sequential-combocheckbox">
      <label><input type="checkbox" onclick="return false">32MB+32MB</label>
      </div></div></div>`);
    const rejected = await fillVariantSpecs(page, product);
    assert.equal(rejected.failures[0].reason, 'control-rejected');
    assert.equal(variantTransferFailure(rejected.failures[0]).code, 'PUBLISH_SPECIFICATION_CONTROL_REJECTED');
    assert.deepEqual(product, original);

    await page.setContent(`<div id="struct-specification"><div id="p-210188933">
      <span class="label required">存储容量</span><label><input type="checkbox" disabled>32MB+32MB</label>
      </div></div>`);
    const disabled = await fillVariantSpecs(page, product);
    assert.equal(disabled.failures[0].reason, 'control-disabled');
    assert.equal(variantTransferFailure(disabled.failures[0]).code, 'PUBLISH_SPECIFICATION_CONTROL_DISABLED');
    assert.deepEqual(disabled.unmapped, ['storage capacity: 32MB+32MB']);
    assert.deepEqual(disabled.failures[0].committedValues, []);
    assert.equal(await page.locator('input:checked').count(), 0);
    await page.locator('input').evaluate(input => { input.checked = true; });
    const committedDisabled = await fillVariantSpecs(page, product);
    assert.deepEqual(committedDisabled.unmapped, [], 'An already committed disabled option remains valid');
    assert.equal(await page.locator('input:checked').count(), 1);

    await page.setContent('<div id="struct-specification"></div>');
    const missing = await fillVariantSpecs(page, { variantGroups: [{ ...product.variantGroups[0], options: ['32MB+32MB', '64MB'] }] });
    assert.equal(missing.failures[0].reason, 'field-missing');
    assert.equal(variantTransferFailure(missing.failures[0]).code, 'PUBLISH_SPECIFICATION_FIELD_MISSING');
    assert.deepEqual(product, original);
  } finally { await browser.close(); }
});

test('preserves preset and custom SKU choices when the same category offers Other and Add more', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-specification"><div id="p-200001069">
      <span class="sell-o-addon-label label">front camera</span><div class="sell-sequential-combocheckbox">
      <div id="choices"><label><input type="checkbox">14.0MP</label><label><input type="checkbox">Other</label></div>
      <button class="add-button">Add more</button><div class="sell-sequential-combobox-custom-wrap" hidden><input></div>
      </div></div></div><script>
      const wrap=document.querySelector('.sell-sequential-combobox-custom-wrap'),custom=wrap.querySelector('input');
      window.otherSelected=0;window.added=[];
      document.querySelector('#choices').onchange=e=>{if(e.target.parentElement.textContent==='Other'&&e.target.checked)window.otherSelected++};
      document.querySelector('button').onclick=()=>{wrap.hidden=false;custom.value='';custom.focus()};
      custom.onblur=()=>{const value=custom.value;if(!value)return;setTimeout(()=>{const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=true;label.append(check,document.createTextNode(value));document.querySelector('#choices').append(label);window.added.push(value);wrap.hidden=true},100)};
      </script>`);
    const product = { variantGroups: [{ id: '200001069', name: 'front camera', options: ['14.0MP', '72MP', '108MP'] }] };
    const original = structuredClone(product);
    const result = await fillVariantSpecs(page, product);
    assert.deepEqual(result.unmapped, []);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema)).find(field => field.id === '200001069').values, ['14.0MP', '72MP', '108MP']);
    assert.deepEqual(await page.evaluate(() => window.added), ['72MP', '108MP']);
    assert.equal(await page.evaluate(() => window.otherSelected), 0);
    assert.deepEqual(product, original);
    await fillVariantSpecs(page, product);
    assert.deepEqual(await page.evaluate(() => window.added), ['72MP', '108MP'], 'A second pass must reuse committed choices');
    await page.locator('.add-button').evaluate(node => node.remove());
    assert.equal(await fillChoice(page, page.locator('#choices input').first(), ['14.0MP', '200MP'], { minimumScore: 100 }), false);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema)).find(field => field.id === '200001069').values, ['14.0MP', '72MP', '108MP'], 'Rejected custom data must restore the prior selections');
  } finally { await browser.close(); }
});

test('resolves joined words only through one complete partition of actual multi-select options', () => {
  assert.deepEqual(attributeValueList('SBC AAC', { options: ['Sbc', 'AAC'] }), ['SBC', 'AAC']);
  assert.deepEqual(attributeValueList('Game Player Smart Watch', { options: ['Game Player', 'Smart Watch'] }), ['Game Player', 'Smart Watch']);
  assert.deepEqual(attributeValueList('A B C', { options: ['A', 'B C', 'A B', 'C'] }), ['A B C']);
  assert.deepEqual(attributeValueList('SBC AAC', { options: ['SBC AAC', 'Sbc', 'AAC'] }), ['SBC AAC']);
  assert.deepEqual(attributeValueList('SBC unknown', { options: ['Sbc', 'AAC'] }), ['SBC unknown']);
  assert.deepEqual(attributeValueList('SBC AAC', { multiple: false, options: ['Sbc', 'AAC'] }), ['SBC AAC']);
  assert.deepEqual(attributeValueList('SBC AAC', { options: ['Sbc', 'AAC'], valueIds: { 'SBC AAC': '10' } }), ['SBC AAC']);
  assert.equal(attributeFieldMatchesValue({ controlType: 'combobox', multiple: true, values: ['Sbc', 'AAC'] }, 'SBC AAC'), true);
  assert.equal(attributeFieldMatchesValue({ controlType: 'combobox', multiple: true, values: ['Sbc'] }, 'SBC AAC'), false);
  assert.equal(attributeFieldMatchesValue({ controlType: 'combobox', multiple: true, values: ['Sbc', 'AAC', 'LC3'] }, 'SBC AAC'), false);
});

test('uses existing tag options before search generates ambiguous custom duplicates with whitespace differences', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item"><div class="next-select next-select-tag"><div class="next-select-values"></div>
      <input id="choice" role="combobox" maxcustomitems="60" aria-controls="options"></div></div>
      <div class="next-overlay-inner" hidden><ul id="options" role="listbox"></ul></div>
      <script>
      const input=document.querySelector('input'),menu=document.querySelector('.next-overlay-inner'),list=document.querySelector('ul');
      const options=['mobile phone','Game Player','Camera','Universal\\u00a0','Earphone','Tablet','Smart Watch',' Li-ion'];
      window.selectedIds=[];window.customCount=0;window.searches=0;
      function render(){list.replaceChildren();const query=input.value;const choices=options.map((label,i)=>({label,id:String(i)})).filter(o=>o.label.toLowerCase().includes(query.toLowerCase()));
        if(query&&!options.includes(query))choices.unshift({label:query,id:'custom'});
        choices.forEach(o=>{const li=document.createElement('li');li.setAttribute('role','option');li.dataset.value=o.id;li.textContent=o.label;const check=document.createElement('input');check.type='checkbox';li.prepend(check);list.append(li);
          li.onclick=()=>{if(o.id==='custom')window.customCount++;window.selectedIds.push(o.id);const tag=document.createElement('em');tag.textContent=o.label;document.querySelector('.next-select-values').append(tag);input.value='';render()}})}
      input.onclick=()=>{menu.hidden=false;input.setAttribute('aria-expanded','true');render()};input.oninput=()=>{window.searches++;render()};
      document.addEventListener('mousedown',e=>{if(e.target!==input&&!menu.contains(e.target)){menu.hidden=true;input.setAttribute('aria-expanded','false')}});
      </script>`);
    assert.equal(await fillChoice(page, page.locator('#choice'), 'mobile phone, Game Player, Camera, Universal , Earphone, Tablet, Smart Watch, Li-ion'), true);
    assert.deepEqual(await page.evaluate(() => window.selectedIds), ['0', '1', '2', '3', '4', '5', '6', '7']);
    assert.equal(await page.evaluate(() => window.customCount), 0);
    assert.equal(await page.evaluate(() => window.searches), 0, 'Loaded exact options must not trigger custom creation and ambiguous retries');
    await page.locator('.next-select-values').evaluate(node => node.replaceChildren());
    assert.equal(await fillChoice(page, page.locator('#choice'), '2.4A'), true);
    assert.deepEqual(await page.locator('.next-select-values em').allTextContents(), ['2.4A'], 'Custom values retain their units instead of becoming the numeric search term');
    assert.equal(await page.evaluate(() => window.customCount), 1);
    for (const value of ['466x466', '1ATM']) {
      await page.locator('.next-select-values').evaluate(node => node.replaceChildren());
      assert.equal(await fillChoice(page, page.locator('#choice'), value), true);
      assert.deepEqual(await page.locator('.next-select-values em').allTextContents(), [value], 'Preserve source resolution dimensions and waterproof units in custom choices');
    }
  } finally { await browser.close(); }
});
