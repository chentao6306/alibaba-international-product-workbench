import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { readSellerGroups, applySellerGroup } from '../server/seller-groups.js';
import { fillOriginCountry, inferRequiredAttributeValue, recoverRequiredAttributes } from '../server/publisher.js';
import { originCountry } from '../server/origin-country.js';

test('origin resolves country and preserves explicit compatible provinces without inventing unknown values', () => {
  for (const value of ['中国', 'CN', 'Guangdong, China', 'China, Guangdong']) assert.equal(originCountry(value), 'China');
  assert.equal(originCountry('California, United States'), 'United States');
  assert.equal(originCountry('Taiwan, China'), 'Taiwan, China');
  assert.equal(originCountry('Croatia'), 'Croatia (local name: Hrvatska)');
  assert.equal(originCountry('Congo, The Democratic Republic Of The'), 'Congo, The Democratic Republic Of The');
  assert.equal(originCountry('Guangdong'), 'China');
  assert.equal(originCountry('China, United States'), '');
  assert.equal(inferRequiredAttributeValue({ origin: 'Japan', attributes: [{ name: '产地', value: 'China' }] }, '产地'), 'Japan');
  assert.equal(inferRequiredAttributeValue({ attributes: [{ name: '省份', value: 'Guangdong' }] }, '省份'), 'Guangdong');
  assert.equal(inferRequiredAttributeValue({ origin: 'Japan', attributes: [{ name: '省份', value: 'Guangdong' }] }, '省份'), '');
  assert.equal(inferRequiredAttributeValue({ origin: 'China' }, '省份'), '');
  assert.equal(inferRequiredAttributeValue({}, '产地'), '');
});

test('seller groups wait for animated popups, delayed selection and repeated checks by ID', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-productGroup"><button class="product-group-select" aria-expanded="false">分组</button></div>
      <div class="posting-field-group" style="display:none"><ul role="tree">${[1, 2].map((id) => `<li class="next-tree-node" value="${id}"><div role="treeitem" aria-label="照相机" aria-selected="false"><div class="next-tree-node-label" tabindex="0">照相机</div></div></li>`).join('')}</ul></div>
      <script>
      const control=document.querySelector('button'), popup=document.querySelector('.posting-field-group');window.clicks=0;
      const close=()=>{control.setAttribute('aria-expanded','false');setTimeout(()=>popup.style.display='none',150);};
      control.onclick=()=>{if(control.getAttribute('aria-expanded')==='true')close();else{control.setAttribute('aria-expanded','true');popup.style.display='block';}};
      control.onkeydown=e=>{if(e.key==='Escape')close();};
      document.querySelectorAll('.next-tree-node-label').forEach(label=>label.onclick=()=>{
        window.clicks++;label.focus();const item=label.parentElement, was=item.getAttribute('aria-selected');
        setTimeout(()=>{document.querySelectorAll('[role=treeitem]').forEach(n=>n.setAttribute('aria-selected','false'));item.setAttribute('aria-selected',was==='true'?'false':'true');},300);
        close();
      });</script>`);
    const groups = await readSellerGroups(page);
    assert.equal(groups.length, 2);
    assert.equal((await applySellerGroup(page, groups[1])).id, '2');
    assert.equal((await applySellerGroup(page, groups[1])).id, '2');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(await page.locator('li[value="1"] [role=treeitem]').getAttribute('aria-selected'), 'false');
    await assert.rejects(applySellerGroup(page, { id: '99', name: '照相机' }), { code: 'SELLER_GROUP_UNAVAILABLE' });
  } finally { await browser.close(); }
});

test('seller groups accept an empty account and close its popup without inventing a selected group', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-productGroup"><button class="product-group-select" aria-expanded="false">分组</button></div>
      <div class="posting-field-group" style="display:none"><button class="posting-field-group-add">Add group</button></div>
      <script>
      const control=document.querySelector('.product-group-select'), popup=document.querySelector('.posting-field-group');
      control.onclick=()=>{control.setAttribute('aria-expanded','true');popup.style.display='block';};
      control.onkeydown=e=>{if(e.key==='Escape'){control.setAttribute('aria-expanded','false');popup.style.display='none';}};
      </script>`);
    assert.deepEqual(await readSellerGroups(page), []);
    assert.equal(await page.locator('.posting-field-group').isVisible(), false);
    await assert.rejects(applySellerGroup(page, { id: '99', name: 'Removed group' }), { code: 'SELLER_GROUP_UNAVAILABLE' });
    assert.equal(await page.locator('.posting-field-group').isVisible(), false);
    // The add button is present while a populated tree is still loading too.
    await page.evaluate(() => {
      document.querySelector('.product-group-select').addEventListener('click', () => setTimeout(() => {
        document.querySelector('.posting-field-group').insertAdjacentHTML('beforeend', '<ul role="tree"><li class="next-tree-node" value="7"><div role="treeitem" aria-label="Loaded group"></div></li></ul>');
      }, 350));
    });
    assert.equal((await readSellerGroups(page))[0].id, '7');
  } finally { await browser.close(); }
});

test('country selection commits an actual option without filling a province during repair', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-1"><div class="label">产地</div><input></div>
      <div class="sell-catProp-item" id="struct-province"><div class="label">省份</div><input></div>
      <div class="sell-o-select-options" style="display:none"><div class="options-search"><input></div><div class="options-item">China</div><div class="options-item">Japan</div></div>
      <script>const origin=document.querySelector('#struct-p-1 input'),menu=document.querySelector('.sell-o-select-options');origin.onclick=()=>menu.style.display='block';document.querySelectorAll('.options-item').forEach(n=>n.onclick=()=>{origin.value=n.textContent;menu.style.display='none';});</script>`);
    assert.equal(await fillOriginCountry(page, 'Guangdong, China'), true);
    const product = { origin: 'Japan', attributes: [{ name: '产地', value: 'Guangdong, China' }, { name: '省份', value: 'Guangdong' }] };
    assert.deepEqual(await recoverRequiredAttributes(page, product, ['产地', '省份']), ['产地']);
    assert.equal(await page.locator('#struct-p-1 input').inputValue(), 'Japan');
    assert.equal(await page.locator('#struct-province input').inputValue(), '');
    assert.equal(await fillOriginCountry(page, 'Unknown'), false);
  } finally { await browser.close(); }
});
