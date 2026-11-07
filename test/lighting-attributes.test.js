import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { sourceAttributeForField } from '../server/category-attributes.js';
import { planPublicAttributeTransfer, requirePublicAttributeValues } from '../server/attribute-transfer.js';
import { customAttributePostingName, fillCustomAttributes, supplierCustomAttributes } from '../server/custom-attributes.js';
import { requiredAttributeKey } from '../server/publish-reference.js';
import { attributeFieldMatchesValue, fillAndVerify, requirePublicAttributeTransfer } from '../server/publisher.js';

const source = () => ({ id: '100100', name: 'Body Material', value: ['Iron', 'Glass', 'Crystal'], source: 'detailData.attributes' });
const field = () => ({ id: '100100', label: '灯体材质', values: ['Iron, Glass, Crystal'], hasValue: true, controlType: 'text' });

test('lighting capture fragments and comma-joined views preserve one complete identified material property', () => {
  for (const value of ['Iron', 'Iron, Glass', 'Iron，Glass；Crystal', ['Glass', 'Crystal']]) {
    for (const captureSource of ['dom', 'detailData.attributes']) {
      const original = [source(), { name: 'Body Material', value, source: captureSource }];
      for (const attributes of [original, [...original].reverse()]) {
        const product = { attributes, source: { snapshot: { attributes: structuredClone(attributes) } } };
        const before = structuredClone(product);
        const native = planPublicAttributeTransfer(product, [field()]);
        assert.equal(native.standard.length, 1);
        assert.equal(requirePublicAttributeValues(native, (target, item) => attributeFieldMatchesValue(target, item.value)).length, 1);
        const fallback = planPublicAttributeTransfer(product, []);
        assert.deepEqual(fallback.custom.map(row => row.value), [source().value]);
        assert.deepEqual(supplierCustomAttributes(fallback.product).map(row => row.value), ['Iron, Glass, Crystal']);
        assert.deepEqual(product, before);
      }
    }
  }
});

test('lighting normalization never absorbs manual edits, different property IDs or unknown material facts', () => {
  for (const extra of [
    { name: 'Body Material', value: 'Iron, Glass', source: 'manual' },
    { id: '200200', name: 'Body Material', value: 'Iron, Glass', source: 'detailData.attributes' },
    { name: 'Body Material', value: 'Iron, Wood', source: 'dom' },
    { name: 'Body Material', value: 'Iron/Glass', source: 'dom' },
  ]) {
    assert.throws(() => planPublicAttributeTransfer({ attributes: [source(), extra] }, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  }
  const product = { attributes: [source()], customAttributes: [{ name: 'Body Material', value: 'Iron, Glass', source: 'manual' }] };
  assert.throws(() => planPublicAttributeTransfer(product, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  assert.equal(planPublicAttributeTransfer(product, [field()]).custom[0].value, 'Iron, Glass');
  const punctuation = { id: '100100', name: 'Body Material', value: ['Brass (Cu, Zn)', 'Glass'], source: 'detailData.attributes' };
  assert.throws(() => planPublicAttributeTransfer({ attributes: [punctuation,
    { name: 'Body Material', value: 'Brass (Cu', source: 'dom' }] }, []), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
});

test('shade color has its own bilingual identity and never becomes body color', () => {
  for (const name of ['Shade Color', 'Shade Colour', '灯罩颜色']) assert.equal(requiredAttributeKey(name), '灯罩颜色');
  assert.equal(customAttributePostingName('灯罩颜色'), 'Shade Color');
  for (const name of ['Body Color', 'Body Colour', 'Color', '颜色', '灯体颜色']) {
    assert.notEqual(requiredAttributeKey(name), requiredAttributeKey('灯罩颜色'));
    assert.equal(sourceAttributeForField({ attributes: [{ name, value: 'Black' }] }, { label: '灯罩颜色' }), null);
  }
  assert.equal(sourceAttributeForField({ attributes: [{ name: 'Shade Colour', value: 'White' }] }, { label: '灯罩颜色' }).value, 'White');
  assert.equal(sourceAttributeForField({ attributes: [{ id: 'different', name: 'Shade Color', value: 'White' }] }, { id: 'shade', label: '灯罩颜色' }), null);
});

test('referenced lighting design style and total lamp power retain distinct names and explicit watts', () => {
  assert.equal(customAttributePostingName('设计风格'), 'Design Style');
  assert.equal(customAttributePostingName('灯具总功率(瓦)'), 'Total Lamp Power (W)');
  assert.equal(customAttributePostingName('灯具总功率（瓦）'), 'Total Lamp Power (W)');
  assert.equal(requiredAttributeKey('Design Style'), requiredAttributeKey('设计风格'));
  assert.notEqual(requiredAttributeKey('Style'), requiredAttributeKey('设计风格'));
  for (const name of ['Lamp Power', 'Bulb Power', 'Power', 'Wattage', '单灯功率', '额定功率']) {
    assert.notEqual(requiredAttributeKey(name), requiredAttributeKey('灯具总功率(瓦)'));
    assert.equal(sourceAttributeForField({ attributes: [{ name, value: '10' }] }, { label: '灯具总功率(瓦)' }), null);
  }
  const product = { attributes: [
    { name: '设计风格', value: 'Modern', source: 'reference-published-product' },
    { name: '灯具总功率(瓦)', value: '100', source: 'reference-published-product' },
  ] };
  const plan = planPublicAttributeTransfer(product, []);
  assert.deepEqual(plan.custom.map(row => [customAttributePostingName(row.name), row.value]), [['Design Style', 'Modern'], ['Total Lamp Power (W)', '100']]);
  assert.throws(() => customAttributePostingName('未知灯具描述'), { code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED' });
});

test('lighting custom fallback keeps every material and posts the separate shade name in English', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="customMoreProperty"><div class="rows"></div><button class="add-attr-btn">Add</button></div>
      <script>document.querySelector('button').onclick=()=>document.querySelector('.rows').insertAdjacentHTML('beforeend','<div class="item"><div class="attr-title"><input maxlength="40"></div><div class="attr-value"><input></div></div>');</script>`);
    const product = { attributes: [source(), { name: 'Body Material', value: 'Iron, Glass', source: 'dom' },
      { name: '灯罩颜色', value: 'White', source: 'dom' }], customAttributes: [{ name: 'Body Color', value: 'Black' }] };
    const before = structuredClone(product);
    const plan = planPublicAttributeTransfer(product, []);
    await fillCustomAttributes(page, plan.product, fillAndVerify);
    const receipt = await requirePublicAttributeTransfer(page, product);
    assert.deepEqual(await page.locator('.attr-title input').evaluateAll(nodes => nodes.map(node => node.value)), ['Body Color', 'Body Material', 'Shade Color']);
    assert.equal(receipt.find(row => row.name === 'Body Material').value.join(', '), 'Iron, Glass, Crystal');
    assert.deepEqual(product, before);
    await page.locator('.attr-value input').nth(1).fill('Iron');
    await assert.rejects(requirePublicAttributeTransfer(page, product), { code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED' });
  } finally { await browser.close(); }
});
