import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { compileNativeDescription, nativeDescriptionSchemas, resolveNativeGallery, readNativeDescriptionFields, requireNativeDescriptionFields } from '../server/native-description-fields.js';
import { fillStructuredDescription } from '../server/structured-description.js';

// The native company component exposes limits and an Add control, but omits
// the supportCustomGallery flag used by its product-image counterpart.
const schemas = {
  detailImage: { maxImageItem: 30, supportCustomGallery: true, maxCustomGalleryItem: 5, maxGalleryNameLength: 50,
    dataSource: [{ value: '350', enName: 'Other product images' }] },
  companyImage: { maxImageItem: 30, maxCustomGalleryItem: 3, maxGalleryNameLength: 50,
    dataSource: [{ value: '400', enName: 'Company overview' }] },
};
const structure = { modules: [
  { type: 'gallery', scope: 'product', title: '', images: [{ url: 'https://example.test/product.png' }] },
  { type: 'gallery', scope: 'company', title: 'Supplier Clothing Studio', images: [{ url: 'https://example.test/company.png' }] },
  { type: 'gallery', scope: 'company', title: 'Our Cooperating Brands', images: [{ url: 'https://example.test/brand1.png' }, { url: 'https://example.test/brand2.png' }] },
] };

async function galleryFixture(page, { companyAdd = true, productAdd = true, companySupport, inputLimit = 50, duplicate = false } = {}) {
  await page.route('https://example.test/**', route => route.abort());
  const schema = structuredClone(schemas);
  if (companySupport !== undefined) schema.companyImage.supportCustomGallery = companySupport;
  await page.setContent(`<div id="detailImage"></div><div id="companyImage"></div><script>
    (()=>{
    const schemas=${JSON.stringify(schema)}, options=${JSON.stringify({ companyAdd, productAdd, inputLimit, duplicate })};
    const state={productDescType:{value:4},textDesc:'',companyDesc:'',companyFaqDesc:[],detailImage:[],companyImage:[]};
    window.GlobalStore={engine:{getModels:()=>({formValues:state})}};
    window.Json={components:Object.fromEntries(Object.entries(schemas).map(([id,props])=>[id,{props}]))};
    window.addClicks=0;let serial=0;
    function select(root,id,option) {
      const group={value:option.value,enName:option.enName,imageList:[]};state[id].push(group);
      const container=document.createElement('div');container.className='gallery-item-container';
      const header=document.createElement('div');header.className='gallery-item-header-en-name';header.textContent=option.enName;
      const input=document.createElement('input');input.type='file';input.multiple=true;
      const images=document.createElement('div');container.append(header,input,images);root.append(container);
      input.onchange=e=>{for(const file of e.target.files){
        const url='https://example.test/uploaded-'+file.name;
        const item=document.createElement('div');item.className='gallery-item-image';
        const image=document.createElement('img');image.src=url;image.alt=file.name;item.append(image);images.append(item);
        group.imageList.push({imgURL:url});
      }};
    }
    function addLabel(root,id,option,checked=false) {
      const label=document.createElement('label');label.className='gallery-names-checkbox';
      const input=document.createElement('input');input.type='checkbox';input.value=option.value;input.checked=checked;
      const span=document.createElement('span');span.className='gallery-names-checkbox-en-name';span.textContent=option.enName;
      label.append(input,span);root.append(label);
      input.onchange=()=>{if(input.checked)select(root,id,option)};
      if(checked)select(root,id,option);
    }
    for(const id of ['detailImage','companyImage']) {
      const root=document.getElementById(id);
      for(const option of schemas[id].dataSource)addLabel(root,id,option);
      if(!(id==='companyImage'?options.companyAdd:options.productAdd))continue;
      const add=document.createElement('button');add.className='add-custom-gallery-name-btn';add.textContent='Custom gallery';root.append(add);
      add.onclick=()=>{
        window.addClicks++;
        const box=document.createElement('div');box.className='custom-input';
        const input=document.createElement('input');input.maxLength=options.inputLimit;box.append(input);root.append(box);input.focus();
        input.onblur=()=>{if(!input.value)return;const option={value:'CUSTOM-'+(++serial),enName:input.value};
          schemas[id].dataSource.push(option);box.remove();addLabel(root,id,option,true);
          if(options.duplicate)addLabel(root,id,{...option,value:'CUSTOM-duplicate'});
        };
      };
    }
    })();
  </script>`);
}

test('reads company custom-gallery capability from the current scoped control and limits without changing the source schema', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await galleryFixture(page);
    const live = await nativeDescriptionSchemas(page);
    assert.equal(live.companyImage.supportCustomGallery, true);
    assert.equal(live.companyImage.customGalleryCapabilitySource, 'current-form-control-and-limits');
    assert.equal(await page.evaluate(() => window.Json.components.companyImage.props.supportCustomGallery), undefined);
    assert.throws(() => compileNativeDescription(structure, schemas), /无法唯一匹配/);
    const original = structuredClone(structure);
    const plan = compileNativeDescription(structure, live);
    assert.deepEqual(plan.galleries.map(group => [group.rootId, group.name, group.images.length]), [
      ['detailImage', 'Other product images', 1], ['companyImage', 'Supplier Clothing Studio', 1], ['companyImage', 'Our Cooperating Brands', 2],
    ]);
    assert.deepEqual(structure, original);
    await galleryFixture(page, { companyAdd: false });
    assert.equal((await nativeDescriptionSchemas(page)).companyImage.supportCustomGallery, undefined, 'An unrelated product control is not company capability evidence');
    await galleryFixture(page);
    await page.locator('#companyImage .add-custom-gallery-name-btn').evaluate(button => { button.disabled = true; });
    assert.equal((await nativeDescriptionSchemas(page)).companyImage.supportCustomGallery, undefined, 'A disabled Add control does not prove current capability');
    await galleryFixture(page, { companySupport: false });
    assert.equal((await nativeDescriptionSchemas(page)).companyImage.supportCustomGallery, false, 'An explicit prohibition must not be overridden');
    await page.evaluate(() => { delete window.Json.components.companyImage.props.supportCustomGallery; delete window.Json.components.companyImage.props.maxGalleryNameLength; });
    assert.equal((await nativeDescriptionSchemas(page)).companyImage.supportCustomGallery, undefined, 'Unknown limits must not be invented');
  } finally { await browser.close(); }
});

test('keeps custom company gallery count, title length, ambiguous names and image limits enforced', () => {
  const live = structuredClone(schemas);live.companyImage.supportCustomGallery = true;
  for (const [key, value] of [['maxCustomGalleryItem', 1], ['maxGalleryNameLength', 10], ['maxGalleryNameLength', undefined], ['maxImageItem', 2]]) {
    const limited = structuredClone(live);limited.companyImage[key] = value;
    assert.throws(() => compileNativeDescription(structure, limited), { code: 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH' });
  }
  const duplicated = structuredClone(live);
  duplicated.companyImage.dataSource.push({ value: 'custom-one', enName: 'Supplier Clothing Studio' }, { value: 'custom-two', enName: 'Supplier Clothing Studio' });
  assert.throws(() => compileNativeDescription(structure, duplicated), /无法唯一匹配/);
});

test('creates each custom gallery exactly once, retains its entire title and refuses truncated or ambiguous controls', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await galleryFixture(page);
    const gallery = compileNativeDescription(structure, await nativeDescriptionSchemas(page)).galleries[1];
    await resolveNativeGallery(page, gallery);
    const firstValue = gallery.value;
    await resolveNativeGallery(page, gallery);
    assert.equal(gallery.value, firstValue);
    assert.equal(await page.evaluate(() => window.addClicks), 1);
    assert.equal((await readNativeDescriptionFields(page)).companyImage[0].enName, gallery.name);
    await galleryFixture(page, { inputLimit: 10 });
    await assert.rejects(resolveNativeGallery(page, { ...gallery, value: null }), /未截断名称/);
    assert.deepEqual((await readNativeDescriptionFields(page)).companyImage, []);
    await galleryFixture(page, { duplicate: true });
    await assert.rejects(resolveNativeGallery(page, { ...gallery, value: null }), /strict mode|不唯一/);
    assert.equal(await page.evaluate(() => window.addClicks), 1);
  } finally { await browser.close(); }
});

test('uploads and reads back product and custom company galleries with every title, image and order retained', { skip: !findChromium(), timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apparel-custom-gallery-'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await galleryFixture(page);
    const imageUrls = structure.modules.flatMap(module => module.images.map(image => image.url));
    const files = [];
    for (let index = 0; index < imageUrls.length; index++) {
      const file = path.join(root, `gallery-${index}.png`);
      await sharp({ create: { width: 650, height: 650, channels: 3, background: '#336699' } }).png().toFile(file);
      files.push(file);
    }
    const before = structuredClone(structure);
    const result = await fillStructuredDescription(page, { structure, imageUrls, files });
    const fields = await readNativeDescriptionFields(page);
    assert.equal(result.native, true);
    requireNativeDescriptionFields(result.plan, fields);
    assert.deepEqual(fields.companyImage.map(group => group.enName), ['Supplier Clothing Studio', 'Our Cooperating Brands']);
    assert.deepEqual([...fields.detailImage, ...fields.companyImage].flatMap(group => group.imageList.map(image => image.imgURL)), files.map(file => `https://example.test/uploaded-${path.basename(file)}`));
    assert.equal(await page.evaluate(() => window.addClicks), 2);
    assert.deepEqual(structure, before);
    const corrupted = structuredClone(fields);corrupted.companyImage.reverse();
    assert.throws(() => requireNativeDescriptionFields(result.plan, corrupted), /分类或排列未保留/);
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
