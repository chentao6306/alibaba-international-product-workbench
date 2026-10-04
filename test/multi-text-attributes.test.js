import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillCategoryAttributes, requireCategoryAttributes } from '../server/publisher.js';

test('writes each OE code into its own limited text entry and replaces previously saved codes', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent(`<div class="sell-catProp-item" id="p-99"><label class="label required">OE代码</label>
      <div class="posting-field-multi-text"><input maxlength="12" value="OLD-001"><input maxlength="12" value="OLD-002">
      <button class="add-button" onclick="const input=document.createElement('input');input.maxLength=12;this.before(input)">添加</button></div></div>`);
    const product = { attributes: [{ id: '99', name: 'OE Number', value: ['A4638200164', 'A4638200264', 'A4638200364'] }] };
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual(await page.locator('input').evaluateAll((nodes) => nodes.map((node) => node.value).filter(Boolean)), product.attributes[0].value);
    product.attributes[0].value = ['A4638209999'];
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual(await page.locator('input').evaluateAll((nodes) => nodes.map((node) => node.value).filter(Boolean)), ['A4638209999']);
    product.attributes[0].value = ['CODE-TOO-LONG-FOR-THE-CONTROL'];
    await fillCategoryAttributes(page, product);
    await assert.rejects(requireCategoryAttributes(page, product), (error) => error.unmatchedSourceFields.includes('OE代码'));
  } finally { await browser.close(); }
});

test('maps an OE code source value when the target field uses a different attribute id', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent(`<div class="sell-catProp-item" id="p-456"><label class="label required">OE代码</label>
      <div class="posting-field-multi-text"><input maxlength="12"></div></div>`);
    const product = { attributes: [{ id: 'source-oe', name: 'OE Number', value: ['A4638200164'] }] };
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.equal(await page.locator('#p-456 input').inputValue(), 'A4638200164');
  } finally { await browser.close(); }
});
