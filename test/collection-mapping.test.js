import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { extractAlibabaAttributes, packagingFromAttributes, readPostingAttributeSchema, sourceAttributeForField } from '../server/category-attributes.js';
import { collectSourceAttributeSections } from '../server/source-attributes.js';
import { attachCategoryRequirements, categoryReadiness, categoryRequirementSchema, rememberCategoryRequirements, CATEGORY_SCHEMA_MAX_AGE_MS } from '../server/category-readiness.js';
import { chooseAttributeOption, fillCategoryAttributes, fillChoice, requireCategoryAttributes } from '../server/publisher.js';
import { JsonStore } from '../server/store.js';
import { recordProductMutation, syncProductModel } from '../server/product-model.js';

const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

test('preserves units and partial option IDs without assigning a parent ID to unrelated values', () => {
  const attributes = extractAlibabaAttributes({ nodeMap: { module_attributes: { privateData: [
    { name: 'Single gross weight', value: 750, unit: 'g' },
    { name: 'Feature', id: 12, valueId: 999, values: [{ name: 'A', id: 1 }, { name: 'B' }] },
  ] } } });
  assert.equal(attributes[0].value, '750 g');
  assert.equal(attributes[0].rawValue, '750');
  assert.deepEqual(packagingFromAttributes(attributes), { weight: '0.75' });
  assert.deepEqual(attributes[1].valueIds, { A: '1' });
});

test('uses current IDs or a unique label, rejecting disabled and equally plausible choices', () => {
  const options = [{ value: 'new', label: '8000-8999 mAh' }, { value: 'b', label: '6000-6999 mAh' }];
  assert.equal(chooseAttributeOption(options, '8000 mAh', 'old').value, 'new');
  assert.equal(chooseAttributeOption(options, '未翻译', 'b').value, 'b');
  assert.equal(chooseAttributeOption([...options, { value: 'c', label: '7500-8500 mAh' }], '8000 mAh'), null);
  assert.equal(chooseAttributeOption([{ ...options[0], disabled: true }], '8000 mAh', 'new'), null);
});

test('records only leaf-specific baseline requirements and recomputes readiness after editing', () => {
  const schema = categoryRequirementSchema('100', [
    { id: '1', label: '原产地', required: true, values: ['Other product origin'] },
    { id: '2', label: '是否可定制', required: true },
    { id: '3', label: '颜色', required: true, saleSpecification: true },
    { id: '4', label: '隐藏要求', required: true, disabled: true },
  ]);
  const state = { products: [{ categoryId: '100', origin: 'China', attributes: [] }, { categoryId: '101', origin: 'China' }] };
  rememberCategoryRequirements(state, schema);
  const product = state.products[0];
  assert.equal(schema.fields.length, 2);
  assert.equal(JSON.stringify(schema).includes('Other product origin'), false);
  assert.deepEqual(categoryReadiness(product).missing, ['是否可定制']);
  recordProductMutation(product, { attributes: [{ id: '2', name: 'is_customized', value: false }] });
  assert.equal(product.quality.categoryReadiness.status, 'covered');
  assert.equal(state.products[1].postingRequirements, undefined);
  assert.equal(categoryReadiness(product, schema, Date.parse(schema.capturedAt) + CATEGORY_SCHEMA_MAX_AGE_MS + 1).status, 'stale');
  recordProductMutation(product, { categoryId: '101' });
  attachCategoryRequirements(product, state.postingSchemas);
  assert.equal(product.postingRequirements, undefined);
  assert.equal(categoryReadiness(product).status, 'unchecked');
});

test('captures lazy packaging and expanded attributes without navigating or reading recommendations', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-testid="module-attribute-group"><div><span>Material</span><span>Plastic</span></div>
      <button onclick="this.remove();setTimeout(()=>document.querySelector('[data-testid]').insertAdjacentHTML('beforeend','<div><span>Age Range</span><span>3-6 years</span></div>'),350)">Show more</button></div>
      <div style="height:1200px"></div><div data-module-name="module_productPackInfo" aria-busy="true" style="height:100px"></div>
      <div data-module-name="module_recommend"><table><tr><td>Material</td><td>Gold</td></tr></table></div>
      <script>const section=document.querySelector('[data-module-name=module_productPackInfo]');new IntersectionObserver(entries=>{
        if(entries.some(entry=>entry.isIntersecting)&&!section.dataset.started){section.dataset.started='1';setTimeout(()=>{
          section.innerHTML='<div><span>Single gross weight</span><span>750 g</span></div>';section.setAttribute('aria-busy','false');},650);}
      }).observe(section);</script>`);
    const result = await collectSourceAttributeSections(page, { timeoutMs: 5500 });
    assert.equal(result.evidence.settled, true);
    assert.equal(result.attributes.find((item) => item.name === 'Age Range')?.value, '3-6 years');
    assert.deepEqual(packagingFromAttributes(result.attributes), { weight: '0.75' });
    assert.equal(result.attributes.some((item) => item.value === 'Gold'), false);
    await page.setContent('<div data-testid="module-attribute-group" aria-busy="true"><div><span>Type</span><span>Toy</span></div></div>');
    assert.equal((await collectSourceAttributeSections(page, { timeoutMs: 1600 })).evidence.settled, false);
    await assert.rejects(collectSourceAttributeSections(page, { shouldStop: () => true }), { code: 'COLLECT_PAUSED' });
  } finally { await browser.close(); }
});

test('maps saved source data into ten distinct category forms and verifies committed values', { skip: !findChromium() }, async (t) => {
  const fixtures = [
    ['Phones', 'Battery Capacity', '电池容量', '8000 mAh', ['8000-8999 mAh', '6000-6999 mAh']],
    ['Clothing', 'Fabric Type', '面料类型', 'Cotton', ['Cotton', 'Linen']],
    ['Bread', 'Shelf Life', '保质期', '6 months', ['6 months', '12 months']],
    ['Toy Cars', 'Age Range', '年龄范围', ['3-6 years', '7-12 years'], ['3-6岁', '7-12岁', '0-3岁']],
    ['Construction Toys', 'Number of Pieces', '组合产品数量', '73', ['73', '100']],
    ['Drones', 'Waterproof', '防水', false, ['No', 'Yes']],
    ['Cameras', 'Resolution', '分辨率', '640x512', ['640x512', '1280x720']],
    ['Furniture', 'Material', '材质', 'Wood', ['Wood', 'Plastic']],
    ['Industrial Parts', 'Custom category property', '陌生类目属性', 'English source option', ['本类目中文选项', '其他选项']],
    ['Packaging', 'Thickness', '厚度', '0.5 mm', ['0.5 mm', '5 mm']],
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-mapping-'));
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const [index, [category, sourceName, label, value, options]] of fixtures.entries()) {
      await t.test(category, async () => {
        const propertyId = String(900 + index), categoryId = String(10000 + index);
        const valueId = index === 8 ? 'opt-0' : 'obsolete-source-id';
        const attributes = extractAlibabaAttributes({ nodeMap: { module_product_attributes: { privateData: [
          { id: propertyId, attributeName: sourceName, attributeValues: [value].flat().map((name, i) => ({ name, id: index === 8 ? valueId : `${valueId}-${i}` })) },
        ] } } });
        store.update((state) => state.products.push(syncProductModel({ id: categoryId, categoryId, attributes, origin: 'China' }, { captureSource: true })));
        const saved = new JsonStore(path.join(root, 'workspace.json')).read().products.find((product) => product.id === categoryId);
        await page.setContent(`<div class="sell-catProp-item" id="struct-p-${propertyId}"><div class="label required">${label}</div>
          <select ${Array.isArray(value) ? 'multiple' : ''}><option value="">请选择</option>${options.map((option, i) => `<option value="opt-${i}">${escape(option)}</option>`).join('')}</select></div>`);
        await fillCategoryAttributes(page, saved);
        await requireCategoryAttributes(page, saved);
        const expected = index === 3 ? options.slice(0, 2) : [options[0]];
        assert.deepEqual(await page.locator('select').evaluate((node) => [...node.selectedOptions].map((option) => option.textContent)), expected);
        assert.deepEqual(saved.attributes, attributes, 'Mapping never rewrites the saved source attributes');
      });
    }
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('replaces stale checkbox selections and refuses conflicting source values', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-12"><div class="label required">Age Range</div>
      <label><input type="checkbox" value="new">3-6 years</label><label><input type="checkbox" value="old" checked>0-3 years</label></div>`);
    assert.equal(await fillChoice(page, page.locator('input').first(), ['3-6 years'], { valueIds: { '3-6 years': 'stale' }, minimumScore: 90 }), true);
    assert.deepEqual(await page.locator('input').evaluateAll((nodes) => nodes.map((node) => node.checked)), [true, false]);
    const product = { attributes: [{ id: '12', name: 'Age Range', value: '3-6 years' }], customAttributes: [{ id: '12', name: 'Age Range', value: '0-3 years' }] };
    assert.equal(sourceAttributeForField(product, { id: '12', label: 'Age Range' }).conflict, true);
    assert.deepEqual(await fillCategoryAttributes(page, product), []);
    await assert.rejects(requireCategoryAttributes(page, product), (error) => error.conflictingSourceFields.includes('Age Range'));
    const schema = categoryRequirementSchema('100', await page.evaluate(readPostingAttributeSchema));
    assert.deepEqual(categoryReadiness({ ...product, categoryId: '100' }, schema).conflicts, ['Age Range']);
  } finally { await browser.close(); }
});

test('commits Other custom text for dropdowns and mixed checkboxes and rejects Other without an input', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-1"><div class="label required">Brand Name</div>
      <select onchange="this.nextElementSibling.hidden=this.value!=='other'"><option value="">Select</option><option value="other">Other</option></select><input hidden></div>
      <div class="sell-catProp-item" id="struct-p-2"><div class="label required">Material</div>
      <label><input type="checkbox" value="composite">Composite</label><label><input type="checkbox" value="other" onchange="document.querySelector('#material-custom').hidden=!this.checked">Other</label><input id="material-custom" hidden></div>
      <div class="sell-catProp-item" id="struct-p-3"><div class="label required">Type</div><select><option value="">Select</option><option value="other">Other</option></select></div>`);
    const product = { attributes: [{ id: '1', name: 'Brand Name', value: 'T-Motor' }, { id: '2', name: 'Material', value: ['Composite', 'Polymer+CF'] }] };
    assert.deepEqual(await fillCategoryAttributes(page, product), ['Brand Name', 'Material']);
    const schema = await page.evaluate(readPostingAttributeSchema);
    assert.deepEqual(schema[0].values, ['T-Motor']);
    assert.deepEqual(schema[1].values, ['Composite', 'Polymer+CF']);
    await page.locator('#struct-p-3 select').selectOption('');
    assert.equal(await fillChoice(page, page.locator('#struct-p-3 select'), 'Dual channel'), false);
    assert.equal(await page.locator('#struct-p-3 select').inputValue(), '');

    await page.setContent(`<div class="sell-catProp-item" id="struct-p-4"><div class="label required">Output Voltage</div><div class="next-select">
      <input readonly role="combobox" onclick="document.querySelector('[role=listbox]').hidden=false"><span class="next-select-values"></span></div>
      <input id="custom-voltage" hidden></div><div role="listbox" hidden><div role="option" data-value="other">Other</div></div>
      <script>document.querySelector('[role=option]').onclick=()=>{document.querySelector('.next-select-values').innerHTML='<em>Other</em>';document.querySelector('#custom-voltage').hidden=false;document.querySelector('[role=listbox]').hidden=true;};</script>`);
    assert.equal(await fillChoice(page, page.locator('[role=combobox]'), '50.4V'), true);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, ['50.4V']);
    await requireCategoryAttributes(page, { attributes: [{ id: '4', name: 'Output Voltage', value: '50.4V' }] });
  } finally { await browser.close(); }
});
