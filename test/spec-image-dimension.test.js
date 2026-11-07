import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { enableImageBackedVariantSpecs, enableSpecImageUpload, preferredSpecificationImageGroup } from '../server/publisher.js';

test('requires complete per-SKU image equivalence instead of matching unordered image sets', () => {
  const red = 'https://sc04.alicdn.com/kf/Hred.jpg';
  const blue = 'https://sc04.alicdn.com/kf/Hblue.jpg';
  const color = { id: '191288010', name: 'color', type: 'IMAGE', options: ['Red', 'Blue'], optionImages: { Red: red, Blue: blue } };
  const model = { id: '3', name: 'model number', type: 'TEXT', options: ['Small', 'Large'], optionImages: { Small: red, Large: blue } };
  const product = { variantGroups: [color, model], skus: [
    { attributes: { color: 'Red', 'model number': 'Small' } },
    { attributes: { color: 'Blue', 'model number': 'Large' } },
  ] };
  assert.equal(preferredSpecificationImageGroup(product, model), color);
  assert.equal(preferredSpecificationImageGroup(product, color), null);
  assert.equal(preferredSpecificationImageGroup({ ...product, skus: [] }, model), null);
  assert.equal(preferredSpecificationImageGroup({ ...product, skus: product.skus.slice(0, 1) }, model), null);
  assert.equal(preferredSpecificationImageGroup({ ...product, skus: [...product.skus, { attributes: { color: 'Red' } }] }, model), null);
  assert.equal(preferredSpecificationImageGroup({ ...product, skus: product.skus.map(sku => ({ ...sku, image: blue })) }, model), null);
  assert.equal(preferredSpecificationImageGroup({ ...product, skus: [
    { attributes: { color: 'Blue', 'model number': 'Small' } },
    { attributes: { color: 'Red', 'model number': 'Large' } },
  ] }, model), null, 'Identical image sets with swapped combinations are different associations');
  assert.equal(preferredSpecificationImageGroup(product, { ...model, optionImages: { Small: red } }), null);
  assert.equal(preferredSpecificationImageGroup(product, { ...model, sourceGroups: [model] }), null);
  assert.equal(preferredSpecificationImageGroup({ ...product, variantGroups: [
    color, { ...color, id: '99', name: 'style' }, model,
  ], skus: product.skus.map(sku => ({ attributes: { ...sku.attributes, style: sku.attributes.color } })) }, model), null,
  'Multiple possible source image dimensions must remain unambiguous');
  const same = { ...model, options: ['Small'], optionImages: { Small: red.replace('.jpg', '.jpg_960x960q80.jpg') } };
  assert.equal(preferredSpecificationImageGroup({ variantGroups: [{ ...color, options: ['Red'] }, same] }, same)?.id, color.id);
  assert.equal(preferredSpecificationImageGroup({ variantGroups: [{ ...color, options: ['Red'] }, same], skus: [{ image: blue }] }, same), null);
});

async function singleImageDimensionFixture(page) {
  await page.setContent(`<div id="saleAttributesItems">
    <label>Color<input type="checkbox" value="191288010" checked></label>
    <label>Model<input type="checkbox" value="3" checked></label></div>
    <div id="struct-specification">
    <div id="p-191288010"><span>颜色</span><span class="upload-image-switch">添加规格图
      <button role="switch" aria-checked="false" class="next-switch next-switch-off">图片</button></span>
      <div class="posting-feild-color-item"><input role="colorCombobox" value="As Picture"><span class="slot"></span></div></div>
    <div id="p-3"><span>型号</span><span class="upload-image-switch">添加规格图
      <button role="switch" aria-checked="false" class="next-switch next-switch-off">图片</button></span>
      <div class="posting-feild-color-item"><input role="colorCombobox" value="Radar Model"><span class="slot"></span></div></div></div>
    <script>
      window.toggles=[];window.uploads=[];window.confirmations=0;
      function enable(row){
        document.querySelectorAll('[role="switch"]').forEach(button=>{
          const on=button.closest('[id^="p-"]')===row;
          button.setAttribute('aria-checked',String(on));button.className='next-switch next-switch-'+(on?'on':'off');
          button.closest('[id^="p-"]').querySelector('.slot').innerHTML=on?'<div class="custom-upload-image">上传<input type="file" accept="image/*"></div>':'';
        });
        row.querySelector('[type="file"]').onchange=function(){
          window.uploads.push(row.id);
          this.parentNode.insertAdjacentHTML('beforeend','<div class="value-preview uploaded"><img src="https://example.test/accepted-'+row.id+'.png"></div>');
        };
      }
      document.querySelectorAll('[role="switch"]').forEach(button=>button.onclick=()=>{
        const row=button.closest('[id^="p-"]');window.toggles.push(row.id);
        if(document.querySelector('[role="switch"][aria-checked="true"]')){
          const dialog=document.createElement('div');dialog.className='next-dialog';dialog.setAttribute('role','dialog');
          dialog.style.cssText='position:fixed;inset:0;background:white;z-index:9';
          dialog.innerHTML='数据清空提示 仅支持一组规格项添加图片，确认开启后，之前规格项上传的图片将被清空！确认是否继续调整？<button>取消</button><button>确定</button>';
          const buttons=dialog.querySelectorAll('button');buttons[0].onclick=()=>dialog.remove();buttons[1].onclick=()=>{window.confirmations++;enable(row);dialog.remove()};document.body.append(dialog);
        }else enable(row);
      });
    </script>`, { waitUntil: 'domcontentloaded' });
}

test('keeps the source image dimension when a text model repeats its exact SKU image', { skip: !findChromium(), timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-image-dimension-'));
  const file = path.join(directory, 'source.png');
  fs.writeFileSync(file, 'source image bytes');
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.route('**/*', route => route.abort());
    await singleImageDimensionFixture(page);
    const url = 'https://sc04.alicdn.com/kf/Hsource.jpg';
    const color = { id: '191288010', name: 'color', type: 'IMAGE', options: ['As Picture'], optionImages: { 'As Picture': url } };
    const model = { id: '3', name: 'model number', type: 'TEXT', options: ['Radar Model'], optionImages: { 'Radar Model': url } };
    const product = { variantGroups: [color, model], skus: [{ attributes: { color: 'As Picture', 'model number': 'Radar Model' }, image: url }] };
    const original = structuredClone(product);
    const downloads = [];
    const download = async urls => { downloads.push(...urls); return [file]; };
    assert.equal(await enableImageBackedVariantSpecs(page, product, [model], download), true);
    assert.equal(await enableSpecImageUpload(page, product, color, download), true);
    assert.deepEqual(await page.evaluate(() => window.toggles), ['p-191288010']);
    assert.deepEqual(await page.evaluate(() => window.uploads), ['p-191288010']);
    assert.equal(await page.evaluate(() => window.confirmations), 0);
    assert.equal(await page.locator('#p-191288010 .value-preview.uploaded img').count(), 1);
    assert.equal(await page.locator('#p-3 .value-preview.uploaded img').count(), 0);
    assert.equal(await enableImageBackedVariantSpecs(page, product, [model], download), true);
    assert.equal(await enableSpecImageUpload(page, product, color, download), true);
    assert.deepEqual(downloads, [url]);
    assert.deepEqual(product, original);
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not erase a different image dimension or turn an incomplete upload into success', { skip: !findChromium(), timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-image-conflict-'));
  const file = path.join(directory, 'source.png');
  fs.writeFileSync(file, 'image bytes');
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.route('**/*', route => route.abort());
    const color = { id: '191288010', name: 'color', type: 'IMAGE', options: ['As Picture'], optionImages: { 'As Picture': 'https://example.test/color.png' } };
    const model = { id: '3', name: 'model number', type: 'TEXT', options: ['Radar Model'], optionImages: { 'Radar Model': 'https://example.test/model.png' } };
    const product = { variantGroups: [color, model] };
    await singleImageDimensionFixture(page);
    assert.equal(await enableImageBackedVariantSpecs(page, product, [model], async () => [file]), true);
    await assert.rejects(enableSpecImageUpload(page, product, color, async () => [file]), {
      code: 'PUBLISH_SPECIFICATION_IMAGE_DIMENSION_CONFLICT',
    });
    assert.equal(await page.evaluate(() => window.confirmations), 0);
    assert.equal(await page.locator('#p-3 .value-preview.uploaded img').count(), 1);
    assert.equal(await page.locator('#p-191288010 [role="switch"]').getAttribute('aria-checked'), 'false');
    assert.deepEqual(await page.evaluate(() => window.toggles), ['p-3', 'p-191288010'], 'The pending destructive prompt must not trigger repeated toggles');

    await singleImageDimensionFixture(page);
    const duplicateModel = { ...model, optionImages: { 'Radar Model': color.optionImages['As Picture'] } };
    const duplicateProduct = { variantGroups: [color, duplicateModel] };
    assert.equal(await enableImageBackedVariantSpecs(page, duplicateProduct, [duplicateModel], async () => []), false);
    assert.equal(await page.locator('.value-preview.uploaded img').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.toggles), ['p-191288010']);

    await singleImageDimensionFixture(page);
    await page.locator('#p-191288010').evaluate(node => node.remove());
    assert.equal(await enableImageBackedVariantSpecs(page, duplicateProduct, [duplicateModel], async () => [file]), true);
    assert.deepEqual(await page.evaluate(() => window.toggles), ['p-3'], 'An unavailable source image dimension must not suppress the available target');
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rechecks every committed color image after a later upload rebuilds the row', { skip: !findChromium(), timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-image-readback-'));
  const file = path.join(directory, 'source.png');
  fs.writeFileSync(file, 'image bytes');
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.route('**/*', route => route.abort());
    await page.setContent(`<div id="saleAttributesItems"><label>Color<input type="checkbox" value="191288010" checked></label></div>
      <div id="struct-specification"><div id="p-191288010">
      <div class="posting-feild-color-item"><input role="colorCombobox" value="Red"><div class="custom-upload-image"><input type="file"></div></div>
      <div class="posting-feild-color-item"><input role="colorCombobox" value="Blue"><div class="custom-upload-image"><input type="file"></div></div>
      </div></div><script>
      window.uploads=0;
      document.querySelectorAll('[type="file"]').forEach(input=>input.onchange=()=>{
        window.uploads++;document.querySelectorAll('.value-preview').forEach(node=>node.remove());
        input.parentNode.insertAdjacentHTML('beforeend','<div class="value-preview uploaded"><img src="https://example.test/'+window.uploads+'.png"></div>');
      });</script>`);
    const color = { id: '191288010', name: 'color', type: 'IMAGE', options: ['Red', 'Blue'], optionImages: { Red: 'red', Blue: 'blue' } };
    assert.equal(await enableSpecImageUpload(page, { variantGroups: [color] }, color, async () => [file]), false);
    assert.equal(await page.evaluate(() => window.uploads), 2);
    assert.equal(await page.locator('.value-preview.uploaded img').count(), 1, 'A later upload removed the earlier image; success requires both');
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
