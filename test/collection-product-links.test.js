import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectionUrls, parseCollectionUrl } from '../server/source-platform.js';
import { requireAlibabaSourceProduct } from '../server/alibaba-source-data.js';
import { productIdFromUrl } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';
import { JsonStore } from '../server/store.js';
import { verifySourceIntegrity } from '../server/product-model.js';

const sourceId = '1601840934242';
const chinese = 'https://chinese.alibaba.com/product-detail/Cute-Bun-Shaped-Acrylic-Liquid-Keychain-' + sourceId + '.html?spm=a27aq.29918103.4207392620.6.40ae50dfGCW7PJ&trafficsource=hometool';
const english = 'https://www.alibaba.com/product-detail/Cute-Bun-Shaped-Acrylic-Liquid-Keychain_' + sourceId + '.html';

test('accepts localized hyphen detail links and deduplicates by identity without rewriting the source URL', () => {
  for (const url of [chinese, english, english.replace('_160', '-160'), chinese.replace('-160', '_160')]) {
    const parsed = parseCollectionUrl(url, 'product', 'alibaba.com');
    assert.deepEqual(parsed, { url, platform: 'alibaba.com', sourceId, mode: 'product' });
    assert.equal(productIdFromUrl(url), sourceId);
  }
  assert.equal(parseCollectionUrl(chinese.replace('https://', '')).url, chinese);
  assert.equal(parseCollectionUrl(chinese + '#details').url, chinese);
  assert.deepEqual(collectionUrls([chinese, english, chinese + '&extra=1'], 'product', 'alibaba.com'), [
    { url: chinese + '&extra=1', platform: 'alibaba.com', sourceId, mode: 'product' },
  ]);
});

test('localized detail support does not accept stores, search pages, nested paths, invalid IDs or lookalike hosts', () => {
  for (const url of [
    'https://chinese.alibaba.com/', 'https://supplier.en.alibaba.com/productlist.html',
    'https://chinese.alibaba.com/search/page?productId=' + sourceId,
    'https://chinese.alibaba.com/product-detail/Cute-Bun.html',
    'https://chinese.alibaba.com/product-detail/nested/Cute-' + sourceId + '.html',
    'https://chinese.alibaba.com/product-detail/Cute-' + sourceId + 'abc.html',
    'https://chinese.alibaba.com/product-detail/Cute-' + sourceId + '.html/extra',
    chinese.replace('chinese.alibaba.com', 'chinese.alibaba.com.example.com'),
    chinese.replace('https://', 'https://name:password@'),
    chinese.replace('chinese.alibaba.com', 'chinese.alibaba.com:9999'),
  ]) assert.throws(() => parseCollectionUrl(url, 'product', 'alibaba.com'), url);
  assert.throws(() => parseCollectionUrl(chinese, 'product', '1688'));
});

test('source identity survives localized redirects but still detects removed, different and restricted products', () => {
  for (const url of [chinese, english, english.replace('_160', '-160')]) {
    assert.doesNotThrow(() => requireAlibabaSourceProduct(url, sourceId, 'Available product'));
    assert.throws(() => requireAlibabaSourceProduct(url.replace(sourceId, '1601840934243'), sourceId, 'Other product'),
      { code: 'SOURCE_PRODUCT_UNAVAILABLE', canSkipProduct: true });
    assert.throws(() => requireAlibabaSourceProduct(url, sourceId, '该商品已下架'),
      { code: 'SOURCE_PRODUCT_UNAVAILABLE', canSkipProduct: true });
    assert.throws(() => requireAlibabaSourceProduct(url, sourceId, '', { status: 403 }),
      { code: 'SOURCE_PAGE_NOT_READY' });
  }
});

test('single-product API queues a localized link once, saves its original identity and reopens the collected source snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localized-collection-'));
  const original = SellerPublisher.prototype.enrichSourceProducts;
  process.env.DATA_DIR = root;
  process.env.PORT = '0';
  let server;
  const visits = [];
  SellerPublisher.prototype.enrichSourceProducts = async products => products.map(product => {
    visits.push(product.sourceUrl);
    requireAlibabaSourceProduct(product.sourceUrl, product.sourceId, 'Available');
    return { ...product, sourceOriginalTitle: 'Cute Bun Shaped Acrylic Liquid Keychain', price: 1.2, minOrder: 10,
      mainImages: ['https://sc04.alicdn.com/kf/product.jpg'], detailImages: ['https://sc04.alicdn.com/kf/detail.jpg'],
      descriptionHtml: '<p>Acrylic liquid keychain</p>', attributes: [{ name: 'Material', value: 'Acrylic' }] };
  });
  try {
    server = await import('../server/index.js');
    const listener = await server.serverReady;
    const api = async (route, body) => {
      const response = await fetch('http://127.0.0.1:' + listener.address().port + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    const folder = (await api('/api/collection-folders', { name: 'Localized detail QA' })).data;
    const result = await api('/api/collect/links', { collectionFolderId: folder.id, platform: 'alibaba.com',
      method: 'product', delaySeconds: 0, urls: [english, chinese].join('\n') });
    assert.equal(result.status, 202);
    const store = new JsonStore(path.join(root, 'workspace.json'));
    const deadline = Date.now() + 10000;
    while (store.read().jobs.find(job => job.id === result.data.id)?.status !== 'completed' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const state = store.read();
    assert.equal(state.jobs.find(job => job.id === result.data.id).status, 'completed');
    assert.deepEqual(visits, [chinese]);
    assert.equal(state.products.length, 1);
    const product = state.products[0];
    assert.equal(product.sourceId, sourceId);
    assert.equal(product.sourceUrl, chinese);
    assert.equal(product.title, 'Cute Bun Shaped Acrylic Liquid Keychain');
    assert.equal(product.collectionFolderId, folder.id);
    assert.equal(verifySourceIntegrity(product).valid, true);
    const reopened = new JsonStore(path.join(root, 'workspace.json')).read().products[0];
    assert.deepEqual(reopened.source, product.source);
    const invalid = await api('/api/collect/links', { collectionFolderId: folder.id, platform: 'alibaba.com',
      method: 'product', urls: 'https://supplier.en.alibaba.com/productlist.html' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(visits, [chinese]);
  } finally {
    await server?.shutdownServer();
    SellerPublisher.prototype.enrichSourceProducts = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
