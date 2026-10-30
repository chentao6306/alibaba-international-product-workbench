import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { collectionUrls, convertProductPrices, crossPlatformPublishErrors, parseCollectionUrl, sourcePlatform } from '../server/source-platform.js';
import { extractMarketplaceProduct, readAssignedJson, marketplaceDescriptionHtml } from '../server/marketplace-source-data.js';
import { createPublishPlan, productCategory } from '../server/category-routing.js';
import { ShopCollector } from '../server/collector.js';
import { JsonStore } from '../server/store.js';
import { auditProduct, recordProductMutation, syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

test('preserves image-search parameters and rejects mismatched and untrusted collection hosts', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=imageTextSearch&imagePath=https%3A%2F%2Fimage.example%2Ftest.jpeg&regions=%5B%22102%2C207%22%5D&tab=all';
  assert.equal(parseCollectionUrl(url, 'image-search', 'alibaba.com').url, url);
  assert.equal(parseCollectionUrl('https://detail.1688.com/offer/123456789.html').platform, '1688');
  assert.equal(parseCollectionUrl('https://www.aliexpress.us/item/3256808420121881.html').sourceId, '3256808420121881');
  assert.throws(() => parseCollectionUrl('https://alibaba.com.attacker.example/product-detail/X_123456789.html'));
  assert.throws(() => parseCollectionUrl('https://detail.1688.com/offer/123456789.html', 'product', 'alibaba.com'));
  assert.throws(() => parseCollectionUrl('https://user:pass@www.alibaba.com/product-detail/X_123456789.html'));
  assert.throws(() => parseCollectionUrl('https://www.alibaba.com/search/page', 'image-search'));
  assert.equal(collectionUrls(['https://detail.1688.com/offer/123456789.html?a=1', 'https://detail.1688.com/offer/123456789.html?a=2'], 'product').length, 1);
});

test('keeps domestic taxonomy out of international routing and separates platform groups', () => {
  const domestic = { id: 'd', sourceUrl: 'https://detail.1688.com/offer/123456789.html', sourceCategoryId: '123456', sourceCategoryPath: ['Domestic category'] };
  assert.deepEqual(productCategory(domestic), { id: '', path: [], pathText: '', pathKey: '' });
  assert.equal(sourcePlatform({ ...domestic, sourcePlatform: 'alibaba.com' }), '1688');
  const groups = createPublishPlan([{ ...domestic, categoryId: '201745901' }, { id: 'a', categoryId: '201745901' }]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.url.includes('catId=201745901')));
  assert.deepEqual(new Set(groups.map((group) => group.sourcePlatform)), new Set(['1688', 'alibaba.com']));
});

test('parses AliExpress structured SKU identities, prices and detail images without recommendation data', () => {
  const data = { data: {
    productInfoComponent: { subject: 'Wired Stereo Headphones' },
    imageComponent: { imagePathList: ['//ae01.alicdn.com/kf/main.jpg'] },
    skuComponent: { productSKUPropertyList: [{ skuPropertyId: 14, skuPropertyName: 'Color', skuPropertyValues: [
      { propertyValueId: 193, propertyValueName: 'Black' }, { propertyValueId: 29, propertyValueName: 'White' },
    ] }], skuPriceList: [
      { skuId: 'first', skuAttr: '14:193#Black', skuVal: { skuAmount: { value: 12.5 }, availQuantity: 6 } },
      { skuId: 'second', skuAttr: '14:29#White', skuVal: { skuAmount: { value: 14 }, availQuantity: 0 } },
    ] },
    currencyCode: 'USD', specs: [{ attrName: 'Material', attrValue: 'Plastic' }],
    recommendedProducts: [{ imageList: ['https://ae01.alicdn.com/kf/unrelated.jpg'], attrName: 'Wrong', attrValue: 'Value' }],
  } };
  const html = `<script>window.runParams = ${JSON.stringify(data)};</script><div id="product-description"><img data-src="//ae01.alicdn.com/kf/detail.jpg"><p>Original detail</p></div>`;
  const result = extractMarketplaceProduct(html, 'aliexpress', 'https://www.aliexpress.com/item/123456789.html');
  assert.equal(result.title, 'Wired Stereo Headphones');
  assert.deepEqual(result.mainImages, ['https://ae01.alicdn.com/kf/main.jpg']);
  assert.deepEqual(result.detailImages, ['https://ae01.alicdn.com/kf/detail.jpg']);
  assert.deepEqual(result.skus.map((sku) => [sku.id, sku.attributes.Color, sku.price, sku.stock]), [['first', 'Black', '12.5', 6], ['second', 'White', '14', 0]]);
  assert.equal(result.currencySymbol, '$');
  assert.equal(result.categoryId, '');
  assert.equal(result.attributes.length, 1);
  assert.equal(readAssignedJson('window.runParams = {evil: process.exit()};', 'runParams'), null);
});

test('parses domestic tiers and SKU combinations in yuan without inventing missing prices', () => {
  const data = { subject: '测试耳机', images: ['https://cbu01.alicdn.com/main.jpg'], categoryId: 8888,
    skuProps: [{ prop: '颜色', value: [{ name: '黑色' }, { name: '白色' }] }],
    skuMap: { 黑色: { skuId: 1, price: '70', canBookCount: 12 }, 白色: { skuId: 2, canBookCount: 0 } },
    priceRanges: [{ beginAmount: 2, price: '70' }, { beginAmount: 10, price: '60' }],
  };
  const result = extractMarketplaceProduct(`<script>window.__INIT_DATA = ${JSON.stringify(data)};</script>`, '1688', 'https://detail.1688.com/offer/123456789.html');
  assert.equal(result.currencySymbol, '¥');
  assert.equal(result.sourceCategoryId, '8888');
  assert.equal(result.categoryId, '');
  assert.equal(result.skus[1].price, '');
  assert.equal(result.skus[1].stock, 0);
  assert.equal(result.priceTiers[1].price, '60');
  assert.equal(result.moq, 2);
});

test('converts all price modes and preserves the immutable original prices', () => {
  const product = syncProductModel({ id: 'd', sourceUrl: 'https://detail.1688.com/offer/123456789.html', title: '测试耳机', price: '70', currencySymbol: '¥',
    priceTiers: [{ minQuantity: 2, price: '70' }], skus: [{ id: 'a', price: '84' }], fobPrice: { minPrice: 70, maxPrice: 84, tiers: [{ price: 70 }] } }, { captureSource: true });
  const snapshot = structuredClone(product.source.snapshot);
  assert.equal(crossPlatformPublishErrors(product).length, 3);
  recordProductMutation(product, { ...convertProductPrices(product, 0.14), title: 'Wired Headphones', categoryId: '201745901' });
  assert.equal(product.price, '9.80');
  assert.equal(product.skus[0].price, '11.76');
  assert.equal(product.fobPrice.maxPrice, '11.76');
  assert.equal(product.priceTiers[0].price, '9.80');
  assert.equal(product.fobPrice.tiers[0].price, '9.80');
  assert.deepEqual(product.source.snapshot, snapshot);
  assert.equal(verifySourceIntegrity(product).valid, true);
  assert.deepEqual(crossPlatformPublishErrors(product), []);
  assert.throws(() => convertProductPrices(product, -1));
});

test('reads modern 1688 offer modules instead of shop data and preserves actual SKU inventory and package units', () => {
  const context = { result: { data: {
    productTitle: { fields: { title: '针织开衫', shopInfo: { subject: '服饰工厂' } } },
    gallery: { fields: { offerId: 123456789, mainImage: ['https://cbu01.alicdn.com/product.jpg'] } },
    description: { fields: { detailUrl: 'https://itemcdn.tmall.com/desc/test?var=desc' } },
    productPackInfo: { fields: { unitWeight: 1, pieceWeightScale: { pieceWeightScaleInfo: [{ length: 50, width: 30, height: 10, weight: 1000 }], columnList: [{ name: 'length', label: '长(cm)' }, { name: 'width', label: '宽(cm)' }, { name: 'height', label: '高(cm)' }, { name: 'weight', label: '重量(g)' }] } } },
    mainPrice: { fields: { priceModel: { currentPrices: [{ beginAmount: 1, price: '73.60' }] } } },
  }, global: { globalData: { model: {
    buyerModel: { subject: 'Wrong title', images: ['https://cbu01.alicdn.com/wrong.jpg'] },
    offerDetail: { offerId: 123456789, subject: '针织开衫', skuProps: [{ prop: '颜色', value: [{ name: '米色' }] }, { prop: '尺码', value: [{ name: 'S' }, { name: 'M' }] }], featureAttributes: [{ name: '面料', value: '羊毛' }], leafCategoryId: 777, leafCategoryName: '针织衫' },
    tradeModel: { minPrice: '73.60', beginAmount: 1, canBookedAmount: 8, skuMap: [{ skuId: 1, specAttrs: '米色&gt;S', price: '73.60', canBookCount: 0 }, { skuId: 2, specAttrs: '米色&gt;M', price: '73.60', canBookCount: 8 }] },
  } } } } };
  const item = extractMarketplaceProduct('<h1>服饰工厂</h1>', '1688', 'https://detail.1688.com/offer/123456789.html', { context });
  assert.equal(item.title, '针织开衫'); assert.equal(item.price, '73.60'); assert.equal(item.stock, 8);
  assert.deepEqual(item.mainImages, ['https://cbu01.alicdn.com/product.jpg']);
  assert.deepEqual(item.packaging, { weight: 1, length: 50, width: 30, height: 10 });
  assert.deepEqual(item.skus.map((sku) => [sku.attributes.颜色, sku.attributes.尺码, sku.stock]), [['米色', 'S', 0], ['米色', 'M', 8]]);
  assert.equal(item.descriptionUrl, 'https://itemcdn.tmall.com/desc/test?var=desc');
  assert.throws(() => extractMarketplaceProduct('', '1688', 'https://detail.1688.com/offer/999999999.html', { context }), /ID/);
});

test('decodes supplier detail string literals without executing scripts or retaining active markup', () => {
  assert.equal(marketplaceDescriptionHtml('var offer_details={"content":"<p>Original description</p>"};'), '<p>Original description</p>');
  const html = '<div><img src="https://cbu01.alicdn.com/detail.jpg" onerror="alert(1)"><p>原始详情</p></div>';
  assert.equal(marketplaceDescriptionHtml('var desc=' + JSON.stringify(html) + ';'), html);
  assert.equal(marketplaceDescriptionHtml("var desc='<p>supplier\\\'s detail</p>';"), "<p>supplier's detail</p>");
  assert.equal(marketplaceDescriptionHtml('var desc=(function(){throw Error()})();'), '');
  const result = extractMarketplaceProduct(`<div id="product-description">${html}<script>alert(1)</script></div>`, '1688', 'https://detail.1688.com/offer/123456789.html');
  assert.deepEqual(result.detailImages, ['https://cbu01.alicdn.com/detail.jpg']);
  assert.ok(!/onerror|script/.test(result.descriptionHtml));
});

test('accepts sparse marketplace SKU maps only while all original combinations remain intact', () => {
  const data = { subject: 'Shirt', skuProps: [{ prop: 'Color', value: ['Black', 'White'] }, { prop: 'Size', value: ['S', 'M'] }],
    skuMap: { 'Black;S': { skuId: 1, price: 10 }, 'Black;M': { skuId: 2, price: 10 }, 'White;S': { skuId: 3, price: 10 } } };
  const product = extractMarketplaceProduct(`<script>window.__INIT_DATA = ${JSON.stringify(data)};</script>`, '1688', 'https://detail.1688.com/offer/123456789.html');
  const incomplete = (value) => auditProduct(value).issues.some((issue) => issue.code === 'sku.rows.incomplete');
  assert.equal(incomplete(product), false);
  assert.equal(incomplete({ ...product, skus: product.skus.slice(0, 2) }), true);
  assert.equal(incomplete({ ...product, skus: [product.skus[0], product.skus[0], product.skus[2]] }), true);
});

test('continues link collection after an individual failure and resumes without recollecting completed links', async () => {
  const collector = new ShopCollector(os.tmpdir());
  const visited = [];
  collector.enrichProducts = async ([product]) => { visited.push(product.sourceId); if (product.sourceId === '2') throw new Error('Login required'); return [product]; };
  const links = ['1', '2', '3'].map((sourceId) => ({ sourceId, platform: '1688', url: `https://detail.1688.com/offer/${sourceId}.html` }));
  const events = [];
  const products = await collector.collectLinks(links, (event) => events.push(event), { completedKeys: ['1688:1'] });
  assert.deepEqual(visited, ['2', '3']);
  assert.deepEqual(products.map((product) => product.sourceId), ['3']);
  assert.equal(events[0].error, 'Login required');
  assert.equal(events.at(-1).total, 3);
});

test('creates a titled international product when collection starts without a storefront listing', async () => {
  const collector = new ShopCollector(os.tmpdir(), async ([product]) => [{ ...product, sourceOriginalTitle: 'Original Product Title', mainImages: ['https://example.com/main.jpg'], sourceCategoryPath: ['Electronics', 'Headphones'] }]);
  const [product] = await collector.enrichProducts([{ sourceId: '123456789', sourceUrl: 'https://www.alibaba.com/product-detail/Test_123456789.html' }]);
  assert.equal(product.title, 'Original Product Title');
  assert.equal(product.sourceTitle, 'Original Product Title');
  assert.deepEqual(product.categoryPath, ['Electronics', 'Headphones']);
  collector.detailReader = async ([base]) => [{ ...base, collectWarning: 'Login required' }];
  await assert.rejects(collector.enrichProducts([{ sourceUrl: product.sourceUrl }]), /Login required/);
});

test('checkpoints the completed link before honoring a pause during detail collection', async () => {
  const collector = new ShopCollector(os.tmpdir());
  let stopped = false;
  const visited = [];
  collector.enrichProducts = async ([product]) => {
    visited.push(product.sourceId);
    stopped = true;
    return [{ ...product, title: 'Completed product' }];
  };
  const links = ['1', '2'].map((sourceId) => ({ sourceId, platform: '1688', url: `https://detail.1688.com/offer/${sourceId}.html` }));
  const saved = [];
  await assert.rejects(collector.collectLinks(links, (event) => saved.push(event), { shouldStop: () => stopped }), { code: 'COLLECT_PAUSED' });
  assert.deepEqual(visited, ['1']);
  assert.equal(saved[0].product.title, 'Completed product');
  assert.equal(saved[0].key, '1688:1');
});

test('POST publish planning accepts 606 product IDs and returns only compact product identities', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-plan-test-'));
  const original = { PORT: process.env.PORT, DATA_DIR: process.env.DATA_DIR };
  const store = new JsonStore(path.join(directory, 'workspace.json'));
  const products = Array.from({ length: 606 }, (_, index) => ({ id: randomUUID(), sourceId: String(100000000 + index), title: `Product ${index}`, selected: true, categoryId: '201745901', categoryPath: ['Headphones'], sourceUrl: `https://www.alibaba.com/product-detail/Test_${100000000 + index}.html`, description: 'detail'.repeat(1000) }));
  store.update((state) => { state.products = products; });
  process.env.PORT = '0'; process.env.DATA_DIR = directory;
  const server = await import('../server/index.js');
  try {
    const listener = await server.serverReady;
    const endpoint = `http://127.0.0.1:${listener.address().port}/api/publish/plan`;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: products.map((product) => product.id) }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const plan = JSON.parse(raw);
    assert.equal(plan.total, 606);
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].products.length, 606);
    assert.ok(raw.length < 60000);
    assert.equal(plan.groups[0].products[0].description, undefined);
    const empty = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }) });
    assert.equal((await empty.json()).total, 0);
  } finally {
    await server.shutdownServer();
    for (const [key, value] of Object.entries(original)) { if (value == null) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
