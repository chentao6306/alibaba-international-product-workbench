import assert from 'node:assert/strict';
import test from 'node:test';
import { ShopCollector, collectionPageRange, readInternationalModules } from '../server/collector.js';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CollectionCheckpoint } from '../server/collection-checkpoint.js';

test('resumes listing pages and detail items from disk after pause, restart and browser recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-resume-'));
  const disk = new CollectionCheckpoint(directory, 'task');
  let checkpoint;
  const visits = [];
  const details = [];
  const makeCollector = () => {
    const collector = new ShopCollector(directory, async (products, progress) => {
      const result = [];
      for (const product of products) {
        details.push(product.sourceId); result.push(product);
        if (progress(result.length, products.length, product) === false) throw Object.assign(new Error('Paused'), { code: 'COLLECT_PAUSED' });
      }
      return result;
    });
    let current;
    const page = { isClosed: () => false, evaluate: async () => false, waitForTimeout: async () => {}, waitForLoadState: async () => {},
      url: () => `https://fixture.en.alibaba.com/productlist-${current}.html`,
      goto: async (url) => { current = Number(url.match(/productlist-(\d+)/)?.[1] || 1); visits.push(current); },
      locator: () => ({ evaluateAll: async () => ({ pageNav: { currentPage: current, totalLines: 6, pageLines: 2,
        formatString: 'https://fixture.en.alibaba.com/productlist-{0}.html' }, products: [1, 2].map((i) => ({
          id: String((current - 1) * 2 + i), subject: 'Product', url: `https://www.alibaba.com/product-detail/item_${current}${i}.html` })) }) }) };
    collector.withPage = (callback) => callback(page);
    return collector;
  };
  const options = () => ({ allPages: true, checkpoint: new CollectionCheckpoint(directory, 'task').read(), onCheckpoint: (value) => { disk.write(value); checkpoint = value; } });
  try {
    const url = 'https://fixture.en.alibaba.com/productlist.html';
    await assert.rejects(makeCollector().collectGroup(url, (event) => event.stage !== 'listing' || event.page !== 2, options()), { code: 'COLLECT_PAUSED' });
    assert.deepEqual(visits, [1, 2]); assert.equal(checkpoint.page, 2); assert.equal(checkpoint.products.length, 4);
    visits.length = 0;
    await assert.rejects(makeCollector().collectGroup(url, (event) => !event.product || event.current !== 2, options()), { code: 'COLLECT_PAUSED' });
    assert.deepEqual(visits, [3]); assert.deepEqual(details, ['1', '2']); assert.deepEqual(checkpoint.completedIds, ['1', '2']);
    visits.length = 0;
    const events = [];
    await makeCollector().collectGroup(url, (event) => events.push(event), options());
    assert.deepEqual(visits, [], 'Resuming details must not reread any listing page');
    assert.deepEqual(details, ['1', '2', '3', '4', '5', '6']);
    assert.equal(events[0].current, 2); assert.equal(events.at(-1).current, 6);
    assert.equal(new CollectionCheckpoint(directory, 'task').read().completedIds.length, 6);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('all-pages collection reads past ten pages and respects explicit ranges without repeating a redirected page', async () => {
  const collector = new ShopCollector('.', async (products) => products);
  let current = 1;
  let redirected = false;
  let emptyReads = 0;
  let emptyPage = 0;
  let recommendationsOnly = false;
  let emptyPager = false;
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
      evaluateAll: async () => selector !== '[module-data]' ? false : (current === emptyPage && emptyReads-- > 0) ? { products: recommendationsOnly ? [{ id: 'recommendation', subject: 'Recommended' }] : [], pageNav: emptyPager ? { currentPage: current, totalLines: 0, pageLines: 16 } : null } : {
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
  assert.equal(events.filter((event) => event.stage === 'listing').at(-1).page, 62);
  assert.equal(events.filter((event) => event.stage === 'listing').at(-1).storeTotal, 982);
  assert.deepEqual(events.at(-1), { stage: 'detail', current: 0, saved: 0, skippedCount: 0, total: 982, found: 982 });
  const limited = await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 10 });
  assert.equal(limited.length, 160);
  const tail = await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { startPage: 61, endPage: 62 });
  assert.equal(tail.length, 22);
  emptyPage = 2; emptyReads = 1;
  assert.equal((await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 3 })).length, 48);
  emptyReads = 3;
  await assert.rejects(collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 3 }), /第 2 页未返回商品列表.*采集未完成/);
  recommendationsOnly = true; emptyPage = 31; emptyReads = 1;
  const recovered = await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 100 });
  assert.equal(recovered.length, 982);
  assert.equal(recovered.some((product) => product.sourceId === 'recommendation'), false);
  emptyReads = 3;
  await assert.rejects(collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 100 }), /第 31 页未返回商品列表.*采集未完成/);
  recommendationsOnly = false; emptyPager = true; emptyReads = 3;
  await assert.rejects(collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { endPage: 100 }), /第 31 页未返回商品列表.*采集未完成/);
  emptyPage = 1; emptyReads = 1;
  assert.equal((await collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { allPages: true })).length, 0);
  emptyPage = 0;
  redirected = true;
  await assert.rejects(collector.collectGroup('https://example.en.alibaba.com/productlist.html', () => {}, { allPages: true }), /第 2 页未成功加载/);
});

test('store recommendations never replace the paginated product list regardless of module order', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const listing = { productList: [{ id: 'actual' }], pageNavView: { currentPage: 42, totalLines: 981, pageLines: 16 } };
    const recommendations = { productList: [{ id: 'recommended' }] };
    for (const modules of [[listing, recommendations], [recommendations, listing]]) {
      await page.setContent('<main></main>');
      await page.evaluate((modules) => {
        for (const data of modules) {
          const node = document.createElement('div');
          node.setAttribute('module-data', encodeURIComponent(JSON.stringify({ mds: { moduleData: { data } } })));
          document.body.append(node);
        }
      }, modules);
      const result = await readInternationalModules(page);
      assert.deepEqual(result.products, listing.productList);
      assert.deepEqual(result.pageNav, listing.pageNavView);
    }
  } finally { await browser.close(); }
});
