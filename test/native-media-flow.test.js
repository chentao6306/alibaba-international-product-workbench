import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher, buildLegacyDescriptionHtml, preparePublishProduct } from '../server/publisher.js';
import { currentDescriptionStructure, descriptionSourceHash } from '../server/description-structure.js';
import { fillStructuredDescription } from '../server/structured-description.js';
import { readNativeDescriptionFields } from '../server/native-description-fields.js';

test('collects all description images from DOM, structured data and iframe without a combined 30-image cap', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const urls = Array.from({ length: 35 }, (_, i) => `https://sc04.alicdn.com/kf/description-${i}.jpg`);
    const html = urls.map(url => `<p><img src="${url}"></p>`).join('');
    const publisher = new SellerPublisher(os.tmpdir());
    const page = await browser.newPage();
    let mode = '';
    await page.route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.abort();
      if (route.request().url().includes('descIframe')) return route.fulfill({ contentType: 'text/html', body: `<div id="detail_decorate_root">${html}</div>` });
      const description = mode === 'dom' ? `<div data-module-name="module_description">${html}</div>`
        : mode === 'iframe' ? '<div data-module-name="module_description"><iframe src="https://www.alibaba.com/descIframe.html"></iframe></div>'
          : `<script>window.detailData=${JSON.stringify({ nodeMap: { module_description: { privateData: { productDescription: { details: urls.map(url => ({ type: 'image', url })) } } } } })}</script>`;
      return route.fulfill({ contentType: 'text/html', body: `<h1>Image collection sample</h1><div data-module-name="module_gallery"><img src="https://sc04.alicdn.com/kf/main.jpg"></div><table><tr><td>Material</td><td>Plastic</td></tr></table>${description}` });
    });
    for (mode of ['dom', 'data', 'iframe']) {
      const product = await publisher.readSourceProduct(page, { sourceId: '12345678901', sourceUrl: 'https://www.alibaba.com/product-detail/Sample_12345678901.html' });
      assert.deepEqual(product.detailImages, urls, mode);
      assert.equal(product.dataCompleteness.detailImages, 35, mode);
      assert.deepEqual(JSON.parse(JSON.stringify(product)).detailImages, urls);
    }
    const structure = { version: 1, sourceHtmlHash: descriptionSourceHash(html), modules: [
      { type: 'gallery', scope: 'product', title: 'Other product images', images: urls.slice(0, 25).map(url => ({ url })) },
      { type: 'gallery', scope: 'company', title: 'Company overview', images: urls.slice(25).map(url => ({ url })) },
    ] };
    const old = { descriptionHtml: html, structuredDescription: structure, detailImages: urls.slice(0, 30) };
    assert.deepEqual(preparePublishProduct(old).detailImages, urls);
    assert.deepEqual(old.detailImages, urls.slice(0, 30));
    assert.equal(currentDescriptionStructure(old).modules.length, 2);
    assert.deepEqual(preparePublishProduct({ ...old, imageEdits: { detail: true } }).detailImages, urls.slice(0, 30));
    assert.deepEqual(preparePublishProduct({ ...old, descriptionHtml: '<p>Manually replaced</p>' }).detailImages, urls.slice(0, 30));
  } finally { await browser.close(); }
});

test('fills an image-only native form with no AI editor entry and checks the committed model after dimension adaptation', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-image-flow-'));
  try {
    const file = path.join(directory, 'short.png');
    await sharp({ create: { width: 900, height: 200, channels: 3, background: '#aa6600' } }).png().toFile(file);
    const page = await browser.newPage();
    await page.setContent(`<div id="detailImage"><label><input type="checkbox" value="350">Other product images</label><div id="groups"></div></div><script>
      const state={productDescType:{value:4},textDesc:'',companyDesc:'',companyFaqDesc:[],detailImage:[],companyImage:[]};
      window.GlobalStore={engine:{getModels:()=>({formValues:state})}};
      window.Json={components:{detailImage:{props:{maxImageItem:30,dataSource:[{value:'350',enName:'Other product images'}]}}}};
      document.querySelector('input').onchange=e=>{
        document.querySelector('#groups').innerHTML=e.target.checked?'<div class="gallery-item-container"><div class="gallery-item-header-en-name">Other product images</div><input type="file"><div id="images"></div></div>':'';
        state.detailImage=e.target.checked?[{value:'350',enName:'Other product images',imageList:[]}]:[];
        if(!e.target.checked)return;
        document.querySelector('input[type=file]').onchange=async e=>{
          for(const file of e.target.files){const bitmap=await createImageBitmap(file);
            if(bitmap.width<600||bitmap.height<600||file.size>5242880)throw new Error('Invalid image');
            const url='https://sc04.alicdn.com/kf/'+file.name;
            const row=document.createElement('div');row.className='gallery-item-image';
            const img=document.createElement('img');img.alt=file.name;img.src=url;row.append(img);document.querySelector('#images').append(row);
            setTimeout(()=>state.detailImage[0].imageList.push({imgURL:url,width:bitmap.width,height:bitmap.height}),150);
          }
        };
      };
    </script>`);
    const urls = ['https://sc04.alicdn.com/kf/source.png'];
    const html = buildLegacyDescriptionHtml({ descriptionHtml: `<p><img src="${urls[0]}"></p>`, detailImages: urls });
    const result = await fillStructuredDescription(page, { html, files: [file], imageUrls: urls });
    assert.equal(result.native, true);
    assert.equal(await page.getByText(/AI详情编辑器|详描通用排版/).count(), 0);
    const fields = await readNativeDescriptionFields(page);
    assert.equal(fields.detailImage[0].imageList[0].height, 600);
    assert.equal(fields.detailImage[0].imageList[0].width, 900);
    assert.equal((await sharp(fs.readFileSync(file)).metadata()).height, 200);
    assert.equal(result.imageAdjustments.length, 1);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
