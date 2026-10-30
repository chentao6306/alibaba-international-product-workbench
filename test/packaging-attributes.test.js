import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { extractAlibabaAttributes, mergeSourceAttributes, readPostingAttributeSchema, sourceAttributeForField, bindSourceAttributesToPostingSchema } from '../server/category-attributes.js';
import { planPublicAttributeTransfer } from '../server/attribute-transfer.js';
import { supplierCustomAttributes } from '../server/custom-attributes.js';
import { fillCategoryAttributes, requireCategoryAttributes, requirePublicAttributeTransfer } from '../server/publisher.js';
import { createRequiredFieldRepair, createPublishedReferenceTemplate } from '../server/publish-reference.js';

const useField = { id: '19421-19427', label: '具体用途', labels: ['具体用途', 'Use'], multiple: true, controlType: 'combobox' };

test('repairs specific Use from a published reference without overwriting or borrowing general Usage', () => {
  const target = { categoryId: '201268985', attributes: [{ name: 'Usage', value: 'package', isCustom: true }] };
  const reference = { attributes: [
    { id: '19421-19427', name: 'Use', value: ['Essential Oil', 'Perfume'] },
    { name: 'Usage', value: 'package', isCustom: true },
  ] };
  const before = structuredClone({ target, reference });
  const repair = createRequiredFieldRepair(target, reference, ['具体用途']);
  assert.ok(repair);
  assert.deepEqual(repair.fields, ['具体用途']);
  assert.deepEqual(repair.patch.attributes[0], target.attributes[0]);
  assert.deepEqual(sourceAttributeForField({ ...target, ...repair.patch }, useField).value, ['Essential Oil', 'Perfume']);
  assert.deepEqual({ target, reference }, before);
  for (const name of ['Usage', 'Purpose', 'Application']) {
    assert.equal(createRequiredFieldRepair(target, { attributes: [{ name, value: 'package', isCustom: true }] }, ['具体用途']), null);
  }
  const template = createPublishedReferenceTemplate({ ...reference, publishResult: {
    status: 'published', requiredAttributes: [{ name: '具体用途', value: 'Essential Oil' }],
  } });
  assert.deepEqual(template.attributes.find(a => a.name === 'Usage'), reference.attributes[1]);
  assert.equal(template.attributes.find(a => a.id === '19421-19427').value, 'Essential Oil');
});

test('verifies duplicate Application captures against Application rather than the separate Usage property', () => {
  const product = { attributes: [
    { id: '139', name: 'Application', value: 'Bottle Seal, Essential Oil Bottle', source: 'detailData.attributes' },
    { id: '191288006', name: 'Usage', value: 'Bottles', source: 'detailData.attributes' },
    { name: 'Application', value: 'Bottle Seal, Essential Oil Bottle', source: 'dom' },
    { name: 'Usage', value: 'Bottles', source: 'dom' },
  ] };
  const fields = [{ id: '139', label: '应用', labels: ['应用', 'Application'] },
    { id: '191288006', label: '用途', labels: ['用途', 'Usage'] }];
  const plan = planPublicAttributeTransfer(product, fields);
  assert.equal(plan.standard.length, 4);
  assert.deepEqual(plan.standard.map(row => row.fields.map(field => field.id)), [['139'], ['191288006'], ['139'], ['191288006']]);
  assert.equal(mergeSourceAttributes(product.attributes).length, 2);
});

test('preserves distinct supplier Application and Usage rows even when their values are identical', () => {
  // Public plastic-bottle attributes have both native ID rows and named,
  // ID-less custom rows. Both names must survive collection and reopening.
  const data = { nodeMap: { module_sorted_attribute: { privateData: { attributes: [
    { id: 19421, attribute: 'Industrial Use', value: 'Medicine' },
    { attribute: 'Usage', value: 'package' },
    { attribute: 'Application', value: 'package' },
  ] } } } };
  const attributes = extractAlibabaAttributes(data);
  const reopened = JSON.parse(JSON.stringify({ attributes: mergeSourceAttributes(attributes,
    [{ name: 'Usage', value: 'package', source: 'dom' }, { name: 'Application', value: 'package', source: 'dom' }]) }));
  assert.deepEqual(supplierCustomAttributes(reopened).map(row => [row.name, row.value]), [['Usage', 'package'], ['Application', 'package']]);
  assert.equal(sourceAttributeForField(reopened, useField), null, 'General packaging text is not a specific cosmetic use');
  const plan = planPublicAttributeTransfer(reopened, [{ id: '19421', label: '行业应用' }, useField]);
  assert.deepEqual(plan.standard.map(row => row.source.name), ['Industrial Use']);
  assert.deepEqual(plan.custom.map(row => row.name), ['Usage', 'Application']);
  assert.equal(JSON.stringify(data).includes('isCustom'), false, 'Extraction does not mutate the source');
});

test('resolves dependent Use by its complete path or exact terminal ID without borrowing Application or a different branch', () => {
  const origin = { id: '1', name: 'Place of Origin', value: 'Zhejiang, China' };
  assert.equal(sourceAttributeForField({ attributes: [origin] }, { id: '1-1', label: 'Province', labels: ['Province'] }), null,
    'A repeated numeric subfield index is not the country property ID');
  for (const id of ['19427', '19421-19427']) {
    const source = { id, name: 'Use', value: ['Essential Oil', 'Perfume'], valueIds: { 'Essential Oil': 'oil' } };
    const resolved = sourceAttributeForField({ attributes: [source] }, useField);
    assert.equal(resolved.matchedById, true);
    assert.deepEqual(resolved.value, source.value);
    assert.deepEqual(resolved.valueIds, source.valueIds);
  }
  for (const id of ['19421', 'other', '900-19427']) {
    assert.equal(sourceAttributeForField({ attributes: [{ id, name: 'Use', value: 'Essential Oil' }] }, useField), null);
  }
  const product = { attributes: [{ name: 'Use', value: 'Essential Oil' }, { name: 'Application', value: 'Liquid packaging' }, { name: 'Usage', value: 'Liquid packaging' }] };
  const bound = bindSourceAttributesToPostingSchema(product, [useField]);
  assert.equal(bound.attributes[0].id, useField.id);
  assert.equal(bound.attributes[1].id, undefined);
  assert.equal(bound.attributes[2].id, undefined);
  for (const name of ['Application', 'Usage', 'Purpose']) {
    const plan = planPublicAttributeTransfer({ attributes: [{ name, value: 'Liquid packaging' }] }, [useField]);
    assert.equal(plan.standard.length, 0);
    assert.equal(plan.custom[0].name, name);
  }
  assert.equal(sourceAttributeForField({ attributes: [{ name: '具体用途', value: 'Essential Oil' }] }, useField).value, 'Essential Oil');
});

test('fills a late-mounted packaging Use field and detects subsequent parent resets with all supplied values intact', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-19421"><label class="label required">行业应用</label>
      <select><option value="">Choose</option><option>Cosmetic</option><option>Medicine</option></select></div><div id="dependent"></div>
      <div class="sell-catProp-item" id="struct-p-19423"><label class="label">瓶身材料</label><input></div>
      <script>document.querySelector('select').onchange=()=>setTimeout(()=>{
        document.querySelector('#dependent').innerHTML='<div class="sell-catProp-item" id="struct-p-19421-19427"><label class="label required">具体用途</label><select multiple><option value="oil">Essential Oil</option><option value="perfume">Perfume</option><option value="cream">Face Cream</option></select></div>';
        document.querySelector('#struct-p-19423 input').value='';
      },100)</script>`);
    const product = { attributes: [{ id: '19421', name: 'Industrial Use', value: 'Cosmetic' },
      { id: '19427', name: 'Use', value: ['Essential Oil', 'Perfume'], valueIds: { 'Essential Oil': 'oil', Perfume: 'perfume' } },
      { id: '19423', name: 'Body Material', value: 'PET' }] };
    const original = structuredClone(product);
    await fillCategoryAttributes(page, product);
    const schema = await page.evaluate(readPostingAttributeSchema);
    const use = schema.find(field => field.id === useField.id);
    assert.ok(use);
    assert.ok(use.labels.includes('Use'));
    assert.deepEqual(use.values, ['Essential Oil', 'Perfume']);
    const missingUse = { attributes: product.attributes.filter(item => item.name !== 'Use') };
    await page.locator('#struct-p-19421-19427 select').selectOption([]);
    await assert.rejects(requireCategoryAttributes(page, missingUse), error => {
      assert.equal(error.code, 'PUBLISH_REQUIRED_DATA_MISSING');
      assert.deepEqual(error.missingSourceFields, ['具体用途']);
      assert.equal(error.diagnostics.dependencies[0].parentValues[0], 'Cosmetic');
      assert.match(error.message, /未找到可匹配当前选项/);
      assert.doesNotMatch(error.message, /重新采集/);
      return true;
    });
    await fillCategoryAttributes(page, product);
    assert.equal(await page.locator('#struct-p-19423 input').inputValue(), 'PET');
    await requireCategoryAttributes(page, product);
    const transfers = await requirePublicAttributeTransfer(page, product);
    assert.equal(transfers.find(row => row.name === 'Use').targetId, useField.id);
    await page.locator('#struct-p-19421 select').selectOption('Medicine');
    await page.waitForTimeout(150);
    await assert.rejects(requireCategoryAttributes(page, product), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual(product, original);
  } finally { await browser.close(); }
});
