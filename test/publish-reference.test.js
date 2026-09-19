import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { createRequiredFieldRepair, findPublishedReferenceRepair } from '../server/publish-reference.js';
import { requiredLabelsFromError, classifyAlibabaActionResult, inferRequiredAttributeValue, visibleEmptyAttributeLabels } from '../server/publisher.js';

test('repairs only the failed attributes and preserves all target commercial content', () => {
  const target = { id: 'target', title: 'Source phone', categoryId: '201896803', price: 23,
    descriptionHtml: '<p>Source detail</p>', mainImages: ['source.jpg'],
    skus: [{ price: 23, image: 'sku.jpg' }],
    attributes: [{ name: 'screen', value: 'unsupported value' }, { name: 'battery capacity', value: '6000mAh' }],
    customAttributes: [{ name: '屏幕尺寸', value: 'unsupported value' }] };
  const before = structuredClone(target);
  const reference = { title: 'Reference phone', price: 999, mainImages: ['reference.jpg'],
    attributes: [{ name: '屏幕', value: '6.6"' }, { name: '电池容量', value: '5000mAh' }],
    requiredAttributes: [{ name: '屏幕', value: '6.8"' }] };
  const repair = createRequiredFieldRepair(target, reference, ['屏幕尺寸', '商品名称', '价格', '商品图片']);
  assert.deepEqual(target, before);
  assert.deepEqual(Object.keys(repair.patch), ['attributes', 'customAttributes']);
  assert.equal(repair.patch.attributes[0].value, '6.8"');
  assert.equal(repair.patch.customAttributes[0].value, '6.8"');
  assert.equal(repair.patch.attributes[1].value, '6000mAh');
});

test('chooses a usable successful snapshot from the exact category and skips drafts', () => {
  const target = { id: 'target', categoryId: '201896803', attributes: [] };
  const attrs = [{ name: '屏幕', value: '6.8"' }];
  const candidates = [
    { id: 'draft', categoryId: target.categoryId, status: 'drafted', attributes: attrs },
    { id: 'wrong', categoryId: '201346401', status: 'published', attributes: attrs },
    { id: 'empty', categoryId: target.categoryId, status: 'published', attributes: [] },
    { id: 'history', categoryId: '201346401', attributes: [], publishHistory: [
      { categoryId: target.categoryId, data: { categoryId: target.categoryId, attributes: attrs }, result: { status: 'published' } }
    ] }
  ];
  const repair = findPublishedReferenceRepair(target, candidates, ['屏幕尺寸']);
  assert.equal(repair.referenceId, 'history');
  assert.equal(repair.patch.attributes[0].value, '6.8"');
  assert.equal(findPublishedReferenceRepair(target, candidates, ['屏幕'], ['history']), null);
});

test('does not reuse the target itself, empty values, or unknown categories', () => {
  const target = { id: 'same', categoryId: '201896803' };
  assert.equal(findPublishedReferenceRepair(target, [{ ...target, status: 'published', attributes: [{ name: '屏幕', value: '6.8"' }] }], ['屏幕']), null);
  assert.equal(createRequiredFieldRepair(target, { attributes: [{ name: '屏幕', value: '' }] }, ['屏幕']), null);
  assert.equal(findPublishedReferenceRepair({ id: 'target' }, [{ id: 'reference', status: 'published', attributes: [{ name: '屏幕', value: '6.8"' }] }], ['屏幕']), null);
});

test('extracts concrete missing fields and rejects quota failures as success', () => {
  assert.deepEqual(requiredLabelsFromError('属性[Type] 必须填写\n商品属性：[类型] 必须填写'), ['Type', '类型']);
  assert.deepEqual(requiredLabelsFromError('属性[Logo printing] 必须填写\n商品属性：[Logo印刷] 必须填写'), ['Logo printing', 'Logo印刷']);
  assert.deepEqual(requiredLabelsFromError('屏幕尺寸必填项不能为空；电池容量必填项不能为空'), ['屏幕尺寸', '电池容量']);
  assert.deepEqual(requiredLabelsFromError('提交后未检测到国际站成功反馈：类型必填项不能为空;商品图片项必填项不能为空'), ['类型']);
  assert.deepEqual(requiredLabelsFromError('Battery capacity cannot be empty; Screen size is required'), ['Battery capacity', 'Screen size']);
  assert.equal(classifyAlibabaActionResult({ mode: 'submit', feedback: ['审核中'], bodyText: '您发布的产品总量已超出限制。' }).succeeded, false);
});

test('does not infer a propeller diameter as a screen size from supplier boilerplate', () => {
  assert.equal(inferRequiredAttributeValue({ title: '17 Inch Drone Propeller', description: 'We also sell smartphones' }, '屏幕'), '');
  assert.equal(inferRequiredAttributeValue({ productType: 'Drones Accessories', variantGroups: [
    { name: 'type', options: ['Propeller Blades'] },
  ] }, '类型', 'product type'), 'Propeller Blades');
});

test('extracts only the invalid field from a section containing other valid fields', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <section class="error-section">
        <div class="sell-catProp-item"><label>电池容量</label><input value="6000-6999mAh"></div>
        <div class="sell-catProp-item"><label>蜂窝频段</label><input><span class="error">必填项不能为空</span></div>
      </section>
      <section class="error-summary"><label>物流信息</label><div>蜂窝频段必填项不能为空</div></section>
      <div><label>材质</label><input><span class="invalid">required</span></div>
      <div hidden class="sell-catProp-item"><label>屏幕</label><input><span class="error">必填项不能为空</span></div>
    `);
    assert.deepEqual(await visibleEmptyAttributeLabels(page), ['蜂窝频段', '材质']);
  } finally {
    await browser.close();
  }
});
