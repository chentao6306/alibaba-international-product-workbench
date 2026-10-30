import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { readAlibabaAvailabilityText, requireAlibabaSourceProduct } from '../server/alibaba-source-data.js';
import { SellerPublisher } from '../server/publisher.js';
import { ShopCollector } from '../server/collector.js';
import { CollectionCheckpoint, collectionResumeMessage } from '../server/collection-checkpoint.js';
import { findChromium } from '../server/browser-runtime.js';

const url = 'https://www.alibaba.com/product-detail/Item_1600462433078.html';
const sourceId = '1600462433078';

test('unavailable notices in reviews, recommendations, description and hidden templates cannot skip the current product', async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const wrapper of ['data-module-name="module_review"', 'data-testid="product-reviews"', 'id="recommendations"',
      'class="store-review-container"', 'data-module-name="module_structure_description"', 'style="display:none"']) {
      await page.setContent(`<h1>Steel bike basket</h1><div ${wrapper}>This product is no longer available</div>`);
      const text = await page.evaluate(readAlibabaAvailabilityText);
      assert.equal(text, 'Steel bike basket');
      assert.doesNotThrow(() => requireAlibabaSourceProduct(url, sourceId, text));
    }
    await page.setContent('<h1>This product is currently unavailable</h1><section class="recommendations">Steel basket</section>');
    const text = await page.evaluate(readAlibabaAvailabilityText);
    assert.equal(text, 'This product is currently unavailable');
    assert.throws(() => requireAlibabaSourceProduct(url, sourceId, text), { canSkipProduct: true });
  } finally { await browser.close(); }
});

test('only unavailable products and known redirects are skippable, never login, challenges, throttling or server errors', () => {
  for (const text of ['This product is currently unavailable', 'The product is no longer available', '此商品已下架', '该商品不存在']) {
    assert.throws(() => requireAlibabaSourceProduct(url, sourceId, text), { code: 'SOURCE_PRODUCT_UNAVAILABLE', canSkipProduct: true });
  }
  for (const status of [404, 410]) assert.throws(() => requireAlibabaSourceProduct(url, sourceId, '', { status }), { canSkipProduct: true });
  for (const redirect of ['https://www.alibaba.com/search/page', 'https://www.alibaba.com/', url.replace(sourceId, '1600462433079')]) {
    assert.throws(() => requireAlibabaSourceProduct(redirect, sourceId, 'Other products'), { canSkipProduct: true, reason: 'redirected' });
  }
  for (const status of [401, 403, 429, 500, 502, 503]) {
    assert.throws(() => requireAlibabaSourceProduct(url, sourceId, 'This product is currently unavailable', { status }), { code: 'SOURCE_PAGE_NOT_READY' });
  }
  for (const redirect of ['https://login.alibaba.com/', 'https://www.alibaba.com/verify/', 'https://www.alibaba.com/punish?x=1', url + '?_____tmd_____=1']) {
    assert.throws(() => requireAlibabaSourceProduct(redirect, sourceId, 'This product is currently unavailable'), { code: 'SOURCE_PAGE_NOT_READY' });
  }
  for (const redirect of ['about:blank', 'https://example.com/404', 'https://www.alibaba.com/unknown-error', 'https://www.alibaba.com/']) {
    assert.throws(() => requireAlibabaSourceProduct(redirect, sourceId, ''), { canSkipProduct: false });
  }
  assert.doesNotThrow(() => requireAlibabaSourceProduct(url, sourceId, 'This product is currently available'));
  assert.doesNotThrow(() => requireAlibabaSourceProduct(url.replace('/Item_', '/Fingerprint-login-Controller_'), sourceId, 'Available'));
});

test('skipping in the middle checkpoints a separate result and survives pause and process restart without dropping following products', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-skip-'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const context = await browser.newContext();
  const publisher = new SellerPublisher(directory);
  publisher.sourceBrowser = async () => context;
  const groupUrl = 'https://fixture.en.alibaba.com/productlist.html';
  const products = ['1', '2', '3', '4'].map(sourceId => ({ sourceId, sourceUrl: url.replace('1600462433078', sourceId), title: `Product ${sourceId}` }));
  const disk = new CollectionCheckpoint(directory, 'test-job');
  const initial = { version: 1, scope: JSON.stringify({ groupUrl, allPages: true, startPage: 1, endPage: null, sort: 'default', destinationCountry: '' }),
    stage: 'detail', page: 1, nextUrl: '', visited: [groupUrl], products, completedIds: [] };
  disk.write(initial);
  const reads = [], saved = [], progress = [];
  publisher.readSourceProduct = async (_page, product) => {
    reads.push(product.sourceId);
    if (product.sourceId === '2' || product.sourceId === '3') requireAlibabaSourceProduct(product.sourceUrl, product.sourceId, 'This product is currently unavailable');
    return { ...product, attributes: [{ name: 'Material', value: 'Steel' }] };
  };
  const collect = (pause) => {
    const collector = new ShopCollector(directory, (...args) => publisher.enrichSourceProducts(...args));
    collector.withPage = callback => callback({});
    return collector.collectGroup(groupUrl, item => {
      progress.push(item);
      if (item.product) saved.push(item.product.sourceId);
      return !(pause && item.skippedProduct);
    }, { checkpoint: new CollectionCheckpoint(directory, 'test-job').read(), onCheckpoint: value => disk.write(value) });
  };
  try {
    await assert.rejects(collect(true), { code: 'COLLECT_PAUSED' });
    const checkpoint = new CollectionCheckpoint(directory, 'test-job').read();
    assert.deepEqual(checkpoint.completedIds, ['1']);
    assert.deepEqual(checkpoint.skippedProducts.map(item => item.sourceId), ['2']);
    assert.equal(checkpoint.skippedProducts[0].sourceUrl, products[1].sourceUrl);
    assert.match(collectionResumeMessage(checkpoint), /2\/4.*跳过 1/);
    const resumed = await collect(false);
    assert.deepEqual(reads, ['1', '2', '3', '4']);
    assert.deepEqual(saved, ['1', '4']);
    assert.deepEqual(resumed.map(item => item.sourceId), ['4']);
    assert.equal(resumed[0].attributes[0].value, 'Steel');
    assert.equal(progress.at(-1).current, 4);
    assert.equal(progress.at(-1).saved, 2);
    assert.equal(progress.at(-1).skippedCount, 2);
    // Standalone collection must surface the failure instead of returning an
    // empty successful result, and old checkpoints remain readable.
    await assert.rejects(publisher.enrichSourceProducts([products[1]]), { code: 'SOURCE_PRODUCT_UNAVAILABLE' });
    disk.write(initial);
    assert.deepEqual(disk.read().completedIds, []);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('network and authentication failures retain the current product for retry even when automatic skipping is enabled', async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const context = await browser.newContext();
  const publisher = new SellerPublisher(os.tmpdir());
  publisher.sourceBrowser = async () => context;
  try {
    for (const error of [new Error('net::ERR_TIMED_OUT'), Object.assign(new Error('Login required'), { code: 'SOURCE_LOGIN_REQUIRED' }),
      Object.assign(new Error('Unknown redirect'), { code: 'SOURCE_PRODUCT_UNAVAILABLE', canSkipProduct: false })]) {
      let reads = 0;
      publisher.readSourceProduct = async () => { reads++; throw error; };
      await assert.rejects(publisher.enrichSourceProducts([{ sourceId: '1' }, { sourceId: '2' }], () => assert.fail('Must not save'), { onSkipped: () => assert.fail('Must not skip') }));
      assert.equal(reads, 1);
    }
  } finally { await browser.close(); }
});
