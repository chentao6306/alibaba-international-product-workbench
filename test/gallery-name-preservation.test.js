import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillStructuredDescription } from '../server/structured-description.js';
import { sanitizeCollectedProduct, sanitizeSourceDescriptionHtml, preparePublishProduct } from '../server/publisher.js';
import { currentDescriptionStructure, extractDescriptionStructure } from '../server/description-structure.js';
import { compileNativeDescription, readNativeDescriptionFields, requireNativeDescriptionFields } from '../server/native-description-fields.js';

const schemas = {
  companyDesc: { maxLength: 2000 },
  detailImage: { maxImageItem: 30, dataSource: [{ value: '350', enName: 'Other product images' }] },
  companyImage: { maxImageItem: 30, dataSource: [
    { value: '450', enName: 'Competitive advantages' },
    { value: '550', enName: 'Factory profile' },
    { value: '750', enName: 'Packaging & shipping specifications' },
    { value: '500', enName: 'Extended company profile', cnName: '其他公司介绍' },
  ] },
};
const image = name => `<div data-testid="product-detail-image-simple"><img src="https://example.test/${name}.jpg"></div>`;
const heading = name => `<div data-testid="product-detail-title"><span>${name}</span></div>`;
const source = `<div data-module-name="module_structure_descption_productDescription">${image('product')}</div>`
  + `<div data-module-name="module_structure_descption_companyInfo">${heading('About this supplier')}`
  + `<div data-testid="product-detail-text">Original supplier description.</div>`
  + heading('Competitive advantages') + image('advantages') + heading('Factory profile') + image('factory')
  + heading('Packaging &amp; shipping specifications') + image('shipping')
  + heading('Extended company profile') + image('other') + '</div>';

test('preserves company gallery titles after collection, persistence and a manual company-text edit', () => {
  const collected = sanitizeCollectedProduct({ descriptionHtml: source, structuredDescription: extractDescriptionStructure(source) });
  assert.match(collected.descriptionHtml, /Extended company profile/);
  const reopened = JSON.parse(JSON.stringify(collected));
  reopened.descriptionHtml = reopened.descriptionHtml.replace('Original supplier description.', 'Edited supplier description.');
  const prepared = preparePublishProduct(reopened);
  const structure = currentDescriptionStructure(prepared);
  const plan = compileNativeDescription(structure, schemas);
  assert.equal(plan.companyDesc, 'Edited supplier description.');
  assert.deepEqual(plan.galleries.map(g => [g.rootId, g.name, g.images.length]), [
    ['detailImage', 'Other product images', 1], ['companyImage', 'Competitive advantages', 1],
    ['companyImage', 'Factory profile', 1], ['companyImage', 'Packaging & shipping specifications', 1],
    ['companyImage', 'Extended company profile', 1],
  ]);
  assert.match(collected.descriptionHtml, /Original supplier description/);
});

test('keeps native legacy-editor gallery headings while still removing scripts and actual contact details', () => {
  const html = '<div module-name="icbu-pc-detailStructured"><div class="comp-navigation-sib"><span>Extended company profile</span></div></div>'
    + '<p>Contact us: sales@example.test</p><p>Phone: +1 555 123 4567</p><script>alert(1)</script>';
  const cleaned = sanitizeSourceDescriptionHtml(html);
  assert.match(cleaned, /Extended company profile/);
  assert.doesNotMatch(cleaned, /sales@|555 123|alert\(1\)|Contact us/);
});

test('maps already-saved unnamed company images only to the current generic company gallery and verifies readback', () => {
  const structure = extractDescriptionStructure(source.replace('Extended company profile', ''));
  const before = structuredClone(structure);
  const plan = compileNativeDescription(structure, schemas);
  const last = plan.galleries.at(-1);
  assert.deepEqual([last.rootId, last.value, last.name, last.custom], ['companyImage', '500', 'Extended company profile', false]);
  assert.deepEqual(structure, before);
  const fields = { textDesc: plan.textDesc, companyDesc: plan.companyDesc, companyFaqDesc: [], detailImage: [], companyImage: [] };
  for (const group of plan.galleries) {
    group.urls = group.images.map(img => img.url);
    fields[group.rootId].push({ value: group.value, enName: group.name, imageList: group.urls.map(imgURL => ({ imgURL })) });
  }
  requireNativeDescriptionFields(plan, fields);
  fields.detailImage.push(fields.companyImage.pop());
  assert.throws(() => requireNativeDescriptionFields(plan, fields), /分类或排列未保留/);
});

test('rejects missing, disabled or ambiguous generic galleries instead of guessing another company category', () => {
  const structure = { modules: [{ type: 'gallery', scope: 'company', title: '', images: [{ url: 'https://example.test/company.jpg' }] }] };
  for (const options of [schemas.companyImage.dataSource.slice(0, 3),
    [{ value: '500', enName: 'Extended company profile', disabled: true }],
    [{ value: '500', enName: 'Extended company profile' }, { value: '900', enName: 'Extended company profile' }]]) {
    assert.throws(() => compileNativeDescription(structure, { ...schemas, companyImage: {
      ...schemas.companyImage, dataSource: options, supportCustomGallery: true, maxCustomGalleryItem: 5, maxGalleryNameLength: 100,
    } }), { code: 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH' });
  }
  const named = structuredClone(structure); named.modules[0].title = 'Unrecognized named gallery';
  assert.throws(() => compileNativeDescription(named, schemas), /无法唯一匹配/);
  const duplicate = { modules: [structure.modules[0], { ...structure.modules[0], title: 'Extended company profile' }] };
  assert.throws(() => compileNativeDescription(duplicate, schemas), /重复图集/);
});

test('uploads all nine product and company images through native controls with an unnamed legacy gallery', { skip: !findChromium(), timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-name-flow-'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const files = [];
    for (let i = 0; i < 9; i++) {
      const file = path.join(directory, `image-${i}.png`);
      await sharp({ create: { width: 650, height: 650, channels: 3, background: '#336699' } }).png().toFile(file);
      files.push(file);
    }
    const urls = files.map((_, i) => `https://example.test/source-${i}.png`);
    const structure = { modules: [
      { type: 'gallery', scope: 'product', title: '', images: urls.slice(0, 4).map(url => ({ url })) },
      ...['Competitive advantages', 'Factory profile', 'Packaging & shipping specifications', ''].map((title, i) => ({
        type: 'gallery', scope: 'company', title, images: (i === 0 ? urls.slice(4, 6) : [urls[i + 5]]).map(url => ({ url })),
      })),
    ] };
    const original = structuredClone(structure);
    const page = await browser.newPage();
    await page.route('https://example.test/**', route => route.abort());
    await page.setContent(`<div id="detailImage"></div><div id="companyImage"></div><script>
      const schemas=${JSON.stringify(schemas)};
      const state={productDescType:{value:4},textDesc:'',companyDesc:'',companyFaqDesc:[],detailImage:[],companyImage:[]};
      window.GlobalStore={engine:{getModels:()=>({formValues:state})}};
      window.Json={components:Object.fromEntries(Object.entries(schemas).map(([id,props])=>[id,{props}]))};
      for(const id of ['detailImage','companyImage']) {
        const root=document.getElementById(id);
        for(const option of schemas[id].dataSource) {
          const label=document.createElement('label');
          label.innerHTML='<input type="checkbox" value="'+option.value+'">'+option.enName;root.append(label);
          label.querySelector('input').onchange=e=>{
            if(!e.target.checked)return;
            const group={value:option.value,enName:option.enName,imageList:[]};state[id].push(group);
            const container=document.createElement('div');container.className='gallery-item-container';
            container.innerHTML='<div class="gallery-item-header-en-name">'+option.enName+'</div><input type="file" multiple><div class="images"></div>';
            root.append(container);
            container.querySelector('input').onchange=e=>{
              for(const file of e.target.files) {
                const url='https://example.test/uploaded-'+file.name;
                const row=document.createElement('div');row.className='gallery-item-image';
                row.innerHTML='<img src="'+url+'" alt="'+file.name+'">';container.querySelector('.images').append(row);
                setTimeout(()=>group.imageList.push({imgURL:url}),100);
              }
            };
          };
        }
      }
    </script>`);
    const result = await fillStructuredDescription(page, { structure, files, imageUrls: urls });
    assert.equal(result.native, true);
    const fields = await readNativeDescriptionFields(page);
    requireNativeDescriptionFields(result.plan, fields);
    assert.deepEqual(fields.companyImage.map(g => [g.enName, g.imageList.length]), [
      ['Competitive advantages', 2], ['Factory profile', 1], ['Packaging & shipping specifications', 1], ['Extended company profile', 1],
    ]);
    assert.deepEqual([...fields.detailImage, ...fields.companyImage].flatMap(g => g.imageList.map(img => img.imgURL)),
      files.map(file => `https://example.test/uploaded-${path.basename(file)}`));
    assert.deepEqual(structure, original);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
