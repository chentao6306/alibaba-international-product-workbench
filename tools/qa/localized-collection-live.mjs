import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../../server/publisher.js';
import { ShopCollector } from '../../server/collector.js';
import { collectionUrls } from '../../server/source-platform.js';
import { readPrivateSession, writePrivateSession } from '../../server/private-session-storage.js';
import { syncProductModel, verifySourceIntegrity } from '../../server/product-model.js';
import { JsonStore } from '../../server/store.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && !fs.existsSync(root) && process.env.QA_DESKTOP_USER_DATA_DIR);
fs.mkdirSync(root, { recursive: true });
const cookies = path.join(root, 'session.json');
writePrivateSession(cookies, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookies;
const url = 'https://chinese.alibaba.com/product-detail/Cute-Bun-Shaped-Acrylic-Liquid-Keychain-1601840934242.html?spm=a27aq.29918103.4207392620.6.40ae50dfGCW7PJ&trafficsource=hometool';
const publisher = new SellerPublisher(path.join(root, 'browser'));
const collector = new ShopCollector(root, (...args) => publisher.enrichSourceProducts(...args));
const report = { requestedUrl: url, events: [] };
try {
  const products = await collector.collectLinks(collectionUrls(url, 'product', 'alibaba.com'), event => {
    report.events.push({ current: event.current, total: event.total, error: event.error || '', key: event.key });
  }, { delaySeconds: 0 });
  assert.equal(products.length, 1, JSON.stringify(report.events));
  const product = syncProductModel({ ...products[0], id: 'localized-link-live-1601840934242' }, { captureSource: true });
  assert.equal(product.sourceId, '1601840934242');
  assert.equal(product.sourceUrl, url);
  assert.ok(product.title && product.mainImages.length && product.attributes.length);
  assert.equal(verifySourceIntegrity(product).valid, true);
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => { state.products.push(product); });
  const reopened = new JsonStore(path.join(root, 'workspace.json')).read().products.find(row => row.id === product.id);
  assert.deepEqual(reopened.source.snapshot, product.source.snapshot);
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify(product, null, 2));
  Object.assign(report, { ok: true, sourceId: product.sourceId, title: product.title,
    mainImages: product.mainImages.length, detailImages: product.detailImages?.length || 0,
    attributes: product.attributes.length, skus: product.skus?.length || 0,
    sourceIntegrity: verifySourceIntegrity(reopened).valid, savedAndReopened: true });
} catch (error) {
  Object.assign(report, { ok: false, error: { code: error.code, message: error.message } });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await publisher.shutdown();
}
