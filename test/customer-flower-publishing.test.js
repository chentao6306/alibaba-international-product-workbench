import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { mergeSourceAttributes } from '../server/category-attributes.js';
import { planPublicAttributeTransfer } from '../server/attribute-transfer.js';
import { fillCustomAttributes, requireCustomAttributes, customAttributePostingName } from '../server/custom-attributes.js';
import { createRequiredFieldRepair } from '../server/publish-reference.js';
import { fillAndVerify, fillDeliveryFields } from '../server/publisher.js';

const interfaceRow = { name: 'Further analysis & research about this product', value: 'Calculate the cost and margin', source: 'dom', section: 'Product Attributes' };

test('buyer analysis widgets are excluded from fresh collection and old saved products without removing supplier facts', () => {
  const material = { id: '238736366', name: 'material', value: 'Silk', source: 'detailData.attributes' };
  const product = { attributes: [material, interfaceRow], source: { snapshot: { attributes: [material, interfaceRow] } } };
  const before = structuredClone(product);
  assert.deepEqual(mergeSourceAttributes(product.attributes), [material]);
  const plan = planPublicAttributeTransfer(product, [{ id: material.id, label: '材质' }]);
  assert.equal(plan.standard.length, 1);
  assert.deepEqual(plan.custom, []);
  assert.deepEqual(product, before);
  const genuine = { ...interfaceRow, source: 'manual' };
  assert.deepEqual(mergeSourceAttributes([genuine]), [genuine]);
});

test('referenced flower fields retain verified property identity through translated success receipts', () => {
  const reference = { attributes: [{ id: '100001801', name: 'Flower Type', value: 'Rose' }],
    requiredAttributes: [{ name: '花的种类', value: 'Rose' }] };
  const result = createRequiredFieldRepair({ attributes: [] }, reference, ['花的种类']);
  assert.equal(result.patch.attributes[0].id, '100001801');
  assert.equal(planPublicAttributeTransfer(result.patch, [{ id: '100001801', label: 'Flower Type' }]).custom.length, 0);
  assert.equal(customAttributePostingName('类型'), 'Type');
  assert.throws(() => customAttributePostingName('无法确认的中文名称'), { code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED' });
});

test('known referenced Chinese names publish as English and custom validation is checked before submit', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="customMoreProperty"><div class="item"><div class="attr-title"><input value="类型"></div><div class="attr-value"><input></div></div><div class="next-form-item-help" style="display:none"></div></div>`);
    const product = { attributes: [{ name: '类型', value: 'Artificial Flowers', source: 'reference-published-product' }] };
    const before = structuredClone(product);
    const plan = planPublicAttributeTransfer(product, []);
    const accepted = await fillCustomAttributes(page, plan.product, fillAndVerify);
    assert.deepEqual(accepted.map(item => [item.name, item.postingName]), [['类型', 'Type']]);
    assert.equal(await page.locator('.attr-title input').inputValue(), 'Type');
    assert.equal(await page.locator('.attr-value input').inputValue(), 'Artificial Flowers');
    assert.deepEqual(product, before);
    await page.locator('.next-form-item-help').evaluate(node => { node.textContent = '属性名不符合要求'; node.style.display = 'block'; });
    await assert.rejects(requireCustomAttributes(page, plan.product), /校验未通过/);
    await page.locator('.attr-title input').fill('');
    await page.locator('.attr-value input').fill('');
    await assert.rejects(fillCustomAttributes(page, { customAttributes: [{ name: 'A'.repeat(41), value: 'Real source value' }] }, fillAndVerify), /40 字符限制/);
  } finally { await browser.close(); }
});

test('all delivery tiers are created, committed after blur, restored after resets and stale extra rows removed', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-ladderPeriod"><div class="rows"></div><button class="add" role="btn-add">+ 增加数量区间</button></div>
      <script>window.committed=[];const rows=document.querySelector('.rows');function add(){rows.insertAdjacentHTML('beforeend','<div class="row"><input><input><button role="remove" onclick="this.parentElement.remove()">删除</button></div>');rows.querySelectorAll('input').forEach(n=>n.onblur=()=>window.committed=[...rows.querySelectorAll('input')].map(i=>i.value));}document.querySelector('.add').onclick=add;add();</script>`);
    const source = [['Quantity (pieces)', '1 - 12', '13 - 800', '> 800'], ['Lead time (days)', '7', '15', 'To be negotiated']];
    const before = structuredClone(source);
    await fillDeliveryFields(page, source);
    assert.deepEqual(await page.evaluate(() => window.committed), ['12', '7', '800', '15']);
    await page.locator('.rows input').nth(2).fill('30');
    await fillDeliveryFields(page, source);
    assert.equal(await page.locator('.rows input').nth(2).inputValue(), '800');
    await fillDeliveryFields(page, [['Quantity', '1 - 15', '> 15'], ['Days', '5', 'To be negotiated']]);
    assert.deepEqual(await page.locator('.rows input').evaluateAll(nodes => nodes.map(n => n.value)), ['15', '5']);
    assert.deepEqual(source, before);
    await page.locator('.add').evaluate(node => node.disabled = true);
    await assert.rejects(fillDeliveryFields(page, source), { code: 'PUBLISH_DELIVERY_REJECTED' });
  } finally { await browser.close(); }
});
