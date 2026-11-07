import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillVariantSpecs } from '../server/publisher.js';

async function withPage(run) {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await run(page);
  } finally { await browser.close(); }
}

const product = (options) => ({ variantGroups: [{ id: '100008179', name: 'Body Color', type: 'IMAGE', options }] });

test('accepts normalized specification casing after blur and preserves all pen colors on repeat passes', { skip: !findChromium() }, () => withPage(async page => {
  await page.setContent(`<div id="struct-specification"><div id="p-100008179"><span class="label">Body Color</span>
    <div class="values"></div><button role="btn-add">Add</button></div></div><script>
    window.commits=[];window.adds=0;
    const values=document.querySelector('.values');
    function add(){window.adds++;const input=document.createElement('input');input.setAttribute('role','colorCombobox');
      input.onblur=()=>{if(!input.value)return;input.value=input.value[0].toUpperCase()+input.value.slice(1).toLowerCase();
        window.commits=[...values.querySelectorAll('input')].map(node=>node.value)};values.append(input)};
    document.querySelector('button').onclick=add;add();</script>`);
  const item = product(['Black', 'White', 'Blue', 'Yellow', 'Orange', 'green', 'Gray', 'pink']);
  const original = structuredClone(item);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fillVariantSpecs(page, item);
    assert.deepEqual(result.unmapped, []);
    assert.deepEqual(await page.evaluate(() => window.commits), ['Black', 'White', 'Blue', 'Yellow', 'Orange', 'Green', 'Gray', 'Pink']);
    assert.equal(await page.evaluate(() => window.adds), 8, 'No duplicate rows when the platform canonicalizes case');
  }
  assert.deepEqual(item, original);
}));

test('reads committed specification tags when blur removes the input and adds later options without duplicate commits', { skip: !findChromium() }, () => withPage(async page => {
  await page.setContent(`<div id="struct-specification"><div id="p-100008179"><span class="label">Body Color</span>
    <div class="values"></div><button role="btn-add">Add</button></div></div><script>
    window.commits=[];const row=document.querySelector('#p-100008179');
    function add(){const input=document.createElement('input');input.setAttribute('role','colorCombobox');row.insertBefore(input,row.querySelector('button'));
      input.onblur=()=>{if(!input.value)return;const value=input.value;input.remove();setTimeout(()=>{
        const tag=document.createElement('span');tag.className='next-tag';tag.textContent=value;row.querySelector('.values').append(tag);window.commits.push(value)},400)}};
    document.querySelector('button').onclick=add;add();</script>`);
  const item = product(['Black', 'Blue']);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual((await fillVariantSpecs(page, item)).unmapped, []);
    assert.deepEqual(await page.evaluate(() => window.commits), ['Black', 'Blue']);
  }
}));

test('rejects a different committed specification instead of accepting text shown only by a suggestion', { skip: !findChromium() }, () => withPage(async page => {
  await page.setContent(`<div id="struct-specification"><div id="p-100008179"><span class="label">Body Color</span>
    <input role="colorCombobox"><button>Next</button><ul role="listbox"></ul></div></div><script>
    const input=document.querySelector('input');input.oninput=()=>{document.querySelector('ul').innerHTML='<li role="option" class="next-menu-item">green</li>'};
    input.onblur=()=>{input.value='Blue'};</script>`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fillVariantSpecs(page, product(['green', 'Red']));
    assert.ok(result.unmapped.includes('Body Color: green'));
    assert.ok(result.unmapped.includes('Body Color: Red'));
    assert.notEqual(await page.locator('input').inputValue(), 'green');
  }
}));
