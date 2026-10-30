import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { attributeValueList } from '../server/attribute-values.js';
import { bindSourceAttributesToPostingSchema, extractAlibabaAttributes, mergeSourceAttributes, readPostingAttributeSchema, sourceAttributeForField } from '../server/category-attributes.js';
import { mergeSourceDataForPublish } from '../server/product-model.js';
import { categoryRequirementSchema, postingSchemaWithKnownLabels, CATEGORY_SCHEMA_MAX_AGE_MS } from '../server/category-readiness.js';
import { attributeFieldMatchesValue, fillCategoryAttributes, fillChoice, requireCategoryAttributes } from '../server/publisher.js';

const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try { const page = await browser.newPage(); page.setDefaultTimeout(2000); await run(page, t); } finally { await browser.close(); }
});

test('preserves distinct same-name property IDs and ambiguous DOM rows in either collection order', () => {
  const a = { id: '1', name: 'Treatment', value: 'Steam', source: 'detailData.attributes' };
  const b = { id: '2', name: 'Treatment', value: 'Coated', source: 'detailData.attributes' };
  const dom = { name: 'Treatment', value: 'Printed', source: 'dom' };
  for (const rows of [[a, b, dom], [b, a, dom], [dom, a, b], [a, dom, b]]) {
    const merged = mergeSourceAttributes(rows);
    assert.equal(merged.length, 3);
    assert.equal(sourceAttributeForField({ attributes: merged }, { id: '1', label: 'Treatment' }).value, 'Steam');
    assert.equal(sourceAttributeForField({ attributes: merged }, { id: '2', label: 'Treatment' }).value, 'Coated');
    assert.equal(merged.find((item) => !item.id).value, 'Printed');
  }
  const merged = mergeSourceAttributes([{ name: 'Type', value: 'Motor', section: 'Key attributes' }, { name: 'Type', value: 'Accessory', section: 'Custom attributes' }]);
  assert.equal(merged.length, 2);
  assert.equal(sourceAttributeForField({ attributes: merged }, { label: 'Type', controlType: 'select' }).conflict, true);
  const enriched = mergeSourceDataForPublish({ attributes: [a, b] }, { attributes: [dom] });
  assert.equal(enriched.attributes.length, 3);
  assert.deepEqual(enriched.attributes.slice(0, 2), [a, b]);
});

test('prefers a uniquely exact field name when broad aliases cover two real properties', () => {
  const schema = [{ id: '1', label: 'Type' }, { id: '2', label: 'Product Type' }];
  const bound = bindSourceAttributesToPostingSchema({ attributes: [{ name: 'Type', value: 'A' }, { name: 'Product Type', value: 'B' }] }, schema);
  assert.deepEqual(bound.attributes.map((item) => item.id), ['1', '2']);
  const ambiguous = bindSourceAttributesToPostingSchema({ attributes: [{ name: 'Type', value: 'A' }] }, [{ id: '1', label: 'Type' }, { id: '2', label: 'Type' }]);
  assert.equal(ambiguous.attributes[0].id, undefined);
});

test('reuses observed bilingual names only within a fresh matching leaf and property ID', () => {
  const capturedAt = '2026-09-21T00:00:00.000Z';
  const product = { categoryId: '100', attributes: [{ name: 'Unlisted Fabric Treatment', value: 'Steam' }],
    postingRequirements: categoryRequirementSchema('100', [{ id: '55', label: 'Unlisted Fabric Treatment', required: true, multiple: true }], capturedAt) };
  const current = [{ id: '55', label: '面料处理', required: false, multiple: false, controlType: 'select' }];
  const time = Date.parse(capturedAt) + 1000;
  const resolved = postingSchemaWithKnownLabels(product, current, time);
  assert.deepEqual(resolved[0].labels, ['面料处理', 'Unlisted Fabric Treatment']);
  assert.equal(resolved[0].required, false);
  assert.equal(resolved[0].multiple, false);
  assert.equal(bindSourceAttributesToPostingSchema(product, resolved).attributes[0].id, '55');
  assert.deepEqual(postingSchemaWithKnownLabels({ ...product, categoryId: '101' }, current, time), current);
  assert.deepEqual(postingSchemaWithKnownLabels(product, current, time + CATEGORY_SCHEMA_MAX_AGE_MS), current);
  assert.deepEqual(postingSchemaWithKnownLabels(product, [{ ...current[0], id: '56' }], time), [{ ...current[0], id: '56' }]);
});

test('splits any multi-value attribute while preserving literal labels, punctuation and option IDs', () => {
  assert.deepEqual(attributeValueList('Cotton, Wool'), ['Cotton', 'Wool']);
  assert.deepEqual(attributeValueList('Cotton, linen blend', { options: ['Cotton, linen blend'] }), ['Cotton, linen blend']);
  assert.deepEqual(attributeValueList('Indoor (dry, ventilated); Outdoor'), ['Indoor (dry, ventilated)', 'Outdoor']);
  assert.deepEqual(attributeValueList('1,000 W, 2,000 W'), ['1,000 W', '2,000 W']);
  assert.deepEqual(attributeValueList('A, B', { valueIds: { 'A, B': '10' } }), ['A, B']);
  assert.deepEqual(attributeValueList('A, B', { multiple: false }), ['A, B']);
  const f = { label: 'Unlisted Fabric Property', controlType: 'checkbox', multiple: true, options: [{ label: 'Cotton' }, { label: 'Wool' }] };
  const p = { attributes: [{ name: f.label, value: 'Cotton, Wool' }, { name: f.label, value: ['Wool', 'Cotton'] }] };
  assert.equal(sourceAttributeForField(p, f).conflict, undefined);
  assert.equal(sourceAttributeForField({ attributes: [...p.attributes, { name: f.label, value: 'Silk' }] }, f).conflict, true);
  assert.equal(attributeFieldMatchesValue({ ...f, values: ['Cotton'] }, 'Cotton, Wool'), false);
});

test('compares measurements for arbitrary property names without collapsing real multi-selection or numeric model codes', () => {
  for (const [name, range, point] of [['Rated Thermal Power', '30-50 W', '35 W'], ['Wall Gauge', '0.4-0.8 mm', '0.5 mm'], ['Storage Life', '3-9 months', '6 months'], ['Fluid Capacity', '500-900 ml', '750 ml']]) {
    const attributes = [{ name, value: range }, { name, value: point }];
    assert.equal(sourceAttributeForField({ attributes }, { label: name, controlType: 'select' }).value, point);
    assert.equal(sourceAttributeForField({ attributes: [{ name, value: [range, point] }] }, { label: name, controlType: 'multiSelect', multiple: true }).value.length, 2);
  }
  assert.equal(sourceAttributeForField({ attributes: [{ name: 'Model', value: '100-200' }, { name: 'Model', value: '123' }] }, { label: 'Model', controlType: 'select' }).conflict, true);
  assert.equal(sourceAttributeForField({ attributes: [{ name: 'Material', value: ['Cotton', 'Wool'] }] }, { label: 'Material', controlType: 'select', multiple: false }).conflict, true);
});

browserTest('maps unknown fields by observed IDs across different category forms from collection through readback', async (page, t) => {
  const fixtures = [
    ['Clothing', 'Fabric Finish', '面料整理', ['Brushed', 'Printed'], 'checkbox', ['Brushed', 'Printed', 'Coated']],
    ['Food', 'Storage Life', '存储期限', '6 months', 'select', ['3-9 months', '12 months']],
    ['Industrial Parts', 'Wall Gauge', '管壁厚度', '0.5 mm', 'select', ['0.4-0.8 mm', '5 mm']],
    ['Lighting', 'Rated Thermal Power', '额定功率', '35 W', 'select', ['30-50 W', '350 W']],
    ['Packaging', 'Fluid Capacity', '容积', '750 ml', 'select', ['500-900 ml', '100 ml']],
    ['Furniture', 'Surface Texture', '表面纹理', 'Smooth', 'radio', ['Smooth', 'Rough']],
    ['Toys', 'Play Setting', '玩耍场景', ['Indoor', 'Outdoor'], 'multiSelect', ['Indoor', 'Outdoor', 'Pool']],
    ['Machinery', 'Model Code', '设备型号', 'MX-12A', 'select', ['MX-12A', 'MX-12B']],
    ['Sports', 'Grip Finish', '握柄表面', 'Textured', 'select', ['Textured', 'Smooth']],
    ['Textiles', 'Blend Description', '混纺名称', 'Cotton, linen blend', 'checkbox', ['Cotton, linen blend', 'Wool']],
    ['Household', 'Use Environment', '使用环境', 'Indoor (dry, ventilated)', 'radio', ['Indoor (dry, ventilated)', 'Outdoor']],
    ['Accessories', 'Print Technique', '图案工艺', 'Laser', 'text', []],
  ];
  for (const [index, [category, name, label, value, type, options]] of fixtures.entries()) {
    await t.test(category, async () => {
      const id = String(50000 + index);
      const attrs = extractAlibabaAttributes({ globalData: { product: { properties: [{ propertyId: id, propertyName: name, value }] } } });
      const body = ['select', 'multiSelect'].includes(type)
        ? `<select ${type === 'multiSelect' ? 'multiple' : ''}><option value="">Choose</option>${options.map((option, i) => `<option value="${i + 1}">${escape(option)}</option>`).join('')}</select>`
        : type === 'text' ? '<input>' : options.map((option, i) => `<label><input type="${type}" name="choice" value="${i + 1}">${escape(option)}</label>`).join('');
      await page.setContent(`<div class="sell-catProp-item" id="struct-p-${id}"><label class="label required">${label}</label>${body}</div>`);
      const product = { attributes: attrs };
      const copy = structuredClone(product);
      await fillCategoryAttributes(page, product);
      await requireCategoryAttributes(page, product);
      const [f] = await page.evaluate(readPostingAttributeSchema);
      assert.equal(attributeFieldMatchesValue(f, value), true);
      assert.deepEqual(product, copy);
    });
  }
});

browserTest('keeps literal comma options in portal controls and respects explicit single-selection', async (page) => {
  await page.setContent(`<div class="sell-catProp-item" id="struct-p-900"><label class="label required">Fabric Blend</label>
    <div class="next-select next-select-multiple"><div class="next-select-values"></div><input readonly role="combobox"></div></div>
    <div class="next-select-popup" hidden><div role="option">Cotton, linen blend</div><div role="option">Wool</div></div>
    <script>const input=document.querySelector('input'),menu=document.querySelector('.next-select-popup');input.onclick=()=>{menu.hidden=false;input.setAttribute('aria-expanded','true')};
    menu.onclick=e=>{if(e.target.matches('[role=option]')){document.querySelector('.next-select-values').insertAdjacentHTML('beforeend','<em>'+e.target.textContent+'</em>')}};
    document.onkeydown=e=>{if(e.key==='Escape'){menu.hidden=true;input.setAttribute('aria-expanded','false')}};</script>`);
  const product = { attributes: [{ id: '900', name: 'Fabric Blend', value: ['Cotton, linen blend', 'Wool'] }] };
  await fillCategoryAttributes(page, product);
  await requireCategoryAttributes(page, product);
  assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, ['Cotton, linen blend', 'Wool']);
  await page.locator('.next-select').evaluate((node) => node.className = 'next-select next-select-single');
  const [field] = await page.evaluate(readPostingAttributeSchema);
  assert.equal(field.multiple, false);
  assert.equal(await fillChoice(page, page.locator('input'), ['Cotton', 'Wool']), false);
});

browserTest('rejects an optional source value that disappears after a dependent control changes', async (page) => {
  await page.setContent('<div data-property-id="10"><label class="label">Fabric Treatment</label><select><option value="">Choose</option><option>Steam</option></select></div>');
  const product = { attributes: [{ id: '10', name: 'Fabric Treatment', value: 'Steam' }] };
  await fillCategoryAttributes(page, product);
  await requireCategoryAttributes(page, product);
  await page.locator('select').selectOption('');
  await assert.rejects(requireCategoryAttributes(page, product), (error) => error.unmatchedSourceFields.includes('Fabric Treatment'));
  await requireCategoryAttributes(page, {});
});
