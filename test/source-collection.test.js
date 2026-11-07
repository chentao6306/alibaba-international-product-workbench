import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { extractAlibabaDescription, extractAlibabaSourceData, requireAlibabaSourceProduct } from '../server/alibaba-source-data.js';
import { auditProduct } from '../server/product-model.js';
import { findChromium } from '../server/browser-runtime.js';
import { hasCompleteSourceData, SellerPublisher } from '../server/publisher.js';
import { SOURCE_ATTRIBUTE_SCHEMA_VERSION } from '../server/category-attributes.js';
import { readSourceDescriptionFrame, waitForSourceDetailVideos } from '../server/source-description-frame.js';

test('reports an unresolved native detail video without waiting on unrelated players and preserves cancellation', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-module-name="module_recommend"><video></video></div>');
    assert.deepEqual(await waitForSourceDetailVideos(page), { modules: 0, ready: 0, pending: false });
    await page.setContent('<div data-module-name="module_detail_video"></div>');
    assert.deepEqual(await waitForSourceDetailVideos(page), { modules: 0, ready: 0, pending: false });
    await page.setContent('<div data-module-name="module_detail_video"><video></video></div>');
    const capture = await waitForSourceDetailVideos(page, { timeoutMs: 50 });
    assert.deepEqual(capture, { modules: 1, ready: 0, pending: true });
    assert.ok(auditProduct({ dataCompleteness: { detailVideoCapture: capture } }).issues.some(issue => issue.code === 'media.detail.video.pending'));
    await assert.rejects(waitForSourceDetailVideos(page, { shouldStop: () => true }), { code: 'COLLECT_PAUSED' });
  } finally { await browser.close(); }
});

test('description iframes reject redirected error pages and full product pages instead of importing navigation or recommended images', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    let content = '<title>404-Error</title><nav>All categories</nav><img src="https://sc04.alicdn.com/kf/recommended.jpg">';
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: content }));
    for (const url of ['https://error.alibaba.com/error404.htm', 'https://www.alibaba.com/product-detail/description/descIframe.html']) {
      await page.setContent(`<iframe src="${url}"></iframe>`);
      await page.locator('iframe').contentFrame().locator('nav').waitFor();
      assert.equal(await readSourceDescriptionFrame(page, { selector: 'iframe', timeoutMs: 1 }), null);
    }
    content = '<title>Related product</title><div data-module-name="module_gallery"><img src="https://sc04.alicdn.com/kf/recommended.jpg"></div>';
    await page.setContent('<iframe src="https://www.alibaba.com/other.html"></iframe>');
    await page.locator('iframe').contentFrame().locator('[data-module-name]').waitFor();
    assert.equal(await readSourceDescriptionFrame(page, { selector: 'iframe', timeoutMs: 1 }), null);
    content = '<div id="detail_decorate_root"><p>Original description</p><img src="https://sc04.alicdn.com/kf/original.jpg"></div>';
    await page.setContent('<iframe src="https://www.alibaba.com/valid.html"></iframe>');
    await page.locator('iframe').contentFrame().locator('#detail_decorate_root').waitFor();
    const detail = await readSourceDescriptionFrame(page, { selector: 'iframe', timeoutMs: 1 });
    assert.deepEqual(detail.images.map(image => image.src), ['https://sc04.alicdn.com/kf/original.jpg']);
    assert.equal(detail.text, 'Original description');
    content = '<img src="https://sc04.alicdn.com/kf/unrelated.jpg"><div id="J-rich-text-description"><div class="is-magic"><div id="detail_decorate_root">\n\n</div><div class="mceSectionContainer">Original product details<img src="https://sc04.alicdn.com/kf/first.jpg"></div><div><img src="https://sc04.alicdn.com/kf/second.jpg"></div></div></div>';
    await page.setContent('<iframe src="https://www.alibaba.com/magic.html"></iframe>');
    await page.locator('iframe').contentFrame().locator('#J-rich-text-description').waitFor();
    const magic = await readSourceDescriptionFrame(page, { selector: 'iframe', timeoutMs: 1 });
    assert.deepEqual(magic.images.map(image => image.src), ['https://sc04.alicdn.com/kf/first.jpg', 'https://sc04.alicdn.com/kf/second.jpg']);
    assert.doesNotMatch(magic.html, /unrelated/);
  } finally { await browser.close(); }
});

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
    productDetails: { details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/second.jpg' }, { type: 'text', text: 'After second image' }, { type: 'image', url: 'https://sc04.alicdn.com/kf/first.jpg' }] },
    recommendProductInfo: { details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/unrelated.jpg' }] }
  } } } });
  assert.deepEqual(description.images, ['https://sc04.alicdn.com/kf/first.jpg', 'https://sc04.alicdn.com/kf/second.jpg']);
  assert.match(description.html, /Product &lt;detail&gt;/);
  assert.doesNotMatch(description.html, /unrelated/);
  assert.match(description.html, /first.jpg[\s\S]*Product &lt;detail&gt;[\s\S]*second.jpg[\s\S]*After second image[\s\S]*first.jpg/);
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

test('does not accept a redirected search page or another product as the requested source', { skip: !findChromium() }, async () => {
  const url = 'https://www.alibaba.com/product-detail/Charger_1601576374050.html';
  assert.doesNotThrow(() => requireAlibabaSourceProduct(url + '?language=en', '1601576374050'));
  for (const [value, text] of [[url, 'This product is currently unavailable. See similar products below.'],
    [url.replace('1601576374050', '1601576374051'), ''], ['https://www.alibaba.com/search/page?productId=1601576374050', '']]) {
    assert.throws(() => requireAlibabaSourceProduct(value, '1601576374050', text), { code: 'SOURCE_PRODUCT_UNAVAILABLE' });
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url() === url
      // Keep the redirect navigation inside the browser fixture; fulfilled
      // HTTP redirects may bypass routing and accidentally contact Alibaba.
      ? route.fulfill({ contentType: 'text/html', body: '<script>location.replace("https://www.alibaba.com/search/page?productId=1601576374050")</script>' })
      : route.fulfill({ contentType: 'text/html', body: '<h1>This product is currently unavailable. See similar products below.</h1><table><tr><td>Material</td><td>Steel</td></tr></table><img src="https://sc04.alicdn.com/kf/unrelated.jpg">' }));
    const publisher = new SellerPublisher(os.tmpdir());
    await assert.rejects(publisher.readSourceProduct(page, { sourceId: '1601576374050', sourceUrl: url }), { code: 'SOURCE_PRODUCT_UNAVAILABLE' });
  } finally { await browser.close(); }
});

test('source navigation is reread once before persistence while cancellation and other failures remain visible', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const context = await browser.newContext();
  const publisher = new SellerPublisher(os.tmpdir());
  publisher.sourceBrowser = async () => context;
  const products = [{ sourceId: 'first' }, { sourceId: 'second' }];
  const attempts = [], saved = [];
  publisher.readSourceProduct = async (_page, product) => {
    attempts.push(product.sourceId);
    if (attempts.length === 1) throw new Error('locator.evaluateAll: Execution context was destroyed, most likely because of a navigation');
    return { ...product, attributes: [{ name: 'Material', value: 'ABS' }] };
  };
  try {
    const result = await publisher.enrichSourceProducts(products, (_done, _total, product) => { saved.push(product.sourceId); });
    assert.deepEqual(attempts, ['first', 'first', 'second']);
    assert.deepEqual(saved, ['first', 'second']);
    assert.equal(result[0].attributes[0].value, 'ABS');
    for (const [error, expectedCalls] of [
      [new Error('Execution context was destroyed'), 2],
      [new Error('Source attributes missing'), 1],
      [Object.assign(new Error('CAPTCHA required'), { code: 'HUMAN_VERIFICATION_REQUIRED' }), 1],
    ]) {
      let calls = 0;
      publisher.readSourceProduct = async () => { calls++; throw error; };
      publisher.completeSourceVerification = async () => { throw error; };
      await assert.rejects(publisher.enrichSourceProducts(products, () => { throw new Error('Must not persist failed data'); }));
      assert.equal(calls, expectedCalls);
    }
    let cancelled = false, calls = 0;
    publisher.readSourceProduct = async () => { calls++; cancelled = true; throw new Error('Execution context was destroyed'); };
    await assert.rejects(publisher.enrichSourceProducts(products, () => {}, { shouldStop: () => cancelled }), { code: 'COLLECT_PAUSED' });
    assert.equal(calls, 1);
  } finally { await browser.close(); }
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
    let mainModule = 'data-module-name="module_gallery"';
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.abort();
      if (route.request().url().includes('/descIframe.html')) return route.fulfill({ contentType: 'text/html',
        body: '<div id="detail_decorate_root"><p>Original product description with a picture also used in its gallery.</p><img data-src="https://sc04.alicdn.com/kf/main0.jpg_960x960.jpg"><table><tr><td>Package Weight</td><td>185g</td></tr></table><video src="https://video.example/detail.mp4"></video></div>' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html lang="en"><body><h1>Sample Phone</h1>${gallery}
        <div ${mainModule}><video src="https://video.example/main.mp4"></video></div>
        <nav class="breadcrumb"><a href="https://www.alibaba.com/parent_cid123456.html">Parent</a><a href="https://www.alibaba.com/leaf_cid234567.html">Leaf</a></nav>
        <div data-testid="module-attribute-row"><span data-testid="module-attribute-name">Place of Origin</span><span data-testid="module-attribute-value">China</span></div>
        <div data-testid="module-attribute-row"><span data-testid="module-attribute-name">Material</span><span data-testid="module-attribute-value">Plastic</span></div>
        <table><tr><td>Age Range</td><td>3-6 years</td></tr></table>
        <dl><dt>Single gross weight</dt><dd>250 g</dd><dt>Single package size (cm)</dt><dd>30x20x10</dd></dl>
        <div data-module-name="module_recommend"><img src="https://sc04.alicdn.com/kf/unrelated.jpg_960x960.jpg"><video src="https://video.example/unrelated.mp4"></video><p>This product is currently unavailable</p></div>
        <div data-module-name="module_review"><p>Store reviews</p><p>This product is no longer available</p></div>
        <script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://video.example/detail.mp4"}</script>
        ${description}<script>window.detailData = ${JSON.stringify({ globalData: { product: { customPrice: { fixedDollarPrice: 23 }, attributes: [
          { id: 123, name: 'Animal', values: [{ id: 456, name: 'Bee' }] },
        ] } }, nodeMap: { recommendations: { categoryId: 999999 }, module_description: { privateData, renderType } } })};</script>
        </body></html>` });
    });
    for (const module of ['module_structure_description', 'module_description', 'missing', 'structured-data-only', 'late-iframe', 'native-structured-dom', 'native-structured-dom-no-images-with-data', 'lazy-detail-video', 'late-iframe-with-policy']) {
      mainModule = module === 'module_structure_description' ? 'data-testid="main-image-media-frame"' : 'data-module-name="module_gallery"';
      description = ['native-structured-dom', 'native-structured-dom-no-images-with-data'].includes(module)
        ? `<section data-module-name="module_structure_descption_productDescription"><h2 data-testid="product-detail-title">Supplier product description</h2><div>Product highlights</div><p data-testid="product-detail-text-sort">TPE material protects the fairing.</p><p data-testid="product-detail-text-sort">Vented design improves comfort.</p>${module === 'native-structured-dom' ? '<div data-testid="product-detail-image-simple"><img src="https://sc04.alicdn.com/kf/structured-detail.jpg"></div>' : ''}</section>
          <section data-module-name="module_structure_descption_companyInfo"><h2 data-testid="product-detail-title">About this supplier</h2><p data-testid="product-detail-text">Established in 2019.</p><h3 data-testid="product-detail-title">Company overview</h3>${module === 'native-structured-dom' ? '<div data-testid="product-detail-image-simple"><img src="https://sc04.alicdn.com/kf/company-overview.jpg"></div>' : ''}</section>
          <section data-module-name="module_structure_descption_faqInfo"><h2 data-testid="product-detail-title">FAQs</h2><div data-testid="product-detail-qa"><div><div>Who are we?</div><div>A trading company.</div></div><div><div>What do we supply?</div><div>Motorcycle parts.</div></div></div></section>`
        : ['missing', 'structured-data-only'].includes(module) ? '' : `<div data-module-name="${module}">
        <div data-module-name="module_report">Report abuse</div><p>Source specification</p><img data-src="https://sc04.alicdn.com/kf/detail.jpg">
        <table><tr><td>原产地</td><td>Japan</td></tr></table>
        </div>`;
      privateData = module === 'structured-data-only' ? { productDescription: { details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/structured.jpg' }] } }
        : module === 'native-structured-dom-no-images-with-data' ? { productDescription: { title: 'Fallback data', details: [{ type: 'text', text: 'Wrong fallback highlights.' }] } } : {};
      renderType = module === 'late-iframe' ? 'js_ssr' : '';
      if (module === 'late-iframe') description = `<div data-module-name="module_description">Supplier description</div><script>
        setTimeout(()=>{const frame=document.createElement('iframe');frame.src='https://www.alibaba.com/product-detail/description/descIframe.html';document.querySelector('[data-module-name="module_description"]').append(frame);},5000);
      </script>`;
      if (module === 'late-iframe-with-policy') description = `<div data-module-name="module_description"><h2>Product descriptions from the supplier</h2>
        <div data-module-name="module_risk_control_tips">${'California Proposition 65 Consumer Warning '.repeat(6)}</div>
        <div data-module-name="module_product_specification"><div></div></div></div><script>
        setTimeout(() => { const frame = document.createElement('iframe'); frame.src = 'https://www.alibaba.com/product-detail/description/descIframe.html';
          document.querySelector('[data-module-name="module_product_specification"]').append(frame); }, 5000);
      </script>`;
      if (module === 'lazy-detail-video') description = `<div data-module-name="module_description"><p>Source specification</p><img data-src="https://sc04.alicdn.com/kf/detail.jpg">
        <div data-module-name="module_detail_video" style="margin-top:1800px;height:200px"><div class="widget-detail-video">Video Description</div></div></div><script>
        const target = document.querySelector('[data-module-name="module_detail_video"]');
        const observer = new IntersectionObserver(entries => {
          if (!entries.some(entry => entry.intersectionRatio > 0.8)) return;
          observer.disconnect();
          setTimeout(() => { target.innerHTML = '<video src="https://video.example/detail.mp4"></video>'; }, 1200);
        }, { threshold: 0.8 }); observer.observe(target);
      </script>`;
      const product = await publisher.readSourceProduct(page, { sourceId: '12345678901', sourceUrl: 'https://www.alibaba.com/product-detail/Sample_12345678901.html', title: 'Sample Phone' });
      const expected = ['missing', 'native-structured-dom-no-images-with-data'].includes(module) ? [] : module.startsWith('late-iframe') ? ['https://sc04.alicdn.com/kf/main0.jpg_960x960.jpg']
        : module === 'native-structured-dom' ? ['https://sc04.alicdn.com/kf/structured-detail.jpg', 'https://sc04.alicdn.com/kf/company-overview.jpg']
        : [`https://sc04.alicdn.com/kf/${module === 'structured-data-only' ? 'structured' : 'detail'}.jpg`];
      assert.deepEqual(product.detailImages, expected, module);
      assert.doesNotMatch(product.descriptionHtml, /Report abuse|unrelated|California Proposition/, module);
      assert.equal(Boolean(product.descriptionHtml), module !== 'missing', module);
      if (['native-structured-dom', 'native-structured-dom-no-images-with-data'].includes(module)) {
        assert.deepEqual(product.structuredDescription.modules.map(item => item.type), module === 'native-structured-dom'
          ? ['highlights', 'gallery', 'company', 'gallery', 'faq'] : ['highlights', 'company', 'faq']);
        assert.deepEqual(product.structuredDescription.modules[0].items, ['TPE material protects the fairing.', 'Vented design improves comfort.']);
        const company = product.structuredDescription.modules.find(item => item.type === 'company');
        const faq = product.structuredDescription.modules.find(item => item.type === 'faq');
        assert.equal(company.text, 'Established in 2019.');
        if (module === 'native-structured-dom') {
          const companyGallery = product.structuredDescription.modules.find(item => item.type === 'gallery' && item.scope === 'company');
          assert.equal(companyGallery.title, 'Company overview');
        }
        assert.deepEqual(faq.items, [
          { question: 'Who are we?', answer: 'A trading company.' },
          { question: 'What do we supply?', answer: 'Motorcycle parts.' }
        ]);
        if (module === 'native-structured-dom-no-images-with-data') assert.doesNotMatch(product.descriptionHtml, /Wrong fallback highlights/);
      }
      assert.equal(product.sourcePriceRange.minPrice, '23.00');
      assert.equal(product.sourceCategoryId, '234567');
      assert.deepEqual(product.sourceCategoryPath, ['Parent', 'Leaf']);
      assert.equal(product.attributes.find((item) => item.name === 'Age Range').value, '3-6 years');
      assert.deepEqual(product.attributes.find((item) => item.name === 'Animal').valueIds, { Bee: '456' });
      assert.equal(product.origin, 'China');
      assert.deepEqual(product.packaging, { weight: '0.25', length: '30', width: '20', height: '10' });
      assert.equal(product.sourceAttributeSchemaVersion, SOURCE_ATTRIBUTE_SCHEMA_VERSION);
      assert.equal(product.videoUrl, 'https://video.example/main.mp4');
      assert.equal(product.videos.some((item) => /unrelated/.test(item.url)), false);
      if (module === 'lazy-detail-video') {
        assert.deepEqual(product.dataCompleteness.detailVideoCapture, { modules: 1, ready: 1, pending: false });
        assert.equal(product.videos.find(item => item.role === 'detail' && item.source === 'dom')?.url, 'https://video.example/detail.mp4');
      }
      if (module.startsWith('late-iframe')) {
        assert.equal(product.attributes.find((item) => item.name === 'Package Weight').value, '185g');
        assert.equal(product.attributes.find((item) => item.name === 'Package Weight').source, 'description-iframe');
        assert.equal(product.videos.find((item) => item.role === 'detail')?.url, 'https://video.example/detail.mp4');
      }
      if (['module_structure_description', 'module_description'].includes(module)) {
        assert.equal(product.attributes.find((item) => item.name === '原产地').source, 'description-dom');
        assert.match(product.descriptionHtml, /Japan/);
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
