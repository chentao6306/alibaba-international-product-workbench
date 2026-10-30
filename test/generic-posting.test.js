import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { extractAlibabaAttributes, readPostingAttributeSchema, bindSourceAttributesToPostingSchema, sourceAttributeForField } from '../server/category-attributes.js';
import { fillCategoryAttributes, fillLogisticsFields, fillDeliveryFields, requireLogisticsReady, attributeOptionMatchScore, validateProductData } from '../server/publisher.js';
import { readPostingLogistics, logisticsControlValue, fillLogisticsAttributes, capturePostingLogistics } from '../server/posting-logistics.js';
import { postingPageProblem } from '../server/posting-readiness.js';

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try { const page = await browser.newPage(); page.setDefaultTimeout(2000); await run(page); } finally { await browser.close(); }
});

test('binds previously unknown English properties before the form switches language without guessing ambiguous IDs', () => {
  const product = { attributes: [{ name: 'Unique Fabric Treatment', value: 'Steam' }, { id: 'existing', name: 'Type', value: 'A' }, { name: 'Ambiguous', value: 'B' }] };
  const schema = [{ id: '19', label: 'Unique Fabric Treatment' }, { id: '20', label: 'Ambiguous' }, { id: '21', label: 'Ambiguous' }];
  const bound = bindSourceAttributesToPostingSchema(product, schema);
  assert.equal(sourceAttributeForField(bound, { id: '19', label: '面料处理方法' }).value, 'Steam');
  assert.equal(bound.attributes[1].id, 'existing'); assert.equal(bound.attributes[2].id, undefined);
  assert.equal(product.attributes[0].id, undefined);
});

test('preserves unknown category option IDs from property lists without accepting object serialization as data', () => {
  const attrs = extractAlibabaAttributes({ nodeMap: { module_productProperties: { privateData: [
    { propertyId: 15, propertyName: 'Fabric Type', propertyValues: [{ propertyValueId: 99, propertyValueName: 'Woven' }] },
    { attributeId: 16, attributeName: 'Shelf Life', valueList: [{ attributeValueId: 21, attributeValueName: '6 months' }] },
    { name: 'Invalid', value: { wrong: 'not an attribute' } },
  ] } } });
  assert.equal(attrs.length, 2);
  assert.deepEqual(attrs[0].valueIds, { Woven: '99' });
  assert.deepEqual(attrs[1].valueIds, { '6 months': '21' });
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm', '该类目不在线上经营类目范围内，无法发品').code, 'PUBLISH_CATEGORY_NOT_AUTHORIZED');
});

browserTest('keeps distinct toy age properties and resolves translated theme through its verified property ID', async (page) => {
  await page.setContent('<div class="sell-catProp-item" id="struct-p-210194576"><label class="label required">适用年龄</label><input></div><div class="sell-catProp-item" id="struct-p-210240146"><label class="label">年龄范围</label><input></div><div class="sell-catProp-item" id="struct-p-200515261"><label class="label">场景</label><input></div>');
  const product = { attributes: [{ name: 'Age Range', value: '2 to 4 Years' }, { name: 'Age', value: '4-6Y' }, { name: 'Theme', value: 'Modern Buildings' }] };
  const fields = await page.evaluate(readPostingAttributeSchema);
  const bound = bindSourceAttributesToPostingSchema(product, fields);
  assert.deepEqual(fields.map(field => sourceAttributeForField(bound, field)?.value), ['4-6Y', '2 to 4 Years', 'Modern Buildings']);
  assert.equal(sourceAttributeForField({ attributes: [{ id: '210240146', name: 'Age', value: 'wrong property' }] }, fields[0]), null);
  await fillCategoryAttributes(page, bound);
  assert.deepEqual(await page.locator('input').evaluateAll(nodes => nodes.map(node => node.value)), ['4-6Y', '2 to 4 Years', 'Modern Buildings']);
});

browserTest('reads field component metadata past the wrapper fiber without leaking another property label', async (page) => {
  await page.setContent('<div class="sell-catProp-item" id="struct-p-700"><label class="label">陌生属性</label><input></div>');
  await page.locator('.sell-catProp-item').evaluate(node => {
    node.__reactFiberTest = { memoizedProps: { id: 'struct-p-700' }, return: { memoizedProps: { id: 'icbuCatProp', name: 'p-700', enName: 'Special Treatment' }, return: { memoizedProps: { name: 'p-701', label: 'Unrelated' } } } };
  });
  const [field] = await page.evaluate(readPostingAttributeSchema);
  assert.deepEqual(field.labels, ['陌生属性', 'Special Treatment']);
  assert.equal(sourceAttributeForField({ attributes: [{ name: 'Special Treatment', value: 'Steam' }] }, field)?.value, 'Steam');
});

test('does not treat months as years or silently increase inventory to satisfy MOQ', () => {
  assert.equal(attributeOptionMatchScore('4-6Y', '4-6M'), 0);
  assert.equal(attributeOptionMatchScore('4-6Y', '4-6 years'), 100);
  assert.equal(attributeOptionMatchScore('4-6 years', '4-6 months'), 0);
  const product = { stock: 100, priceTiers: [{ minQuantity: 180, price: 1.34 }] };
  assert.ok(validateProductData(product).some(text => text.includes('可售数量 100 小于最小起订量 180')));
  assert.ok(!validateProductData(product, { mode: 'draft' }).some(text => text.includes('可售数量')));
  assert.equal(product.stock, 100);
  const reference = { ...product, categoryReference: { sourceId: 'reference' }, variantGroups: [{ name: 'Color', options: ['Red', 'Blue'] }], skus: [{ stock: 90 }, { stock: 90 }, { stock: 1000, enabled: false }] };
  assert.ok(!validateProductData(reference).some(text => text.includes('可售数量')));
  reference.skus[1].enabled = false;
  assert.ok(validateProductData(reference).some(text => text.includes('可售数量 90 小于最小起订量 180')));
});

browserTest('opens a category text row only when a source value exists and commits it after blur', async (page) => {
  await page.setContent('<div class="sell-catProp-item" id="struct-p-200000552"><label class="label required">远程距离</label><div class="posting-field-multi-text"><button class="add-button">添加</button></div></div>');
  await page.locator('button').evaluate(button => {
    button.onclick = () => {
      const input = document.createElement('input');
      input.onblur = () => { input.dataset.committed = input.value; };
      button.before(input);
    };
  });
  await fillCategoryAttributes(page, {});
  assert.equal(await page.locator('input').count(), 0);
  await fillCategoryAttributes(page, { attributes: [{ name: 'Remote Distance', value: '20 m' }] });
  assert.equal(await page.locator('input').inputValue(), '20 m');
  assert.equal(await page.locator('input').getAttribute('data-committed'), '20 m');
});

browserTest('fills dynamically mounted food attributes after parent changes and ignores disabled requirements', async (page) => {
  await page.setContent(`<div data-property-id="10"><label class="label required">储存类型</label><select onchange="document.querySelector('#dependent').innerHTML='<div data-property-id=11><label class=label>保质期</label><input required></div>'"><option value="">Choose</option><option value="shelf">Shelf stable</option></select></div>
    <div id="dependent"></div><div data-property-id="12"><label class="label required">不参与填写</label><input required disabled></div>`);
  const mapped = await fillCategoryAttributes(page, { attributes: [{ id: '10', name: 'Storage Type', value: 'Shelf stable' }, { id: '11', name: 'Shelf Life', value: '6 months' }] });
  assert.deepEqual(mapped, ['Storage Type', 'Shelf Life']);
  assert.equal(await page.locator('#dependent input').inputValue(), '6 months');
  const schema = await page.evaluate(readPostingAttributeSchema);
  assert.equal(schema.find((field) => field.id === '12').disabled, true);
});

browserTest('searches portal dropdowns and verifies committed readonly values in a clothing category', async (page) => {
  await page.setContent(`<div data-attribute-id="71"><label class="label required">面料类型</label><input role="combobox" readonly></div>
    <div class="next-select-popup" style="display:none"><input placeholder="Search"><div role="listbox"></div></div>
    <script>const trigger=document.querySelector('[role=combobox]'),popup=document.querySelector('.next-select-popup'),search=popup.querySelector('input'),list=popup.querySelector('[role=listbox]');
    trigger.onclick=()=>popup.style.display='block';search.oninput=()=>list.innerHTML='<div role="option">Woven</div>';
    list.onclick=()=>{trigger.value='Woven';popup.style.display='none'};</script>`);
  assert.deepEqual(await fillCategoryAttributes(page, { attributes: [{ name: 'Fabric Type', value: 'Woven' }] }), ['Fabric Type']);
  assert.equal(await page.locator('[role=combobox]').inputValue(), 'Woven');
});

browserTest('fills every package card in its own units without changing net weight, samples or descriptions', async (page) => {
  await page.setContent(`<div class="sell-catProp-item"><label class="label required">Net weight</label><input value="200 g"></div>
    <label>Product description<input placeholder="weight and height" value="Description"></label>
    <div id="samplePackaging"><input name="pkgWeight" value="0.1"></div>
    <div id="struct-logistics"><label>Gross weight (g)<input required></label><label>Package length (mm)<input></label><label>Package width (cm)<input></label><label>Package height (cm)<input></label><label>Volume (m3)<input></label></div>
    <div id="pkgMeasure"><input><input><input></div>`);
  assert.equal(await fillLogisticsFields(page, { weight: 0.8, length: 30, width: 20, height: 10 }), true);
  assert.deepEqual(await page.locator('#struct-logistics input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['800', '300', '20', '10', '0.006']);
  assert.deepEqual(await page.locator('#pkgMeasure input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['30', '20', '10']);
  assert.equal(await page.locator('.sell-catProp-item input').inputValue(), '200 g');
  assert.equal(await page.locator('#samplePackaging input').inputValue(), '0.1');
  assert.equal(await page.locator('[placeholder]').inputValue(), 'Description');
  assert.equal((await page.evaluate(readPostingLogistics)).length, 8);
  assert.deepEqual((await capturePostingLogistics(page)).packaging, { weight: 0.8, length: 30, width: 20, height: 10 });
});

browserTest('preserves partial source packaging and reports its missing dependency before submission', async (page) => {
  await page.setContent('<div id="logistics"><input name="pkgWeight" required><input name="pkgLength" value="30"><input name="pkgWidth"><input name="pkgHeight"></div>');
  assert.equal(await fillLogisticsFields(page, { weight: '1' }), false);
  assert.equal(await page.locator('[name=pkgLength]').inputValue(), '30');
  assert.equal(await page.locator('[name=pkgWeight]').inputValue(), '1');
  await assert.rejects(requireLogisticsReady(page, { packaging: { weight: '1' } }), (error) => {
    assert.equal(error.code, 'PUBLISH_REQUIRED_DATA_MISSING');
    assert.deepEqual(error.missingSourceFields, ['包装宽', '包装高']); return true;
  });
  assert.equal(logisticsControlValue({ weight: '1-2kg' }, { key: 'weight', unit: 'kg' }), null);
});

browserTest('fills source lead time independently of missing packaging and preserves quantity boundaries', async (page) => {
  await page.setContent('<div id="struct-ladderPeriod" style="display:none"><input value="hidden"><input></div><div id="struct-ladderPeriod"><input value="1"><input></div><div id="pkgWeight"><input></div>');
  await fillDeliveryFields(page, [['Quantity (pieces)', '1 - 40', '> 40'], ['Lead time (days)', '12', 'To be negotiated']]);
  assert.deepEqual(await page.locator('#struct-ladderPeriod input:visible').evaluateAll(nodes => nodes.map(node => node.value)), ['40', '12']);
  assert.equal(await page.locator('#struct-ladderPeriod input').first().inputValue(), 'hidden');
  assert.equal(await page.locator('#pkgWeight input').inputValue(), '');
  await fillDeliveryFields(page, null);
  assert.equal(await page.locator('#struct-ladderPeriod input').last().inputValue(), '12');
});

browserTest('catches missing logistics when the empty value has no visible rectangle', async (page) => {
  await page.setContent('<div id="pkgWeight"><input name="pkgWeight" value="2"></div><div id="logisticsProperty"><span class="logistics-property-content" style="display:inline-block;width:0;height:0"></span><button>Add</button></div>');
  assert.equal(await page.locator('.logistics-property-content').isVisible(), false);
  await assert.rejects(requireLogisticsReady(page, { packaging: { weight: 2 } }), error => error.requiredFields.includes('物流属性') && error.missingSourceFields.includes('物流属性'));
});

browserTest('scrolls lazy lead-time controls into view before filling source delivery terms', async (page) => {
  await page.setContent('<div style="height:2400px"></div><div id="struct-ladderPeriod" style="height:100px">发货期</div><script>new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))document.querySelector("#struct-ladderPeriod").innerHTML="<input><input>"}).observe(document.querySelector("#struct-ladderPeriod"));</script>');
  await fillDeliveryFields(page, [['Quantity (pieces)', '1 - 40'], ['Lead time (days)', '12']]);
  assert.deepEqual(await page.locator('#struct-ladderPeriod input').evaluateAll(nodes => nodes.map(node => node.value)), ['40', '12']);
});

browserTest('selects only explicitly supplied logistics attributes and never defaults unknown goods to general cargo', async (page) => {
  await page.setContent(`<div id="logisticsProperty"><div class="logistics-property-content"></div><button onclick="document.querySelector('.product-attr-dialog').style.display='block'">添加</button></div>
    <div class="product-attr-dialog" style="display:none"><div class="tagWrapper"><div class="tag">普货</div><div class="tag">内置电池（锂电池）：单块电池≤100WH</div></div><button id="confirm">确认</button><button id="cancel">取消</button></div>
    <script>document.querySelectorAll('.tag').forEach(n=>n.onclick=()=>n.classList.toggle('isSelected'));
    document.querySelector('#confirm').onclick=()=>{document.querySelector('.logistics-property-content').textContent=[...document.querySelectorAll('.isSelected')].map(n=>n.textContent).join(';');document.querySelector('.product-attr-dialog').style.display='none'};
    document.querySelector('#cancel').onclick=()=>document.querySelector('.product-attr-dialog').style.display='none';</script>`);
  assert.equal(await fillLogisticsAttributes(page, {}), false);
  assert.equal(await page.locator('.product-attr-dialog').isVisible(), false);
  assert.equal(await fillLogisticsAttributes(page, { logisticsAttributes: ['内置电池（锂电池）：单块电池≤100WH'] }), true);
  assert.equal(await page.locator('.isSelected').textContent(), '内置电池（锂电池）：单块电池≤100WH');
  assert.deepEqual((await capturePostingLogistics(page)).logisticsAttributes, ['内置电池（锂电池）：单块电池≤100WH']);
  assert.equal(await fillLogisticsAttributes(page, { logisticsAttributes: ['Unknown'] }), false);
  assert.equal(await page.locator('.product-attr-dialog').isVisible(), false);
});
