import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';

// Exercise the real local queue and UI with fixture publishing outcomes only.
// No seller session, network upload or real submission is used.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-continuation-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
const store = new JsonStore(path.join(root, 'workspace.json'));
store.update((state) => {
  state.collectionFolders = [{ id: 'qa', name: '连续上架验证' }];
  state.products = ['主图接收不完整', '类目已失效', '提交结果待核对', '下一件正常商品'].map((title, index) => ({
    id: String(index + 1), sourceId: String(index + 1), title: `测试商品 · ${title}`,
    collectionFolderId: 'qa', selected: true, status: 'ready', sourcePlatform: 'alibaba.com',
    price: 10, stock: 10, categoryId: '201346401', categoryPath: ['Drones Accessories'],
  }));
});
const original = SellerPublisher.prototype.publishProduct;
let release;
let attempts = 0;
SellerPublisher.prototype.publishProduct = async (product) => {
  const failures = {
    1: ['MAIN_IMAGE_UPLOAD_PENDING', '国际站主图尚未完成接收（已确认 2 张），请稍后重试该商品'],
    2: ['PUBLISH_CATEGORY_INVALID', '当前类目已失效，请重新选择有效类目'],
    3: ['PUBLISH_SUBMIT_RESULT_UNKNOWN', '请先在国际站商品管理中核对，避免重复发布'],
  };
  if (failures[product.id]) throw Object.assign(new Error(failures[product.id][1]), { code: failures[product.id][0] });
  if (!attempts++) await new Promise((_resolve, reject) => { release = () => reject(Object.assign(new Error('User paused'), { code: 'PUBLISH_PAUSED' })); });
  return { status: 'drafted', message: '已保存测试草稿' };
};
const server = await import('../server/index.js');
const listener = await server.serverReady;
const base = `http://127.0.0.1:${listener.address().port}`;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
try {
  await page.goto(base);
  await page.locator('.sidebar nav button').filter({ hasText: '上架任务' }).click();
  await page.getByLabel('采集分组', { exact: true }).selectOption('qa');
  const response = await fetch(base + '/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['1', '2', '3', '4'], collectionFolderId: 'qa', mode: 'draft' }) });
  assert.equal(response.status, 202);
  const job = await response.json();
  const next = page.locator('.queue-item').filter({ hasText: '下一件正常商品' });
  await next.getByText('正在上架', { exact: true }).waitFor();
  for (const title of ['主图接收不完整', '类目已失效', '提交结果待核对']) {
    await page.locator('.queue-item').filter({ hasText: `测试商品 · ${title}` }).getByText('上架失败', { exact: true }).waitFor();
  }
  assert.equal(store.read().jobs.find((item) => item.id === job.id).status, 'running');
  assert.equal(await page.getByRole('button', { name: /继续处理剩余/ }).count(), 0);
  await page.screenshot({ path: path.join(root, 'continues-after-errors.png'), fullPage: true });
  await page.locator('.launch-panel').getByRole('button', { name: '暂停任务', exact: true }).click();
  release();
  await page.getByRole('button', { name: '继续处理剩余 1 件', exact: true }).waitFor();
  await page.getByRole('button', { name: '继续处理剩余 1 件', exact: true }).click();
  await page.getByText('上架任务完成，成功 1 件，失败 3 件', { exact: true }).last().waitFor();
  const final = store.read().jobs.find((item) => item.id === job.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.progress, 4);
  assert.deepEqual(Object.values(final.results).map((item) => item.status), ['failed', 'failed', 'failed', 'drafted']);
  assert.equal(attempts, 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, checked: ['continues-after-errors', 'manual-pause', 'resume', 'final-counts'] }));
} finally {
  release?.(); await browser.close(); await server.shutdownServer();
  SellerPublisher.prototype.publishProduct = original;
}
