import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillReferencedSkuRows, selectSkuPricing, usesSkuPricing } from '../server/sku-reference.js';
import { fillAndVerify, preparePublishProduct, validateProductData } from '../server/publisher.js';

test('keeps referenced zero stock and blank codes during publish preparation', () => {
  const prepared = preparePublishProduct({ categoryReference: {}, variantGroups: [{ name: 'Color', options: ['Black'] }],
    price: 5, stock: 100, skus: [{ attributes: { Color: 'Black' }, stock: 0, enabled: false, code: '' }] });
  assert.equal(prepared.skus[0].stock, 0);
  assert.equal(prepared.skus[0].code, '');
  assert.equal(validateProductData(prepared).some((message) => /SKU 库存/.test(message)), false);
  prepared.skus[0].enabled = true;
  assert.ok(validateProductData(prepared).some((message) => /SKU 库存/.test(message)));
});

test('preserves different collected SKU prices and refuses to invent a missing variant price', () => {
  const product = { price: 5, variantGroups: [{ name: 'Color', options: ['Blue', 'White', 'Black'] }],
    priceMode: 'quantity-tier', skus: [{ attributes: { Color: 'Blue' }, price: '12.34' }, { attributes: { Color: 'White' }, price: '23.45' }, { attributes: { Color: 'Black' }, price: '' }] };
  const prepared = preparePublishProduct(product);
  assert.equal(prepared.priceMode, 'sku');
  assert.deepEqual(prepared.skus.map(sku => sku.price), ['12.34', '23.45', '']);
  assert.ok(validateProductData(prepared).includes('SKU 缺少价格'));
  assert.equal(usesSkuPricing({ skus: [{ price: 5 }, { price: 5 }], priceMode: 'quantity-tier' }), false);
});

test('writes distinct non-reference prices by variant identity in a virtual SKU matrix', { skip: !findChromium(), timeout: 40000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<label><input type="radio" name="mode" checked>根据数量设置阶梯价</label><label><input type="radio" name="mode" id="sku-mode">根据规格设置价格</label><input placeholder="最小起订量">
      <div id="sku"><table class="sku-header"><tr><th><div class="th-saleProps-label"><span>颜色</span></div><div class="checkSelectBabel"><span class="labelText">Black</span><span class="labelText">Blue</span></div></th><th><div class="th-saleProps-label"><span>尺寸</span></div><div class="checkSelectBabel"><span class="labelText">S</span><span class="labelText">M</span></div></th></tr></table>
      <div class="virtualized-table-scroll-wrapper" style="height:100px;overflow:auto"><div style="height:400px"><table id="body"></table></div></div></div>
      <script>window.rows=Array.from({length:4},()=>({price:'5',code:'',stock:'',enabled:true}));let offset=0;
        const render=()=>{document.getElementById('body').innerHTML=rows.slice(offset,offset+2).map((row,i)=>'<tr><td data-name="skuOuterId" data-row="'+(offset+i)+'"><input value="'+row.code+'"></td><td data-name="skuPrice"><input value="'+row.price+'"></td><td data-name="skuStock"><input value="'+row.stock+'"></td><td data-name="operate"><button role="switch" aria-checked="'+row.enabled+'">Toggle</button></td></tr>').join('');
          document.querySelectorAll('#body tr').forEach((tr,i)=>{const row=rows[offset+i];['code','price','stock'].forEach((key,j)=>{tr.querySelectorAll('input')[j].oninput=e=>row[key]=e.target.value;});tr.querySelector('button').onclick=e=>{row.enabled=!row.enabled;e.target.setAttribute('aria-checked',row.enabled);};});};
        document.querySelector('.virtualized-table-scroll-wrapper').onscroll=e=>{const next=e.target.scrollTop>0?2:0;if(next!==offset){offset=next;render();}};render();</script>`);
    const product = { moq: 10, variantGroups: [{ name: 'Color', options: ['Blue', 'Black'] }, { name: 'Size', options: ['M', 'S'] }], skus: [
      { attributes: { Color: 'Blue', Size: 'S' }, price: 23.45, code: 'B-S', stock: 20 },
      { attributes: { Color: 'Black', Size: 'M' }, price: 14.5, code: 'K-M', stock: 10 },
      { attributes: { Color: 'Black', Size: 'S' }, price: 12.34, code: 'K-S', stock: 30 },
    ] };
    await selectSkuPricing(page, product, fillAndVerify);
    assert.equal(await page.locator('#sku-mode').isChecked(), true);
    assert.equal(await page.getByPlaceholder('最小起订量').inputValue(), '10');
    assert.deepEqual(await fillReferencedSkuRows(page, product, fillAndVerify, () => {}, { appliedGroups: [{ name: 'Size', targetName: '尺寸' }] }), { filled: 4 });
    assert.deepEqual(await page.evaluate(() => rows.map(row => [row.price, row.code, row.stock, row.enabled])), [
      ['12.34', 'K-S', '30', true], ['14.50', 'K-M', '10', true], ['23.45', 'B-S', '20', true], ['5', '', '', false],
    ]);
    await page.setContent('<input role="input-price" value="99">');
    await assert.rejects(selectSkuPricing(page, product, fillAndVerify), { code: 'PUBLISH_FIELD_NOT_READY' });
    assert.equal(await page.locator('input').inputValue(), '99');
  } finally { await browser.close(); }
});

test('writes reference codes and quantities by SKU identity across virtual pages and disables missing combinations', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="sku"><table class="sku-header"><tr><th><div class="th-saleProps-label"><span>颜色</span></div><div class="checkSelectBabel"><span class="labelText">Black</span><span class="labelText">Blue</span></div></th><th><div class="th-saleProps-label"><span>类型</span></div><div class="checkSelectBabel"><span class="labelText">A</span><span class="labelText">B</span></div></th></tr></table>
      <div class="virtualized-table-scroll-wrapper" style="height:100px;overflow:auto"><div style="height:400px"><table id="body"></table></div></div></div>
      <script>window.rows=Array.from({length:4},()=>({code:'',stock:'',enabled:true}));let offset=0;
        const render=()=>{document.getElementById('body').innerHTML=rows.slice(offset,offset+2).map((row,i)=>'<tr><td data-name="skuOuterId" data-row="'+(offset+i)+'"><input value="'+row.code+'"></td><td data-name="skuStock"><input value="'+row.stock+'"></td><td data-name="operate"><button role="switch" aria-checked="'+row.enabled+'">Toggle</button></td></tr>').join('');
          document.querySelectorAll('#body tr').forEach((tr,i)=>{const row=rows[offset+i];tr.querySelector('input').oninput=e=>row.code=e.target.value;tr.querySelectorAll('input')[1].oninput=e=>row.stock=e.target.value;tr.querySelector('button').onclick=e=>{row.enabled=!row.enabled;e.target.setAttribute('aria-checked',row.enabled);};});};
        document.querySelector('.virtualized-table-scroll-wrapper').onscroll=e=>{const next=e.target.scrollTop>0?2:0;if(next!==offset){offset=next;render();}};render();</script>`);
    const product = { categoryReference: {}, variantGroups: [{ name: 'Color', options: ['Black', 'Blue'] }], skus: [
      { attributes: { Color: 'Blue', Type: 'A' }, code: 'B-A', stock: 22 },
      { attributes: { Color: 'Black', Type: 'A' }, code: 'K-A', stock: 11 },
      { attributes: { Color: 'Black', Type: 'B' }, code: 'K-B', stock: 0, enabled: false },
    ] };
    assert.deepEqual(await fillReferencedSkuRows(page, product, fillAndVerify), { filled: 4 });
    assert.deepEqual(await page.evaluate(() => window.rows), [
      { code: 'K-A', stock: '11', enabled: true }, { code: 'K-B', stock: '0', enabled: false },
      { code: 'B-A', stock: '22', enabled: true }, { code: '', stock: '', enabled: false },
    ]);
    await assert.rejects(fillReferencedSkuRows(page, { ...product, skus: [{ attributes: { Color: 'Red' } }] }, fillAndVerify), /规格组合不一致/);
    assert.deepEqual(await fillReferencedSkuRows(page, { ...product, variantGroups: [] }, fillAndVerify), { filled: 0 });
  } finally { await browser.close(); }
});

test('initializes an offscreen lazy SKU table before reading references and pauses if headers never load', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div style="height:3000px">Earlier fields</div><div id="sku" style="min-height:200px"></div>
      <script>const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;observer.disconnect();
      setTimeout(()=>{document.querySelector('#sku').innerHTML='<table class="sku-header"><tr><th><div class="th-saleProps-label"><span>Color</span></div><div class="checkSelectBabel"><span class="labelText">Black</span></div></th></tr></table><div class="virtualized-table-scroll-wrapper"><table><tr><td data-name="skuOuterId" data-row="0"><input></td><td data-name="skuStock"><input></td></tr></table></div>';},700);
      });observer.observe(document.querySelector('#sku'));</script>`);
    const product = { categoryReference: {}, variantGroups: [{ name: 'Color', options: ['Black'] }], skus: [{ attributes: { Color: 'Black' }, code: 'B-1', stock: 5 }] };
    assert.deepEqual(await fillReferencedSkuRows(page, product, fillAndVerify, () => {}, { timeoutMs: 3000 }), { filled: 1 });
    assert.equal(await page.locator('[data-name=skuOuterId] input').inputValue(), 'B-1');
    assert.equal(await page.locator('[data-name=skuStock] input').inputValue(), '5');
    await page.setContent('<div id="sku" style="height:200px"></div>');
    await assert.rejects(fillReferencedSkuRows(page, product, fillAndVerify, () => {}, { timeoutMs: 300 }), { code: 'PUBLISH_FIELD_NOT_READY' });
  } finally { await browser.close(); }
});
