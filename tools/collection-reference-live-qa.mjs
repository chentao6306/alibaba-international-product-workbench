import { app, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ShopCollector, normalizeShopUrl } from '../server/collector.js';
import { CollectionCheckpoint } from '../server/collection-checkpoint.js';
import { SellerPublisher } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { withVerificationContext } from '../server/human-verification.js';
import { showHumanVerification } from '../electron/human-verification.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { inspectVerificationDocument } from '../server/human-verification.js';
import { productCategory, buildAlibabaPublishUrl } from '../server/category-routing.js';
import { createPublishedReferenceTemplate } from '../server/publish-reference.js';
import { applyPublishedProductReference, syncProductModel, recordProductMutation } from '../server/product-model.js';

// QA uses an isolated workspace and cookie copy; real submissions require a
// separate, explicit submit run after successful draft verification.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-reference-live-'));
const report = { output: root, listed: 0, resumedPages: [], collected: [], drafts: [] };
const save = () => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
const desktop = process.env.QA_DESKTOP_USER_DATA_DIR;
assert.ok(desktop && process.env.QA_EXPECTED_ACCOUNT, 'Specify desktop profile and expected seller account');
const state = JSON.parse(fs.readFileSync(path.join(desktop, '.data', 'workspace.json'), 'utf8'));
const cookieFile = path.join(root, 'alibaba-cookies.json');
const cookies = readPrivateSession(path.join(desktop, 'alibaba-cookies.json'));
writePrivateSession(cookieFile, cookies);
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
const partition = `collection-reference-${Date.now()}`;
const browserSession = session.fromPartition(partition);
for (const cookie of cookies) {
  const domain = cookie.domain.replace(/^\./, '');
  if (/(^|\.)(alibaba\.com|alicdn\.com)$/.test(domain)) await browserSession.cookies.set({ ...cookie, url: `https://${domain}${cookie.path || '/'}` }).catch(() => {});
}
app.on('window-all-closed', () => {});
let lastMessage = '';
const onWaiting = (message) => { if (lastMessage !== message) { lastMessage = message; console.log(message); } };
globalThis.__KUA_YIPU_SELLER_BRIDGE = { humanVerification: (url, options) => showHumanVerification({
  url, partition, ...options,
  saveSession: async ({ webContents, readStorage }) => {
    writePrivateSession(cookieFile, await webContents.session.cookies.get({}));
    writePrivateSession(path.join(root, 'alibaba-storage.json'), { [new URL(webContents.getURL()).origin]: await readStorage() });
  },
  onCreated: ({ window }) => window.on('show', () => console.log('验证码窗口已显示，请用户完成验证')),
}) };
const publisher = new SellerPublisher(root);
const readSource = publisher.readSourceProduct.bind(publisher);
publisher.readSourceProduct = async (page, ...args) => {
  try { return await readSource(page, ...args); }
  catch (error) {
    const info = await page.evaluate(() => ({ path: location.pathname, title: document.title, text: document.body?.innerText?.slice(0, 400) })).catch(() => ({}));
    const verification = await page.evaluate(inspectVerificationDocument).catch(() => ({}));
    delete verification.url;
    console.log(JSON.stringify({ failedPage: info, verification }));
    await page.screenshot({ path: path.join(root, 'failed-source.png'), timeout: 5000 }).catch(() => {});
    throw error;
  }
};
let collector;
const disk = new CollectionCheckpoint(root, 'collection');
const options = () => ({ allPages: false, startPage: 1, endPage: 2, delaySeconds: 1,
  checkpoint: disk.read(), onCheckpoint: (value) => disk.write(value) });
const run = async (progress) => {
  // Recreate collector/profile connection to verify the disk checkpoint.
  collector = new ShopCollector(root, (...args) => publisher.enrichSourceProducts(...args));
  try { return await withVerificationContext({ onWaiting }, () => collector.collectGroup(normalizeShopUrl(process.argv[2]), progress, options())); }
  finally { await collector.resetContext(); }
};
try {
  await assert.rejects(run((event) => event.stage !== 'listing'), { code: 'COLLECT_PAUSED' });
  report.firstPage = disk.read().page; save();
  console.log(`列表暂停：已读第 ${report.firstPage} 页`);
  await assert.rejects(run((event) => {
    if (event.stage === 'listing') { report.resumedPages.push(event.page); console.log(`断点继续：读取第 ${event.page} 页`); }
    return event.stage !== 'detail';
  }), { code: 'COLLECT_PAUSED' });
  assert.ok(report.resumedPages.every((page) => page > report.firstPage));
  const listed = disk.read();
  report.listed = listed.products.length;
  // Limit expensive real publishing QA to two actual source products.
  listed.products = listed.products.slice(0, 2); disk.write(listed); save();
  const collected = [];
  const record = (event) => {
    if (event.product) {
      assert.ok(!event.product.collectWarning, event.product.collectWarning);
      collected.push(event.product);
      report.collected.push({ sourceId: event.product.sourceId, images: event.product.mainImages?.length, attributes: event.product.attributes?.length });
      save(); console.log(`真实详情保存 ${event.current}/${event.total}`);
    }
  };
  await assert.rejects(run((event) => { record(event); return !event.product; }), (error) => {
    if (!collected.length) console.log(`详情读取暂停原因：${error.message}`);
    return error.code === 'COLLECT_PAUSED';
  });
  assert.equal(disk.read().completedIds.length, 1);
  await run(record);
  assert.equal(collected.length, 2);
  assert.equal(new Set(collected.map((item) => item.sourceId)).size, 2);
  const sellerPage = await publisher.currentSellerPage();
  assert.equal(matchesAlibabaSession(await sellerPage.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, sellerPage.url()), true);
  for (const source of collected) {
    const product = syncProductModel({ ...source, id: `qa-${source.sourceId}` }, { captureSource: true });
    const category = productCategory(product);
    const reference = state.products.find((candidate) => candidate.status === 'published' && candidate.id === process.env.QA_REFERENCE_ID)
      || state.products.find((candidate) => candidate.status === 'published' && productCategory(candidate).id === category.id);
    assert.ok(reference, `No successful reference for category ${category.id}`);
    const snapshot = (reference.publishHistory || []).find((entry) => ['published', 'submitted', 'success'].includes(entry.result?.status) && entry.data);
    const patch = applyPublishedProductReference(product, createPublishedReferenceTemplate(reference, snapshot), { fullTemplate: true });
    recordProductMutation(product, patch, { actor: 'user', action: 'reference-published-product' });
    const item = { sourceId: product.sourceId, referenceId: reference.id, categoryId: productCategory(product).id, score: product.quality?.score };
    report.drafts.push(item); save();
    fs.writeFileSync(path.join(root, `${product.sourceId}.json`), JSON.stringify(product));
    try {
      item.result = await withVerificationContext({ onWaiting }, () => publisher.publishProduct(product, buildAlibabaPublishUrl(item.categoryId), 'draft', productCategory(product).pathText, `qa-${product.sourceId}`, onWaiting));
    } catch (error) { item.error = error.message; item.code = error.code; process.exitCode = 1; }
    if (publisher.page && !publisher.page.isClosed()) {
      const tables = await publisher.page.locator('table').evaluateAll((tables) => tables.filter((table) => /Commodity code|商品编码|Available quantity|可售数量/i.test(table.innerText)).map((table) => table.outerHTML.slice(0, 90000))).catch(() => []);
      fs.writeFileSync(path.join(root, `${product.sourceId}-sku-tables.json`), JSON.stringify(tables));
    }
    save(); console.log(JSON.stringify(item));
  }
  report.success = report.drafts.length === 2 && report.drafts.every((item) => item.result);
} catch (error) { report.error = error.message; report.code = error.code; process.exitCode = 1; }
finally {
  await publisher.shutdown(); await collector?.resetContext(); save(); console.log(JSON.stringify(report));
}
