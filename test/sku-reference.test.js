import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillReferencedSkuRows, reconcileSkuMinimumOrder, requireSkuMinimumOrder, selectSkuPricing, skuMinimumOrderQuantity, usesSkuPricing } from '../server/sku-reference.js';
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

test('validates ordinary variant inventory against enabled SKU totals instead of a stale summary stock', () => {
  const product = { title: 'Stock fixture', price: 5, stock: 1, minOrder: 20, priceMode: 'quantity-tier',
    mainImages: ['https://example.test/a.jpg', 'https://example.test/b.jpg', 'https://example.test/c.jpg', 'https://example.test/d.jpg'],
    detailImages: ['https://example.test/detail.jpg'], description: 'Stock fixture description',
    variantGroups: [{ name: 'Color', options: ['Black', 'Blue', 'Red'] }], skus: [
      { attributes: { Color: 'Black' }, price: 5, stock: 12 },
      { attributes: { Color: 'Blue' }, price: 5, stock: 8 },
      { attributes: { Color: 'Red' }, price: 5, stock: 200, enabled: false },
    ] };
  const original = structuredClone(product);
  assert.deepEqual(validateProductData(product), []);
  assert.deepEqual(product, original);
  product.stock = 1000;
  product.skus[1].stock = 7;
  assert.ok(validateProductData(product).includes('可售数量 19 小于最小起订量 20，请核实库存或起订量'));
  assert.ok(!validateProductData(product, { mode: 'draft' }).some(message => /可售数量/.test(message)));
  assert.deepEqual(product.skus.map(sku => sku.stock), [12, 7, 200]);
  product.skus[1].stock = null;
  assert.ok(validateProductData(product).includes('启用的 SKU 库存必须大于 0'));
  assert.equal(product.skus[1].stock, null);
});

test('preserves non-reference same-price SKU stock, codes and disabled combinations without changing tier prices', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<label><input id="tier-mode" type="radio" checked>根据数量设置阶梯价</label><div class="posting-field-ladder"><input role="input-price" value="5"><input role="input-price" value="4"></div>
      <div id="sku"><table class="sku-header"><tr><th><div class="th-saleProps-label"><span>颜色</span></div><div class="checkSelectBabel"><span class="labelText">Black</span><span class="labelText">Blue</span><span class="labelText">Green</span></div></th></tr></table>
      <div class="virtualized-table-scroll-wrapper"><table id="body"></table></div></div>
      <script>window.rows=[{code:'old-black',stock:'99',enabled:true},{code:'old-blue',stock:'99',enabled:false},{code:'',stock:'',enabled:true}];
      document.querySelector('#body').innerHTML=rows.map((row,i)=>'<tr><td data-name="skuOuterId" data-row="'+i+'"><input value="'+row.code+'"></td><td data-name="skuStock"><input value="'+row.stock+'"></td><td data-name="operate"><button role="switch" aria-checked="'+row.enabled+'">Toggle</button></td></tr>').join('');
      document.querySelectorAll('#body tr').forEach((tr,i)=>{const row=rows[i];const update=()=>tr.querySelectorAll('input').forEach(input=>input.disabled=!row.enabled);update();tr.querySelectorAll('input').forEach((input,j)=>input.oninput=e=>row[j?'stock':'code']=e.target.value);tr.querySelector('button').onclick=e=>{row.enabled=!row.enabled;e.target.setAttribute('aria-checked',row.enabled);update();};});</script>`);
    const product = { priceMode: 'quantity-tier', priceTiers: [{ minQuantity: 1, price: 5 }, { minQuantity: 10, price: 4 }],
      variantGroups: [{ name: 'Color', options: ['Blue', 'Black', 'Green'] }], skus: [
        { attributes: { Color: 'Blue' }, price: 5, stock: 17, code: 'BLUE' },
        { attributes: { Color: 'Black' }, price: 5, stock: 0, code: '', enabled: false },
      ] };
    const original = structuredClone(product);
    assert.equal(usesSkuPricing(product), false);
    assert.deepEqual(await fillReferencedSkuRows(page, product, fillAndVerify), { filled: 3 });
    assert.deepEqual(await page.evaluate(() => window.rows), [
      { code: '', stock: '0', enabled: false }, { code: 'BLUE', stock: '17', enabled: true }, { code: '', stock: '', enabled: false },
    ]);
    assert.equal(await page.locator('#tier-mode').isChecked(), true);
    assert.deepEqual(await page.locator('[role=input-price]').evaluateAll(nodes => nodes.map(node => node.value)), ['5', '4']);
    assert.deepEqual(product, original);
  } finally { await browser.close(); }
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
    await assert.rejects(selectSkuPricing(page, product, fillAndVerify, { timeoutMs: 100 }), { code: 'PUBLISH_FIELD_NOT_READY' });
    assert.equal(await page.locator('input').inputValue(), '99');
  } finally { await browser.close(); }
});

test('waits for lazy pricing modes after variant changes and selects a label beside a hidden radio', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.setContent(`<div style="height:3000px">Specifications</div><div id="struct-scPrice" style="height:200px"></div>
      <script>let observed=false;new IntersectionObserver(entries=>{
        if(observed||!entries.some(e=>e.isIntersecting))return;observed=true;
        setTimeout(()=>{document.querySelector('#struct-scPrice').innerHTML='<div id="scPrice"><span class="icbuRadio-item"><input type="radio" hidden><span class="item-label">根据规格设置价格</span></span></div>';
          document.querySelector('.item-label').onclick=()=>{
            document.querySelector('#scPrice input').checked=true;
            setTimeout(()=>document.querySelector('#scPrice').insertAdjacentHTML('afterend','<input id="minOrderQuantity">'),200);
          };
        },300);
      }).observe(document.querySelector('#struct-scPrice'));</script>`);
    await selectSkuPricing(page, { minOrder: 10 }, fillAndVerify, { timeoutMs: 4000 });
    assert.equal(await page.locator('#scPrice input').isChecked(), true);
    assert.equal(await page.locator('#minOrderQuantity').inputValue(), '10');
    await page.setContent('<div id="scPrice"><label>根据数量设置阶梯价</label><label>单一区间价格</label></div><div id="sku" hidden><div data-name="skuPrice"><input value="15"></div></div>');
    await assert.rejects(selectSkuPricing(page, { minOrder: 1 }, fillAndVerify, { timeoutMs: 100 }), error => {
      assert.equal(error.fieldName, '规格价格');
      assert.equal(error.diagnostics.reason, 'sku-pricing-mode-missing');
      return true;
    });
    assert.equal(await page.locator('#sku input').inputValue(), '15');
  } finally { await browser.close(); }
});

test('fills the separate SKU minimum order control with a generic placeholder and blocks when it is absent', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<label><input type="radio" checked>根据规格设置价格</label><div id="sku"><input role="input-quantity" value="99"></div><input id="minOrderQuantity" placeholder="请输入">');
    await selectSkuPricing(page, { minOrder: 3000 }, fillAndVerify);
    assert.equal(await page.locator('#minOrderQuantity').inputValue(), '3000');
    assert.equal(await page.locator('#sku input').inputValue(), '99');
    await page.locator('#minOrderQuantity').evaluate(node => node.remove());
    await assert.rejects(selectSkuPricing(page, { minOrder: 3000 }, fillAndVerify, { timeoutMs: 100 }), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '最小起订量' });
  } finally { await browser.close(); }
});

test('recognizes the live English SKU pricing label with a native help icon and keeps tier pricing separate', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="scPrice"><label><input id="tier" type="radio" name="mode" checked>Tiered pricing</label>
      <label><input id="sku-mode" type="radio" name="mode">SKU pricing <span>\uE633</span></label></div>
      <div class="posting-field-ladder"><input role="input-quantity" value="5000"></div><input id="minOrderQuantity" value="1">`);
    const product = { minOrder: 27, priceMode: 'sku', skus: [{ price: 2 }, { price: 3 }] };
    await selectSkuPricing(page, product, fillAndVerify, { timeoutMs: 3000 });
    assert.equal(await page.locator('#sku-mode').isChecked(), true);
    assert.equal(await page.locator('#tier').isChecked(), false);
    assert.equal(await page.locator('.posting-field-ladder input').inputValue(), '5000');
    assert.deepEqual(await requireSkuMinimumOrder(page, product), { expected: 27, actual: 27 });
  } finally { await browser.close(); }
});

test('commits the actual SKU minimum order without touching earlier sample, customization or ladder quantities', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<label><input type="radio" checked>根据规格设置价格</label>
      <div class="customizedServices"><input placeholder="最小起订量" value="100"></div>
      <div class="posting-field-ladder"><input role="input-quantity" value="1"></div>
      <div id="sample"><input role="input-quantity" value="2"></div>
      <div id="minOrderQuantity"><input id="minOrderQuantity" name="minOrderQuantity" type="number" value="1"></div>`);
    await selectSkuPricing(page, { minOrder: '3,000 Piece/Pieces' }, fillAndVerify, { timeoutMs: 3000 });
    assert.equal(await page.locator('input#minOrderQuantity').inputValue(), '3000');
    assert.deepEqual(await page.locator('input:not([type=radio]):not(#minOrderQuantity)').evaluateAll(nodes=>nodes.map(n=>n.value)), ['100', '1', '2']);
  } finally { await browser.close(); }
});

test('waits for SKU minimum order initialization and replacement instead of exhausting quick writes', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<label><input type="radio" checked>Price by SKU</label><div id="moq"><input id="minOrderQuantity" value="1"></div>
      <script>window.accepted='1';window.initializing=true;
      const bind=()=>{document.querySelector('#minOrderQuantity').oninput=e=>{if(initializing)e.target.value='1';else accepted=e.target.value;};};bind();
      window.release=()=>{initializing=false;document.querySelector('#moq').innerHTML='<input id="minOrderQuantity" value="1">';bind();};</script>`);
    await Promise.all([
      selectSkuPricing(page, { minOrder: 27 }, fillAndVerify, { timeoutMs: 5000 }),
      page.waitForTimeout(1600).then(() => page.evaluate(() => release())),
    ]);
    assert.equal(await page.locator('#minOrderQuantity').inputValue(), '27');
    assert.equal(await page.evaluate(()=>accepted), '27');
  } finally { await browser.close(); }
});

test('normalizes explicit MOQ units across categories without rounding fractions or guessing ranges', () => {
  for (const [raw, expected] of [['3,000 Piece/Pieces', 3000], ['0.25 Kilogram/Kilograms', 0.25], ['2.5 Square Meter/Square Meters', 2.5], ['10 Pair/Pairs', 10], ['1 Metric Ton/Metric Tons', 1], ['20平方米', 20], [1, 1]]) {
    assert.equal(skuMinimumOrderQuantity({ minOrder: raw }), expected, String(raw));
  }
  for (const raw of [0, -1, Infinity, '0', '5-10', '1,50', '1.000,5', '10 or 20 pieces', '5 pieces, 10 sets']) {
    assert.throws(() => skuMinimumOrderQuantity({ minOrder: raw, moq: 1 }), { code: 'PUBLISH_SOURCE_DATA_INVALID', fieldName: '最小起订量' }, String(raw));
  }
  assert.equal(skuMinimumOrderQuantity({ minOrder: '', moq: '15' }), 15);
  assert.equal(skuMinimumOrderQuantity({ priceTiers: [{ minQuantity: 50 }] }), 50);
  assert.equal(skuMinimumOrderQuantity({}), 1);
});

test('repairs MOQ reset after dependent controls and refuses a changed pricing mode before submission', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const product = { minOrder: 25, priceMode: 'sku', skus: [{ price: 3 }, { price: 4 }] };
    await page.setContent('<label><input id="mode" type="radio" checked>Price by SKU</label><div id="moq"><input id="minOrderQuantity" value="25"></div><div id="sku"><div data-name="skuPrice"><input value="3"></div><div data-name="skuPrice"><input value="4"></div></div>');
    assert.deepEqual(await requireSkuMinimumOrder(page, product), { expected: 25, actual: 25 });
    await page.locator('#moq').evaluate(node => { node.innerHTML = '<input id="minOrderQuantity" value="1" readonly>'; setTimeout(() => node.querySelector('input').readOnly = false, 1000); });
    await assert.rejects(requireSkuMinimumOrder(page, product), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '最小起订量' });
    assert.deepEqual(await reconcileSkuMinimumOrder(page, product, { timeoutMs: 4000 }), { expected: 25, actual: 25 });
    assert.deepEqual(await page.locator('#sku input').evaluateAll(nodes => nodes.map(node => node.value)), ['3', '4']);
    await page.locator('#mode').evaluate(node => { node.checked = false; });
    await assert.rejects(requireSkuMinimumOrder(page, product), { code: 'PUBLISH_FIELD_NOT_READY' });
    await assert.rejects(reconcileSkuMinimumOrder(page, product, { timeoutMs: 1500 }), { code: 'PUBLISH_FIELD_NOT_READY' });
    assert.equal(await page.locator('#mode').isChecked(), false);
    assert.equal(await reconcileSkuMinimumOrder(page, { priceMode: 'quantity-tier', skus: [{ price: 3 }, { price: 3 }] }), null);
  } finally { await browser.close(); }
});

test('bounds MOQ retries and never forces rejected, read-only or ambiguous inputs', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const mode = '<label><input type="radio" checked>Price by SKU</label>';
    await page.setContent(`${mode}<input id="minOrderQuantity" value="1" oninput="this.value='1'" onchange="this.value='1'">`);
    const started = Date.now();
    await assert.rejects(selectSkuPricing(page, { minOrder: 25 }, fillAndVerify, { timeoutMs: 1200 }), error => {
      assert.equal(error.code, 'PUBLISH_FIELD_NOT_READY');
      assert.equal(error.diagnostics.reason, 'rejected-or-replaced');
      assert.equal(error.diagnostics.expected, 25);
      return true;
    });
    assert.ok(Date.now() - started < 5000);
    assert.equal(await page.locator('#minOrderQuantity').inputValue(), '1');
    await page.setContent(`${mode}<input id="minOrderQuantity" value="1" readonly><input placeholder="最小起订量" value="99">`);
    await assert.rejects(selectSkuPricing(page, { minOrder: 25 }, fillAndVerify, { timeoutMs: 500 }), error => error.diagnostics.reason === 'not-editable');
    assert.equal(await page.getByPlaceholder('最小起订量').inputValue(), '99');
    await page.setContent(`${mode}<input name="minOrderQuantity" value="1"><input name="minOrderQuantity" value="2">`);
    await assert.rejects(selectSkuPricing(page, { minOrder: 25 }, fillAndVerify, { timeoutMs: 500 }), error => error.diagnostics.reason === 'ambiguous');
    assert.deepEqual(await page.locator('input[name="minOrderQuantity"]').evaluateAll(nodes => nodes.map(node => node.value)), ['1', '2']);
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
