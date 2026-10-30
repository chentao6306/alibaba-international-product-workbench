import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { attributeOptionMatchScore } from '../server/attribute-values.js';
import { bindSourceAttributesToPostingSchema, mergeSourceAttributes, readPostingAttributeSchema, sourceAttributeForField } from '../server/category-attributes.js';
import { categoryReadiness, categoryRequirementSchema } from '../server/category-readiness.js';
import { createRequiredFieldRepair, requiredAttributeKey } from '../server/publish-reference.js';
import { mergeSourceDataForPublish } from '../server/product-model.js';
import { applyReferencePreview, previewProductReference } from '../server/reference-workflow.js';
import { fillCategoryAttributes, recoverRequiredAttributes, requireCategoryAttributes, SellerPublisher } from '../server/publisher.js';

const watchAttributes = [
  { name: 'feature', value: 'Touchscreen, with earphone', source: 'dom' },
  { name: 'function', value: 'Activity Tracker, Heart Rate Tracker', source: 'dom' },
];
const watchFields = [
  { id: '191284141', label: '功能/特性', controlType: 'combobox', required: true, multiple: true },
  { id: '210194090', label: '功能', controlType: 'combobox', required: true, multiple: true },
];

test('keeps feature and function distinct through collection, enrichment, binding and readiness', () => {
  assert.notEqual(requiredAttributeKey('feature'), requiredAttributeKey('function'));
  for (const rows of [watchAttributes, [...watchAttributes].reverse()]) {
    const attributes = mergeSourceAttributes(rows);
    assert.equal(attributes.length, 2);
    const source = { categoryId: '127684037', attributes };
    const bound = bindSourceAttributesToPostingSchema(source, watchFields);
    assert.deepEqual(watchFields.map((field) => sourceAttributeForField(bound, field).value), watchAttributes.map((row) => row.value));
    assert.deepEqual(categoryReadiness(bound, categoryRequirementSchema(source.categoryId, watchFields)).conflicts, []);
    assert.equal(source.attributes.every((row) => !row.id), true);
  }
  const enriched = mergeSourceDataForPublish({ attributes: [watchAttributes[0]] }, { attributes: [watchAttributes[1]] });
  assert.equal(enriched.attributes.length, 2);
});

test('does not bind a broad alias over an exact observed property name or copy a different property ID', () => {
  const field = { id: '191288357', label: '用途', labels: ['用途', 'use'], controlType: 'combobox' };
  const attributes = [{ name: 'use', value: 'For drone', source: 'dom' }, { name: 'Usage', value: 'Rc car, Rc Boat', source: 'dom' }];
  const bound = bindSourceAttributesToPostingSchema({ attributes }, [field]);
  assert.equal(bound.attributes[0].id, field.id);
  assert.equal(bound.attributes[1].id, undefined);
  assert.equal(sourceAttributeForField(bound, field).value, 'For drone');
  const conflicting = bindSourceAttributesToPostingSchema({ attributes: [...attributes, { name: 'Use', value: 'Other', source: 'dom' }] }, [field]);
  assert.equal(sourceAttributeForField(conflicting, field).conflict, true);
  assert.equal(sourceAttributeForField({ attributes: [{ ...attributes[0], id: 'different' }] }, field), null);
});

test('only repairs the requested feature or function while preserving other attributes and commercial data', () => {
  const target = { attributes: watchAttributes, price: 29, stock: 3 };
  const reference = { attributes: [{ name: 'feature', value: 'Waterproof' }, { name: 'function', value: 'Music Player' }] };
  for (const [label, changedName, value] of [['功能/特性', 'feature', 'Waterproof'], ['功能', 'function', 'Music Player']]) {
    const before = structuredClone(target);
    const { patch, fields } = createRequiredFieldRepair(target, reference, [label]);
    assert.deepEqual(fields, [label]);
    assert.equal(patch.attributes.find((row) => row.name === changedName).value, value);
    assert.deepEqual(patch.attributes.find((row) => row.name !== changedName), target.attributes.find((row) => row.name !== changedName));
    assert.deepEqual(Object.keys(patch), ['attributes']);
    assert.deepEqual(target, before);
    const state = { products: [{ ...structuredClone(target), id: 'target', categoryId: '127684037', status: 'publish_failed', publishResult: { requiredFields: [label] } },
      { ...structuredClone(reference), id: 'reference', categoryId: '127684037', status: 'published' }], jobs: [] };
    const request = { ids: ['target'], referenceId: 'reference', options: { scope: 'failed-fields' } };
    const preview = previewProductReference(state, request);
    assert.deepEqual(state.products[0].attributes, target.attributes);
    applyReferencePreview(state, { ...request, previewToken: preview.token });
    assert.equal(state.products[0].attributes.find((row) => row.name === changedName).value, value);
    assert.deepEqual(state.products[0].attributes.find((row) => row.name !== changedName), target.attributes.find((row) => row.name !== changedName));
    assert.equal(state.products[0].price, 29);
    assert.equal(state.products[0].stock, 3);
  }
});

test('retains real conflicts within one property and never fills feature from function alone', () => {
  assert.equal(sourceAttributeForField({ attributes: [watchAttributes[1]] }, watchFields[0]), null);
  const duplicates = [...watchAttributes, { name: 'Feature', value: 'Waterproof', source: 'dom' }];
  assert.equal(sourceAttributeForField({ attributes: duplicates }, watchFields[0]).conflict, true);
  const identified = [{ ...watchAttributes[0], id: watchFields[0].id }, { ...watchAttributes[1], id: watchFields[1].id }];
  assert.equal(sourceAttributeForField({ attributes: identified }, watchFields[0]).value, watchAttributes[0].value);
  assert.equal(sourceAttributeForField({ attributes: identified }, watchFields[1]).value, watchAttributes[1].value);
});

test('reconciles a verified alternate screen unit without accepting inconsistent measurements', () => {
  const field = { id: '191288035', label: '屏幕尺寸', controlType: 'text', required: true };
  const attributes = [{ name: 'screen size', value: '11 inches(27.94cm)' }, { name: 'screen size', value: '11 inches' }, { name: 'Screen', value: '11" Capacitive Touch' }];
  const resolved = sourceAttributeForField({ attributes }, field);
  assert.equal(resolved.conflict, undefined);
  assert.ok(attributeOptionMatchScore(resolved.value, '11 inches') >= 90);
  assert.ok(attributeOptionMatchScore('11 inches(27.94cm)', '11 inches') >= 90);
  for (const value of ['11 inches(30cm)', '11 inches(27.94mm)', '12 inches', '11 inches / 12 inches']) {
    assert.equal(sourceAttributeForField({ attributes: [{ name: 'screen size', value: '11 inches' }, { name: 'screen size', value }] }, field).conflict, true, value);
  }
});

test('fills independent fields on Chinese category forms and validates every committed value', { skip: !findChromium(), timeout: 90000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-191284141"><label class="label required">功能/特性</label>
      <label><input type="checkbox">Touchscreen</label><label><input type="checkbox">with earphone</label></div>
      <div class="sell-catProp-item" id="struct-p-210194090"><label class="label required">功能</label>
      <label><input type="checkbox">Activity Tracker</label><label><input type="checkbox">Heart Rate Tracker</label></div>`);
    let product = bindSourceAttributesToPostingSchema({ attributes: watchAttributes }, await page.evaluate(readPostingAttributeSchema));
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema)).map((field) => field.values), [['Touchscreen', 'with earphone'], ['Activity Tracker', 'Heart Rate Tracker']]);
    await page.locator('#struct-p-210194090 input').first().uncheck();
    await assert.rejects(requireCategoryAttributes(page, product), (error) => error.unmatchedSourceFields.includes('功能'));
    await recoverRequiredAttributes(page, product, ['功能']);
    await requireCategoryAttributes(page, product);

    await page.setContent(`<div class="sell-catProp-item" id="struct-p-210196928"><label class="label">功能/特性</label><select multiple><option>Hard</option><option>Soft</option></select></div>
      <div class="sell-catProp-item" id="struct-p-191288035"><label class="label required">屏幕尺寸</label><input></div>`);
    product = { attributes: [{ name: 'feature', value: 'Hard' }, { name: 'Function', value: '5G/4G/WIFI/BT/FM/GPS/Record/rfid' },
      { name: 'screen size', value: ['11 inches', '11 inches(27.94cm)'] }] };
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, ['Hard']);
    await page.locator('select').selectOption([]);
    await fillCategoryAttributes(page, { attributes: [{ id: 'other-property', name: 'feature', value: 'Soft' }] });
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, []);
    await recoverRequiredAttributes(page, { attributes: [{ id: 'other-property', name: 'feature', value: 'Soft' }] }, ['功能/特性']);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, []);

    await page.setContent('<div class="sell-catProp-item" id="struct-p-191288357"><label class="label">用途</label><select><option value="">Choose</option><option>For drone</option></select></div>');
    product = { attributes: [{ name: 'use', value: 'For drone' }, { name: 'Usage', value: 'Rc car, Rc Boat' }] };
    product = bindSourceAttributesToPostingSchema(product, await page.evaluate(readPostingAttributeSchema));
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, ['For drone']);
  } finally { await browser.close(); }
});

test('the full stable-field writer does not borrow feature values for an unrelated function control', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<div class="sell-catProp-item" id="struct-p-373265001"><label class="label">功能</label><input name="p-373265001"></div>');
    const featureOnly = { attributes: [{ name: 'feature', value: 'Touchscreen' }] };
    await assert.rejects(SellerPublisher.prototype.fillStableProductFields.call({}, page, featureOnly), {
      code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED', fieldName: 'feature',
    });
    assert.equal(await page.locator('input').inputValue(), '');
    await page.setContent('<div class="sell-catProp-item" id="struct-p-191284141"><label class="label required">功能/特性</label><input></div><div class="sell-catProp-item" id="struct-p-373265001"><label class="label required">功能</label><input name="p-373265001"></div>');
    const product = { attributes: watchAttributes };
    await SellerPublisher.prototype.fillStableProductFields.call({}, page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema)).map((field) => field.values), watchAttributes.map((row) => [row.value]));
  } finally { await browser.close(); }
});
