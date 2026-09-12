import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher, dismissPostingOverlays, emptyRequiredSpecificationLabels, enableImageBackedVariantSpecs, recoverRequiredAttributes, specImageIsUploaded } from '../server/publisher.js';
import { createPublishedReferenceTemplate } from '../server/publish-reference.js';
import { applyPublishedProductReference } from '../server/product-model.js';

test('references accepted category values while retaining target values and product media', () => {
  const source = { categoryId: '201346401', attributes: [{ name: 'Type', value: 'Old type' }], mainImages: ['reference.jpg'] };
  const snapshot = { data: source, categoryId: source.categoryId, result: { status: 'published', requiredAttributes: [
    { name: '类型', value: 'FPV Flight Control' }, { name: '商品图片', value: 'unrelated.jpg' },
  ] } };
  const template = createPublishedReferenceTemplate(source, snapshot);
  assert.equal(template.attributes[0].value, 'FPV Flight Control');
  assert.equal(template.attributes.length, 1);
  for (const current of ['', 'Drone Battery']) {
    const target = { categoryId: source.categoryId, attributes: [{ name: 'Type', value: current }], mainImages: ['target.jpg'], price: 12 };
    const patch = applyPublishedProductReference(target, template, { onlyMissing: true, preserveCategory: true });
    assert.equal(patch.attributes[0].value, current || 'FPV Flight Control');
    assert.equal(patch.mainImages, undefined);
    assert.equal(patch.price, undefined);
  }
  assert.equal(source.attributes[0].value, 'Old type');
});

test('fills required type in specifications and adds custom types without touching unrelated controls', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <input id="productTitle" value="Original product">
      <div id="struct-other"><label>Missing</label></div>
      <div id="struct-specification"><div id="p-200399262">
        <div><div><label class="required">类型</label></div></div>
        <div class="sell-sequential-combobox"><div class="sell-sequential-combocheckbox">
          <label><input type="checkbox"><span>FPV Flight Control</span></label>
          <button class="add-button">添加</button>
        </div></div>
      </div><div id="p-optional"><label>Optional</label><input value="untouched"></div></div>
      <script>
        window.additions = 0;
        document.querySelector('button').onclick = () => {
          window.additions++;
          const wrap = document.createElement('div'); wrap.className = 'sell-sequential-combobox-custom-wrap';
          const input = document.createElement('input'); wrap.append(input);
          document.querySelector('.sell-sequential-combobox').append(wrap);
          input.onblur = () => {
            const label = document.createElement('label');
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
            label.append(checkbox, document.createTextNode(input.value));
            document.querySelector('.sell-sequential-combocheckbox').prepend(label); wrap.remove();
          };
        };
      </script>`);
    assert.deepEqual(await emptyRequiredSpecificationLabels(page), ['类型']);
    assert.deepEqual(await recoverRequiredAttributes(page, { attributes: [{ name: 'Type', value: 'FPV Flight Control' }] }, ['类型']), ['类型']);
    assert.equal(await page.evaluate(() => window.additions), 0);
    assert.deepEqual(await emptyRequiredSpecificationLabels(page), []);
    await page.locator('[type="checkbox"]').uncheck();
    assert.deepEqual(await emptyRequiredSpecificationLabels(page), ['类型']);
    const product = { attributes: [{ name: 'Type', value: 'Flight Controller' }] };
    assert.deepEqual(await recoverRequiredAttributes(page, product, ['类型']), ['类型']);
    assert.deepEqual(await recoverRequiredAttributes(page, product, ['类型']), ['类型']);
    assert.equal(await page.evaluate(() => window.additions), 1);
    assert.deepEqual(await recoverRequiredAttributes(page, { attributes: [{ name: 'Missing', value: 'bad' }, { name: 'Optional', value: 'bad' }] }, ['Missing', 'Optional']), []);
    assert.equal(await page.locator('#productTitle').inputValue(), 'Original product');
    assert.equal(await page.locator('#p-optional input').inputValue(), 'untouched');
  } finally { await browser.close(); }
});

test('closes recognized blocking dialogs and refuses to confirm unknown prompts', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<div role="dialog"><button onclick="setTimeout(() => this.parentElement.remove(), 150)">我知道了</button></div>');
    assert.equal(await dismissPostingOverlays(page), true);
    await page.setContent('<div role="dialog"><button onclick="window.confirmed = true">确认发布</button></div>');
    assert.equal(await dismissPostingOverlays(page), false);
    assert.equal(await page.evaluate(() => Boolean(window.confirmed)), false);
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
  } finally { await browser.close(); }
});

test('does not count temporary or missing specification images as completed uploads', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="saleAttributesItems"><label>Model<input type="checkbox" value="3" checked></label></div>
      <div id="struct-specification" class="next-loading-wrapper error-summary"><div id="p-3">
        <div class="posting-feild-color-item"><input role="colorCombobox" value="Small"><div class="custom-upload-image"><div class="value-preview uploaded"><img src="https://example.test/small.png"></div></div></div>
        <div class="posting-feild-color-item"><input role="colorCombobox" value="Large"><div class="custom-upload-image"><div class="value-preview uploaded"><img src="blob:pending"></div></div></div>
      </div></div>`);
    const items = page.locator('.posting-feild-color-item');
    assert.equal(await specImageIsUploaded(items.nth(0)), true);
    await items.nth(0).locator('.value-preview').evaluate((node) => node.classList.add('uploading'));
    assert.equal(await specImageIsUploaded(items.nth(0)), false);
    await items.nth(0).locator('.value-preview').evaluate((node) => node.classList.remove('uploading'));
    assert.equal(await specImageIsUploaded(items.nth(1)), false);
    const group = { id: '3', name: 'Model', type: 'IMAGE', options: ['Small', 'Large'], optionImages: { Small: 'small' } };
    let downloads = 0;
    assert.equal(await enableImageBackedVariantSpecs(page, {}, [group], async () => { downloads++; return []; }), false);
    assert.equal(downloads, 0);
  } finally { await browser.close(); }
});

test('main-image portal chooser never assigns files to an unrelated multiple uploader', { skip: !findChromium() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-portal-test-'));
  const files = Array.from({ length: 4 }, (_, i) => path.join(directory, `${i}.png`));
  files.forEach((file) => fs.writeFileSync(file, 'fixture'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <div class="image-uploader">${Array.from({ length: 6 }, () => '<div class="image-upload-list-item"><span id="image-placeholder-span">添加主图</span></div>').join('')}</div>
      <div role="menu" hidden><button>本地上传</button><input id="main" type="file" accept="image/*" multiple hidden></div>
      <input id="unrelated" type="file" accept="image/*" multiple hidden>
      <script>
        window.wrongUploads = 0;
        document.querySelector('#unrelated').onchange = () => window.wrongUploads++;
        document.querySelectorAll('#image-placeholder-span').forEach(node => node.onmouseenter = () => { document.querySelector('[role="menu"]').hidden = false; });
        document.querySelector('button').onclick = () => document.querySelector('#main').click();
        document.querySelector('#main').onchange = function () {
          [...this.files].forEach((file, i) => {
            document.querySelector('.image-upload-list-item:has(#image-placeholder-span)').innerHTML = '<img width="80" height="80" src="https://example.test/' + i + '.png">';
          });
        };
      </script>`);
    const publisher = new SellerPublisher(directory);
    publisher.downloadImageSet = async () => files;
    publisher.waitForMainImageUploads = async () => 4;
    assert.equal(await publisher.uploadMainImages(page, { mainImages: files }), 4);
    assert.equal(await page.evaluate(() => window.wrongUploads), 0);
    assert.equal(await page.locator('.image-uploader img').count(), 4);
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
