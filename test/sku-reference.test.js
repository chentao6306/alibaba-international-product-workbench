import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillReferencedSkuRows } from '../server/sku-reference.js';
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
