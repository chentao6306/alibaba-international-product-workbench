import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-ui-qa-'));
process.env.DATA_DIR = root;
process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
store.update((state) => {
  state.collectionFolders = [{ id: 'qa', name: '引用验收' }];
  state.settings.activeCollectionFolderId = 'qa';
  state.products = [
    { id: 'target', sourceId: '123456789', collectionFolderId: 'qa', sourcePlatform: 'alibaba.com', title: '待上架测试商品', price: 25, categoryId: 'old', categoryPath: ['旧类目'], selected: true, status: 'publish_failed' },
    { id: 'reference', sourceId: '987654321', collectionFolderId: 'qa', sourcePlatform: 'alibaba.com', title: '成功商品测试模板', status: 'published',
      categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'], origin: 'China', province: 'Guangdong',
      attributes: [{ name: 'Material', value: ['Metal', 'Rubber'] }], variantGroups: [{ name: 'Color', options: ['Black'], optionImages: { Black: 'https://example.invalid/black.jpg' } }],
      skus: [{ attributes: { Color: 'Black' }, code: 'QA-001', stock: 21, enabled: false, price: 99 }] },
  ];
});
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('采集分组', { exact: true }).selectOption('qa');
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByRole('button', { name: '引用成功商品资料', exact: true }).click();
  await page.getByLabel('选择已成功上架的商品').selectOption('reference');
  await page.getByText('规格与 SKU · 1 行', { exact: true }).waitFor();
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.locator('.drawer').evaluate((node) => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(root, `reference-${width}.png`) });
  }
  await page.getByRole('button', { name: '引用并保存', exact: true }).click();
  await page.getByText('已引用类目、属性和规格，更新 1 件商品', { exact: true }).waitFor();
  const target = store.read().products.find((product) => product.id === 'target');
  assert.equal(target.categoryId, '201346401');
  assert.equal(target.origin, 'China');
  assert.deepEqual(target.attributes[0].value, ['Metal', 'Rubber']);
  assert.equal(target.skus[0].code, 'QA-001');
  assert.equal(target.skus[0].stock, 21);
  assert.equal(target.skus[0].enabled, false);
  assert.equal(target.skus[0].price, 25);
  assert.equal(target.title, '待上架测试商品');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: root }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ root, errors }));
  throw error;
} finally { await browser.close(); await server.shutdownServer(); }
