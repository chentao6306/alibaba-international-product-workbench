import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { internationalFeaturedUrl, normalizeShopUrl, productIdFromUrl } from '../server/collector.js';
import {
  buildLegacyDescriptionHtml,
  buildSkuCombinations,
  canonicalizePriceTiers,
  classifyAlibabaActionResult,
  distinctAlibabaImageUrls,
  ensureColorSpecImageSwitch,
  findBlockingUnmappedVariant,
  categoryMismatchMessage,
  canonicalCategoryLeaf,
  parseDeliveryTiers,
  isAlibabaInternationalUrl,
  isProductPostingUrl,
  mainImageSlotsComplete,
  needsColorSaleSpecification,
  normalizePriceTiers,
  parsePriceTiers,
  sanitizeCategoryPath,
  sanitizeCollectedProduct,
  sanitizeSourceDescriptionHtml,
  sourceDetailHasBrokenImages,
  validateProductData
} from '../server/publisher.js';
import { auditProduct, recordProductMutation, sourceSnapshotFingerprint, syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { extractAlibabaSourceData, parseAlibabaDetailDataScript } from '../server/alibaba-source-data.js';
import { deleteWorkspaceEntities, findWorkspaceJobs, JsonStore } from '../server/store.js';
import { isExplicitHumanVerificationSignal, normalizeAlibabaCookies } from '../server/browser-runtime.js';

test('does not classify ordinary product text containing captcha as a challenge', () => {
  assert.equal(isExplicitHumanVerificationSignal('Product description and captcha-compatible camera module'), false);
  assert.equal(isExplicitHumanVerificationSignal('Please drag the slider to verify'), true);
  assert.equal(isExplicitHumanVerificationSignal('请完成验证后继续访问'), true);
});

test('normalizes a 1688 shop home page to its product list', () => {
  assert.equal(
    normalizeShopUrl('https://example.1688.com/'),
    'https://example.1688.com/page/offerlist.htm'
  );
});

test('keeps an existing group product-list URL', () => {
  assert.equal(
    normalizeShopUrl('example.1688.com/page/offerlist_12345.htm'),
    'https://example.1688.com/page/offerlist_12345.htm'
  );
});

test('normalizes an Alibaba.com international storefront', () => {
  assert.equal(
    normalizeShopUrl('https://sample.en.alibaba.com/'),
    'https://sample.en.alibaba.com/productlist.html'
  );
  assert.equal(
    normalizeShopUrl('https://sample.en.alibaba.com/productgrouplist-806590009/Plain_Cargo_pants.html'),
    'https://sample.en.alibaba.com/productgrouplist-806590009/Plain_Cargo_pants.html'
  );
  assert.equal(
    normalizeShopUrl('同行店铺：https://sample.en.alibaba.com/?from=share 请查看'),
    'https://sample.en.alibaba.com/productlist.html'
  );
});

test('builds the international storefront featured-products URL', () => {
  assert.equal(
    internationalFeaturedUrl('https://sample.m.en.alibaba.com/productgrouplist-123/Parts.html'),
    'https://sample.m.en.alibaba.com/featureproductlist.html'
  );
});

test('extracts domestic and international product IDs', () => {
  assert.equal(productIdFromUrl('https://detail.1688.com/offer/123456789.html'), '123456789');
  assert.equal(productIdFromUrl('https://www.alibaba.com/product-detail/Sample_1601931432990.html'), '1601931432990');
});

test('accepts only Alibaba.com international product-posting pages for publishing', () => {
  assert.equal(isAlibabaInternationalUrl('https://i.alibaba.com/'), true);
  assert.equal(isProductPostingUrl('https://hz-productposting.alibaba.com/product/posting.htm'), true);
  assert.equal(isProductPostingUrl('https://us-productposting.alibaba.com/product/manage_products.htm'), true);
  assert.equal(isProductPostingUrl('https://post.alibaba.com/product/category.htm'), true);
  assert.equal(isProductPostingUrl('https://work.1688.com/'), false);
  assert.equal(isProductPostingUrl('https://www.alibaba.com/product-detail/example_12345678.html'), false);
});

test('normalizes Electron session cookies for Playwright without dropping unspecified SameSite cookies', () => {
  const cookies = normalizeAlibabaCookies([
    { name: 'session', value: 'abc', domain: '.alibaba.com', sameSite: 'unspecified' },
    { name: 'strict', value: 'def', domain: '.alibaba.com', sameSite: 'strict' },
    { name: '', value: 'ignored', domain: '.alibaba.com', sameSite: 'lax' }
  ]);
  assert.deepEqual(cookies.map((cookie) => cookie.sameSite), ['Lax', 'Strict']);
  assert.equal(cookies.length, 2);
});

test('does not mistake the color image switch wrapper for an enabled upload slot', async () => {
  let clicked = false;
  const switchControl = {
    count: async () => 1,
    isVisible: async () => true,
    getAttribute: async (name) => name === 'aria-checked' ? (clicked ? 'true' : 'false') : (clicked ? 'next-switch-on' : 'next-switch-off'),
    isChecked: async () => false,
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { clicked = true; },
    press: async () => {},
    last() { return this; }
  };
  const emptyLocator = {
    count: async () => 0,
    isVisible: async () => false,
    evaluateAll: async () => false,
    last() { return this; }
  };
  const row = {
    locator(selector) {
      if (selector.includes('.upload-image-switch')) return switchControl;
      if (selector.includes('.custom-upload-image')) {
        return { evaluateAll: async () => clicked };
      }
      return emptyLocator;
    },
    getByText: () => emptyLocator
  };
  const page = { waitForTimeout: async () => {} };
  assert.equal(await ensureColorSpecImageSwitch(page, row), true);
  assert.equal(clicked, true);
});

test('recognizes Alibaba review confirmation text after submit', () => {
  const result = classifyAlibabaActionResult({
    mode: 'submit',
    url: 'https://post.alibaba.com/product/publish.htm?catId=201346401',
    originalUrl: 'https://post.alibaba.com/product/publish.htm?catId=201346401',
    bodyText: '您的产品信息已经成功提交！ 您的产品已经进入审核流程，您可以在1个工作日之后查询审核结果。'
  });
  assert.equal(result.succeeded, true);
  assert.equal(result.verifiedBy, 'page-content');
});

test('recognizes the Alibaba product success URL even when only notices are visible', () => {
  const result = classifyAlibabaActionResult({
    mode: 'submit',
    url: 'https://post.alibaba.com/product/success.htm?language=zh_CN&isSuccess=true&primaryId=1601935092104',
    originalUrl: 'https://post.alibaba.com/product/publish.htm?catId=201346401',
    feedback: ['【通知】AI创意生图功能全新发布']
  });
  assert.equal(result.succeeded, true);
  assert.equal(result.verifiedBy, 'success-url');
});

test('counts each remaining Alibaba main-image slot only once', () => {
  assert.equal(mainImageSlotsComplete(6, 2, 4), true);
  assert.equal(mainImageSlotsComplete(6, 1, 5), true);
  assert.equal(mainImageSlotsComplete(6, 2, 5), false);
});

test('deduplicates Alibaba CDN derivatives of the same source image', () => {
  assert.deepEqual(distinctAlibabaImageUrls([
    'https://sc04.alicdn.com/kf/Habc123.jpg',
    'https://s.alicdn.com/@sc04/kf/Habc123.jpg_960x960q80.jpg',
    'https://sc04.alicdn.com/kf/Hdifferent.jpg'
  ]), [
    'https://sc04.alicdn.com/kf/Habc123.jpg',
    'https://sc04.alicdn.com/kf/Hdifferent.jpg'
  ]);
});

test('does not treat a single descriptive source value as a required SKU variant', () => {
  const product = { variantGroups: [{ name: 'compatible model', options: ['General'] }] };
  assert.equal(findBlockingUnmappedVariant(product, ['compatible model: General']), '');
});

test('keeps a multi-option SKU variant blocking when the target category cannot represent it', () => {
  const product = { variantGroups: [{ name: 'Compatible model', options: ['Model A', 'Model B'] }] };
  assert.equal(findBlockingUnmappedVariant(product, ['Compatible model: Model B']), 'Compatible model: Model B');
});

test('keeps the source color as a target sales specification, including one-color SKUs', () => {
  assert.equal(needsColorSaleSpecification({ options: ['Black'] }), true);
  assert.equal(needsColorSaleSpecification({ options: ['Black', 'Black'] }), true);
  assert.equal(needsColorSaleSpecification({ options: ['Black', 'Red'] }), true);
});

test('does not treat Alibaba feature notices as a publish result', () => {
  const result = classifyAlibabaActionResult({
    mode: 'submit',
    url: 'https://post.alibaba.com/product/publish.htm?catId=201346401',
    originalUrl: 'https://post.alibaba.com/product/publish.htm?catId=201346401',
    feedback: ['【通知】AI创意生图功能全新发布，生图稳定性提高200%']
  });
  assert.equal(result.succeeded, false);
});

test('keeps visible posting errors blocking on the publish form', () => {
  const result = classifyAlibabaActionResult({
    mode: 'submit',
    url: 'https://post.alibaba.com/product/publish.htm?catId=201346401',
    originalUrl: 'https://post.alibaba.com/product/publish.htm?catId=201346401',
    feedback: ['报错反馈 1 错误项 商品图片必填项不能为空', '提交成功']
  });
  assert.equal(result.succeeded, false);
  assert.equal(result.blockingFeedback, true);
});

test('blocks obvious phone-to-business-service category mismatches', () => {
  assert.match(categoryMismatchMessage({ title: 'Rugged Mobile Phone' }, '商务服务>>检验和质量控制服务'), /不匹配/);
  assert.equal(categoryMismatchMessage({ title: 'Inspection Service' }, '商务服务>>检验和质量控制服务'), '');
});

test('blocks motor controllers from a consumer-electronics posting category', () => {
  assert.match(categoryMismatchMessage({
    title: 'BLDC Brushless DC Motor Driver Controller',
    productType: 'Motor Controllers',
    sourceCategoryPath: ['Power Transmission', 'Motors', 'Motor Controllers']
  }, '消费电子>>其他消费电子产品'), /Motor Controllers/);
});

test('blocks publishing a product into a different target category', () => {
  assert.match(categoryMismatchMessage({
    title: 'FPV 42130 Folding Propeller',
    sourceCategoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories']
  }, 'Consumer Electronics >> Other Consumer Electronics'), /目标类目/);
  assert.equal(categoryMismatchMessage({
    title: 'FPV 42130 Folding Propeller',
    sourceCategoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories']
  }, 'Consumer Electronics >> Camera, Photo & Accessories >> Drones Accessories'), '');
});

test('treats translated category names as the same category', () => {
  assert.equal(canonicalCategoryLeaf('无人机配件'), 'drones accessories');
  assert.equal(categoryMismatchMessage({
    sourceCategoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories']
  }, '消费电子 >> 相机，无人机配件 >> 无人机配件'), '');
});

test('preserves source delivery quantity ranges separately from lead days', () => {
  assert.deepEqual(parseDeliveryTiers([
    ['Quantity (pieces)', '1 - 50', '> 50'],
    ['Lead time (days)', '14', 'To be negotiated']
  ]), [
    { range: '1 - 50', upperQuantity: 50, leadText: '14', leadDays: '14' },
    { range: '> 50', upperQuantity: null, leadText: 'To be negotiated', leadDays: '' }
  ]);
});

test('parses Alibaba price ranges without treating discount text as a tier', () => {
  const tiers = parsePriceTiers('¥2,327.78 50-499 pieces ¥2,260.89 500-2,999 pieces ¥2,194 ≥3,000 pieces 满 ¥66,890 可省 ¥3,344.50');
  assert.deepEqual(tiers, [
    { price: '2327.78', minQuantity: 50, maxQuantity: 499, currencySymbol: '¥' },
    { price: '2260.89', minQuantity: 500, maxQuantity: 2999, currencySymbol: '¥' },
    { price: '2194.00', minQuantity: 3000, maxQuantity: null, currencySymbol: '¥' }
  ]);
});

test('parses price and quantity when Alibaba collapses whitespace in visible text', () => {
  const tiers = parsePriceTiers('¥2,327.7850-499 pieces¥2,260.89500-2,999 pieces¥2,194≥3,000 pieces');
  assert.deepEqual(tiers.map((tier) => [tier.price, tier.minQuantity, tier.maxQuantity]), [
    ['2327.78', 50, 499], ['2260.89', 500, 2999], ['2194.00', 3000, null]
  ]);
});

test('parses box-based Alibaba price tiers', () => {
  const tiers = parsePriceTiers('¥920.341-29 boxes¥908.1030-49 boxes¥885.76≥50 boxes');
  assert.deepEqual(tiers.map((tier) => [tier.price, tier.minQuantity, tier.maxQuantity]), [
    ['920.34', 1, 29], ['908.10', 30, 49], ['885.76', 50, null]
  ]);
});

test('deduplicates and sorts repeated price modules', () => {
  assert.deepEqual(canonicalizePriceTiers([
    { minQuantity: 10, maxQuantity: 19, price: '358' },
    { minQuantity: 20, maxQuantity: 49, price: '350' },
    { minQuantity: 50, maxQuantity: null, price: '339' },
    { minQuantity: 20, maxQuantity: 49, price: '350' },
    { minQuantity: 50, maxQuantity: null, price: '339' }
  ]).map((tier) => tier.minQuantity), [10, 20, 50]);
});

test('normalizes source tiers to the collected listing currency while retaining source prices', () => {
  const normalized = normalizePriceTiers(parsePriceTiers('¥2,327.78 50-499 pieces ¥2,260.89 500-2,999 pieces ¥2,194 ≥3,000 pieces'), 328, '$');
  assert.deepEqual(normalized.map((tier) => tier.price), ['348.00', '338.00', '328.00']);
  assert.equal(normalized[0].sourcePrice, '2327.78');
  assert.equal(normalized[0].sourceCurrencySymbol, '¥');
});

test('builds SKU combinations as a Cartesian product', () => {
  const skus = buildSkuCombinations([
    { name: 'Color', options: ['Black', 'Orange'] },
    { name: 'Storage', options: ['256GB', '512GB'] }
  ], 328, 100);
  assert.equal(skus.length, 4);
  assert.deepEqual(skus[3].attributes, { Color: 'Orange', Storage: '512GB' });
});

test('extracts Alibaba source price ranges and real SKU identities without inventing prices', () => {
  const script = `window.detailData = ${JSON.stringify({
    globalData: {
      global: { productPriceCurrencySimpleName: 'US $' },
      product: {
        price: {
          productRangePrices: {
            dollarPriceRangeLow: 1.5,
            dollarPriceRangeHigh: 7,
            priceRangeText: '$1.50-7'
          },
          unit: 'piece'
        },
        sku: {
          firstSkuId: 106742567791,
          skuAttrs: [
            { id: 191, name: 'color', values: [{ id: 1, name: 'Black', originImage: 'https://example.com/black.jpg' }] },
            { id: 210, name: 'compatible model', values: [{ id: 2, name: 'For T40 T20P' }] },
            { id: 3, name: 'model number', values: [{ id: 3, name: 'T20/T16' }] },
            { id: 200, name: 'type', values: [{ id: 4, name: 'Centrifugal Spray bar' }] }
          ],
          skuInfoMap: {
            '191:1;210:2;3:3;200:4;': { id: 106742567791 }
          }
        },
        tradeAvailable: false,
        sourcingTradeAvailable: false
      }
    }
  })};`;
  const detailData = parseAlibabaDetailDataScript(script);
  const source = extractAlibabaSourceData(detailData);

  assert.deepEqual(source.sourcePriceRange, {
    minPrice: '1.50', maxPrice: '7.00', currencySymbol: '$',
    formattedText: '$1.50-7', unit: 'piece', source: 'detailData.productRangePrices'
  });
  assert.equal(source.priceMode, 'source-range');
  assert.equal(source.sourcePriceTiers.length, 0);
  assert.equal(source.variantGroups.length, 4);
  assert.equal(source.skus[0].id, '106742567791');
  assert.deepEqual(source.skus[0].attributes, {
    color: 'Black', 'compatible model': 'For T40 T20P', 'model number': 'T20/T16', type: 'Centrifugal Spray bar'
  });
  assert.equal(Object.hasOwn(source.skus[0], 'price'), false);
  assert.equal(Object.hasOwn(source.skus[0], 'stock'), false);
  assert.equal(source.sourceTradeAvailability.exactSkuPricesPublished, false);
  assert.equal(source.sourceTradeAvailability.exactSkuStockPublished, false);
});

test('keeps Alibaba quantity ladder pricing distinct from source range pricing', () => {
  const source = extractAlibabaSourceData({
    globalData: {
      global: { productPriceCurrencySimpleName: 'US $' },
      product: {
        price: {
          productRangePrices: { dollarPriceRangeLow: 4.5, dollarPriceRangeHigh: 5.5 },
          productLadderPrices: [
            { dollarPrice: 5.5, minQuantity: 20, maxQuantity: 99 },
            { dollarPrice: 5, minQuantity: 100, maxQuantity: 499 },
            { dollarPrice: 4.5, minQuantity: 500 }
          ],
          unit: 'piece'
        }
      }
    }
  });

  assert.equal(source.priceMode, 'quantity-tier');
  assert.deepEqual(source.sourcePriceTiers.map((tier) => [tier.minQuantity, tier.maxQuantity, tier.price]), [
    [20, 99, '5.50'], [100, 499, '5.00'], [500, null, '4.50']
  ]);
});

test('parses Alibaba min/max ladder fields and derives the public price range', () => {
  const source = extractAlibabaSourceData({
    globalData: {
      global: { productPriceCurrencySimpleName: 'US $' },
      product: {
        customPrice: {
          formatLadderPrice: '$104-114.40',
          productLadderPrices: [
            { dollarPrice: 114.4, min: 1, max: 49, localMin: '1', localMax: '49' },
            { dollarPrice: 110.5, min: 50, max: 99, localMin: '50', localMax: '99' },
            { dollarPrice: 104, min: 100, max: -1, localMin: '100', localMax: '-1' }
          ],
          unit: 'piece'
        }
      }
    }
  });

  assert.equal(source.priceMode, 'quantity-tier');
  assert.equal(source.price, 104);
  assert.equal(source.maxPrice, 114.4);
  assert.deepEqual(source.sourcePriceRange, {
    minPrice: '104.00', maxPrice: '114.40', currencySymbol: '$',
    formattedText: '$104-114.40', unit: 'piece', source: 'detailData.productLadderPrices'
  });
  assert.deepEqual(source.sourcePriceTiers.map((tier) => [tier.minQuantity, tier.maxQuantity, tier.price]), [
    [1, 49, '114.40'], [50, 99, '110.50'], [100, null, '104.00']
  ]);
});

test('does not block products when Alibaba publishes a source range but no per-SKU price', () => {
  const product = syncProductModel({
    id: 'range-only', sourceId: '1601455081878', title: 'Centrifugal Spray bar',
    sourceCategoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'],
    sourcePriceRange: { minPrice: '1.50', maxPrice: '7.00', formattedText: '$1.50-7', currencySymbol: '$', unit: 'piece' },
    price: 1.5, maxPrice: 7, priceMode: 'source-range', salesUnit: 'piece',
    mainImages: ['1', '2', '3', '4'], detailImages: ['detail'],
    attributes: [{ name: 'Material', value: 'Rubber' }, { name: 'Place of Origin', value: 'China' }],
    origin: 'China', packaging: { weight: 1, length: 30, width: 20, height: 10 },
    variantGroups: [{ name: 'color', options: ['Black'] }],
    skus: [{ id: '106742567791', attributes: { color: 'Black' }, source: 'detailData.skuInfoMap', derived: false }],
    description: 'Agriculture sprayer drone spare part', descriptionHtml: '<p>Agriculture sprayer drone spare part</p>',
    deliveryTime: [{ range: '1-10', leadDays: '7' }], keywords: ['sprayer drone']
  }, { captureSource: true });
  const audit = auditProduct(product);

  assert.equal(audit.errors, 0);
  assert.equal(audit.status, 'review');
  assert.equal(audit.issues.some((issue) => issue.code === 'trade.tiers.missing'), false);
  assert.equal(audit.issues.some((issue) => issue.code === 'sku.price.missing'), false);
  assert.equal(audit.issues.some((issue) => issue.code === 'sku.price.not-published'), true);
});

test('reports incomplete product data before draft or publishing', () => {
  assert.deepEqual(validateProductData({ title: '', price: 0 }), [
    '缺少商品标题', '销售价格无效', '主图不足 4 张（当前 0 张）', '缺少详情图片',
    '商品属性不足 2 项', '缺少产地', '缺少包装重量', '缺少商品详情'
  ]);
});

test('sanitizes source rich text before international publishing', () => {
  const html = sanitizeSourceDescriptionHtml('<h3>Product</h3><p>Contact us: sales@example.com</p><script>alert(1)</script><img src="https://example.com/a.jpg" onerror="bad()">');
  assert.match(html, /Product/);
  assert.doesNotMatch(html, /sales@example|script|onerror/i);
  assert.match(html, /<img/);
});

test('removes remote source images from the publish description copy', () => {
  const html = buildLegacyDescriptionHtml({ title: 'Demo', description: 'Text', descriptionHtml: '<p>Source</p><img src="https://sc04.alicdn.com/kf/stale.jpg">' });
  assert.doesNotMatch(html, /stale\.jpg/);
  assert.match(html, /Source/);
});

test('detects invalid detail images before publishing', () => {
  assert.equal(sourceDetailHasBrokenImages('<img src="about:blank">'), true);
  assert.equal(sourceDetailHasBrokenImages('<p>Product image</p>'), false);
});

test('removes Alibaba Lens promotional text from collected category fields', () => {
  assert.deepEqual(sanitizeCategoryPath(['Telephones', 'Corded Telephones', 'Alibaba Lens 我们的免费比价插件帮助您寻找价格更低的相似商品']), ['Telephones', 'Corded Telephones']);
  const product = sanitizeCollectedProduct({ productType: 'Alibaba Lens 我们的免费比价插件帮助您寻找价格更低的相似商品', sourceCategoryPath: ['Telephones', 'Corded Telephones', 'Alibaba Lens 我们的免费比价插件帮助您寻找价格更低的相似商品'], keywords: ['corded telephone', 'Alibaba Lens 免费比价插件'], subtitle: 'Accio Work 免费比价插件' });
  assert.equal(product.productType, 'Corded Telephones');
  assert.deepEqual(product.sourceCategoryPath, ['Telephones', 'Corded Telephones']);
  assert.deepEqual(product.keywords, ['corded telephone']);
  assert.equal(product.subtitle, '');
});

test('keeps source-language metadata and legitimate source text unchanged', () => {
  const product = sanitizeCollectedProduct({
    sourceOriginalTitle: 'Explosion Proof Telephone', sourceLanguage: 'en', sourceCaptureLocale: 'en-US',
    title: 'Explosion Proof Telephone', description: 'ATEX certified telephone for hazardous areas',
    attributes: [{ name: 'Place of Origin', value: 'Zhejiang, China' }]
  });
  assert.equal(product.sourceLanguage, 'en');
  assert.equal(product.description, 'ATEX certified telephone for hazardous areas');
  const synced = syncProductModel({ ...product, id: 'language-source', sourceId: '11000034856073' }, { captureSource: true });
  assert.equal(synced.source.snapshot.sourceLanguage, 'en');
  assert.equal(synced.source.snapshot.sourceCaptureLocale, 'en-US');
});

test('audits and records product source versus working changes', () => {
  const product = syncProductModel({ id: 'p1', sourceId: '1601', title: 'Demo', mainImages: ['1', '2', '3', '4'], detailImages: ['d'], attributes: [{ name: 'Material', value: 'Steel' }, { name: 'Origin', value: 'China' }], origin: 'China', price: 10, priceTiers: [{ minQuantity: 1, price: 10 }], packaging: { weight: 1 }, description: 'Demo' }, { captureSource: true });
  assert.equal(product.schemaVersion, 4);
  assert.equal(product.source.snapshot.title, 'Demo');
  recordProductMutation(product, { title: 'Edited' }, { action: 'test-edit' });
  assert.equal(product.source.snapshot.title, 'Demo');
  assert.equal(product.working.title, 'Edited');
  assert.equal(product.auditTrail[0].action, 'test-edit');
  assert.ok(auditProduct(product).checkedAt);
});

test('keeps an immutable source snapshot when working values are edited', () => {
  const product = syncProductModel({
    id: 'immutable-source', sourceId: '1601', sourceUrl: 'https://www.alibaba.com/product-detail/demo_1601.html',
    title: 'Original title', price: '10.00', sourcePrice: '10.00', sourcePriceTiers: [{ minQuantity: 1, price: '10.00' }],
    mainImages: ['1', '2', '3', '4'], detailImages: ['d'], attributes: [{ name: 'Material', value: 'Steel' }, { name: 'Origin', value: 'China' }],
    origin: 'China', priceTiers: [{ minQuantity: 1, price: '10.00' }], packaging: { weight: 1 }, description: 'Original'
  }, { captureSource: true });
  const original = structuredClone(product.source.snapshot);
  const originalHash = product.source.snapshotHash;
  recordProductMutation(product, { title: 'Edited title', price: '12.00', priceTiers: [{ minQuantity: 1, price: '12.00' }] });
  assert.deepEqual(product.source.snapshot, original);
  assert.equal(product.source.snapshotHash, originalHash);
  assert.deepEqual(verifySourceIntegrity(product), { present: true, valid: true, expected: originalHash, actual: originalHash });
  assert.equal(sourceSnapshotFingerprint(product.source.snapshot), originalHash);
  assert.equal(product.working.title, 'Edited title');
});

test('flags a modified source snapshot instead of silently accepting it', () => {
  const product = syncProductModel({ id: 'tampered-source', title: 'Original', sourceId: '1' }, { captureSource: true });
  product.source.snapshot.title = 'Tampered';
  const audit = auditProduct(product);
  assert.equal(audit.sourceIntegrity.valid, false);
  assert.ok(audit.issues.some((item) => item.code === 'source.snapshot.tampered'));
});

test('removes Chinese source placeholders from international listing details', () => {
  const html = buildLegacyDescriptionHtml({
    title: 'Explosion Proof Telephone',
    description: '供应商的产品说明',
    attributes: [{ name: '产地', value: '浙江，中国' }],
    variantGroups: [{ name: '颜色', options: ['黑色'] }]
  });
  assert.doesNotMatch(html, /[\u3400-\u9fff]/);
  assert.doesNotMatch(html, /Supplier Product Description/i);
  assert.match(html, /Explosion Proof Telephone/);
  assert.match(html, /Place of Origin/);
  assert.match(html, /Black/);
});

test('rejects non-1688 sources', () => {
  assert.throws(() => normalizeShopUrl('https://example.com/shop'), /1688/);
});

test('persists jobs and settings atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-store-'));
  try {
    const file = path.join(directory, 'workspace.json');
    const store = new JsonStore(file);
    const job = store.createJob('collect', { groupId: 'g1' });
    store.patchJob(job.id, { status: 'running', progress: 3, total: 10 });
    store.update((state) => { state.settings.defaultStock = 88; });

    const reloaded = new JsonStore(file).read();
    assert.equal(reloaded.jobs[0].status, 'running');
    assert.equal(reloaded.jobs[0].progress, 3);
    assert.equal(reloaded.settings.defaultStock, 88);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deletes shops and groups with their dependent products', () => {
  const state = {
    shops: [{ id: 's1' }, { id: 's2' }],
    groups: [{ id: 'g1', shopId: 's1' }, { id: 'g2', shopId: 's2' }],
    products: [{ id: 'p1', shopId: 's1', groupId: 'g1' }, { id: 'p2', shopId: 's2', groupId: 'g2' }]
  };
  const deleted = deleteWorkspaceEntities(state, { shopIds: ['s1'] });
  assert.deepEqual({ shops: deleted.shops, groups: deleted.groups, products: deleted.products }, { shops: 1, groups: 1, products: 1 });
  assert.deepEqual(state, {
    shops: [{ id: 's2' }], groups: [{ id: 'g2', shopId: 's2' }],
    products: [{ id: 'p2', shopId: 's2', groupId: 'g2' }]
  });
});

test('distinguishes running jobs from paused jobs related to deleted workspace data', () => {
  const state = {
    shops: [{ id: 's1' }, { id: 's2' }],
    groups: [{ id: 'g1', shopId: 's1' }, { id: 'g2', shopId: 's2' }],
    products: [{ id: 'p1', shopId: 's1', groupId: 'g1' }],
    jobs: [
      { id: 'paused-collect', type: 'collect', status: 'paused', metadata: { groupId: 'g1' } },
      { id: 'running-other-shop', type: 'collect', status: 'running', metadata: { groupId: 'g2' } },
      { id: 'paused-publish', type: 'publish', status: 'paused', metadata: { productIds: ['p1'] } }
    ]
  };
  const snapshot = structuredClone(state);
  const targets = deleteWorkspaceEntities(snapshot, { shopIds: ['s1'] });

  assert.deepEqual(findWorkspaceJobs(snapshot, targets, ['running']).map((job) => job.id), []);
  assert.deepEqual(findWorkspaceJobs(snapshot, targets, ['paused']).map((job) => job.id), ['paused-collect', 'paused-publish']);
});
