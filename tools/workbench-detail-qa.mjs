import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-detail-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js'); const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
await sharp({ create: { width: 120, height: 120, channels: 3, background: '#338877' } }).png().toFile(path.join(root, 'media', 'product.png'));
store.update((state) => {
  state.collectionFolders = [{ id: 'qa', name: 'Detail QA' }]; state.settings.activeCollectionFolderId = 'qa';
  state.products = Array.from({ length: 22 }, (_, i) => syncProductModel({ id: `p${i}`, sourceId: `source-${i}`, title: i < 2 ? 'Same product' : `Other item ${i}`,
    sourcePlatform: 'alibaba.com', collectionFolderId: 'qa', selected: i < 2, status: 'ready', price: 10, currencySymbol: '$', stock: 100,
    mainImages: ['/media/product.png'], mainImage: '/media/product.png', detailImages: [], description: 'Description',
    skus: [{ id: `p${i}-red`, code: `red-${i}`, attributes: { Color: 'Red' }, price: 10 + i, stock: 50 },
      { id: `p${i}-blue`, code: `blue-${i}`, attributes: { Color: 'Blue' }, price: 20 + i, stock: 60 }],
  }));
});
const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1550, height: 1100 }, acceptDownloads: true });
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(20000);
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const nav = (name) => page.locator('.sidebar nav button').filter({ hasText: name }).click();
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`); await nav('商品工作台');
  await page.locator('.product-table tbody tr').first().waitFor();
  assert.equal(await page.locator('.product-table tbody tr').count(), 10);
  await page.getByTitle('下一页', { exact: true }).click();
  await page.getByText('第 2/3 页 · 共 22 件', { exact: true }).waitFor();
  await page.locator('.page-size select').selectOption('50');
  assert.equal(await page.locator('.product-table tbody tr').count(), 22);
  const search = page.getByPlaceholder('搜索标题或商品 ID');
  await search.fill('source-21'); await page.getByText('共 1 件', { exact: true }).waitFor();
  assert.equal(await page.locator('.product-table tbody tr').count(), 1); await search.fill('');
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const drawer = page.locator('.drawer');
  await drawer.getByLabel('查找内容', { exact: true }).fill('Same');
  await drawer.getByLabel('替换为', { exact: true }).fill('Renamed');
  await drawer.getByRole('button', { name: '查找匹配', exact: true }).click();
  await drawer.locator('.find-preview').waitFor();
  await drawer.getByLabel('区分大小写').check();
  assert.equal(await drawer.getByRole('button', { name: '执行替换', exact: true }).isEnabled(), false);
  await drawer.getByRole('button', { name: '查找匹配', exact: true }).click();
  await drawer.locator('.find-preview').waitFor();
  await drawer.getByRole('button', { name: '执行替换', exact: true }).click(); await drawer.waitFor({ state: 'hidden' });
  assert.equal(store.read((s) => s.products[0].title), 'Renamed product');
  await page.getByRole('button', { name: '批量修改 2', exact: true }).click();
  await drawer.locator('.batch-tabs').getByRole('button', { name: '交易信息', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await drawer.getByRole('button', { name: '导出 SKU Excel', exact: true }).click();
  const download = await downloadPromise; const file = path.join(root, 'sku.xlsx'); await download.saveAs(file);
  const workbook = XLSX.read(fs.readFileSync(file), { type: 'buffer' }); const rows = XLSX.utils.sheet_to_json(workbook.Sheets.SKU, { defval: '' });
  assert.deepEqual(rows.map((r) => r.productId), ['p0', 'p0', 'p1', 'p1']);
  rows[0].price = 31; rows[2].price = 47;
  workbook.Sheets.SKU = XLSX.utils.json_to_sheet(rows); fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  await drawer.getByLabel('导入 SKU Excel').setInputFiles(file);
  await drawer.getByText('已读取 4 条 SKU，保存时按商品标识对应', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '应用到 2 件商品', exact: true }).click(); await drawer.waitFor({ state: 'hidden' });
  assert.deepEqual(store.read((s) => s.products.slice(0, 2).map((p) => p.skus.map((sku) => sku.price))), [[31, 20], [47, 21]]);
  await page.getByRole('button', { name: '批量修改 2', exact: true }).click();
  await drawer.locator('.batch-tabs').getByRole('button', { name: '交易信息', exact: true }).click();
  await drawer.getByLabel('价格调整比例（%）').fill('10');
  await drawer.getByRole('button', { name: '应用到 2 件商品', exact: true }).click(); await drawer.waitFor({ state: 'hidden' });
  assert.deepEqual(store.read((s) => s.products.slice(0, 2).map((p) => p.skus.map((sku) => sku.price))), [['34.10', '22.00'], ['51.70', '23.10']]);
  await page.getByRole('button', { name: '删除已勾选 2', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(store.read((s) => s.products.length), 22);
  assert.ok(store.read((s) => s.products.every((p) => verifySourceIntegrity(p).valid)));
  await nav('设置');
  await page.getByRole('button', { name: '清理本地数据', exact: true }).click();
  const cleanup = page.getByRole('dialog', { name: '确认清理数据' });
  assert.equal(await cleanup.getByRole('button', { name: '确认删除', exact: true }).isEnabled(), false);
  await cleanup.getByLabel('图片缓存', { exact: false }).uncheck();
  await cleanup.getByLabel('手动上传图片', { exact: false }).check();
  await cleanup.getByLabel('确认删除所选数据，此操作无法撤销').check();
  await cleanup.getByRole('button', { name: '确认删除', exact: true }).click();
  await cleanup.getByRole('alert').filter({ hasText: '仍被商品引用' }).waitFor();
  assert.equal(fs.existsSync(path.join(root, 'media', 'product.png')), true);
  await cleanup.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'verified.png') });
  console.log(JSON.stringify({ ok: true, root, checks: ['pagination', 'search', 'preview-invalidation', 'sku-export-import', 'distinct-markup', 'cancel-delete', 'cleanup-reference-protection'] }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); throw error; }
finally { await browser.close(); await server.shutdownServer(); }
