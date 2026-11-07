import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { collectionUrls, crossPlatformPublishErrors, parseCollectionUrl, sourcePlatform } from '../server/source-platform.js';
import { extractMarketplaceProduct } from '../server/marketplace-source-data.js';
import { readMadeInChinaProduct } from '../server/made-in-china-source-data.js';
import { cacheMadeInChinaImages } from '../server/made-in-china-media.js';
import { createPublishPlan, productCategory } from '../server/category-routing.js';
import { ShopCollector } from '../server/collector.js';
import { preparePublishProduct, validateProductData, fillCategoryAttributes, fillLogisticsFields } from '../server/publisher.js';
import { recordProductMutation, syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { collectMadeInChinaShop, extractMadeInChinaListing } from '../server/made-in-china-shop.js';
import { createCategoryCatalog } from '../server/category-catalog-model.js';
import { CATEGORY_CATALOG } from '../server/category-catalog-data.js';
import { mapSourceCategory } from '../server/source-category-mapping.js';
import { applyReferencePreview, previewProductReference, referenceCandidates } from '../server/reference-workflow.js';

const url = 'https://supplier.en.made-in-china.com/product/bJtYPjzosqRf/China-Example-Product.html';
const schema = { '@context': 'https://schema.org', '@type': 'Product', name: 'LED Headlight', sku: '2061331682',
  image: Array.from({ length: 6 }, (_, i) => `https://image.made-in-china.com/main-${i}.webp`),
  offers: { '@type': 'Offer', url, price: '2.28', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  additionalProperty: [{ name: 'Voltage', value: '12V' }, { name: 'Light Color', value: 'Cool White' }],
};
// Minimal markup from the observed supplier templates, with synthetic content.
function document({ product = schema, prices = '', attributes = '', details = '', extra = '' } = {}) {
  return `<input id="productId" value="bJtYPjzosqRf"><h1 class="J-baseInfo-name">${product?.name || 'Custom Machine'}</h1>
    <script type="application/ld+json">${JSON.stringify(product)}</script>
    <div class="sr-proMainInfo-baseInfo-propertyPrice">${prices}</div>
    <div class="sample-order-info"><span class="sample-price">US$ 0.01/Piece</span></div>
    <dl class="product-attrs-list">${attributes}</dl>
    <section id="product"><div class="rich-text"><p>Supplier product details</p><img src="//www.micstatic.com/athena/img/transparent.png" data-original="//image.made-in-china.com/detail.webp">${details}</div></section>${extra}`;
}
const tierPrices = [[50, 499, '3.58'], [500, 4999, '3.08'], [5000, 9999, '2.58'], [10000, '', '2.28']].map(([min, max, price]) => `<li class="swiper-slide"><span class="swiper-money-container">US$${price}</span><div class="swiper-unit-container">${min}-${max} <span class="unit">Pieces</span></div></li>`).join('');
const parse = (html) => extractMarketplaceProduct(html, 'made-in-china', url);

test('maps descriptive source leaf names to Alibaba IDs without importing foreign IDs or guessing broader categories', () => {
  const catalog = createCategoryCatalog(CATEGORY_CATALOG.nodes);
  const product = { sourcePlatform: 'made-in-china', sourceCategoryId: 'foreign-id', sourceCategoryPath: ['Lights & Lighting', 'Outdoor Lighting', 'Solar Light'] };
  const matched = mapSourceCategory(product, catalog);
  assert.equal(matched.categoryId, '201730001');
  assert.deepEqual(matched.categoryPath, ['Renewable Energy', 'Solar Applications', 'Solar Light']);
  assert.equal(matched.categoryMapping.status, 'matched');
  assert.equal(mapSourceCategory({ ...product, sourceCategoryPath: ['LED Headlight'] }, catalog).categoryId, '127678021');
  assert.equal(mapSourceCategory({ ...product, sourceCategoryPath: ['Apparel', "Men's T-Shirts", 'Short Sleeve T-Shirt'] }, catalog).categoryId, '127734143');
  for (const patch of [{ categoryId: 'user-choice' }, { targetCategoryId: 'target-choice' }, { categoryReference: { referenceId: 'ref' } }, { sourcePlatform: 'alibaba.com' }]) {
    assert.deepEqual(mapSourceCategory({ ...product, ...patch }, catalog), {});
  }
  const broad = mapSourceCategory({ ...product, title: 'Men Cotton T-Shirt', sourceCategoryPath: ['Apparel', 'T-Shirt'] }, catalog);
  assert.equal(broad.categoryId, undefined);
  assert.ok(broad.categoryMapping.candidates.length > 1);
  const duplicate = createCategoryCatalog([{ id: '1', parentId: '0', name: 'Root', leaf: false }, { id: '2', parentId: '1', name: 'Solar Light', leaf: true }, { id: '3', parentId: '1', name: 'Solar Light', leaf: true }]);
  assert.equal(mapSourceCategory(product, duplicate).categoryId, undefined);
});

test('reads only a supplier shop product grid and keeps pagination inside the same shop or group', () => {
  const base = 'https://supplier.en.made-in-china.com/product-list-1.html';
  const next = base.replace('-1.html', '-2.html');
  const html = `<div class="prod-result-list"><div class="prod-result-item"><a href="${url}">title</a><a href="${url}">image</a><a href="${url.replace('supplier.en', 'unrelated.en')}">wrong supplier</a><a href="/inquiry">inquiry</a></div></div><a href="${url.replace('bJtYPjzosqRf', 'recommend123')}">recommendation</a><a class="next page-main" href="${next}">Next</a>`;
  const listing = extractMadeInChinaListing(html, base);
  assert.equal(listing.products.length, 1);
  assert.equal(listing.products[0].sourceId, 'bJtYPjzosqRf');
  assert.equal(listing.nextUrl, next);
  assert.equal(parseCollectionUrl('https://supplier.en.made-in-china.com/', 'shop-products').url, base);
  assert.equal(extractMadeInChinaListing(html.replace(next, next.replace('supplier.en', 'attacker.en')), base).nextUrl, '');
  const group = 'https://supplier.en.made-in-china.com/product-group/Abc123/Lights-catalog-1.html';
  assert.equal(extractMadeInChinaListing(html, group).nextUrl, '');
  assert.equal(parseCollectionUrl(group, 'shop-products').url, group);
  assert.throws(() => parseCollectionUrl('https://supplier.en.made-in-china.com.evil.test/', 'shop-products'));
  assert.throws(() => collectionUrls([base, base], 'shop-products', 'made-in-china'), /一个/);
});

test('resumes a paginated shop discovery checkpoint, deduplicates products and respects the collection limit', async () => {
  const link = parseCollectionUrl('https://supplier.en.made-in-china.com/', 'shop-products');
  const products = [0, 1, 2].map((index) => parseCollectionUrl(url.replace('bJtYPjzosqRf', `Product${index}`)));
  let checkpoint;
  const calls = [];
  const dependencies = {
    readListing: async (page) => {
      calls.push(page);
      return { readable: true, products: page.endsWith('-1.html') ? [products[0]] : [products[0], products[1], products[2]], nextUrl: page.replace('-1.html', '-2.html') };
    },
    collectLinks: async (links, progress, options) => links.filter((item) => !options.completedKeys?.includes(`made-in-china:${item.sourceId}`)),
  };
  const options = { startPage: 1, endPage: 5, maxProducts: 2, onCheckpoint: (state) => { checkpoint = structuredClone(state); } };
  await assert.rejects(collectMadeInChinaShop(link, () => false, options, dependencies), { code: 'COLLECT_PAUSED' });
  assert.equal(checkpoint.nextUrl.endsWith('-2.html'), true);
  const result = await collectMadeInChinaShop(link, () => {}, { ...options, checkpoint, completedKeys: ['made-in-china:Product0'] }, dependencies);
  assert.deepEqual(result.map((product) => product.sourceId), ['Product1']);
  assert.equal(calls.length, 2);
  assert.equal(checkpoint.stage, 'detail');
  await collectMadeInChinaShop(link, () => {}, { ...options, checkpoint }, dependencies);
  assert.equal(calls.length, 2, 'Detail resume must not rediscover the store');
  await assert.rejects(collectMadeInChinaShop(link, () => {}, { ...options, checkpoint, maxProducts: 3 }, dependencies), /断点/);
});

test('Made-in-China products can reference Alibaba successes from both 1688 and Alibaba sources, preserving source and commercial data', () => {
  for (const platform of ['1688', 'alibaba.com']) {
    const target = syncProductModel({ id: 'mic-target', ...parse(document({ prices: tierPrices })), status: 'ready', stock: 50 }, { captureSource: true });
    const original = structuredClone(target);
    const reference = { id: 'ref', sourcePlatform: platform, status: 'published', title: 'Accepted LED Headlight', categoryId: '127678021', categoryPath: ['Vehicle Parts & Accessories', 'Auto Lighting Systems', 'LED Headlights'],
      attributes: [{ name: 'Voltage', value: '24V' }], variantGroups: [{ name: 'Color', options: ['White'] }], skus: [{ attributes: { Color: 'White' }, price: 80, stock: 999 }] };
    const state = { products: [target, reference, { id: 'failed', status: 'publish_failed' }], jobs: [] };
    assert.deepEqual(referenceCandidates(state).map((entry) => [entry.id, entry.sourcePlatform]), [['ref', platform]]);
    const request = { ids: [target.id], referenceId: 'ref', options: { scope: 'full', preserveSkuStock: true } };
    const preview = previewProductReference(state, request);
    applyReferencePreview(state, { ...request, previewToken: preview.token });
    assert.equal(target.categoryId, '127678021');
    const payload = preparePublishProduct(target);
    assert.equal(payload.attributes.find((item) => item.name === 'Voltage').value, '24V');
    assert.ok(payload.skus.length > 0 && payload.skus.every((sku) => Number(sku.price) === Number(original.price)));
    for (const key of ['sourcePlatform', 'title', 'price', 'mainImages', 'detailImages', 'descriptionHtml', 'source']) assert.deepEqual(target[key], original[key], key);
    assert.equal(verifySourceIntegrity(target).valid, true);
  }
});

test('caches hotlink-protected images, rewrites descriptions and retains the immutable remote source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mic-image-test-'));
  try {
    const image = 'https://image.made-in-china.com/test.webp';
    const buffer = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).png().toBuffer();
    const source = { sourcePlatform: 'made-in-china', mainImages: [image], detailImages: [image], descriptionHtml: `<p>Details</p><img src="${image}">`, skus: [{ image }], variantGroups: [{ name: 'Color', options: ['Blue'], optionImages: { Blue: image } }] };
    let requests = 0;
    const fetcher = async () => { requests++; return new Response(buffer); };
    const product = await cacheMadeInChinaImages(source, root, { fetcher });
    assert.equal(requests, 1);
    assert.match(product.mainImage, /^\/media\/mic-[a-f0-9]+\.png$/);
    assert.equal(product.mainImage, product.detailImages[0]);
    assert.equal(product.skus[0].image, product.mainImage);
    assert.equal(product.variantGroups[0].optionImages.Blue, product.mainImage);
    assert.ok(product.descriptionHtml.includes(product.mainImage));
    assert.deepEqual(product._collectedSnapshot, source);
    assert.equal(source.mainImages[0], image);
    assert.deepEqual(await fs.readFile(path.join(root, 'media', path.basename(product.mainImage))), buffer);
    await cacheMadeInChinaImages(source, root, { fetcher });
    assert.equal(requests, 1, 'valid persisted images are reused after restarting a collection');
    const failed = await cacheMadeInChinaImages({ ...source, mainImages: [image + '?missing'], detailImages: [], skus: [], variantGroups: [] }, root, { fetcher: async () => new Response('Forbidden', { status: 403 }) });
    assert.match(failed.collectWarning, /1 张来源图片/);
    assert.equal(failed.mainImage, image + '?missing');
    let redirected = 0;
    await cacheMadeInChinaImages({ ...source, mainImages: [image + '?redirect'], detailImages: [], skus: [], variantGroups: [] }, root, { fetcher: async () => { redirected++; return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }); } });
    assert.equal(redirected, 1);
  } finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
});

test('reads public server-rendered product data and falls back for challenges without following unrelated redirects', async () => {
  const html = () => new Response(document({ prices: tierPrices }), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  const product = await readMadeInChinaProduct(url, { fetcher: async () => html() });
  assert.equal(product.price, '3.58');
  for (const response of [new Response('Forbidden', { status: 403 }), new Response('<script>challenge()</script>', { headers: { 'content-type': 'text/html' } }), new Response('binary', { headers: { 'content-type': 'application/octet-stream' } }), new Response('', { headers: { 'content-type': 'text/html', 'content-length': String(7 * 1024 * 1024) } })]) {
    assert.equal(await readMadeInChinaProduct(url, { fetcher: async () => response }), null);
  }
  for (const location of ['http://127.0.0.1/private', url.replace('bJtYPjzosqRf', 'OtherProduct')]) {
    let requests = 0;
    assert.equal(await readMadeInChinaProduct(url, { fetcher: async () => { requests++; return new Response('', { status: 302, headers: { location } }); } }), null);
    assert.equal(requests, 1);
  }
  let requests = 0;
  assert.equal((await readMadeInChinaProduct(url, { fetcher: async () => ++requests === 1 ? new Response('', { status: 302, headers: { location: url + '?updated=1' } }) : html() })).sourceId, 'bJtYPjzosqRf');
  assert.equal(requests, 2);
  assert.equal(await readMadeInChinaProduct(url, { fetcher: async () => { throw new Error('Network unavailable'); } }), null);
});

test('accepts Made-in-China product URLs without losing opaque IDs or trusting lookalike hosts', () => {
  assert.equal(parseCollectionUrl(url, 'product', 'made-in-china').sourceId, 'bJtYPjzosqRf');
  assert.equal(sourcePlatform({ sourceUrl: url, sourcePlatform: 'alibaba.com' }), 'made-in-china');
  assert.equal(collectionUrls([url, `${url}?from=search`], 'product', 'made-in-china').length, 1);
  assert.equal(collectionUrls([url, url.replace('bJtYPjzosqRf', 'BJTYPJZOSQRF')], 'product', 'made-in-china').length, 2);
  for (const invalid of [url.replace('.com/', '.com.attacker.example/'), url.replace('https://', 'https://user:pass@'), url.replace('.com/', '.com:8787/'), 'https://www.made-in-china.com/', 'https://supplier.en.made-in-china.com/product-list-1.html']) assert.throws(() => parseCollectionUrl(invalid, 'product', 'made-in-china'));
  assert.throws(() => parseCollectionUrl(url, 'product', 'alibaba.com'));
});

test('preserves actual tier quantities instead of using the cheapest bulk or sample price', () => {
  const product = parse(document({ prices: tierPrices }));
  assert.equal(product.price, '3.58');
  assert.equal(product.moq, 50);
  assert.equal(product.currencySymbol, '$');
  assert.equal(product.salesUnit, 'Pieces');
  assert.deepEqual(product.priceTiers.map((tier) => [tier.minQuantity, tier.price]), [[50, '3.58'], [500, '3.08'], [5000, '2.58'], [10000, '2.28']]);
  assert.equal(product.sourcePriceRange, null);
  assert.equal(product.stock, undefined);
  assert.deepEqual(product.skus, []);
});

test('preserves range pricing, lazy description images and explicitly measured packaging across categories', () => {
  const product = parse(document({ product: { ...schema, name: 'Men&apos;s Cotton T-Shirt' },
    prices: '<span class="only-one-priceNum-td-left">US$14.00-15.00</span><span class="only-one-priceNum-price">20 Pieces(MOQ)</span>',
    attributes: '<dt>Package Size</dt><dd>400.00cm * 300.00cm * 10.00cm</dd><dt>Package Gross Weight</dt><dd>4.000kg</dd><dt>Transport Package</dt><dd>Carton</dd><dt>Production Capacity</dt><dd>1,000,000 Pieces</dd><dt>Size</dt><dd>XS,S,M,L,XL/Customized</dd>',
  }));
  assert.equal(product.title, "Men's Cotton T-Shirt");
  assert.deepEqual(product.detailImages, ['https://image.made-in-china.com/detail.webp']);
  assert.ok(!product.descriptionHtml.includes('transparent.png'));
  assert.deepEqual(product.packaging, { weight: '4', length: '400', width: '300', height: '10', description: 'Carton' });
  assert.equal(product.sourcePriceRange.maxPrice, '15.00');
  assert.equal(product.fobPrice.maxPrice, '15.00');
  assert.equal(product.priceMode, 'fob-range');
  assert.equal(product.moq, 20);
  assert.deepEqual(product.variantGroups, []);
  assert.equal(product.stock, undefined);
});

test('collects inquiry-only goods without inventing prices from samples, capacity or unrelated recommendations', () => {
  const product = parse(document({ product: { ...schema, name: 'Industrial Pump', offers: undefined },
    prices: 'Negotiable / Contact Supplier', attributes: '<dt>Production Capacity</dt><dd>10000 Sets/Year</dd><dt>Specification</dt><dd>100*200*300</dd><dt>Item Weight</dt><dd>7kg</dd>',
    extra: '<div class="recommended"><h1>Wrong</h1><table><tr><td>Weight</td><td>100 kg</td></tr></table><img src="https://image.made-in-china.com/recommend.jpg">US$1</div>',
  }));
  assert.equal(product.price, '');
  assert.equal(product.moq, '');
  assert.deepEqual(product.priceTiers, []);
  assert.deepEqual(product.packaging, {});
  assert.match(product.collectWarning, /询价/);
  assert.equal(product.attributes.some((item) => item.name === 'Weight'), false);
  assert.ok(!product.mainImages.some((image) => image.includes('recommend')));
  assert.ok(validateProductData(preparePublishProduct({ ...product, categoryId: '123', currencySymbol: '$' })).includes('销售价格无效'));
});

test('rejects mismatched product redirects and treats supplier scripts and active description markup as untrusted data', () => {
  assert.throws(() => parse(document().replace('value="bJtYPjzosqRf"', 'value="otherProduct"')), /不一致/);
  assert.throws(() => parse(document({ extra: '<link rel="canonical" href="https://supplier.en.made-in-china.com/product/OtherId123/China-Other.html">' })), /不一致/);
  const product = parse(document({ details: '<script>throw new Error("executed")</script><iframe src="https://attacker.example"></iframe><img src="https://image.made-in-china.com/two.jpg" onerror="alert(1)"><a href="javascript:alert(1)">bad link</a><div style="background:url(https://attacker.example)">Text</div>' }));
  assert.doesNotMatch(product.descriptionHtml, /script|iframe|onerror|javascript|attacker/);
  assert.equal(product.detailImages.length, 2);
  const challenge = parse('<title>Verify your identity</title><h1>Verify</h1><img src="https://image.made-in-china.com/captcha.jpg">');
  assert.equal(challenge.title, '');
  assert.equal(challenge.mainImages.length, 0);
});

test('keeps only explicit sparse variant combinations and does not treat the listing ID as a SKU', () => {
  const hasVariant = [
    { sku: 'a', color: 'Black', size: 'S', offers: { price: 12, priceCurrency: 'USD' } },
    { sku: 'b', color: 'Black', size: 'M', offers: { price: 13, priceCurrency: 'USD' } },
    { sku: 'c', color: 'White', size: 'S' },
  ];
  const product = parse(document({ product: { ...schema, '@type': 'ProductGroup', hasVariant } }));
  assert.equal(product.skus.length, 3);
  assert.deepEqual(product.skus.map((sku) => [sku.id, sku.attributes.Color, sku.attributes.Size, sku.price]), [['a', 'Black', 'S', '12'], ['b', 'Black', 'M', '13'], ['c', 'White', 'S', '']]);
  assert.equal(product.skus.some((sku) => sku.attributes.Color === 'White' && sku.attributes.Size === 'M'), false);
  assert.deepEqual(product.sourceStructuredEvidence.skuIds, ['a', 'b', 'c']);
});

test('routes Made-in-China goods to an explicit Alibaba category and publishes saved edits without altering the original snapshot', () => {
  const product = syncProductModel({ id: 'mic', ...parse(document({ prices: tierPrices })) }, { captureSource: true });
  assert.deepEqual(productCategory({ ...product, sourceCategoryId: 'wrong-mic-id' }), { id: '', path: [], pathText: '', pathKey: '' });
  assert.deepEqual(crossPlatformPublishErrors(product), ['请选择国际站目标类目']);
  recordProductMutation(product, { title: 'My Brand LED Headlight', categoryId: '127666033', categoryPath: ['Auto', 'LED Headlights'], price: '5.5', priceTiers: [{ minQuantity: 50, price: '5.5' }], attributes: [{ name: 'Voltage', value: '24V' }, { name: 'Light Color', value: 'Natural White' }] });
  const payload = preparePublishProduct(product);
  assert.deepEqual(validateProductData(payload, { mode: 'draft' }), []);
  assert.equal(payload.price, '5.5');
  assert.equal(payload.attributes[0].value, '24V');
  assert.equal(verifySourceIntegrity(product).valid, true);
  assert.equal(product.source.snapshot.sourcePrice, '3.58');
  const [plan] = createPublishPlan([payload]);
  assert.equal(plan.sourcePlatform, 'made-in-china');
  assert.match(plan.url, /catId=127666033/);
});

test('reads Made-in-China in the collection browser and fills saved attributes and packaging into the posting controls', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: 'text/html', body: document({ prices: tierPrices, attributes: '<dt>Package Gross Weight</dt><dd>500g</dd><dt>Package Size</dt><dd>185mm * 55mm * 130mm</dd>' }) }) : route.abort());
    const collector = new ShopCollector(os.tmpdir());
    const product = await collector.readMarketplaceDetail(page, { sourceUrl: url, sourceId: 'bJtYPjzosqRf' });
    assert.equal(product.title, 'LED Headlight');
    assert.equal(product.priceTiers.length, 4);
    assert.equal(product.sourcePlatform, 'made-in-china');
    const payload = preparePublishProduct({ ...product, categoryId: '127666033', attributes: [{ name: 'Voltage', value: '24V' }] });
    await page.setContent('<div class="sell-catProp-item"><div class="label">电压</div><input></div><div id="pkgMeasure"><input placeholder="长"><input placeholder="宽"><input placeholder="高"></div><div id="pkgWeight"><input placeholder="毛重"></div>');
    await fillCategoryAttributes(page, payload);
    assert.equal(await page.locator('.sell-catProp-item input').inputValue(), '24V');
    // Test the same logistics filler used by draft and direct publication.
    await fillLogisticsFields(page, payload.packaging);
    assert.equal(await page.getByPlaceholder('长', { exact: true }).inputValue(), '18.5');
    assert.equal(await page.getByPlaceholder('毛重').inputValue(), '0.5');
  } finally { await browser.close(); }
});
