import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { ORIGIN_COUNTRIES, originCountry, productOrigin } from '../server/origin-country.js';
import { recordProductMutation, syncProductModel } from '../server/product-model.js';
import { extractAlibabaAttributes, packagingFromAttributes, readAlibabaAttributeRows } from '../server/category-attributes.js';
import { fillOriginCountry, fillLogisticsFields, preparePublishProduct } from '../server/publisher.js';

test('origin edits synchronize both representations and invalidate old option IDs without changing source or sales region', () => {
  const product = syncProductModel({ title: 'Paddle', origin: 'China', attributes: [
    { id: '100', name: 'Place of Origin', value: 'China', valueIds: { China: 'CN' } },
    { name: 'Brand', value: 'DKS' },
  ], customAttributes: [{ name: '原产地', value: 'China' }], regionalPricing: { country: 'United States', price: 10 },
  packaging: { weight: '1', length: '30', width: '20', height: '10' } });
  const source = structuredClone(product.source);
  recordProductMutation(product, { origin: 'Japan', packaging: { weight: '2' } });
  assert.equal(product.origin, 'Japan');
  assert.deepEqual(product.attributes[0], { id: '100', name: 'Place of Origin', value: 'Japan' });
  assert.equal(product.customAttributes[0].value, 'Japan');
  assert.deepEqual(product.packaging, { weight: '2', length: '30', width: '20', height: '10' });
  assert.equal(product.regionalPricing.country, 'United States');
  assert.deepEqual(product.source, source);
  recordProductMutation(product, { origin: 'Japan', attributes: [{ ...product.attributes[0], value: '中国' }, product.attributes[1]] });
  assert.equal(product.origin, 'China');
  assert.equal(product.customAttributes[0].value, 'China');
  recordProductMutation(product, { attributes: [{ ...product.attributes[0], value: 'Japan', valueIds: { China: 'CN' } }, product.attributes[1]] });
  assert.equal(product.attributes[0].valueIds, undefined);
  assert.equal(product.origin, 'Japan');
  recordProductMutation(product, { origin: 'China' });
  recordProductMutation(product, { regionalPricing: { country: 'Japan', price: 20 } });
  assert.equal(product.origin, 'China');
  recordProductMutation(product, { origin: '' });
  assert.equal(product.attributes[0].value, '');
  assert.equal(product.customAttributes[0].value, '');
  assert.equal(product.sourceIntegrity.valid, true);
});

test('preparing old products reconciles origin without inventing an absent or conflicting country', () => {
  const product = { title: 'Paddle', origin: 'Japan', attributes: [{ name: '原产地', value: 'China', valueIds: { China: 'CN' } }] };
  const prepared = preparePublishProduct(product);
  assert.equal(prepared.attributes[0].value, 'Japan');
  assert.equal(prepared.attributes[0].valueIds, undefined);
  assert.equal(product.attributes[0].value, 'China');
  assert.equal(productOrigin({ attributes: [{ name: 'Country of Origin', value: 'Japan' }] }), 'Japan');
  assert.equal(productOrigin({ attributes: [{ name: '产地', value: 'Japan' }, { name: '原产地', value: 'China' }] }), '');
  assert.equal(productOrigin({ origin: 'Unknown', attributes: [{ name: '产地', value: 'China' }] }), '');
  for (const country of ORIGIN_COUNTRIES) assert.equal(originCountry(`${country.name}（${country.label}）`), country.name);
});

test('collects package units in labels, individual dimensions and structured packaging without using product net size', () => {
  assert.deepEqual(packagingFromAttributes([{ name: 'Single gross weight (g)', value: '750' }, { name: 'Single package size (mm)', value: '300x200x100' }]),
    { weight: '0.75', length: '30', width: '20', height: '10' });
  assert.deepEqual(packagingFromAttributes([{ name: '单件包装尺寸', value: '30cm x 200mm x 0.1m' }]), { length: '30', width: '20', height: '10' });
  assert.deepEqual(packagingFromAttributes([{ name: '包装长（厘米）', value: '30' }, { name: 'Package width (in)', value: '2' }, { name: 'Package height', value: '100mm' }]),
    { length: '30', width: '5.08', height: '10' });
  assert.deepEqual(packagingFromAttributes([{ name: 'Single gross weight (stone)', value: '2' }, { name: 'Size', value: '1x2x3' }, { name: 'Single package size', value: '1-2x3x4cm' }]), {});
  assert.deepEqual(packagingFromAttributes(extractAlibabaAttributes({ nodeMap: { module_packaging: { privateData: {
    singleGrossWeight: 750, singleGrossWeightUnit: 'g', singlePackageSize: '30x20x10', singlePackageSizeUnit: 'cm',
  } } } })), { weight: '0.75', length: '30', width: '20', height: '10' });
});

test('collected definition-list origin and packaging survive editing and fill native publishing controls', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<dl><dt>Country of Origin</dt><dd>Japan</dd><dt>Single gross weight (g)</dt><dd>750</dd><dt>Single package size</dt><dd>30x20x10 cm</dd></dl>');
    const attributes = await page.evaluate(readAlibabaAttributeRows);
    assert.equal(attributes.length, 3);
    const product = syncProductModel({ title: 'Paddle', attributes, packaging: packagingFromAttributes(attributes) });
    recordProductMutation(product, { origin: 'CC', packaging: { weight: '0.8' } });
    const prepared = preparePublishProduct(product);
    await page.setContent(`<div class="sell-catProp-item"><label>原产地</label><select><option value="">请选择</option><option value="CN">中国</option><option value="CC">科科斯（基林）群岛</option></select></div>
      <div id="struct-logistics"><label>包装重量<input></label><label>包装长<input></label><label>包装宽<input></label><label>包装高<input></label></div>`);
    assert.equal(await fillOriginCountry(page, prepared.origin), true);
    assert.equal(await page.locator('select').inputValue(), 'CC');
    assert.deepEqual(prepared.packaging, { weight: '0.8', length: '30', width: '20', height: '10' });
    assert.equal(await fillLogisticsFields(page, prepared.packaging), true);
    assert.deepEqual(await page.locator('#struct-logistics input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['0.8', '30', '20', '10']);
  } finally { await browser.close(); }
});

test('origin selects translated portal options and waits for committed tags instead of search text', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const rejected of [false, true]) {
      await page.setContent(`<div class="sell-catProp-item"><label>原产地</label><span class="next-select-values"></span><input role="combobox"></div>
        <div class="next-select-popup" style="display:none"><input><div role="listbox"></div></div>
        <script>(()=>{
        const trigger=document.querySelector('[role=combobox]'),popup=document.querySelector('.next-select-popup'),search=popup.querySelector('input'),list=popup.querySelector('[role=listbox]');
        trigger.onclick=()=>{popup.style.display='block';list.innerHTML='<div role="option">中国</div>';};
        search.oninput=()=>{list.innerHTML=search.value==='日本'?'<div role="option">日本</div>':'';};
        list.onclick=()=>{trigger.value='Japan';popup.style.display='none';${rejected ? '' : "setTimeout(()=>document.querySelector('.next-select-values').innerHTML='<em>日本</em>',150);"}};
        })();</script>`);
      assert.equal(await fillOriginCountry(page, 'Japan'), !rejected);
    }
    await page.setContent(`<div class="sell-catProp-item"><label>原产地</label><input readonly role="combobox"></div>
      <div role="listbox" style="display:none"><div role="option" data-value="CC">Cocos (Keeling) Islands</div></div>
      <script>const input=document.querySelector('input'),menu=document.querySelector('[role=listbox]');input.onclick=()=>menu.style.display='block';menu.onclick=()=>{input.value='CC';menu.style.display='none';};</script>`);
    assert.equal(await fillOriginCountry(page, 'CC'), true);
    assert.equal(await fillOriginCountry(page, 'China'), false);
    assert.equal(await page.locator('input').inputValue(), 'CC');
  } finally { await browser.close(); }
});
