import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher, fillAndVerify, dismissPostingOverlays, emptyRequiredSpecificationLabels, enableImageBackedVariantSpecs, recoverRequiredAttributes, specImageIsUploaded, visibleFeedback, fillModelNumber, fillColorSpec, ensureColorSpecificationReady, alibabaKeywordText } from '../server/publisher.js';
import { createPublishedReferenceTemplate } from '../server/publish-reference.js';
import { applyPublishedProductReference } from '../server/product-model.js';
import { captureCategoryAttributes, inferRequiredAttributeValue, fillChoice } from '../server/publisher.js';

test('English Add Color creates every referenced color and material checkboxes keep every selected value', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-specification"><div id="p-191288010"><label>color</label>
      <div class="posting-feild-color-item"><input role="colorCombobox"></div><span class="add-color-btn" role="btn-add">+ Add Color</span></div></div>
      <div class="sell-catProp-item"><div class="label">Material</div><label><input type="checkbox">Aluminum Alloy</label><label><input type="checkbox">Rubber</label><label><input type="checkbox">Plastic</label></div>
      <script>document.querySelector('.add-color-btn').onclick=()=>{const row=document.createElement('div');row.className='posting-feild-color-item';row.innerHTML='<input role="colorCombobox">';document.querySelector('.add-color-btn').before(row);};</script>`);
    const progress = [];
    assert.equal(await fillColorSpec(page, ['Black', 'Blue', 'Gold'], message => progress.push(message)), true);
    assert.deepEqual(progress, ['已填写颜色 1/3：Black', '已填写颜色 2/3：Blue', '已填写颜色 3/3：Gold']);
    assert.deepEqual(await page.locator('input[role="colorCombobox"]').evaluateAll((nodes) => nodes.map((node) => node.value)), ['Black', 'Blue', 'Gold']);
    assert.equal(await fillChoice(page, page.locator('input[type=checkbox]').first(), ['Aluminum Alloy', 'Rubber']), true);
    assert.deepEqual(await page.locator('input[type=checkbox]').evaluateAll((nodes) => nodes.map((node) => node.checked)), [true, true, false]);
  } finally { await browser.close(); }
});

test('successful form capture preserves selected labels, multiple attributes and reference specification values', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item"><div class="label">* 最大起飞重量：</div><select><option value="2">25kg</option></select></div>
      <div class="sell-catProp-item"><div class="label">材质</div><label><input type="checkbox" checked>Aluminum Alloy</label><label><input type="checkbox" checked>Rubber</label><label><input type="checkbox">Plastic</label></div>
      <div class="sell-catProp-item"><div class="label">最大飞行时间</div><input value="30 minutes"></div>
      <div id="struct-specification"><div id="p-1"><label>类型</label><em class="next-tag-body">Drone motor</em><input type="search" value="Old type"></div></div>`);
    const requiredAttributes = await captureCategoryAttributes(page);
    assert.deepEqual(requiredAttributes, [{ name: '最大起飞重量', value: '25kg' }, { name: '材质', value: ['Aluminum Alloy', 'Rubber'] }, { name: '最大飞行时间', value: '30 minutes' }, { name: '类型', value: 'Drone motor' }]);
    const reference = { categoryId: '201346401', attributes: [{ name: 'Max Takeoff Weight', value: 'stale' }], variantGroups: [{ name: 'Type', options: ['Old type'], optionImages: { 'Old type': 'motor.jpg' } }], skus: [{ attributes: { Type: 'Old type' }, stock: 7 }] };
    const before = structuredClone(reference);
    const template = createPublishedReferenceTemplate(reference, { data: reference, result: { status: 'published', requiredAttributes } });
    const target = { id: 'target', categoryId: '11111', price: 12, attributes: [{ name: 'Battery', value: 'old category' }], modelImages: { old: 'wrong.jpg' }, variantGroups: [{ name: 'RAM', options: ['8GB'] }] };
    const copied = { ...target, ...applyPublishedProductReference(target, template, { fullTemplate: true }) };
    assert.equal(inferRequiredAttributeValue(copied, 'Maximum Takeoff Weight'), '25kg');
    assert.equal(inferRequiredAttributeValue(copied, 'Max Flight Time'), '30 minutes');
    assert.deepEqual(inferRequiredAttributeValue(copied, 'Material'), ['Aluminum Alloy', 'Rubber']);
    assert.deepEqual(copied.variantGroups[0].options, ['Drone motor']);
    assert.equal(copied.skus[0].attributes.Type, 'Drone motor');
    assert.equal(copied.skus[0].image, 'motor.jpg');
    assert.deepEqual(copied.modelImages, {});
    assert.equal(copied.attributes.some((row) => row.name === 'Battery'), false);
    assert.deepEqual(reference, before);
  } finally { await browser.close(); }
});

test('accepts exact titles containing commas and still validates formatted numeric inputs', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="title"><input id="price" onblur="this.value = Number(this.value.replaceAll(\',\', \'\')).toLocaleString(\'en-US\')">');
    const title = 'T-MOTOR MN1315 KV100: 50kg Max Thrust, Powering 130kg Heavy-Lift Multirotor UAV';
    await fillAndVerify(page.locator('#title'), title, '商品标题');
    assert.equal(await page.locator('#title').inputValue(), title);
    await fillAndVerify(page.locator('#price'), '1250', '价格');
    assert.equal(await page.locator('#price').inputValue(), '1,250');
  } finally { await browser.close(); }
});

test('formats forbidden keyword punctuation without changing source titles or attribute values', () => {
  const product = { title: 'Cross-Border 1:1 Android Phone', keywords: ['1:1 Phone', 'Color: Black'], attributes: [{ name: 'Band', value: '3G: WCDMA850/2100MHz' }] };
  const original = structuredClone(product);
  assert.equal(alibabaKeywordText(product), '1 to 1 Phone\nColor Black');
  assert.equal(alibabaKeywordText({ ...product, keywords: [] }), 'Cross-Border 1 to 1 Android Phone');
  assert.equal(alibabaKeywordText({ title: 'T-MOTOR MN1315 KV100: 50kg Max Thrust, Powering 130kg' }), 'T-MOTOR MN1315 KV100 50kg Max Thrust Powering 130kg');
  assert.equal(alibabaKeywordText({ keywords: ['Carbon Fiber, Propeller', 'Ratio 1:1'] }), 'Carbon Fiber Propeller\nRatio 1 to 1');
  assert.ok(alibabaKeywordText({ keywords: ['Android Smartphone '.repeat(40)] }).length <= 384);
  assert.deepEqual(product, original);
});

test('rechecking committed colors does not dispatch keys or rewrite their values', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-specification"><div id="p-191288010"><label>颜色</label>
      <div class="posting-feild-color-item"><input role="colorCombobox" value="Black"></div>
      <div class="posting-feild-color-item"><input role="colorCombobox" value="Blue"></div></div></div>
      <script>window.events = 0; for (const type of ['keydown', 'input', 'change']) document.addEventListener(type, () => window.events++);</script>`);
    assert.equal(await fillColorSpec(page, ['Black', 'Blue']), true);
    assert.equal(await page.evaluate(() => window.events), 0);
  } finally { await browser.close(); }
});

test('waits for a delayed color editor and never puts color values into the model editor', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`<div id="saleAttributesItems"><label>颜色<input type="checkbox" value="191288010"></label></div>
      <div id="struct-specification"><div id="p-3"><label>型号</label><div class="posting-feild-color-item"><input role="colorCombobox" value="UBEC"></div></div>
      <div id="p-191288010" style="display:none"><label>颜色</label><div class="posting-feild-color-item"><input role="colorCombobox"></div></div></div>
      <script>document.querySelector('input[type=checkbox]').onchange = () => setTimeout(() => document.getElementById('p-191288010').style.display = '', 1200);</script>`);
    assert.ok(await ensureColorSpecificationReady(page, 3000));
    assert.equal(await fillColorSpec(page, ['Yellow']), true);
    assert.equal(await page.locator('#p-191288010 input').inputValue(), 'Yellow');
    assert.equal(await page.locator('#p-3 input').inputValue(), 'UBEC');
    await page.locator('#p-191288010').evaluate((node) => { node.style.display = 'none'; });
    assert.equal(await ensureColorSpecificationReady(page, 300), null);
  } finally { await browser.close(); }
});

test('adds the missing model input after the specification control removes its empty row', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input id="unrelated" value="Keep"><div id="struct-p-3"><div class="label">型号</div>
      <div class="posting-field-multi-text"><button class="add-button" onclick="this.before(document.createElement('input'))">添加</button></div></div>
      <script>document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && event.target.closest('#struct-p-3 input')) event.target.remove(); });</script>`);
    assert.equal(await fillModelNumber(page, 'S25 Ultra'), true);
    assert.equal(await page.locator('#struct-p-3 input').inputValue(), 'S25 Ultra');
    assert.equal(await fillModelNumber(page, 'S25 Ultra'), true);
    assert.equal(await page.locator('#struct-p-3 input').count(), 1);
    assert.equal(await page.locator('#unrelated').inputValue(), 'Keep');
    await page.locator('#struct-p-3 input').evaluate((node) => { node.value = ''; node.onfocus = () => node.remove(); });
    await page.locator('#unrelated').focus();
    assert.equal(await fillModelNumber(page, 'S25 Ultra'), true);
    assert.equal(await page.locator('#struct-p-3 input').inputValue(), 'S25 Ultra');
  } finally { await browser.close(); }
});

test('refills attributes once after Alibaba reloads an automatically saved draft without submitting twice', async () => {
  const publisher = new SellerPublisher(os.tmpdir());
  let url = 'https://post.alibaba.com/product/publish.htm?catId=123';
  let fills = 0;
  const page = { url: () => url, isClosed: () => false, waitForLoadState: async () => {}, locator: () => ({ first: () => ({ waitFor: async () => {} }) }) };
  publisher.fillStableProductFields = async () => {
    fills++;
    if (fills === 1) { url = 'https://post.alibaba.com/product/publish.htm?itemId=1&pubAction=draft'; throw new Error('Execution context was destroyed'); }
    return { mappedAttributes: ['Type'] };
  };
  assert.deepEqual(await publisher.fillProductFields(page, {}), { mappedAttributes: ['Type'] });
  assert.equal(fills, 2);
  publisher.fillStableProductFields = async () => { throw new Error('Invalid type'); };
  await assert.rejects(publisher.fillProductFields(page, {}), /Invalid type/);
});

test('checks empty required category fields after rerender and reads visible feedback without duplicate messages', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item"><div class="label required">Battery</div><input value=""></div>
      <div class="sell-catProp-item"><div class="label required">Screen</div><input value=""><em class="next-tag-body">6 inches</em></div>
      <div class="sell-catProp-item"><div class="label">Optional</div><input value=""></div>
      <div role="alert" class="next-message error">Type is required</div><div class="error" style="display:none">Hidden</div>`);
    assert.deepEqual(await emptyRequiredSpecificationLabels(page, true), ['Battery']);
    assert.deepEqual(await emptyRequiredSpecificationLabels(page), []);
    assert.deepEqual(await visibleFeedback(page), ['Type is required']);
    await page.locator('.sell-catProp-item input').first().fill('6000 mAh');
    assert.deepEqual(await emptyRequiredSpecificationLabels(page, true), []);
  } finally { await browser.close(); }
});

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
    await assert.rejects(enableImageBackedVariantSpecs(page, {}, [group], async () => { downloads++; return []; }), /规格图片缺失.*Large/);
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
    await page.route('https://example.test/**', (route) => route.abort());
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
    // The real main-image portal can expose the file input before its label.
    // An unrelated SKU uploader must still remain untouched.
    for (const accept of ['image/*', '.jpg,.jpeg,.png', null]) {
      await page.setContent(`
      <div class="image-uploader">${Array.from({ length: 6 }, () => '<div class="image-upload-list-item"><span id="image-placeholder-span">上传图片</span></div>').join('')}</div>
      <div class="sc-images-upload-dropdown" hidden><input id="main" type="file" ${accept == null ? '' : `accept="${accept}"`} multiple hidden><span>从图片银行选取</span></div>
      <input id="unrelated" type="file" accept="image/*" multiple hidden>
      <script>
        window.wrongUploads = 0;
        document.querySelector('#unrelated').onchange = () => window.wrongUploads++;
        document.querySelectorAll('#image-placeholder-span').forEach(node => node.onmouseenter = () => { document.querySelector('.sc-images-upload-dropdown').hidden = false; });
        document.querySelector('#main').onchange = function () {
          [...this.files].forEach((file, i) => { document.querySelector('.image-upload-list-item:has(#image-placeholder-span)').innerHTML = '<img width="80" height="80" src="https://example.test/' + i + '.png">'; });
        };
      </script>`);
      assert.equal(await publisher.uploadMainImages(page, { mainImages: files }), 4);
      assert.equal(await page.evaluate(() => window.wrongUploads), 0);
    }
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
