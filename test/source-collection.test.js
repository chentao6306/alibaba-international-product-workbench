import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { extractAlibabaDescription, extractAlibabaSourceData } from '../server/alibaba-source-data.js';
import { auditProduct } from '../server/product-model.js';
import { findChromium } from '../server/browser-runtime.js';
import { hasCompleteSourceData, SellerPublisher } from '../server/publisher.js';

test('collects fixed USD prices without mistaking visitor currency or promotions for source prices', () => {
  const data = { globalData: { global: { productPriceCurrencySimpleName: 'CN¥' }, product: {
    customPrice: { fixedDollarPrice: 278, fixedPrice: 1855.82, promotionFixedDollarPrice: 222.4,
      currencyRule: { currencyPattern: 'CN¥{0}' }, unit: 'piece' }
  } } };
  const source = extractAlibabaSourceData(data);
  assert.deepEqual(source.sourcePriceRange, { minPrice: '278.00', maxPrice: '278.00', currencySymbol: '$',
    formattedText: '$278.00', unit: 'piece', source: 'detailData.fixedPrice' });
  assert.equal(source.price, 278);
  assert.equal(source.priceMode, 'source-range');
  assert.equal(source.sourcePriceTiers.length, 0);
  assert.equal(extractAlibabaSourceData({ globalData: { product: { customPrice: {} } } }).sourcePriceRange, null);
  assert.equal(extractAlibabaSourceData({ globalData: { product: { customPrice: { productLadderPrices: {} } } } }).sourcePriceRange, null);
});

test('collects structured detail images in source order and excludes recommended products', () => {
  const description = extractAlibabaDescription({ nodeMap: { module_description: { privateData: {
    viewOrder: ['productDescription', 'productDetails', 'recommendProductInfo'],
    productDescription: { details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/first.jpg' }, { type: 'text', text: 'Product <detail>' }] },
    productDetails: { details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/second.jpg' }] },
    recommendProductInfo: { details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/unrelated.jpg' }] }
  } } } });
  assert.deepEqual(description.images, ['https://sc04.alicdn.com/kf/first.jpg', 'https://sc04.alicdn.com/kf/second.jpg']);
  assert.match(description.html, /Product &lt;detail&gt;/);
  assert.doesNotMatch(description.html, /unrelated/);
  assert.deepEqual(extractAlibabaDescription(null), { html: '', text: '', images: [] });
});

test('accepts the complete source SKU map even when some option combinations do not exist', () => {
  const source = extractAlibabaSourceData({ globalData: { product: { sku: {
    skuAttrs: [
      { id: 1, name: 'color', values: [{ id: 10, name: 'Black' }, { id: 11, name: 'White' }] },
      { id: 2, name: 'storage', values: [{ id: 20, name: '128GB' }, { id: 21, name: '256GB' }] }
    ],
    skuInfoMap: { '1:10;2:20;': { id: 100 }, '1:10;2:21;': { id: 101 }, '1:11;2:20;': { id: 102 } }
  } } } });
  const product = { ...source, sourceStructuredEvidence: source.evidence };
  const incomplete = (value) => auditProduct(value).issues.some((issue) => issue.code === 'sku.rows.incomplete');
  assert.equal(source.skus.length, 3);
  assert.equal(incomplete(product), false);
  assert.equal(incomplete({ ...product, skus: source.skus.slice(0, 2) }), true);
  assert.equal(incomplete({ ...product, skus: [source.skus[0], source.skus[0], source.skus[2]] }), true);
  assert.equal(incomplete({ ...product, skus: source.skus.map((sku) => ({ ...sku, derived: true })) }), true);
});

test('requires description content before skipping source recollection', () => {
  const product = { mainImages: ['1', '2', '3', '4'], detailImages: ['image'], attributes: [{}, {}], origin: 'China' };
  assert.equal(hasCompleteSourceData(product), false);
  assert.equal(hasCompleteSourceData({ ...product, descriptionHtml: '<p><img src="detail.jpg"></p>' }), true);
});

test('reads modern and legacy detail modules without collecting recommendation images', { skip: !findChromium(), timeout: 90000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-fixture-'));
  const publisher = new SellerPublisher(directory);
  try {
    const page = await browser.newPage();
    const gallery = Array.from({ length: 4 }, (_, index) => `<img src="https://sc04.alicdn.com/kf/main${index}.jpg_960x960.jpg">`).join('');
    let description = '';
    let privateData = {};
    let renderType = '';
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.abort();
      if (route.request().url().includes('/descIframe.html')) return route.fulfill({ contentType: 'text/html',
        body: '<div id="detail_decorate_root"><p>Original product description with a picture also used in its gallery.</p><img data-src="https://sc04.alicdn.com/kf/main0.jpg_960x960.jpg"></div>' });
      return route.fulfill({ contentType: 'text/html', body: `<html lang="en"><body><h1>Sample Phone</h1>${gallery}
        <nav class="breadcrumb"><a href="https://www.alibaba.com/parent_cid123456.html">Parent</a><a href="https://www.alibaba.com/leaf_cid234567.html">Leaf</a></nav>
        <div data-testid="module-attribute-row"><span data-testid="module-attribute-name">Place of Origin</span><span data-testid="module-attribute-value">China</span></div>
        <div data-testid="module-attribute-row"><span data-testid="module-attribute-name">Material</span><span data-testid="module-attribute-value">Plastic</span></div>
        <div data-module-name="module_recommend"><img src="https://sc04.alicdn.com/kf/unrelated.jpg_960x960.jpg"></div>
        ${description}<script>window.detailData = ${JSON.stringify({ globalData: { product: { customPrice: { fixedDollarPrice: 23 } } }, nodeMap: { recommendations: { categoryId: 999999 }, module_description: { privateData, renderType } } })};</script>
        </body></html>` });
    });
    for (const module of ['module_structure_description', 'module_description', 'missing', 'structured-data-only', 'late-iframe']) {
      description = ['missing', 'structured-data-only'].includes(module) ? '' : `<div data-module-name="${module}">
        <div data-module-name="module_report">Report abuse</div><p>Source specification</p><img data-src="https://sc04.alicdn.com/kf/detail.jpg">
        </div>`;
      privateData = module === 'structured-data-only' ? { productDescription: { details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/structured.jpg' }] } } : {};
      renderType = module === 'late-iframe' ? 'js_ssr' : '';
      if (module === 'late-iframe') description = `<div data-module-name="module_description">Supplier description</div><script>
        setTimeout(()=>{const frame=document.createElement('iframe');frame.src='https://www.alibaba.com/product-detail/description/descIframe.html';document.querySelector('[data-module-name="module_description"]').append(frame);},5000);
      </script>`;
      const product = await publisher.readSourceProduct(page, { sourceId: '12345678901', sourceUrl: 'https://www.alibaba.com/product-detail/Sample_12345678901.html', title: 'Sample Phone' });
      const expected = module === 'missing' ? [] : module === 'late-iframe' ? ['https://sc04.alicdn.com/kf/main0.jpg_960x960.jpg']
        : [`https://sc04.alicdn.com/kf/${module === 'structured-data-only' ? 'structured' : 'detail'}.jpg`];
      assert.deepEqual(product.detailImages, expected, module);
      assert.doesNotMatch(product.descriptionHtml, /Report abuse|unrelated/, module);
      assert.equal(Boolean(product.descriptionHtml), module !== 'missing', module);
      assert.equal(product.sourcePriceRange.minPrice, '23.00');
      assert.equal(product.sourceCategoryId, '234567');
      assert.deepEqual(product.sourceCategoryPath, ['Parent', 'Leaf']);
    }
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
