import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { ShopCollector } from '../server/collector.js';

// Isolated UI/API check with simulated drafts. Never use a seller session.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-delay-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
const store = new JsonStore(path.join(root, 'workspace.json'));
store.update((state) => {
  state.collectionFolders = [{ id: 'demo', name: '间隔验证' }];
  state.products = ['1', '2'].map((id) => ({ id, sourceId: id, sourcePlatform: 'alibaba.com', collectionFolderId: 'demo',
    title: `演示商品 ${id}`, selected: true, status: 'ready', price: 10, stock: 100, categoryId: '2623',
    mainImages: ['https://example.com/image.jpg'] }));
});
const calls = [];
const originals = { enrich: ShopCollector.prototype.enrichProducts, publish: SellerPublisher.prototype.publishProduct };
ShopCollector.prototype.enrichProducts = async (products) => products;
SellerPublisher.prototype.publishProduct = async (product) => { calls.push(product.id); return { status: 'drafted', message: '模拟草稿回执' }; };
const server = await import('../server/index.js');
const listener = await server.serverReady;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/announcements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  const nav = (name) => page.locator('.sidebar nav button').filter({ hasText: name }).click();
  await nav('上架任务');
  await page.getByLabel('采集分组', { exact: true }).selectOption('demo');
  await page.getByRole('button', { name: /保存草稿/ }).click();
  const min = page.getByLabel('随机间隔最短秒数');
  const max = page.getByLabel('随机间隔最长秒数');
  await min.fill('300'); await max.fill('10');
  await page.getByRole('button', { name: '开始处理 2 件', exact: true }).click();
  assert.equal(store.read().jobs.length, 0);
  await max.fill('300');
  await page.getByRole('button', { name: '开始处理 2 件', exact: true }).click();
  await page.locator('.queue-item').getByText('间隔等待中', { exact: true }).waitFor();
  assert.deepEqual(calls, ['1']);
  assert.equal(await min.isDisabled(), true);
  await page.screenshot({ path: path.join(root, 'delay-countdown.png'), fullPage: true });
  await page.locator('.launch-panel').getByRole('button', { name: '暂停任务', exact: true }).click();
  await page.getByRole('button', { name: '继续处理剩余 1 件', exact: true }).waitFor();
  assert.equal(await min.isEnabled(), true);
  await min.fill('0'); await max.fill('0');
  await page.getByRole('button', { name: '继续处理剩余 1 件', exact: true }).click();
  await page.getByText(/上架任务完成，成功 2 件/).waitFor();
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(store.read().settings.publishDelayMaxSeconds, 0);
  assert.equal(store.read().products[0].publishHistory.length, 1);
  await nav('商品工作台'); await nav('上架任务');
  assert.equal(await min.inputValue(), '0');
  assert.equal(await max.inputValue(), '0');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, checked: ['input-validation', 'delay-countdown', 'pause', 'edit-and-resume', 'saved-preferences', 'no-duplicate-drafts'] }));
} finally {
  await browser.close(); await server.shutdownServer();
  ShopCollector.prototype.enrichProducts = originals.enrich;
  SellerPublisher.prototype.publishProduct = originals.publish;
}
