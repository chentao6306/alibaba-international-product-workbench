import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { requiredAttributeKey } from '../server/publish-reference.js';
import { extractAlibabaSourceData } from '../server/alibaba-source-data.js';
import { resolveReferencedSkuRows } from '../server/sku-reference.js';
import { readPostingAttributeSchema, sourceSpecificationForField } from '../server/category-attributes.js';
import { emptyRequiredSpecificationLabels, enableImageBackedVariantSpecs, fillCategoryAttributes, fillVariantSpecs,
  inferRequiredAttributeValue, isRequiredTargetVariantGroup, preparePublishProduct, requiredAttributeFailure, SellerPublisher } from '../server/publisher.js';

test('keeps light, lens and ordinary colors distinct while recognizing translated specification names', () => {
  for (const [name, label] of [['Light Color', '灯光颜色'], ['Lens Color', '镜片颜色'], ['Lamp Type', '灯泡类型']]) {
    assert.equal(requiredAttributeKey(name), requiredAttributeKey(label));
    assert.notEqual(requiredAttributeKey(name), requiredAttributeKey('Color'));
  }
  assert.notEqual(requiredAttributeKey('Light Color'), requiredAttributeKey('Color Temperature'));
  assert.equal(isRequiredTargetVariantGroup({ name: 'Light Color', type: 'IMAGE', options: ['Natural White'], optionImages: { 'Natural White': 'light.jpg' } }), false);
  assert.equal(isRequiredTargetVariantGroup({ name: 'Lens Color', options: ['Red', 'Clear'] }), true);
  assert.equal(isRequiredTargetVariantGroup({ name: 'Color', options: ['Red', 'Blue'] }), false);
});

test('uses saved image SKU values even when the source page shows only a thumbnail', () => {
  for (const value of ['Natural White', 'RGB', 'balck', 'Cool White']) {
    const product = extractAlibabaSourceData({ globalData: { product: { sku: {
      skuAttrs: [{ id: 191292949, name: 'Light Color', type: 'IMAGE', values: [{ id: 10, name: value, image: 'https://example.test/light.png' }] }],
      skuInfoMap: { '191292949:10;': { id: 100 } },
    } } } });
    assert.deepEqual(product.variantGroups[0].options, [value]);
    assert.equal(inferRequiredAttributeValue(product, '灯光颜色'), value);
  }
});

test('does not reuse ordinary color images for another color dimension with the same option text', () => {
  const product = { colorImages: { White: 'body.png' }, variantGroups: [
    { id: '191292949', name: 'Light Color', type: 'IMAGE', options: ['White'] },
  ], skus: [{ attributes: { 'Light Color': 'White' }, image: 'lamp.png' }] };
  assert.equal(preparePublishProduct(product).variantGroups[0].optionImages.White, 'lamp.png');
});

test('fills translated image specifications and their images without writing into ordinary color', { skip: !findChromium() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-spec-identity-'));
  const file = path.join(directory, 'source.png');
  fs.writeFileSync(file, 'source-image-fixture');
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    for (const [id, name, label, values, sourceId, fixed] of [
      ['191292949', 'Light Color', '灯光颜色', ['Natural White'], '191292949'],
      ['191292949', 'Light Color', '灯光颜色', ['RGB', 'balck', 'Cool White'], ''],
      ['200000284', 'Lens Color', '镜片颜色', ['Red', 'Clear'], '200000284'],
      ['42', 'Frame Finish', '边框表面处理', ['Matte', 'Glossy'], '42'],
      ['43', 'Fabric Pattern', '面料花纹', ['Floral'], '43'],
      ['191292949', 'Light Color', 'Light Color', ['Natural White'], '191292949', true],
      ['44', 'Surface Finish', '表面处理', ['Brushed', 'Polished'], '44', true],
    ]) {
      await page.setContent(`<div id="saleAttributesItems">
        <label><input type="checkbox" value="191288010">颜色</label>
        ${fixed ? '' : `<label><input type="checkbox" value="${id}">${label} 支持传图</label>`}</div>
        <div id="struct-specification"><div id="p-191288010"><label class="label">颜色</label><input role="colorCombobox" value="Body Black"></div>
        <div id="p-${id}" style="display:${fixed ? 'block' : 'none'}"><label class="label required">${label}</label>
          <div class="posting-feild-color-item"><input role="colorCombobox" placeholder="请输入"><div class="custom-upload-image">上传<input type="file"></div></div>
          <button role="btn-add">添加</button></div></div>
        <script>(()=>{window.uploads=[];const row=document.getElementById('p-${id}');
        const selector=document.querySelector('input[value="${id}"]');if(selector)selector.onchange=function(){row.style.display=this.checked?'block':'none'};
        function bind(item){item.querySelector('[type=file]').onchange=function(){window.uploads.push(item.querySelector('[role=colorCombobox]').value);this.parentNode.insertAdjacentHTML('beforeend','<div class="value-preview uploaded"><img src="https://example.test/uploaded.png"></div>')}};
        bind(row.querySelector('.posting-feild-color-item'));
        row.querySelector('button').onclick=()=>{const item=row.querySelector('.posting-feild-color-item').cloneNode(true);item.querySelector('[role=colorCombobox]').value='';row.querySelector('button').before(item);bind(item)};
        })();</script>`);
      const group = { id: sourceId, name, type: 'IMAGE', options: values,
        optionImages: Object.fromEntries(values.map((value, i) => [value, `https://example.test/source-${i}.png`])) };
      const product = { variantGroups: [group] };
      const original = structuredClone(product);
      const result = await fillVariantSpecs(page, product);
      assert.deepEqual(result.unmapped, [], JSON.stringify({ name, groups: result.groups,
        controls: await page.locator('#saleAttributesItems input').evaluateAll((nodes) => nodes.map((node) => ({ id: node.value, checked: node.checked }))) }));
      await fillCategoryAttributes(page, product);
      assert.deepEqual(await emptyRequiredSpecificationLabels(page), [], name);
      assert.deepEqual(await page.locator(`#p-${id} [role=colorCombobox]`).evaluateAll((nodes) => nodes.map((node) => node.value)), values);
      const downloads = [];
      assert.equal(await enableImageBackedVariantSpecs(page, product, result.groups, async ([url]) => { downloads.push(url); return [file]; }), true);
      assert.deepEqual(downloads, Object.values(group.optionImages));
      assert.deepEqual(await page.evaluate(() => window.uploads), values);
      if (id === '191292949' && values.length === 1 && !fixed) {
        await SellerPublisher.prototype.fillStableProductFields.call({ downloadImageSet: async () => [file] }, page, product);
        assert.deepEqual(await page.locator(`#p-${id} [role=colorCombobox]`).evaluateAll((nodes) => nodes.map((node) => node.value)), values);
      }
      const skus = values.map((value, i) => ({ attributes: { [name]: value }, code: `SKU-${i}`, stock: i + 1 }));
      const resolved = resolveReferencedSkuRows({ skus }, [{ name: label, options: [...values].reverse() }], { appliedGroups: result.groups });
      assert.deepEqual(resolved.map((row) => row.sku), [...skus].reverse());
      assert.equal(await page.locator('#p-191288010 input').inputValue(), 'Body Black');
      assert.equal(await page.locator('[value="191288010"]').isChecked(), false);
      assert.deepEqual(product, original);
      await page.locator(`#p-${id} [role=colorCombobox]`).first().fill('');
      const failure = await requiredAttributeFailure(page, product, [label]);
      assert.deepEqual(failure.missingSourceFields, [], name);
      assert.deepEqual(failure.unmatchedSourceFields, [label], name);
    }
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('does not map a short specification name to an unrelated longer name', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const [source, target] of [['Color', 'Light Color'], ['Size', 'Screen Size']]) {
      await page.setContent(`<div id="saleAttributesItems"><label><input type="checkbox" value="999">${target}</label></div>
        <div id="struct-specification"><div id="p-999"><label>${target}</label><input role="colorCombobox" placeholder="请输入"></div></div>`);
      const result = await fillVariantSpecs(page, { variantGroups: [{ name: source, options: ['Small', 'Large'] }] });
      assert.equal(await page.locator('input[type=checkbox]').isChecked(), false);
      assert.equal(await page.locator('[role=colorCombobox]').inputValue(), '');
      if (source === 'Size') assert.deepEqual(result.unmapped, ['Size: Small', 'Size: Large']);
    }
  } finally { await browser.close(); }
});

test('matches unknown specification labels by property ID and rejects conflicting identities', () => {
  const group = { id: '42', name: 'Surface finish', options: ['Matte'] };
  const product = { variantGroups: [group] };
  assert.equal(sourceSpecificationForField(product, { id: '42', label: '表面处理', saleSpecification: true }), group);
  assert.equal(sourceSpecificationForField(product, { id: '43', label: 'Surface finish', saleSpecification: true }), group);
  assert.equal(sourceSpecificationForField(product, { id: '43', label: 'Lens finish', saleSpecification: true }), null);
  assert.equal(sourceSpecificationForField(product, { id: '42', label: 'Surface finish' }), null);
  assert.equal(sourceSpecificationForField({ variantGroups: [group, { ...group, options: ['Glossy'] }] },
    { id: '42', label: 'Surface finish', saleSpecification: true }), null);
});

test('fills specification control families by ID and preserves all variants instead of only the last value', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    for (const [control, sourceValues, expected, optionIds] of [
      ['<input>', ['Cotton'], ['Cotton']],
      ['<textarea></textarea>', ['Brushed metal'], ['Brushed metal']],
      ['<select><option value="">Select</option><option value="10">哑光</option><option value="11">亮光</option></select>', ['Matte'], ['哑光'], { Matte: '10' }],
      ['<select multiple><option value="10">S</option><option value="11">M</option><option value="12" selected>L</option></select>', ['S', 'M'], ['S', 'M']],
      ['<label><input type="checkbox" value="10">Cotton</label><label><input type="checkbox" value="11">Linen</label><label><input type="checkbox" value="12" checked>Silk</label>', ['Cotton', 'Linen'], ['Cotton', 'Linen']],
      ['<label><input name="option" type="radio" value="10">Matte</label><label><input name="option" type="radio" value="11" checked>Glossy</label>', ['Matte'], ['Matte']],
    ]) {
      await page.setContent(`<div id="struct-specification"><div id="p-42"><label class="label required">材质/规格</label>${control}</div></div>`);
      const group = { id: '42', name: 'Source dimension', options: sourceValues, optionIds };
      const result = await fillVariantSpecs(page, { variantGroups: [group] });
      assert.deepEqual(result.unmapped, [], control);
      assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, expected, control);
      assert.deepEqual(sourceValues.map((raw) => result.groups[0].appliedValues[raw]), expected);
    }
    for (const control of ['<input>', '<select><option>A</option><option>B</option></select>',
      '<label><input name="r" type="radio" value="1">A</label><label><input name="r" type="radio" value="2">B</label>']) {
      await page.setContent(`<div id="struct-specification"><div id="p-42"><label class="label required">规格</label>${control}</div></div>`);
      const result = await fillVariantSpecs(page, { variantGroups: [{ id: '42', name: 'Option', options: ['A', 'B'] }] });
      assert.deepEqual(result.unmapped, ['Option: A', 'Option: B']);
      assert.deepEqual(result.groups[0].appliedValues, {});
    }
  } finally { await browser.close(); }
});
