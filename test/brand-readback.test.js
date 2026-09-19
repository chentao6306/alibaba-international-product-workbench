import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { captureCategoryAttributes, fillCategoryAttributes, requireCategoryAttributes } from '../server/publisher.js';
import { createPublishedReferenceTemplate } from '../server/publish-reference.js';
import { applyPublishedProductReference } from '../server/product-model.js';

test('retains a literal Other brand through direct filling, successful reference and required-field validation', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const direct = { id: 'phone', categoryId: '201896803', brand: 'Other', attributes: [{ name: 'brand name', value: 'Other' }] };
    const reference = { ...direct, id: 'reference', status: 'published', publishResult: { status: 'published', requiredAttributes: [{ name: '品牌名称', value: 'Other' }] } };
    const referenced = { ...direct, ...applyPublishedProductReference(direct, createPublishedReferenceTemplate(reference), { fullTemplate: true }) };
    for (const product of [direct, referenced]) {
      await page.setContent('<div class="sell-catProp-item" id="struct-p-2"><div class="label required">品牌名称</div><span class="next-input"><input name="p-2" uitype="input" maxlength="50"></span></div>');
      await fillCategoryAttributes(page, product);
      assert.equal(await page.locator('input').inputValue(), 'Other');
      assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, ['Other']);
      await requireCategoryAttributes(page, product);
      assert.deepEqual(await captureCategoryAttributes(page), [{ name: '品牌名称', value: 'Other' }]);
      await page.locator('input').fill('');
      await assert.rejects(requireCategoryAttributes(page, product), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
      await page.locator('input').fill('Different brand');
      await assert.rejects(requireCategoryAttributes(page, product), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
    }
  } finally { await browser.close(); }
});

test('distinguishes literal Other text from an Other selector and uncommitted search text', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const value of ['Other', 'other', 'Others', '其他', '其它', '自定义']) {
      await page.setContent('<div class="sell-catProp-item"><label class="label required">Brand Name</label><input></div>');
      await page.locator('input').fill(value);
      assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, [value]);
    }
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-2"><label class="label required">Brand Name</label>
      <div class="next-select"><span class="next-select-values"><em>Other</em></span><input type="search" role="combobox" value="uncommitted search"></div>
      <input name="p-2" value="Acme"></div>`);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, ['Acme']);
    assert.deepEqual(await captureCategoryAttributes(page), [{ name: 'Brand Name', value: 'Acme' }]);
    await page.locator('input[name="p-2"]').fill('Other');
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, ['Other']);
    await page.setContent('<div class="sell-catProp-item"><label class="label required">Brand Name</label><input type="search" value="Other"></div>');
    const [search] = await page.evaluate(readPostingAttributeSchema);
    assert.deepEqual(search.values, []);
    assert.equal(search.hasValue, false);
  } finally { await browser.close(); }
});
