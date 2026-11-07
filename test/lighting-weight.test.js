import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { attributeFieldMatchesValue, fillCategoryAttributes, requireCategoryAttributes, requirePublicAttributeTransfer } from '../server/publisher.js';

test('writes exact unit-qualified product weights within numeric field limits without changing the source', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const [value, expected, name = 'Product Weight (kg)'] of [['0000000002.50000', '2.5'], ['2500 g', '2.5'], ['2500000 mg', '2.5'], ['2.5000e-3 kg', '0.0025'], ['.2500 kg', '0.25'], ['2500', '2.5', 'Product Weight (g)']]) {
      await page.setContent('<div class="sell-catProp-item" id="p-9009"><label class="label required">产品重量（kg）</label><input required maxlength="15"></div>');
      const product = { attributes: [{ id: '9009', name, value }], source: { snapshot: { attributes: [{ name, value }] } } };
      const original = structuredClone(product);
      await fillCategoryAttributes(page, product);
      assert.equal(await page.locator('input').inputValue(), expected);
      await requireCategoryAttributes(page, product);
      await requirePublicAttributeTransfer(page, product);
      assert.deepEqual(product, original);
    }
  } finally { await browser.close(); }
});

test('validates product weight as exact decimal data and rejects rounding even when Number would erase the difference', () => {
  const field = { label: 'Product Weight (kg)', controlType: 'text', values: ['0.3'] };
  assert.equal(attributeFieldMatchesValue(field, '300 g'), true);
  assert.equal(attributeFieldMatchesValue(field, '0.30000000000000001'), false);
  assert.equal(attributeFieldMatchesValue({ ...field, values: ['0.30000000000000004'] }, '0.30000000000000004'), true);
  assert.equal(attributeFieldMatchesValue({ ...field, values: ['0.0025'] }, '2.5000e-3 kg'), true);
  assert.equal(attributeFieldMatchesValue({ ...field, values: ['2.5'] }, '2.5 g'), false);
  assert.equal(attributeFieldMatchesValue({ ...field, values: ['1'] }, '1000 oz'), false);
  assert.equal(attributeFieldMatchesValue({ ...field, label: 'Product Weight (g)', values: ['2500'] }, '2.5 kg'), true);
  assert.equal(attributeFieldMatchesValue({ ...field, values: ['2.5'] }, '2500', { source: { name: 'Product Weight (g)' } }), true);
  assert.equal(attributeFieldMatchesValue({ ...field, values: ['2.5'] }, '2500', { source: { unit: 'g' } }), true);
  assert.equal(attributeFieldMatchesValue({ ...field, values: ['2.5'] }, ['1 kg', '2.5 kg']), false);
});

test('does not truncate precise weights or collapse supplier weight ranges and custom text to one number', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="p-9009"><label class="label required">Product Weight (kg)</label><input required maxlength="15"></div>');
    const precise = { attributes: [{ id: '9009', name: 'Product Weight (kg)', value: '0.30000000000000004' }] };
    await assert.rejects(fillCategoryAttributes(page, precise), error => error.code === 'PUBLISH_ATTRIBUTE_VALUE_TOO_LONG');
    assert.equal(await page.locator('input').inputValue(), '');
    for (const value of ['1-2 kg', 'about 2 kg', 'Custom on order']) {
      await page.locator('input').fill('');
      const product = { attributes: [{ id: '9009', name: 'Product Weight (kg)', value }] };
      await fillCategoryAttributes(page, product);
      assert.equal(await page.locator('input').inputValue(), value);
      await requirePublicAttributeTransfer(page, product);
    }
  } finally { await browser.close(); }
});
