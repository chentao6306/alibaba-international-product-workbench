import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-ui-qa-'));
const targetCount = Math.max(1, Number(process.env.QA_REFERENCE_COUNT || 1));
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
    ...Array.from({ length: targetCount }, (_, index) => ({ id: index ? `target-${index}` : 'target', sourceId: String(123456789 + index), collectionFolderId: 'qa', sourcePlatform: 'alibaba.com', title: index ? `待上架测试商品 ${index}` : '待上架测试商品', price: 25, categoryId: 'old', categoryPath: ['旧类目'], selected: true, status: 'publish_failed', stock: 0, publishResult: { message: '当前商品类目不在线上经营类目范围内', code: 'PUBLISH_CATEGORY_NOT_AUTHORIZED' } })),
    { id: 'untouched', collectionFolderId: 'qa', sourcePlatform: 'alibaba.com', title: '未选择的商品', price: 12, categoryId: 'untouched-category', selected: false, status: 'ready', attributes: [{ name: 'Material', value: 'Original' }] },
    { id: 'reference', sourceId: '987654321', collectionFolderId: 'qa', sourcePlatform: 'alibaba.com', title: '成功商品测试模板', status: 'published',
      categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'], origin: 'China', province: 'Guangdong',
      attributes: [{ name: 'Material', value: ['Metal', 'Rubber'] }], variantGroups: [{ name: 'Color', options: ['Black'], optionImages: { Black: 'https://example.invalid/black.jpg' } }],
      skus: [{ attributes: { Color: 'Black' }, code: 'QA-001', stock: 21, enabled: false, price: 99 }] },
  ];
});
const originalOthers = store.read(state => state.products.filter(product => ['reference', 'untouched'].includes(product.id)));
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
  await page.getByLabel('选择引用商品', { exact: true }).selectOption('reference');
  await page.getByText('规格与 SKU · 1 行', { exact: true }).waitFor();
  await page.getByRole('button', { name: '预览修改', exact: true }).click();
  await page.getByRole('heading', { name: `修改预览 · ${targetCount} 件将更新` }).waitFor();
  assert.equal(await page.locator('.reference-preview details').count(), Math.min(30, targetCount));
  if (targetCount > 30) {
    await page.getByRole('button', { name: '下一页预览', exact: true }).click();
    await page.locator('.reference-preview details').first().filter({ hasText: '待上架测试商品 30' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '引用并保存', exact: true }).isEnabled(), true);
  }
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.locator('.drawer').evaluate((node) => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(root, `reference-${width}.png`) });
  }
  await page.getByRole('button', { name: '引用并保存', exact: true }).click();
  await page.getByText(`已引用类目、属性和规格，更新 ${targetCount} 件商品`, { exact: true }).waitFor();
  const target = store.read().products.find((product) => product.id === 'target');
  assert.equal(target.categoryId, '201346401');
  assert.equal(target.origin, 'China');
  assert.deepEqual(target.attributes[0].value, ['Metal', 'Rubber']);
  assert.equal(target.skus[0].code, '');
  assert.equal(target.skus[0].stock, 0);
  assert.equal(target.skus[0].enabled, true);
  assert.equal(target.skus[0].price, 25);
  assert.equal(target.title, '待上架测试商品');
  const reopened = new JsonStore(store.filePath).read();
  const targets = reopened.products.filter(product => product.id === 'target' || product.id.startsWith('target-'));
  assert.equal(targets.length, targetCount);
  assert.ok(targets.every(product => product.categoryId === '201346401' && product.origin === 'China'
    && product.attributes[0].value.join(',') === 'Metal,Rubber' && product.stock === 0 && product.price === 25
    && product.skus[0].price === 25 && product.skus[0].stock === 0 && product.skus[0].code === ''
    && product.source?.snapshot?.categoryId === 'old' && product.referenceRecovery?.state === 'ready'));
  assert.deepEqual(reopened.products.filter(product => ['reference', 'untouched'].includes(product.id)), originalOthers);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.sidebar nav button').filter({ hasText: '上架任务' }).click();
  await page.getByRole('heading', { name: '失败商品处理' }).waitFor();
  await page.getByText('已应用引用资料，等待重试', { exact: true }).first().waitFor();
  await page.getByLabel('失败原因', { exact: true }).selectOption('类目问题');
  await page.getByRole('button', { name: '仅重试所选失败项' }).waitFor();
  await page.screenshot({ path: path.join(root, 'recovery-1440.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, products: targetCount, screenshots: root,
    verified: ['real-api-preview-page', 'full-batch-save-reopen', 'commercial-data-and-source-preserved', 'unselected-reference-unchanged', 'recovery-ui'] }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ root, errors }));
  throw error;
} finally { await browser.close(); await server.shutdownServer(); }
