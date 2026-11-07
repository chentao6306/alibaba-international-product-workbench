import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { planPublicAttributeTransfer, requirePublicAttributeValues } from '../server/attribute-transfer.js';
import { fillCustomAttributes, supplierCustomAttributes } from '../server/custom-attributes.js';
import { attributeFieldMatchesValue, preparePublishProduct } from '../server/publisher.js';
import { recordProductMutation, syncProductModel } from '../server/product-model.js';
import { createEditorForm, editorPayload } from '../src/product-editor-model.js';
import { buildLegacyDescriptionHtml, fillAndVerify, fillCategoryAttributes, requireCategoryAttributes, requirePublicAttributeTransfer, sanitizeCollectedProduct, sanitizeSourceDescriptionHtml } from '../server/publisher.js';

test('description contact cleanup preserves product and payment terms across collection and publishing', () => {
  const values = ['Telefone FM SOS Unlocked Dual Screen Senior Phone 2G with Button',
    'Telephone handset for industrial machinery', 'Smartphone with Whatsapp LTE 4G',
    'Skype compatible conference speaker', 'We accept Wechat Pay for samples',
    'Email notifications for warehouse controllers'];
  const html = values.map(value => `<p>${value}</p>`).join('')
    + '<p>Tel: +86 138 0012 3456</p><p>Wechat ID: supplier123</p><p>sales@example.com</p>';
  const collected = sanitizeCollectedProduct({ descriptionHtml: html });
  for (const result of [sanitizeSourceDescriptionHtml(html), collected.descriptionHtml, buildLegacyDescriptionHtml(collected)]) {
    for (const value of values) assert.ok(result.includes(value), value);
    assert.doesNotMatch(result, /138 0012 3456|supplier123|sales@example\.com/);
  }
});

test('plain descriptions do not absorb public attributes, specifications or packaging across categories', () => {
  for (const [name, value] of [['Chipset', 'MTK6261'], ['Weave', 'Twill'], ['Binding', 'Hardcover'], ['OE number', 'MD192815']]) {
    const product = { title: 'Product', description: 'Original paragraph\nSecond paragraph',
      attributes: [{ name, value }], variantGroups: [{ name: 'Size', options: ['XXL'] }], packaging: { weight: 0.3 } };
    const before = structuredClone(product);
    const html = buildLegacyDescriptionHtml(product);
    assert.match(html, /Original paragraph<br>Second paragraph/);
    assert.doesNotMatch(html, /<table|Available Specifications|0.3 kg|XXL/);
    assert.ok(!html.includes(value));
    assert.deepEqual(product, before);
  }
});

test('public attribute planning separates description and trade rows while retaining distinct property identities', () => {
  const product = { attributes: [
    { id: 'a', name: 'Material', value: 'Cotton', source: 'detailData.attributes' },
    { id: 'b', name: 'Material', value: 'Steel', source: 'detailData.attributes' },
    { name: 'Weave', value: 'Twill', isCustom: true },
    { name: 'Weave', value: 'Twill', source: 'dom' },
    { name: 'Description only', value: 'Paragraph', source: 'description-iframe' },
    { name: 'Single gross weight', value: '0.3 kg' },
    { name: 'Quantity (sets)', value: '5000' },
    { name: 'Lead time (days)', value: '45' },
  ] };
  const before = structuredClone(product);
  const plan = planPublicAttributeTransfer(product, [{ id: 'a', label: 'Material', values: ['Cotton'] }]);
  assert.equal(plan.standard.length, 1);
  assert.deepEqual(plan.fallback.map(row => [row.id, row.value]), [['b', 'Steel']]);
  assert.deepEqual(plan.custom.map(row => row.name), ['Weave', 'Material']);
  assert.deepEqual(product, before);
  assert.throws(() => planPublicAttributeTransfer({ attributes: [
    { id: 'a', name: 'Material', value: 'Cotton' }, { id: 'b', name: 'Material', value: 'Steel' },
  ] }, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  const cleared = { attributes: [{ name: 'Weave', value: 'Twill', isCustom: true }, { name: 'Weave', value: 'Twill', source: 'dom' }],
    customAttributes: [{ name: 'Weave', value: '' }] };
  assert.deepEqual(supplierCustomAttributes(cleared), []);
  assert.deepEqual(planPublicAttributeTransfer(cleared, []).custom, []);
});

test('localized native input and a distinct supplier input survive anonymous DOM copies without bypassing readback', () => {
  const product = { attributes: [
    { id: '210232495', name: 'input', value: '100-240V/0.3A', source: 'detailData.attributes' },
    { name: 'Input', value: 'AC100-240V 50/60HZ 0.3A', isCustom: true },
    { name: 'input', value: '100-240V/0.3A', source: 'dom' },
    { name: 'Input', value: 'AC100-240V 50/60HZ 0.3A', source: 'dom' },
  ] };
  const original = structuredClone(product);
  const field = { id: '210232495', label: '输入', hasValue: true, values: ['100-240V/0.3A'] };
  for (const attributes of [product.attributes, [...product.attributes].reverse()]) {
    const plan = planPublicAttributeTransfer({ attributes }, [field]);
    assert.equal(plan.standard.length, 2);
    assert.deepEqual(plan.custom.map(row => [row.name, row.value]), [['Input', 'AC100-240V 50/60HZ 0.3A']]);
    assert.equal(requirePublicAttributeValues(plan, (target, source) => target.values.includes(source.value)).length, 3);
    assert.throws(() => requirePublicAttributeValues(plan, () => false), /未被原生属性栏完整接收/);
  }
  assert.deepEqual(product, original);
  assert.throws(() => planPublicAttributeTransfer(product, []), /同名不同值/);
  const different = structuredClone(product); different.attributes[2].value = '220V/1A';
  assert.throws(() => planPublicAttributeTransfer(different, [field]), /同名不同值/);
});

test('editing price or description preserves compound origin in public attributes and the source snapshot', () => {
  const product = syncProductModel({ title: 'Replacement part', origin: 'China', price: '10',
    attributes: [{ id: '1', name: 'Place of Origin', value: 'Guangdong, China' }] });
  const snapshot = structuredClone(product.source.snapshot);
  const form = createEditorForm(product); form.price = '12'; form.description = 'Edited paragraph';
  recordProductMutation(product, editorPayload(form));
  const prepared = preparePublishProduct(product);
  assert.equal(prepared.origin, 'China');
  assert.equal(prepared.attributes.find(row => row.id === '1').value, 'Guangdong, China');
  const plan = planPublicAttributeTransfer(prepared, [{ id: '1', label: '产地' }]);
  assert.equal(plan.standard.length, 1);
  assert.ok(plan.custom.some(row => row.value === 'Guangdong, China'));
  assert.deepEqual(product.source.snapshot, snapshot);
  recordProductMutation(product, { origin: 'Japan' });
  assert.equal(preparePublishProduct(product).attributes.find(row => row.id === '1').value, 'Japan');
});

test('saving unrelated edits does not consume custom slots with a category summary across categories', () => {
  for (const leaf of ['Feature Phone', 'Dresses', 'Construction Machinery Parts', 'Books']) {
    const original = { title: 'Product', price: 10, productType: leaf, sourceCategoryPath: ['Catalog', leaf],
      attributes: [{ id: '1', name: 'Place of Origin', value: 'Guangdong, China' }],
      customAttributes: Array.from({ length: 10 }, (_, i) => ({ name: `Supplier ${i + 1}`, value: `Value ${i + 1}` })) };
    const form = createEditorForm(original); form.price = '12';
    const saved = editorPayload(form);
    assert.equal(saved.productType, leaf);
    assert.ok(!saved.attributes.some(row => row.name === 'Type'));
    const schema = [{ id: '1', label: '产地', hasValue: true, values: ['China'] },
      { id: '9', label: 'Province', hasValue: true, values: ['Guangdong'], controlType: 'select' }];
    const plan = planPublicAttributeTransfer(saved, schema);
    assert.equal(plan.custom.length, 10);
    assert.equal(plan.standard[0].source.value, 'Guangdong, China');
    const genuine = { ...original, attributes: [...original.attributes, { id: 'type', name: 'Type', value: leaf, source: 'detailData.attributes' }] };
    assert.ok(editorPayload(createEditorForm(genuine)).attributes.some(row => row.id === 'type' && row.value === leaf));
    assert.ok(createEditorForm({ productType: 'Manual subtype' }).attributes.some(row => row.name === 'Type' && row.value === 'Manual subtype'));
  }
});

test('complete native origin preserves ten supplier custom slots without hiding rejected or truncated values', () => {
  const product = { attributes: [{ id: '1', name: 'Place of Origin', value: 'Guangdong, China' },
    { name: 'place of origin', value: 'Guangdong, China', source: 'dom' }],
  customAttributes: Array.from({ length: 10 }, (_, i) => ({ name: `Supplier ${i + 1}`, value: `Value ${i + 1}` })) };
  const field = { id: '1', label: '产地', controlType: 'text', hasValue: true, values: ['Guangdong, China'] };
  const before = structuredClone(product);
  const plan = planPublicAttributeTransfer(product, [field]);
  assert.equal(plan.custom.length, 10);
  assert.equal(plan.standard.length, 2);
  assert.equal(requirePublicAttributeValues(plan, (target, source) => target.values.includes(source.value)).length, 12);
  assert.deepEqual(product, before);
  for (const rejected of [{ ...field, hasValue: false }, { ...field, disabled: true },
    { ...field, values: ['China'] }, { ...field, values: ['Zhejiang, China'] }]) {
    assert.equal(planPublicAttributeTransfer(product, [rejected]).fallback.length, 1);
  }
});

test('compound origin still needs a custom row when native province is absent, rejected or incomplete', () => {
  const origin = value => ({ attributes: [{ id: '1', name: 'Place of Origin', value }] });
  const country = { id: '1', label: '产地', hasValue: true, values: ['China'] };
  for (const region of [[], [{ id: '9', label: 'Province', hasValue: false, values: [] }],
    [{ id: '9', label: 'Province', hasValue: true, values: ['Zhejiang'] }],
    [{ id: '9', label: 'Province', hasValue: true, disabled: true, values: ['Guangdong'] }]]) {
    assert.equal(planPublicAttributeTransfer(origin('Guangdong, China'), [country, ...region]).custom.length, 1);
  }
  assert.equal(planPublicAttributeTransfer(origin('Shenzhen, Guangdong, China'), [country,
    { id: '9', label: 'Province', hasValue: true, values: ['Guangdong'] }]).custom.length, 1);
});

test('explicit province fills its dependent native field and is verified without carrying it to a different country', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="p-1"><div class="label">产地</div><select><option value="CN">China</option><option value="JP">Japan</option></select></div>'
      + '<div class="sell-catProp-item" id="p-9"><div class="label">省份</div><input></div>');
    const product = { origin: 'China', attributes: [{ id: '1', name: 'Place of Origin', value: 'China' },
      { id: '9', name: 'Province', value: 'Guangdong' }] };
    await fillCategoryAttributes(page, product);
    assert.equal(await page.locator('#p-9 input').inputValue(), 'Guangdong');
    assert.equal((await requirePublicAttributeTransfer(page, product)).length, 2);
    await page.locator('#p-9 input').fill('');
    await assert.rejects(requirePublicAttributeTransfer(page, product), { fieldName: 'Province' });
    await fillCategoryAttributes(page, { ...product, origin: 'Japan' });
    assert.equal(await page.locator('#p-9 input').inputValue(), '');
  } finally { await browser.close(); }
});

test('a combined source origin fills the optional province and detects a later dependent reset', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="p-1"><div class="label">产地</div><select><option>China</option></select></div>'
      + '<div class="sell-catProp-item" id="p-9"><div class="label">Province</div><select><option value="">Select</option><option>Guangdong</option><option>Zhejiang</option></select></div>');
    const product = { attributes: [{ id: '1', name: 'Place of Origin', value: 'Guangdong, China' }] };
    await fillCategoryAttributes(page, product);
    assert.equal(await page.locator('#p-9 select').inputValue(), 'Guangdong');
    await requireCategoryAttributes(page, product);
    await page.locator('#p-9 select').selectOption('Zhejiang');
    await assert.rejects(requireCategoryAttributes(page, product), error => error.requiredFields.includes('Province'));
  } finally { await browser.close(); }
});

test('public properties transfer to native standard or custom rows and are rechecked after dependent updates', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const [standard, value, extra, extraValue] of [
      ['Screen Size', '2.4', 'Chipset', 'MTK6261'], ['Material', 'Cotton', 'Weave', 'Twill'],
      ['Language', 'English', 'Binding', 'Hardcover'], ['Model Number', '4G63', 'Part finish', 'Polished'],
    ]) {
      await page.setContent(`<div class="sell-catProp-item" id="p-100"><div class="label">${standard}</div><input></div>
        <div id="customMoreProperty"><div class="list"></div><button class="add-attr-btn">Add</button></div>
        <script>document.querySelector('button').onclick=()=>document.querySelector('.list').insertAdjacentHTML('beforeend','<div class="item"><div class="attr-title"><input maxlength="30"></div><div class="attr-value"><input maxlength="80"></div></div>');</script>`);
      const product = { attributes: [{ id: '100', name: standard, value, source: 'detailData.attributes' },
        { name: extra, value: extraValue, source: 'dom', section: 'Product Attributes' }] };
      await fillCategoryAttributes(page, product);
      const plan = planPublicAttributeTransfer(product, await page.evaluate(readPostingAttributeSchema));
      await fillCustomAttributes(page, plan.product, fillAndVerify);
      const receipt = await requirePublicAttributeTransfer(page, product);
      assert.deepEqual(receipt.map(row => [row.name, row.destination]), [[standard, 'standard-attribute'], [extra, 'custom-attribute']]);
      await page.locator('#p-100 input').fill('');
      await assert.rejects(requirePublicAttributeTransfer(page, product), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED', fieldName: standard });
      assert.equal(planPublicAttributeTransfer(product, await page.evaluate(readPostingAttributeSchema)).fallback.length, 1,
        'A present but rejected field must not be disguised as a custom attribute');
      await page.locator('#p-100 input').fill(value);
      await page.locator('.attr-value input').fill('');
      await assert.rejects(requirePublicAttributeTransfer(page, product), { code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED' });
      await page.locator('.list').evaluate(node => node.remove());
      await page.locator('button').evaluate(node => node.disabled = true);
      await assert.rejects(fillCustomAttributes(page, plan.product, fillAndVerify, { timeoutMs: 250 }), /新增入口不可用或尚未加载/);
    }
  } finally { await browser.close(); }
});

test('retries a generated source fallback when the structured source value is available', () => {
  const product = { attributes: [{ id: 'writing-width', name: 'Writing width', value: '1.0 mm', source: 'detailData.attributes' }],
    customAttributes: [{ name: 'Writing width', value: '0.7 mm', isCustom: true, transferSource: 'public-attribute' }] };
  const plan = planPublicAttributeTransfer(product, [{ id: 'writing-width', label: 'Writing width', hasValue: true, values: ['1.0 mm'] }]);
  assert.deepEqual(plan.custom, []);
  assert.equal(plan.standard[0].source.value, '1.0 mm');
  const explicit = planPublicAttributeTransfer({ ...product, customAttributes: [{ name: 'Writing width', value: '0.7 mm', isCustom: true }] },
    [{ id: 'writing-width', label: 'Writing width', hasValue: true, values: ['1.0 mm'] }]);
  assert.equal(explicit.standard[0].source.value, '1.0 mm');
  assert.equal(explicit.custom[0].value, '0.7 mm');
});

test('resolved native duplicates stay removed through custom writer normalization while distinct user values survive', () => {
  for (const name of ['Color', 'Province']) {
    const product = { attributes: [{ id: '9', name, value: 'Source value' },
      { name, value: 'Source value', isCustom: true, source: 'dom' }],
    source: { snapshot: { attributes: [{ name, value: 'Source value', isCustom: true }] } } };
    const original = structuredClone(product);
    const schema = [{ id: '9', label: name, hasValue: true, values: ['Source value'] }];
    const plan = planPublicAttributeTransfer(product, schema);
    assert.deepEqual(plan.custom, []);
    assert.deepEqual(supplierCustomAttributes(plan.product), []);
    assert.deepEqual(product, original);

    const edited = { ...product, customAttributes: [{ name, value: 'User value', isCustom: true }] };
    const editedPlan = planPublicAttributeTransfer(edited, schema);
    assert.deepEqual(supplierCustomAttributes(editedPlan.product).map(row => row.value), ['User value']);
    assert.equal(editedPlan.standard[0].source.value, 'Source value');
  }
});

test('replaces a stale generated fallback with the current source when no native field exists', () => {
  const source = { id: 'writing-width', name: 'Writing width', value: '1.0 mm', source: 'detailData.attributes' };
  const stale = { name: 'Writing width', value: '0.7 mm', isCustom: true, transferSource: 'public-attribute' };
  for (const product of [
    { attributes: [source], customAttributes: [stale] },
    { attributes: [source, stale] },
    { attributes: [source], customAttributes: [{ ...stale, transferSource: undefined, source: 'dom' }] },
  ]) {
    const original = structuredClone(product);
    const plan = planPublicAttributeTransfer(product, []);
    assert.deepEqual(plan.fallback.map(row => row.value), ['1.0 mm']);
    assert.deepEqual(supplierCustomAttributes(plan.product).map(row => row.value), ['1.0 mm']);
    assert.deepEqual(product, original);
  }
  for (const custom of [{ ...stale, transferSource: undefined }, { ...stale, id: 'another-property' }]) {
    assert.throws(() => planPublicAttributeTransfer({ attributes: [source], customAttributes: [custom] }, []), /同名不同值/);
  }
});

test('native-covered Color and Province do not consume an eleventh slot during fill and final readback', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const [name, value] of [['Color', 'Black'], ['Province', 'Guangdong']]) {
      const custom = Array.from({ length: 10 }, (_, i) => ({ name: `Supplier ${i + 1}`, value: `Value ${i + 1}` }));
      const product = { attributes: [{ id: '9', name, value }, { name, value, isCustom: true, source: 'dom' }],
        customAttributes: custom };
      const original = structuredClone(product);
      await page.setContent(`<div class="sell-catProp-item" id="p-9"><div class="label">${name}</div><input value="${value}"></div>
        <div id="customMoreProperty">${custom.map(row => `<div class="item"><div class="attr-title"><input value="${row.name}"></div><div class="attr-value"><input value="${row.value}"></div></div>`).join('')}
        <button class="add-attr-btn" disabled>Add</button></div>`);
      const plan = planPublicAttributeTransfer(product, await page.evaluate(readPostingAttributeSchema));
      assert.equal((await fillCustomAttributes(page, plan.product, fillAndVerify)).length, 10);
      const receipt = await requirePublicAttributeTransfer(page, product);
      assert.equal(receipt.length, 11);
      assert.equal(receipt.find(row => row.name === name).destination, 'standard-attribute');
      assert.equal(await page.locator('#customMoreProperty .item').count(), 10);
      assert.deepEqual(product, original);
      await page.locator('#p-9 input').fill('');
      await assert.rejects(requirePublicAttributeTransfer(page, product), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED', fieldName: name });
    }
  } finally { await browser.close(); }
});

const widthCapture = () => ({ attributes: [
  { id: '222000154', name: 'Writing width', value: ['1.0mm(0.04in)', '1.0mm'], source: 'detailData.attributes' },
  { name: 'Writing width', value: '1.0mm(0.04in)', source: 'detailData.attributes' },
  { name: 'Writing width', value: '1.0mm(0.04in)', source: 'dom' },
  { name: 'Writing width', value: '1.0mm', source: 'dom' },
] });

test('verifies one complete identified array instead of its duplicate captured fragments against native text', () => {
  const product = widthCapture();
  const original = structuredClone(product);
  for (const labels of [['书写粗细'], ['书写粗细', 'Writing width']]) {
    const field = { id: '222000154', label: '书写粗细', labels, controlType: 'text', hasValue: true,
      values: ['1.0mm(0.04in), 1.0mm'] };
    for (const attributes of [product.attributes, [...product.attributes].reverse()]) {
      const plan = planPublicAttributeTransfer({ attributes }, [field]);
      assert.equal(plan.standard.length, 1);
      assert.deepEqual(plan.custom, []);
      assert.equal(requirePublicAttributeValues(plan, (target, source) => attributeFieldMatchesValue(target, source.value)).length, 1);
      const rejected = planPublicAttributeTransfer({ attributes }, [{ ...field, values: ['0.7mm'] }]);
      assert.throws(() => requirePublicAttributeValues(rejected, (target, source) => attributeFieldMatchesValue(target, source.value)),
        { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
    }
  }
  assert.deepEqual(product, original);
});

test('preserves the entire identified source array in one custom fallback regardless of capture order', () => {
  const product = widthCapture();
  for (const attributes of [product.attributes, [...product.attributes].reverse()]) {
    const plan = planPublicAttributeTransfer({ attributes }, []);
    assert.equal(plan.fallback.length, 1);
    assert.equal(plan.fallback[0].id, '222000154');
    assert.deepEqual(plan.fallback[0].value, ['1.0mm(0.04in)', '1.0mm']);
    assert.deepEqual(supplierCustomAttributes(plan.product).map(row => row.value), ['1.0mm(0.04in), 1.0mm']);
  }
});

test('does not merge ambiguous identities, user-edited fragments or different facts into an identified array', () => {
  const product = widthCapture();
  const field = { id: '222000154', label: 'Writing width', controlType: 'text', hasValue: true,
    values: ['1.0mm(0.04in), 1.0mm'] };
  const differentId = { ...product, attributes: [...product.attributes,
    { id: 'another-property', name: 'Writing width', value: '0.7mm', source: 'detailData.attributes' }] };
  assert.throws(() => planPublicAttributeTransfer(differentId, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  const ambiguousPlan = planPublicAttributeTransfer(differentId, [field]);
  assert.ok(ambiguousPlan.standard.length > 1, 'Anonymous fragments cannot identify one of two property IDs');
  const manual = { ...product, attributes: [...product.attributes, { name: 'Writing width', value: '1.0mm', source: 'manual' }] };
  assert.equal(planPublicAttributeTransfer(manual, [field]).standard.length, 2);
  assert.throws(() => planPublicAttributeTransfer(manual, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  const edited = { ...product, customAttributes: [{ name: 'Writing width', value: '0.7mm', isCustom: true, source: 'manual' }] };
  assert.equal(planPublicAttributeTransfer(edited, [field]).custom[0].value, '0.7mm');
  assert.throws(() => planPublicAttributeTransfer(edited, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  for (const source of ['dom', 'detailData.attributes']) {
    const different = { ...product, attributes: [...product.attributes, { name: 'Writing width', value: '0.7mm', source }] };
    for (const attributes of [different.attributes, [...different.attributes].reverse()]) {
      assert.throws(() => planPublicAttributeTransfer({ attributes }, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
    }
  }
});

test('normalized specification case passes the final public attribute readback while different colors fail', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="struct-specification"><div id="p-100008179"><span class="label">Body Color</span><input role="colorCombobox" value="Green"></div></div>');
    const product = { attributes: [{ id: '100008179', name: 'Body Color', value: 'green', source: 'detailData.attributes' }] };
    const receipt = await requirePublicAttributeTransfer(page, product);
    assert.equal(receipt[0].destination, 'specification');
    assert.deepEqual(receipt[0].committedValues, ['Green']);
    await page.locator('input').fill('Blue');
    await assert.rejects(requirePublicAttributeTransfer(page, product), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  } finally { await browser.close(); }
});
