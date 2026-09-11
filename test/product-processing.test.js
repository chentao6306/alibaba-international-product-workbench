import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMarketplaceProduct, processingSettings, translateProductTitle } from '../server/product-processing.js';
import { recordProductMutation, syncProductModel } from '../server/product-model.js';
import { extractMarketplaceProduct } from '../server/marketplace-source-data.js';

test('prepares a 1688 title and all price modes while preserving original evidence and missing facts', async () => {
  const item = syncProductModel({ sourcePlatform: '1688', title: '不锈钢杯 500ml', price: '70', currencySymbol: '¥', sourceCurrency: 'CNY', packaging: {}, categoryId: '', origin: '', skus: [{ id: 'sku', price: '84', stock: 0 }], priceTiers: [{ minQuantity: 2, price: '70' }], fobPrice: { minPrice: '70', maxPrice: '84' } }, { captureSource: true });
  const before = structuredClone(item.source);
  const patch = await prepareMarketplaceProduct(item, { translateTitle: true, convertCurrency: true, usdRates: { CNY: 0.14 } }, {
    apiKey: 'test-secret', fetcher: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer test-secret');
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).messages[1].content, JSON.stringify({ sourceTitle: item.title }));
      return Response.json({ choices: [{ message: { content: '{"title":"Stainless Steel Cup 500ml"}' } }] });
    },
  });
  recordProductMutation(item, patch);
  assert.equal(item.title, 'Stainless Steel Cup 500ml'); assert.equal(item.price, '9.80');
  assert.equal(item.skus[0].price, '11.76'); assert.equal(item.skus[0].stock, 0);
  assert.equal(item.fobPrice.maxPrice, '11.76'); assert.equal(item.priceTiers[0].price, '9.80');
  assert.deepEqual(item.source, before); assert.deepEqual(item.packaging, {}); assert.equal(item.categoryId, ''); assert.equal(item.origin, '');
  const second = await prepareMarketplaceProduct(item, { translateTitle: true, convertCurrency: true, usdRates: { CNY: 0.14 } }, { fetcher: () => { throw Error('should not call twice'); } });
  assert.deepEqual(second, { processingWarnings: [] });
});

test('keeps original data on disabled settings, DeepSeek failure, missing rates and sub-cent prices', async () => {
  const product = { sourcePlatform: '1688', title: '原始中文标题', currencySymbol: '¥', price: 0.01 };
  assert.deepEqual(await prepareMarketplaceProduct(product, {}), { processingWarnings: [] });
  const failed = await prepareMarketplaceProduct(product, { translateTitle: true, convertCurrency: true, usdRates: { CNY: 0.01 } });
  assert.equal(failed.price, undefined); assert.equal(failed.title, undefined); assert.equal(failed.processingWarnings.length, 2);
  const missing = await prepareMarketplaceProduct({ ...product, sourcePlatform: 'aliexpress', currencySymbol: 'EUR' }, { convertCurrency: true });
  assert.match(missing.processingWarnings[0], /EUR/);
  assert.throws(() => processingSettings({ usdRates: { CNY: -1 } }), /汇率/);
  assert.throws(() => processingSettings({ usdRates: { USD: 7 } }), /币种/);
});

test('rejects malformed translations and does not return provider response bodies or secrets', async () => {
  for (const content of ['not-json', '{"title":"中文标题"}', '{"title":"<script>bad</script>"}', JSON.stringify({ title: 'x'.repeat(129) })]) {
    await assert.rejects(translateProductTitle('杯子', { apiKey: 'test', fetcher: async () => Response.json({ choices: [{ message: { content } }] }) }), /未返回有效英文标题/);
  }
  await assert.rejects(translateProductTitle('杯子', { apiKey: 'test', fetcher: async () => Response.json({ error: 'secret' }, { status: 401 }) }), /API 密钥无效/);
});

test('keeps AliExpress USD prices and converts other currencies without changing SKU identities', async () => {
  const product = { sourcePlatform: 'aliexpress', title: 'Headphones', currencySymbol: '€', price: '20', skus: [{ id: '1', price: '25' }] };
  const patch = await prepareMarketplaceProduct(product, { convertCurrency: true, usdRates: { EUR: 1.1 } });
  assert.equal(patch.price, '22.00'); assert.equal(patch.skus[0].id, '1'); assert.equal(patch.skus[0].price, '27.50');
  assert.deepEqual(await prepareMarketplaceProduct({ ...product, currencySymbol: '$' }, { convertCurrency: true }), { processingWarnings: [] });
});

test('ignores interface SVG images and reads alternate source tier quantity names', () => {
  const source = { subject: 'Cup', images: ['https://img.alicdn.com/icon.svg', 'https://cbu01.alicdn.com/product.jpg'], priceRanges: [{ beginNumber: 2, price: '20' }, { beginNumber: 10, price: '18' }] };
  const product = extractMarketplaceProduct(`<script>window.__INIT_DATA=${JSON.stringify(source)};</script>`, '1688', 'https://detail.1688.com/offer/123456789.html');
  assert.deepEqual(product.mainImages, ['https://cbu01.alicdn.com/product.jpg']);
  assert.deepEqual(product.priceTiers.map((tier) => tier.minQuantity), [2, 10]);
});
