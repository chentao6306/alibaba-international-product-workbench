// Exercises the built UI and persistence using isolated cross-category fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-text-ui-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const products = ['HD Phone', 'H-D Cotton Dress', 'HD Water Pump'].map((title, i) => syncProductModel({
  id: `text-${i}`, sourceId: `text-${i}`, title, keywords: [`YINGTAI ${title} YINGTAI`, 'YINGTAI', 'INCA useful phrase', 'untouched'],
  collectionFolderId: 'qa', selected: true, sourcePlatform: 'alibaba.com', status: 'ready', price: 10, currencySymbol: '$',
  categoryId: String(100 + i), categoryPath: [['Electronics', 'Phone'], ['Clothing', 'Dress'], ['Machinery', 'Pump']][i],
  description: 'Original body', descriptionHtml: '<p>Original body</p>', attributes: [{ name: 'Model', value: `M-${i}` }],
}));
store.update((state) => { state.products = products; state.collectionFolders = [{ id: 'qa', name: '文字验收' }]; state.settings.activeCollectionFolderId = 'qa'; });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1550, height: 1050 } });
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const output = path.resolve('.data/batch-text-qa'); fs.mkdirSync(output, { recursive: true });
let releaseSave, saveCount = 0;
const gate = new Promise((resolve) => { releaseSave = resolve; });
await page.route('**/api/products/batch-update', async (route) => { saveCount++; await gate; await route.continue(); });
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByRole('button', { name: '批量修改 3', exact: true }).click();
  await page.getByRole('heading', { name: '已选择 3 件商品', exact: true }).waitFor();
  await page.getByLabel('标题前缀', { exact: true }).fill('New ');
  await page.getByLabel('标题后缀', { exact: true }).fill(' Sale');
  await page.getByLabel('查找标题文字 1', { exact: true }).fill('HD');
  await page.getByLabel('替换为 1', { exact: true }).fill('Harley Davidson');
  await page.getByRole('button', { name: '添加替换规则', exact: true }).click();
  await page.getByLabel('查找标题文字 2', { exact: true }).fill('H-D');
  await page.getByLabel('替换为 2', { exact: true }).fill('Harley Davidson');
  await page.getByRole('button', { name: '添加替换规则', exact: true }).click();
  await page.getByRole('button', { name: '移除替换规则 3', exact: true }).click();
  await page.getByLabel('删除关键词文字 1', { exact: true }).fill('YINGTAI');
  await page.getByRole('button', { name: '添加删除文字', exact: true }).click();
  await page.getByLabel('删除关键词文字 2', { exact: true }).fill('inca');
  await page.getByLabel('匹配文字时区分大小写', { exact: true }).uncheck();
  const preview = await page.locator('.batch-preview-row').allTextContents();
  for (const title of ['Phone', 'Cotton Dress', 'Water Pump']) assert.ok(preview.some((text) => text.includes(`New Harley Davidson ${title} Sale`)));
  assert.ok(preview.every((text) => text.includes('useful phrase / untouched')));
  await page.getByRole('region', { name: '标题与关键词规则', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'rules-preview.png') });
  await page.getByRole('button', { name: '应用到 3 件商品', exact: true }).click();
  await page.getByRole('button', { name: '正在保存…', exact: true }).waitFor();
  assert.equal(await page.getByLabel('标题前缀', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '正在保存…', exact: true }).isDisabled(), true);
  await page.locator('.drawer-actions').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: '已选择 3 件商品', exact: true }).count(), 1);
  releaseSave();
  await page.getByRole('heading', { name: '已选择 3 件商品', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(saveCount, 1);
  const saved = store.read((state) => state.products);
  assert.deepEqual(saved.map((p) => p.title), ['New Harley Davidson Phone Sale', 'New Harley Davidson Cotton Dress Sale', 'New Harley Davidson Water Pump Sale']);
  for (let i = 0; i < saved.length; i++) {
    assert.deepEqual(saved[i].keywords, [products[i].title, 'useful phrase', 'untouched']);
    assert.deepEqual(saved[i].source, products[i].source);
    assert.ok(verifySourceIntegrity(saved[i]).valid);
    assert.equal(saved[i].descriptionHtml, products[i].descriptionHtml);
  }
  await page.reload();
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  const row = page.locator('tr').filter({ hasText: 'New Harley Davidson Phone Sale' });
  await row.getByTitle('编辑完整资料').click();
  await page.getByRole('dialog', { name: '编辑产品', exact: true }).waitFor();
  assert.equal(await page.getByLabel('商品名称', { exact: true }).inputValue(), saved[0].title);
  assert.equal(await page.getByLabel('商品关键词', { exact: true }).inputValue(), saved[0].keywords.join('\n'));
  await page.screenshot({ path: path.join(output, 'saved-editor.png') });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, categories: ['electronics', 'clothing', 'machinery'], saveCount }, null, 2));
  console.log(JSON.stringify({ passed: true, saveCount, screenshots: output }));
} finally {
  releaseSave(); await browser.close(); await server.shutdownServer();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
