import assert from 'node:assert/strict';
import test from 'node:test';
import { ShopCollector, collectionPageRange } from '../server/collector.js';

test('all-pages collection reads past ten pages and respects explicit ranges without repeating a redirected page', async () => {
  const collector = new ShopCollector('.', async (products) => products);
  let current = 1;
  let redirected = false;
  let emptyReads = 0;
  let emptyPage = 0;
  const events = [];
  const total = 982;
  const page = {
    isClosed: () => false,
    url: () => `https://example.en.alibaba.com/productlist-${current}.html`,
    goto: async (url) => { current = Number(url.match(/productlist-(\d+)/)?.[1] || 1); },
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    locator: (selector) => ({
      isVisible: async () => false, count: async () => 0, all: async () => [],
      innerText: async () => '',
      evaluateAll: async () => selector !== '[module-data]' ? false : (current === emptyPage && emptyReads-- > 0) ? { products: [], pageNav: null } : {
        pageNav: { currentPage: redirected ? 1 : current, totalLines: total, pageLines: 16, formatString: 'https://example.en.alibaba.com/productlist-{0}.html' },
        products: Array.from({ length: Math.min(16, total - (current - 1) * 16) }, (_, i) => ({ id: `${(current - 1) * 16 + i + 1}`, subject: 'Product', url: 'https://www.alibaba.com/product-detail/product_123456789.html' }))
      },
    }),
    evaluate: async () => false,
  };
  collector.withPage = async (callback) => callback(page);
  assert.deepEqual(collectionPageRange({}), { allPages: true, startPage: 1, endPage: null });
  assert.equal(collectionPageRange({ endPage: 10 }).allPages, false);
  const all = await collector.collectGroup('https://example.en.alibaba.com/productlist.html', (event) => events.push(event), { allPages: true, endPage: 10 });
  assert.equal(all.length, 982);
  assert.equal(events.at(-1).page, 62);
  assert.equal(events.at(-1).storeTotal, 982);
  const limited = await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 10 });
  assert.equal(limited.length, 160);
  const tail = await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { startPage: 61, endPage: 62 });
  assert.equal(tail.length, 22);
  emptyPage = 2; emptyReads = 1;
  assert.equal((await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 3 })).length, 48);
  emptyReads = 3;
  await assert.rejects(collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 3 }), /第 2 页未返回商品列表.*采集未完成/);
  emptyPage = 0;
  redirected = true;
  await assert.rejects(collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { allPages: true }), /第 2 页未成功加载/);
});
