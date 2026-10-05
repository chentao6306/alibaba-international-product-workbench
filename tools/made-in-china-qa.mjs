import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { preparePublishProduct } from '../server/publisher.js';
import { verifySourceIntegrity } from '../server/product-model.js';

// Public source pages are read; no request is sent to Alibaba's seller service.
if (!process.argv.includes('--live')) throw new Error('Use --live to read two public Made-in-China sample pages in an isolated workspace.');
const root = fs.mkdtempSync(path.resolve('.data', 'mic-ui-qa-'));
process.env.DATA_DIR = root;
process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const endpoint = `http://127.0.0.1:${listener.address().port}`;
const store = new JsonStore(path.join(root, 'workspace.json'));
store.update((state) => {
  state.collectionFolders = [{ id: 'mic', name: '中国制造网验收' }]; state.settings.activeCollectionFolderId = 'mic';
  state.products = ['1688', 'alibaba.com'].map((sourcePlatform) => ({ id: `qa-ref-${sourcePlatform}`, sourcePlatform, status: 'published', title: `QA Accepted ${sourcePlatform} Headlight`, categoryId: '127678021', categoryPath: ['Vehicle Parts & Accessories', 'Auto Lighting Systems', 'LED Headlights'],
    attributes: [{ name: 'Voltage', value: sourcePlatform === '1688' ? '24V' : '12V' }], variantGroups: [{ name: 'Color', options: ['White'] }], price: '99.00' }));
});
const urls = [
  'https://meist2013.en.made-in-china.com/product/mfNUjHkrHPRd/China-Men-s-T-Shirt-with-Custom-Logo-Minimum-Order-of-50-Pieces.html',
  'https://zsliangjian.en.made-in-china.com/product/bJtYPjzosqRf/China-Factory-Wholesale-Auto-LED-Lights-H4-H7-M9PRO-9005-9006-H11-LED-Headlight.html',
];
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
try {
  await page.goto(endpoint);
  await page.locator('.sidebar nav button').filter({ hasText: '中国制造网采集' }).click();
  await page.getByLabel('采集分组', { exact: true }).selectOption('mic');
  await page.getByLabel('采集链接').fill(urls.join('\n'));
  await page.getByText('采集间隔（秒）', { exact: true }).locator('..').locator('input').fill('0');
  await page.screenshot({ path: path.join(root, 'collection.png'), fullPage: true });
  await page.getByRole('button', { name: '开始采集', exact: true }).click();
  await page.getByText('采集完成，成功 2 件，失败 0 件', { exact: true }).first().waitFor({ timeout: 180000 });
  const collected = store.read().products.filter((product) => product.sourcePlatform === 'made-in-china');
  assert.equal(collected.length, 2, JSON.stringify(store.read().jobs.map((job) => job.message)));
  assert.ok(collected.every((product) => product.sourcePlatform === 'made-in-china' && product.mainImages.length === 6 && product.detailImages.length && product.attributes.length));
  assert.ok(collected.every((product) => [...product.mainImages, ...product.detailImages].every((image) => image.startsWith('/media/'))), 'images must be locally readable');
  assert.ok(collected.every((product) => product.source.snapshot.mainImages.every((image) => image.startsWith('https://image.made-in-china.com/'))));
  assert.ok(collected.every((product) => product.categoryMapping?.status === 'matched' && product.categoryId));
  await page.getByRole('button', { name: '查看商品', exact: true }).click();
  await page.getByRole('tab', { name: /中国制造网/ }).waitFor();
  await page.waitForFunction(() => { const images = [...document.querySelectorAll('tbody img')]; return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0); });
  await page.getByTitle('编辑完整资料').first().click();
  await page.getByLabel('商品名称', { exact: true }).fill('QA Saved Product Title');
  // Both reference platforms must be selectable in the real editor and applied
  // to its working draft before the editor itself is saved.
  for (const platform of ['1688', 'alibaba.com']) {
    await page.getByRole('button', { name: '引用类目与属性', exact: true }).click();
    await page.getByLabel('引用来源平台').selectOption(platform);
    await page.getByLabel('选择引用商品').selectOption(`qa-ref-${platform}`);
    await page.getByRole('button', { name: '预览修改', exact: true }).click();
    await page.getByRole('button', { name: '应用到编辑窗口', exact: true }).click();
    await page.getByRole('dialog', { name: '引用商品资料', exact: true }).waitFor({ state: 'hidden' });
  }
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog', { name: '编辑产品', exact: true }).waitFor({ state: 'hidden' });
  const edited = store.read().products.find((product) => product.title === 'QA Saved Product Title');
  assert.ok(edited);
  assert.equal(verifySourceIntegrity(edited).valid, true);
  assert.equal(preparePublishProduct(edited).title, 'QA Saved Product Title');
  assert.equal(preparePublishProduct(edited).attributes.find((item) => item.name === 'Voltage').value, '12V');
  const plan = await fetch(`${endpoint}/api/publish/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [edited.id] }) }).then((result) => result.json());
  assert.equal(plan.groups[0].sourcePlatform, 'made-in-china');
  assert.match(plan.groups[0].url, /catId=127678021/);
  await page.screenshot({ path: path.join(root, 'workbench.png'), fullPage: true });
  await page.locator('.sidebar nav button').filter({ hasText: '中国制造网采集' }).click();
  await page.getByLabel('中国制造网采集方式').selectOption('shop-products');
  await page.getByLabel('采集链接').fill('https://zsliangjian.en.made-in-china.com/');
  await page.getByText('商品上限', { exact: true }).locator('..').locator('input').fill('1');
  await page.getByText('采集间隔（秒）', { exact: true }).locator('..').locator('input').fill('0');
  await page.getByRole('button', { name: '开始采集', exact: true }).click();
  await page.getByText('采集完成，成功 1 件，失败 0 件', { exact: true }).first().waitFor({ timeout: 150000 });
  assert.equal(store.read().products.filter((product) => product.collectionMethod === 'shop-products').length, 1);
  await page.screenshot({ path: path.join(root, 'shop.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, collected: collected.map((product) => ({ sourceId: product.sourceId, title: product.title, mainImages: product.mainImages.length, detailImages: product.detailImages.length, attributes: product.attributes.length })), verified: ['real-link-batch-collection', 'real-shop-collection', 'local-image-rendering', 'source-snapshot', 'automatic-category-mapping', '1688-and-alibaba-reference-ui', 'platform-filter', 'editor-save', 'alibaba-publish-plan', 'saved-publish-payload'] }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ root, errors, jobs: store.read().jobs.map((job) => ({ status: job.status, message: job.message })) }));
  throw error;
} finally { await browser.close(); await server.shutdownServer(); }
