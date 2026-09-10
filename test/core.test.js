import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { internationalFeaturedUrl, normalizeShopUrl, productIdFromUrl } from '../server/collector.js';
import {
  buildLegacyDescriptionHtml,
  buildFlattenedVariantGroup,
  buildSkuCombinations,
  canonicalizePriceTiers,
  classifyAlibabaActionResult,
  distinctAlibabaImageUrls,
  ensureColorSpecImageSwitch,
  findBlockingUnmappedVariant,
  isRequiredTargetVariantGroup,
  categoryMismatchMessage,
  canonicalCategoryLeaf,
  parseDeliveryTiers,
  isAlibabaInternationalUrl,
  isProductPostingUrl,
  mainImageSlotsComplete,
  needsColorSaleSpecification,
  numericValue,
  shouldUseColorSaleSpecification,
  normalizePriceTiers,
  parsePriceTiers,
  sanitizeCategoryPath,
  sanitizeCollectedProduct,
  sanitizeSourceDescriptionHtml,
  sourceDetailHasBrokenImages,
  SellerPublisher,
  validateProductData,
  preparePublishProduct,
  isRequiredAttributeError,
  inferRequiredAttributeValue,
  attributeOptionMatchScore
} from '../server/publisher.js';
import { applyPublishedProductReference, auditProduct, copyMissingProductData, findAndReplaceProduct, recordProductMutation, sourceSnapshotFingerprint, syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { extractAlibabaCategoryId, extractAlibabaSourceData, parseAlibabaDetailDataScript } from '../server/alibaba-source-data.js';
import { buildAlibabaPublishUrl, categoryPathKey, createPublishPlan, productCategory, resolvePublishRoute } from '../server/category-routing.js';
import { deleteWorkspaceEntities, findWorkspaceJobs, JsonStore } from '../server/store.js';
import { isExplicitHumanVerificationSignal, normalizeAlibabaCookies } from '../server/browser-runtime.js';
import { userFacingError } from '../server/browser-error.js';
import { runWithProgressTimeout } from '../server/progress-timeout.js';

test('publish progress timeout resets whenever the current stage advances', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stages = [];
  let advance;
  let finish;
  const pending = runWithProgressTimeout((progress) => {
    advance = progress;
    return new Promise((resolve) => { finish = resolve; });
  }, { timeoutMs: 25, onProgress: (stage) => stages.push(stage) });
  await Promise.resolve();
  t.mock.timers.tick(20);
  advance('uploading images');
  t.mock.timers.tick(20);
  advance('submitting');
  t.mock.timers.tick(20);
  finish('ok');
  assert.equal(await pending, 'ok');
  assert.deepEqual(stages, ['uploading images', 'submitting']);
});

test('publish progress timeout reports the stalled stage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let timedOutStage = '';
  const rejected = assert.rejects(
    runWithProgressTimeout(async (progress) => {
      progress('uploading main images');
      await new Promise((resolve) => setTimeout(resolve, 60));
    }, { timeoutMs: 20, onTimeout: (stage) => { timedOutStage = stage; } }),
    (error) => error.code === 'PUBLISH_STAGE_TIMEOUT' && error.stage === 'uploading main images'
  );
  await Promise.resolve();
  t.mock.timers.tick(20);
  await rejected;
  assert.equal(timedOutStage, 'uploading main images');
});

test('does not classify ordinary product text containing captcha as a challenge', () => {
  assert.equal(isExplicitHumanVerificationSignal('Product description and captcha-compatible camera module'), false);
  assert.equal(isExplicitHumanVerificationSignal('Please drag the slider to verify'), true);
  assert.equal(isExplicitHumanVerificationSignal('请完成验证后继续访问'), true);
});

test('find and replace searches nested editable product fields with optional case sensitivity', () => {
  const product = { title: 'Apple cable', keywords: ['apple accessory'], attributes: [{ name: 'Brand', value: 'Apple' }], price: 10, mainImages: ['apple-image'] };
  const result = findAndReplaceProduct(product, 'apple', 'liangxiang');
  assert.equal(result.count, 3);
  assert.equal(result.patch.title, 'liangxiang cable');
  assert.deepEqual(result.patch.keywords, ['liangxiang accessory']);
  assert.equal(result.patch.attributes[0].value, 'liangxiang');
  assert.equal(result.patch.price, undefined);
  assert.equal(result.patch.mainImages, undefined);
  assert.equal(findAndReplaceProduct(product, 'APPLE', 'x', { caseSensitive: true }).count, 0);
});

test('routes selected products into automatic exact-leaf category groups', () => {
  const settings = { publishBindings: {} };
  const products = [
    { id: 'a', title: 'drone', sourceCategoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'], sourceCategoryId: '201346401' },
    { id: 'b', title: 'motor', sourceCategoryPath: ['Power Transmission', 'Motors', 'Motor Controllers'], sourceCategoryId: '201346402' },
    { id: 'c', title: 'drone 2', sourceCategoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'], sourceCategoryId: '201346401' }
  ];
  const plan = createPublishPlan(products, settings);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].products.length, 2);
  assert.equal(plan[0].url, buildAlibabaPublishUrl('201346401'));
  assert.equal(plan[1].url, buildAlibabaPublishUrl('201346402'));
  assert.equal(resolvePublishRoute(products[0], settings).automatic, true);
});

test('exact category ID ignores a stale binding from another leaf ID', () => {
  const product = {
    id: 'battery',
    sourceCategoryId: '100010001',
    sourceCategoryPath: ['Consumer Electronics', 'Chargers, Batteries & Power Supplies', 'Battery Chargers']
  };
  const route = resolvePublishRoute(product, {
    publishBindings: {
      stale: {
        categoryId: '100010999',
        category: 'Consumer Electronics >> Chargers, Batteries & Power Supplies >> Battery Chargers',
        url: buildAlibabaPublishUrl('100010999')
      }
    }
  });
  assert.equal(route.categoryId, '100010001');
  assert.equal(route.url, buildAlibabaPublishUrl('100010001'));
  assert.equal(route.source, 'generated');
});

test('routes thousands of unbound products by exact leaf category without manual pages', () => {
  const products = Array.from({ length: 3000 }, (_, index) => ({
    id: `product-${index}`,
    title: `product ${index}`,
    sourceCategoryPath: ['Catalog', `Leaf ${index % 37}`],
    sourceCategoryId: String(200000000 + (index % 37))
  }));
  const plan = createPublishPlan(products, { publishBindings: {} });
  assert.equal(plan.length, 37);
  assert.equal(plan.reduce((total, group) => total + group.products.length, 0), 3000);
  assert.ok(plan.every((group) => group.automatic && group.url.includes(`catId=${group.categoryId}`)));
});

test('publish pause invokes the active page stop hook immediately', () => {
  const publisher = new SellerPublisher(os.tmpdir());
  let stopped = false;
  publisher.publishStops.set('job-1', () => { stopped = true; });
  assert.equal(publisher.requestPublishStop('job-1'), true);
  assert.equal(stopped, true);
  publisher.clearPublishStop('job-1');
  assert.equal(publisher.requestPublishStop('job-1'), false);
});

test('browser automation errors are reduced to readable business messages', () => {
  const message = userFacingError(new Error("locator.click: Timeout 30000ms exceeded\n<div class=\"next-overlay-backdrop\"> intercepts pointer events\n--disable-sync\nPID 16152"));
  assert.equal(message, '国际站编辑器切换失败：页面仍有弹窗遮罩，请关闭提示后重试');
  const startup = userFacingError(new Error('--disable-sync\nPID 16152\ntaskkill failed'));
  assert.equal(startup, '浏览器操作失败，请重试');
});

test('extracts Alibaba leaf category IDs from stable and nested detailData fields', () => {
  assert.equal(extractAlibabaCategoryId({ globalData: { product: { leafCategoryId: 201346401 } } }), '201346401');
  assert.equal(extractAlibabaCategoryId({ nodeMap: { breadcrumb: { categoryId: '201346402' } } }), '201346402');
  const source = extractAlibabaSourceData({ globalData: { product: { categoryId: 201346403, sku: {} } } });
  assert.equal(source.sourceCategoryId, '201346403');
  assert.equal(source.evidence.categoryId, '201346403');
});

test('references only missing product data and leaves commercial content untouched', () => {
  const target = { title: 'Unique target', price: 12, keywords: ['target'], detailImages: ['target-image'], origin: '', packaging: { weight: 0 }, attributes: [{ name: 'Color', value: '' }], variantGroups: [{ name: 'Color', options: ['Black'] }] };
  const reference = { title: 'Published reference', price: 99, keywords: ['reference'], detailImages: ['reference-image'], origin: 'Guangdong, China', packaging: { weight: 1.2, length: 30 }, attributes: [{ name: 'Color', value: 'Black' }, { name: 'Material', value: 'Carbon' }], variantGroups: [{ name: 'Color', options: ['Black', 'White'] }, { name: 'Type', options: ['A'] }] };
  const patch = copyMissingProductData(target, reference);
  assert.equal(patch.origin, 'Guangdong, China');
  assert.equal(patch.packaging.weight, 1.2);
  assert.deepEqual(patch.attributes, [{ name: 'Color', value: 'Black' }, { name: 'Material', value: 'Carbon' }]);
  assert.deepEqual(patch.variantGroups, [{ name: 'Color', options: ['Black', 'White'] }, { name: 'Type', options: ['A'] }]);
  assert.equal(patch.title, undefined);
  assert.equal(patch.price, undefined);
  assert.equal(patch.detailImages, undefined);
  assert.equal(patch.keywords, undefined);
});

test('published reference replaces publish template while preserving collected commercial data', () => {
  const target = {
    title: 'Original target title', keywords: ['original'], price: 12.5, stock: 88,
    mainImages: ['target-main.jpg'], detailImages: ['target-detail.jpg'],
    sourceCategoryPath: ['Source', 'Category'], sourceCategoryId: 'source-1',
    categoryPath: ['Old', 'Target'], categoryId: 'old-1',
    origin: '', attributes: [{ name: 'Material', value: 'Carbon' }],
    variantGroups: [{ name: 'Color', options: ['Black'] }],
    skus: [{ code: 'TARGET-1', price: 12.5, stock: 88, attributes: { Color: 'Black' } }]
  };
  const reference = {
    title: 'Published template', keywords: ['template'], price: 99, stock: 2,
    mainImages: ['reference-main.jpg'], detailImages: ['reference-detail.jpg'],
    categoryPath: ['Consumer Electronics', 'Camera', 'Drones Accessories'], categoryId: '201346401',
    origin: 'China', province: 'Guangdong', brandName: 'Template Brand',
    attributes: [{ name: 'Material', value: 'Nylon' }, { name: 'Private Mold', value: 'No' }],
    variantGroups: [{ name: 'Color', options: ['Black', 'White'], optionImages: { Black: 'black.jpg' } }, { name: 'Type', options: ['Propellers'] }],
    skus: [{ code: 'REFERENCE-1', price: 99, stock: 2, attributes: { Color: 'Black', Type: 'Propellers' } }, { code: 'REFERENCE-2', price: 99, stock: 2, attributes: { Color: 'White', Type: 'Propellers' } }]
  };
  const patch = applyPublishedProductReference(target, reference);
  assert.equal(patch.categoryId, '201346401');
  assert.deepEqual(patch.categoryPath, reference.categoryPath);
  assert.equal(patch.province, 'Guangdong');
  assert.deepEqual(patch.attributes, [
    ...reference.attributes,
    { name: '省份', value: 'Guangdong', source: 'reference-published-product' },
    { name: '品牌名称', value: 'Template Brand', source: 'reference-published-product' }
  ]);
  assert.deepEqual(patch.variantGroups, reference.variantGroups);
  assert.equal(patch.skus[0].price, 12.5);
  assert.equal(patch.skus[0].stock, 88);
  assert.equal(patch.skus[0].code, 'TARGET-1');
  assert.equal(patch.skus[1].price, 12.5);
  assert.equal(patch.title, undefined);
  assert.equal(patch.keywords, undefined);
  assert.equal(patch.mainImages, undefined);
  assert.equal(patch.detailImages, undefined);
  assert.equal(patch.stock, undefined);
});

test('working category overrides the immutable source category for publish routing', () => {
  const product = {
    sourceCategoryPath: ['Original', 'Failed Category'],
    sourceCategoryId: '100000001',
    categoryPath: ['Consumer Electronics', 'Camera', 'Drones Accessories'],
    categoryId: '201346401'
  };
  const category = productCategory(product);
  assert.deepEqual(category.path, product.categoryPath);
  assert.equal(category.id, '201346401');
  assert.equal(category.path.at(-1), 'Drones Accessories');
});

test('recovers a phone route when an old reference operation copied a drone category', () => {
  const product = {
    title: 'Unlocked S23 Ultra 5G Smartphone',
    categoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'],
    categoryId: '201346401',
    sourceCategoryPath: ['Consumer Electronics', 'Mobile Phone & Radio', 'Mobile Phones'],
    sourceCategoryId: '201346402'
  };
  const route = resolvePublishRoute(product, { publishBindings: {} });
  assert.equal(route.categoryId, '201346402');
  assert.deepEqual(productCategory(product).path, product.sourceCategoryPath);
});

test('reference templates can preserve the target category while copying fields', () => {
  const target = {
    title: 'Phone', categoryPath: ['Consumer Electronics', 'Mobile Phone & Radio', 'Mobile Phones'], categoryId: '201346402',
    sourceCategoryPath: ['Consumer Electronics', 'Mobile Phone & Radio', 'Mobile Phones'], sourceCategoryId: '201346402',
    price: 10, stock: 5, variantGroups: []
  };
  const reference = {
    categoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'], categoryId: '201346401',
    attributes: [{ name: '类型', value: 'Propellers' }], variantGroups: [{ name: 'Color', options: ['Black'] }]
  };
  const patch = applyPublishedProductReference(target, reference, { preserveCategory: true });
  assert.equal(patch.categoryId, undefined);
  assert.equal(patch.categoryPath, undefined);
  assert.deepEqual(patch.variantGroups, reference.variantGroups);
});

test('references top-level category values and preserves SKU commerce by matching attributes', () => {
  const target = {
    title: 'Target', price: 12, stock: 7,
    attributes: [], variantGroups: [{ name: 'Color', options: ['White', 'Black'] }],
    skus: [
      { code: 'WHITE-TARGET', price: 21, stock: 11, attributes: { Color: 'White' } },
      { code: 'BLACK-TARGET', price: 22, stock: 12, attributes: { Color: 'Black' } }
    ]
  };
  const reference = {
    categoryPath: ['Consumer Electronics', 'Camera', 'Drones Accessories'], categoryId: '201346401',
    province: 'Guangdong', brandName: 'RadioMaster', compatibleBrand: 'DJI', material: 'Carbon Fiber', privateMold: 'Yes',
    colorImages: { Black: 'black-reference.jpg' },
    variantGroups: [{ name: 'Color', options: ['Black', 'White'] }],
    skus: [
      { code: 'BLACK-REFERENCE', price: 99, stock: 1, attributes: { Color: 'Black' } },
      { code: 'WHITE-REFERENCE', price: 98, stock: 2, attributes: { Color: 'White' } }
    ]
  };
  const patch = applyPublishedProductReference(target, reference);
  assert.deepEqual(patch.attributes.map((item) => [item.name, item.value]), [
    ['省份', 'Guangdong'], ['品牌名称', 'RadioMaster'], ['适用品牌', 'DJI'], ['材质', 'Carbon Fiber'], ['私模', 'Yes']
  ]);
  assert.equal(patch.skus[0].price, 22);
  assert.equal(patch.skus[0].stock, 12);
  assert.equal(patch.skus[0].code, 'BLACK-TARGET');
  assert.equal(patch.skus[1].price, 21);
  assert.equal(patch.skus[1].code, 'WHITE-TARGET');
  assert.equal(patch.variantGroups[0].optionImages.Black, 'black-reference.jpg');
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

test('keeps a single image-backed source model as a required SKU variant', () => {
  const product = {
    variantGroups: [{
      name: 'model number',
      type: 'IMAGE',
      options: ['MF1604-2PCS/PAIR'],
      optionImages: { 'MF1604-2PCS/PAIR': 'https://example.com/model.jpg' }
    }]
  };
  assert.equal(findBlockingUnmappedVariant(product, ['model number: MF1604-2PCS/PAIR']), 'model number: MF1604-2PCS/PAIR');
});

test('does not block a single image-backed descriptive socket standard', () => {
  const group = {
    name: 'Socket Standard',
    type: 'IMAGE',
    options: ['QS8+ plug'],
    optionImages: { 'QS8+ plug': 'https://example.com/plug.jpg' }
  };
  assert.equal(isRequiredTargetVariantGroup(group), false);
  assert.equal(findBlockingUnmappedVariant({ variantGroups: [group] }, ['Socket Standard: QS8+ plug']), '');
});

test('keeps a multi-option SKU variant blocking when the target category cannot represent it', () => {
  const product = { variantGroups: [{ name: 'Compatible model', options: ['Model A', 'Model B'] }] };
  assert.equal(findBlockingUnmappedVariant(product, ['Compatible model: Model B']), '');
});

test('flattens a two-dimensional source SKU matrix into one target specification without dropping combinations', () => {
  const product = {
    variantGroups: [
      { name: 'color', options: ['Gray', 'Black'] },
      { name: 'Socket Standard', options: ['EU plug', 'US plug'] }
    ],
    skus: [
      { attributes: { color: 'Gray', 'Socket Standard': 'EU plug' }, image: 'gray.jpg' },
      { attributes: { color: 'Gray', 'Socket Standard': 'US plug' }, image: 'gray.jpg' },
      { attributes: { color: 'Black', 'Socket Standard': 'EU plug' }, image: 'black.jpg' },
      { attributes: { color: 'Black', 'Socket Standard': 'US plug' }, image: 'black.jpg' }
    ]
  };
  const group = buildFlattenedVariantGroup(product, '400050816', 'Output Plug');
  assert.deepEqual(group.options, [
    'Gray / EU plug', 'Gray / US plug', 'Black / EU plug', 'Black / US plug'
  ]);
  assert.equal(group.optionImages['Black / US plug'], 'black.jpg');
  assert.deepEqual(group.sourceGroups, ['color', 'Socket Standard']);
});

test('does not block duplicated single-value SKU options from detail-page matrices', () => {
  const product = {
    variantGroups: [{ name: 'compatible model', options: ['Model A', 'Model B'], type: 'TEXT' }],
    skus: [
      { attributes: { 'compatible model': 'Model A' } },
      { attributes: { 'compatible model': 'Model A' } }
    ]
  };
  assert.equal(findBlockingUnmappedVariant(product, ['compatible model: Model B']), '');
});

test('keeps the source color as a target sales specification, including one-color SKUs', () => {
  assert.equal(needsColorSaleSpecification({ options: ['Black'] }), true);
  assert.equal(needsColorSaleSpecification({ options: ['Black', 'Black'] }), true);
  assert.equal(needsColorSaleSpecification({ options: ['Black', 'Red'] }), true);
  assert.equal(shouldUseColorSaleSpecification({ options: ['Black'] }, true), true);
  assert.equal(shouldUseColorSaleSpecification({ options: ['Black'] }, false), false);
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
  assert.equal(categoryMismatchMessage({
    sourceCategoryPath: ['Consumer Electronics', 'Chargers, Batteries & Power Supplies', 'Battery Chargers']
  }, '消费电子 >> 充电器，电池和电源 >> 电池充电器'), '');
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

test('parses thousands separators in delivery quantities without changing the lead time', () => {
  assert.deepEqual(parseDeliveryTiers([
    ['Quantity (pieces)', '1 - 1,000', '> 1,000'],
    ['Lead time (days)', '7', 'To be negotiated']
  ]), [
    { range: '1 - 1,000', upperQuantity: 1000, leadText: '7', leadDays: '7' },
    { range: '> 1,000', upperQuantity: null, leadText: 'To be negotiated', leadDays: '' }
  ]);
});

test('matches exact measurements and containing ranges without selecting nearest unrelated values', () => {
  assert.ok(attributeOptionMatchScore('6.6 inch', '6.6"') > 0);
  assert.ok(attributeOptionMatchScore('6000-6999mAh', '6000-6999 mAh') > 0);
  assert.ok(attributeOptionMatchScore('5000mAh', '5000-5999 mAh') > 0);
  assert.equal(attributeOptionMatchScore('6.6 inch', '4.6"'), 0);
  assert.equal(attributeOptionMatchScore('6000-6999mAh', '＜500mAh'), 0);
  assert.equal(attributeOptionMatchScore('6000-6999mAh', '5000-5999mAh'), 0);
  assert.equal(attributeOptionMatchScore('5 G', '3 G'), 0);
  assert.equal(attributeOptionMatchScore('500mAh', '＜500mAh'), 0);
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

test('normalizes unit-bearing quantities and currency text for numeric publish inputs', () => {
  assert.equal(numericValue('2 pieces'), 2);
  assert.equal(numericValue('US $99.33 / piece'), 99.33);
  assert.equal(numericValue('1,000 boxes'), 1000);
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

test('validates FOB range and tier pricing modes', () => {
  const base = {
    title: 'Sample', mainImages: ['a', 'b', 'c', 'd'], detailImages: ['d'], attributes: [{ name: 'A', value: 'B' }, { name: 'C', value: 'D' }],
    origin: 'China', packaging: { weight: 1, length: 1, width: 1, height: 1 }, description: 'Details', price: 10, salesUnit: 'Piece', priceMode: 'fob-range'
  };
  assert.equal(auditProduct({ ...base, fobPrice: { minPrice: 8, maxPrice: 12 } }).errors, 0);
  assert.ok(auditProduct({ ...base, fobPrice: { minPrice: 12, maxPrice: 8 } }).issues.some((item) => item.code === 'trade.fob.range.invalid'));
  assert.equal(auditProduct({ ...base, priceMode: 'fob-tier', fobPrice: { tiers: [{ minQuantity: 1, price: 9 }, { minQuantity: 100, price: 8 }] } }).errors, 0);
  assert.ok(auditProduct({ ...base, priceMode: 'fob-tier', fobPrice: { tiers: [{ minQuantity: 100, price: 8 }, { minQuantity: 1, price: 9 }] } }).issues.some((item) => item.code === 'trade.fob.tiers.order'));
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

test('prepares a complete publish payload from collected SKU data', () => {
  const prepared = preparePublishProduct({
    id: 'p-1', title: 'Phone', price: 82.5, stock: 100,
    mainImages: ['https://img/1.jpg', 'bad'], detailImages: ['https://img/detail.jpg'],
    descriptionHtml: '<script>alert(1)</script><p>Details</p>',
    attributes: [{ name: 'screen size', value: '6.8 inch' }, { name: 'battery capacity', value: '5000mAh' }],
    origin: 'China', packaging: { weight: 0.6 },
    variantGroups: [{ name: 'Color', options: ['Black'] }],
    skus: [{ attributes: { Color: 'Black' }, price: '', stock: 0 }]
  });
  assert.equal(prepared.descriptionHtml.includes('<script'), false);
  assert.equal(prepared.skus[0].price, '82.50');
  assert.equal(prepared.skus[0].stock, 100);
  assert.equal(prepared.skus[0].code, 'p-1-1');
  assert.deepEqual(prepared.mainImages, ['https://img/1.jpg']);
});

test('recognizes Alibaba field-specific required errors for recovery', () => {
  assert.equal(isRequiredAttributeError('屏幕尺寸必填项不能为空；电池容量必填项不能为空'), true);
  assert.equal(isRequiredAttributeError('商品已成功提交审核'), false);
});

test('infers common required category values from source titles and SKU groups', () => {
  const phone = { title: 'Unlocked smartphone 6.8 inch 5000mAh Snapdragon 8 Gen 2' };
  assert.equal(inferRequiredAttributeValue(phone, '屏幕尺寸'), '6.8 inch');
  assert.equal(inferRequiredAttributeValue(phone, '电池容量'), '5000mAh');
  assert.match(inferRequiredAttributeValue(phone, '处理器品牌'), /Snapdragon 8 Gen 2/i);
  const drone = { variantGroups: [{ name: 'compatible model', options: ['General UAV'] }] };
  assert.equal(inferRequiredAttributeValue(drone, '适用型号'), 'General UAV');
});

test('automatic reference repair only fills missing publish fields', () => {
  const target = {
    title: 'Target phone', price: 18, stock: 9,
    attributes: [{ name: '屏幕', value: '' }, { name: '品牌名称', value: 'Target brand' }]
  };
  const reference = {
    title: 'Published phone', price: 99,
    attributes: [{ name: '屏幕', value: '6.8 inch' }, { name: '品牌名称', value: 'Reference brand' }, { name: '电池容量', value: '5000mAh' }]
  };
  const patch = applyPublishedProductReference(target, reference, { preserveCategory: true, onlyMissing: true });
  assert.equal(patch.title, undefined);
  assert.equal(patch.price, undefined);
  assert.deepEqual(patch.attributes, [
    { name: '屏幕', value: '6.8 inch', source: 'reference-published-product' },
    { name: '品牌名称', value: 'Target brand' },
    { name: '电池容量', value: '5000mAh' }
  ]);
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
  assert.equal(product.schemaVersion, 5);
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
