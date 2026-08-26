import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeShopUrl, productIdFromUrl } from '../server/collector.js';
import {
  buildLegacyDescriptionHtml,
  buildSkuCombinations,
  canonicalizePriceTiers,
  categoryMismatchMessage,
  parseDeliveryTiers,
  isAlibabaInternationalUrl,
  isProductPostingUrl,
  normalizePriceTiers,
  parsePriceTiers,
  sanitizeCategoryPath,
  sanitizeCollectedProduct,
  sanitizeSourceDescriptionHtml,
  sourceDetailHasBrokenImages,
  validateProductData
} from '../server/publisher.js';
import { auditProduct, recordProductMutation, sourceSnapshotFingerprint, syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { deleteWorkspaceEntities, JsonStore } from '../server/store.js';

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
  assert.equal(product.schemaVersion, 3);
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
