import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { planPublicAttributeTransfer } from '../server/attribute-transfer.js';
import { customAttributePostingName, fillCustomAttributes, readCustomAttributes, requireCustomAttributes } from '../server/custom-attributes.js';
import { fillAndVerify, requirePublicAttributeTransfer } from '../server/publisher.js';

const sourceName = 'provide mould making and sample making service';
const postingName = 'Mould making and sample making service';
const attribute = { id: '323283557', name: sourceName, value: 'sample making',
  source: 'detailData.attributes', section: 'module_sorted_attribute' };

test('uses an equivalent short name only for the identified mould and sample service label', () => {
  assert.equal(customAttributePostingName(sourceName), postingName);
  assert.equal(customAttributePostingName(sourceName.toUpperCase()), postingName);
  for (const name of ['Material', 'Body Material', 'Writing width', 'Usage', 'Flower Type',
    'provide mould making and sample making service cost', 'A'.repeat(41)]) {
    assert.equal(customAttributePostingName(name), name);
  }
});

test('retains native property identity when the target category has the original service field', () => {
  const product = { attributes: [attribute] }, before = structuredClone(product);
  const plan = planPublicAttributeTransfer(product, [{ id: attribute.id, label: '模具和样品制作服务' }]);
  assert.equal(plan.standard.length, 1);
  assert.deepEqual(plan.custom, []);
  assert.deepEqual(product, before);
});

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="customMoreProperty"><div class="item">
      <div class="attr-title"><input maxlength="40"></div><div class="attr-value"><input maxlength="80"></div>
      </div><button class="add-attr-btn" onclick="window.additions++">Add</button></div>
      <script>window.additions=0;window.committed={};
      document.querySelectorAll('input').forEach(input=>input.onblur=()=>{window.committed={
        name:document.querySelector('.attr-title input').value,value:document.querySelector('.attr-value input').value};});</script>`);
    await run(page);
  } finally { await browser.close(); }
});

browserTest('writes and rereads old source service attributes within the live name limit without changing source data', async page => {
  // Older saved products expose this row with or without a property ID.
  for (const identified of [true, false]) {
    const source = { ...attribute, ...(identified ? {} : { id: undefined }) };
    const product = JSON.parse(JSON.stringify({ attributes: [source], source: { snapshot: { attributes: [source] } } }));
    const before = structuredClone(product);
    const plan = planPublicAttributeTransfer(product, []);
    const receipts = await fillCustomAttributes(page, plan.product, fillAndVerify);
    assert.equal(receipts[0].name, sourceName);
    assert.equal(receipts[0].postingName, postingName);
    assert.equal(receipts[0].value, 'sample making');
    assert.deepEqual(await page.evaluate(() => window.committed), { name: postingName, value: 'sample making' });
    await requireCustomAttributes(page, plan.product);
    const transferred = await requirePublicAttributeTransfer(page, product);
    assert.equal(transferred[0].name, sourceName);
    assert.equal(transferred[0].destination, 'custom-attribute');
    assert.deepEqual(product, before);
    assert.equal(await page.evaluate(() => window.additions), 0);
    await page.locator('.attr-value input').fill('Rejected edit');
    await assert.rejects(requireCustomAttributes(page, plan.product), /未被发布页完整保留/);
  }
});

browserTest('rejects conflicting equivalent custom names before writing or adding a row', async page => {
  const product = { customAttributes: [{ name: sourceName, value: 'sample making' }, { name: postingName, value: 'mould making' }] };
  await assert.rejects(fillCustomAttributes(page, product, fillAndVerify), /对应多个不同值/);
  assert.deepEqual(await readCustomAttributes(page), [{ name: '', value: '' }]);
  assert.equal(await page.evaluate(() => window.additions), 0);
});

browserTest('honors narrower live limits and preserves explicit user edits to the source service value', async page => {
  const product = { customAttributes: [{ ...attribute, value: 'mould making', source: 'manual' }] };
  const before = structuredClone(product);
  await page.locator('.attr-title input').evaluate(input => input.maxLength = 30);
  await assert.rejects(fillCustomAttributes(page, product, fillAndVerify), /30 字符限制/);
  assert.equal(await page.locator('.attr-title input').inputValue(), '');
  await page.locator('.attr-title input').evaluate(input => input.maxLength = 40);
  await fillCustomAttributes(page, product, fillAndVerify);
  assert.deepEqual(await page.evaluate(() => window.committed), { name: postingName, value: 'mould making' });
  assert.deepEqual(product, before);
});
