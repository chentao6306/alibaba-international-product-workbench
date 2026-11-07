import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { repairWatermark } from '../server/image-processing.js';
import { buildLegacyDescriptionHtml, fillAndVerify, fillCategoryAttributes } from '../server/publisher.js';
import { supplierCustomAttributes, fillCustomAttributes, requireCustomAttributes } from '../server/custom-attributes.js';
import { sourceAttributeForField } from '../server/category-attributes.js';
import { createEditorForm, editorPayload } from '../src/product-editor-model.js';
import { generateProductKeywords, generateProductSubtitle, alibabaKeywordText } from '../server/product-keywords.js';

test('rich source descriptions retain layout without duplicating summaries, specifications or custom attributes', () => {
  for (const [name, value] of [['Chipset', 'MTK6261'], ['Weave', 'Twill'], ['Binding', 'Hardcover'], ['Part number', '4G63']]) {
    const product = { title: 'Product', description: 'Collapsed table paragraph', descriptionHtml: '<h3>Facts</h3><table><tr><td>Original</td><td>Text</td></tr></table><p>After</p>',
      attributes: [{ name, value, isCustom: true }], variantGroups: [{ name: 'Size', options: ['S', 'L'] }] };
    const html = buildLegacyDescriptionHtml(product);
    assert.doesNotMatch(html, /Collapsed|Available Specifications|<h2>/);
    assert.ok(!html.includes(value));
    assert.ok(html.indexOf('Facts') < html.indexOf('Original') && html.indexOf('Original') < html.indexOf('After'));
  }
});

test('custom attributes survive editor save and reopen without overwriting same-name category attributes', () => {
  const original = { attributes: [{ id: 'screen', name: 'Screen Size', value: '2.4' },
    { name: 'Screen Size', value: 'Main 2.4 + Sub 1.77', isCustom: true },
    { name: 'Single gross weight', value: '0.5 kg', isCustom: true, section: 'Packaging and delivery' }] };
  const before = structuredClone(original);
  const form = createEditorForm(original);
  assert.equal(form.customAttributes.length, 1);
  assert.equal(form.attributes.find(row => row.id === 'screen').value, '2.4');
  form.customAttributes[0].value = 'Main 2.4 + Sub 1.8';
  const reopened = createEditorForm(editorPayload(form));
  assert.equal(reopened.customAttributes[0].value, 'Main 2.4 + Sub 1.8');
  assert.deepEqual(original, before);
  assert.equal(supplierCustomAttributes({ ...original, customAttributes: [{ name: 'Screen Size', value: 'Edited' }] })[0].value, 'Edited');
});

test('mobile band mapping uses explicit radio context without mistaking AC frequency for a mobile band', () => {
  const field = { id: '406736640', label: '蜂窝频段', controlType: 'text' };
  for (const value of ['2G: Quad bands', '2G: Quad band 3G: 850/900/2100 4G: 1/3/5/7/8/20/40']) {
    assert.equal(sourceAttributeForField({ attributes: [{ name: 'Frequency', value, source: 'description-iframe' }] }, field).value, value);
  }
  for (const value of ['50 Hz', '50/60 Hz', '1000', '4G 50 Hz']) assert.equal(sourceAttributeForField({ attributes: [{ name: 'Frequency', value }] }, field), null);
});

test('generated keywords and subtitles use supplied facts across categories and preserve manual keywords', () => {
  for (const title of ['4G Dual SIM Senior Mobile Phone with Large Touch Screen and Long Battery Life', 'Womens Cotton Long Sleeve Shirt with Floral Print and Button Front in Sizes S M L', 'Illustrated Hardcover Childrens Book of Animals with Colour Pages for Early Readers']) {
    const keywords = generateProductKeywords({ title });
    assert.ok(keywords.length <= 3 && keywords.every(word => title.includes(word)));
    assert.equal(alibabaKeywordText({ title, keywords: ['Manual keyword'] }), 'Manual keyword');
    const subtitle = generateProductSubtitle({ title, attributes: [{ name: 'Model', value: 'A12' }] });
    assert.equal(subtitle, 'A12');
  }
});

test('custom property controls retain all supplied rows and reject dropped values and platform limits', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="customMoreProperty"><div class="list"></div><button class="add-attr-btn">Add</button></div>
      <script>document.querySelector('button').onclick=()=>document.querySelector('.list').insertAdjacentHTML('beforeend','<div class="item"><div class="attr-title"><input maxlength="30"></div><div class="attr-value"><input maxlength="80"></div></div>');</script>`);
    const product = { customAttributes: [{ name: 'EU Frequency', value: 'GSM:850/900/1800/1900' }, { name: 'Lining', value: 'Cotton' }, { name: 'Binding', value: 'Hardcover' }] };
    await fillCustomAttributes(page, product, fillAndVerify);
    assert.equal((await requireCustomAttributes(page, product)).length, 3);
    await page.locator('.attr-value input').first().fill('');
    await assert.rejects(requireCustomAttributes(page, product), { code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED' });
    await assert.rejects(fillCustomAttributes(page, { customAttributes: [{ name: 'Oversized', value: 'a'.repeat(81) }] }, fillAndVerify), /80/);
  } finally { await browser.close(); }
});

test('native attribute length limits stop silent truncation while keeping the original value intact', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="p-406736640"><div class="label">蜂窝频段</div><input maxlength="47" value="Existing value"></div>');
    const value = '2G: Quad band 3G: 850/900/2100 (three bands optional); 4G: 1/3/5/7/8/20/40';
    const product = { attributes: [{ name: 'Frequency', value }] };
    await assert.rejects(fillCategoryAttributes(page, product), error => {
      assert.equal(error.code, 'PUBLISH_ATTRIBUTE_VALUE_TOO_LONG');
      assert.equal(error.diagnostics.limit, 47);
      return true;
    });
    assert.equal(await page.locator('input').inputValue(), 'Existing value');
    assert.equal(product.attributes[0].value, value);
  } finally { await browser.close(); }
});

test('watermark repair does not drag a contrasting product edge into the background', async () => {
  const width = 240, height = 180, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const background = 210 + (x * 7 + y * 3) % 9;
    const product = x >= 120 && x < 180 && y >= 55 && y < 145;
    const watermark = x >= 80 && x < 120 && y >= 75 && y < 95;
    const i = (y * width + x) * 4;
    raw.set([product || watermark ? 20 : background, product || watermark ? 20 : background, product || watermark ? 20 : background, 255], i);
  }
  const input = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const region = { x: 80 / width, y: 75 / height, width: 40 / width, height: 20 / height };
  const repaired = await sharp(await repairWatermark(input, region)).raw().toBuffer();
  const texture = new Set();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (x >= 80 && x < 120 && y >= 75 && y < 95) { assert.ok(repaired[i] > 190); texture.add(repaired[i]); }
    else assert.deepEqual(repaired.subarray(i, i + 4), raw.subarray(i, i + 4));
  }
  assert.ok(texture.size > 3, 'Background texture must survive');
  const sample = { x: 0.2, y: 0.2 };
  const manual = await sharp(await repairWatermark(input, region, sample)).raw().toBuffer();
  assert.deepEqual(manual.subarray((75 * width + 80) * 4, (75 * width + 81) * 4), raw.subarray((26 * width + 28) * 4, (26 * width + 29) * 4));
  await assert.rejects(repairWatermark(input, region, { x: 100 / width, y: 85 / height }), /重叠/);
});
