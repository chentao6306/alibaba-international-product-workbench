import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStockPolicy, minimumOrderQuantity } from '../server/publish-policy.js';
import { recordProductMutation } from '../server/product-model.js';
import { preparePublishProduct, buildLegacyDescriptionHtml, applyPostingLogistics } from '../server/publisher.js';
import { createPublishedReferenceTemplate } from '../server/publish-reference.js';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

const policy = { stockPolicy: 'minimum-order' };
const legacy = { stock: 100, minOrder: 180, source: { snapshot: { stock: null } }, sourceTradeAvailability: { exactSkuStockPublished: false } };

test('defaults unpublished stock to the first price tier and records the policy without changing the capture', () => {
  const product = { ...legacy, priceTiers: [{ minQuantity: 360 }, { minQuantity: 240 }] };
  const result = applyStockPolicy(product, policy);
  assert.equal(result.stock, 240);
  assert.equal(result.stockProvenance.stock, 'default-minimum-order');
  assert.equal(product.stock, 100);
  assert.equal(result.source.snapshot.stock, null);
  assert.equal(minimumOrderQuantity({ moq: '1,440 pieces' }), 1440);
});

test('respects manual stock, explicit zero, and exact source quantities even when below MOQ', () => {
  for (const product of [
    { ...legacy, stockProvenance: { stock: 'manual' } },
    { ...legacy, stock: 0 },
    { ...legacy, source: { snapshot: { stock: 100 } } },
    { ...legacy, sourceTradeAvailability: { exactSkuStockPublished: true } },
    { ...legacy, source: undefined },
    { ...legacy, auditTrail: [{ actor: 'user', fields: ['stock'], before: { stock: 90 }, after: { stock: 100 } }] },
  ]) assert.equal(applyStockPolicy(product, policy).stock, product.stock);
});

test('records manual inventory changes durably and does not mark untouched stock when editing a title', () => {
  const product = structuredClone(legacy);
  recordProductMutation(product, { stock: 88 });
  product.auditTrail = [];
  assert.equal(applyStockPolicy(product, policy).stock, 88);
  const unchanged = structuredClone(legacy);
  recordProductMutation(unchanged, { title: 'Updated', stock: 100 });
  assert.equal(applyStockPolicy(unchanged, policy).stock, 180);
  unchanged.skus = [{ stock: 100, price: 1 }];
  recordProductMutation(unchanged, { skus: [{ stock: '100', price: 2 }] });
  assert.equal(applyStockPolicy(unchanged, policy).skus[0].stock, 180);
});

test('preserves manual SKU stock and disabled variants while replacing synthetic default quantities', () => {
  const product = { ...legacy, skus: [{ stock: 100 }, { stock: 0 }, { stock: 100, enabled: false }] };
  const result = preparePublishProduct({ ...product, variantGroups: [{ name: 'Color' }] }, policy);
  assert.deepEqual(result.skus.map((sku) => sku.stock), [180, 0, 100]);
  assert.deepEqual(applyStockPolicy({ ...product, stockProvenance: { skus: 'manual' } }, policy).skus, product.skus);
  assert.deepEqual(applyStockPolicy({ ...product, categoryReference: { sourceId: 'ref' } }, policy).skus, product.skus);
});

test('collection defaults absent inventory, and fixed defaults stay configurable', () => {
  assert.equal(applyStockPolicy({ stock: null, minOrder: 216 }, { ...policy, collected: true }).stock, 216);
  assert.equal(applyStockPolicy({ stock: null }, { stockPolicy: 'fixed', defaultStock: 88, collected: true }).stock, 88);
  assert.equal(applyStockPolicy(legacy).stock, 100);
});

test('keeps factual packaging in the product and inquiry reference without inventing description content', () => {
  const product = { title: 'Toy', packaging: { weight: 0.91, length: 24.1, width: 14.1, height: 21.2 } };
  const html = buildLegacyDescriptionHtml(product);
  assert.doesNotMatch(html, /0.91 kg|24.1 cm/);
  const reference = createPublishedReferenceTemplate({ ...product, publishResult: {
    listingMode: 'inquiry', acceptedLogistics: { packaging: {}, logisticsAttributes: [] },
  } });
  assert.deepEqual(reference.packaging, product.packaging);
});

test('inquiry mode preserves supplied packaging on a verified opportunity form and refuses transactional forms', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<p>当前商品类型：商机品</p><div id="pkgWeight"><input name="pkgWeight" value="2"></div><input id="unrelated" value="12">');
    await applyPostingLogistics(page, { packaging: { weight: 2 } }, { listingMode: 'inquiry' });
    assert.equal(await page.locator('#pkgWeight input').inputValue(), '2');
    assert.equal(await page.locator('#unrelated').inputValue(), '12');
    await page.setContent('<p>当前商品类型：交易品</p><div id="pkgWeight"><input name="pkgWeight" value="2"></div>');
    await assert.rejects(applyPostingLogistics(page, {}, { listingMode: 'inquiry' }), { code: 'PUBLISH_SALES_MODE_MISMATCH' });
    assert.equal(await page.locator('input').inputValue(), '2');
    await page.setContent('<p>当前商品类型：商机品</p><div id="pkgWeight"><input name="pkgWeight" required value="2"></div>');
    await assert.rejects(applyPostingLogistics(page, {}, { listingMode: 'inquiry' }), { code: 'PUBLISH_SALES_MODE_MISMATCH' });
  } finally { await browser.close(); }
});
