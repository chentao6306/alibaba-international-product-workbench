import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';

// Local UI regression only. No seller session, collection or uploads.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-status-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
const store = new JsonStore(path.join(root, 'workspace.json'));
const oldMessage = '国际站页面仍有弹窗遮罩，请关闭提示后重试';
const capacityMessage = '详情图片上传失败（完成 0/8 张）：图片银行空间不足，任务已保留；请在国际站确认图片空间，处理后继续';
store.update((state) => {
  state.collectionFolders = [{ id: 'phones', name: '手机状态验证' }];
  state.products = ['current', 'next', 'unrelated'].map((id) => ({ id, sourceId: id, title: `S25 ${id}`, status: 'publish_failed',
    collectionFolderId: 'phones', selected: id !== 'unrelated', sourcePlatform: 'alibaba.com', price: 10, stock: 10, categoryId: '201896803',
    publishResult: { status: 'failed', message: oldMessage }, publishHistory: [{ result: { status: 'failed', message: oldMessage } }] }));
  state.jobs = [{ id: 'paused', type: 'publish', status: 'paused', progress: 1, total: 3, currentProductId: 'current', createdAt: new Date().toISOString(),
    metadata: { productIds: ['done', 'current', 'next'], collectionFolderId: 'phones', mode: 'submit' },
    results: { done: { status: 'published', message: 'Saved receipt' } }, message: `已暂停：S25 current - ${capacityMessage}。处理后可继续` }];
});
const server = await import('../server/index.js');
const listener = await server.serverReady;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
const nav = (label) => page.locator('.sidebar nav button').filter({ hasText: label }).click();
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await nav('商品工作台');
  await page.getByLabel('采集分组', { exact: true }).selectOption('phones');
  const row = page.locator('.product-table tbody tr').filter({ hasText: 'S25 current' });
  await row.getByText('上架已暂停', { exact: true }).waitFor();
  assert.match(await row.innerText(), /图片银行空间不足/);
  assert.doesNotMatch(await row.innerText(), /弹窗遮罩|上架失败/);
  await page.getByRole('button', { name: '上架失败', exact: true }).click();
  assert.equal(await page.locator('.product-table tbody tr').count(), 1);
  assert.match(await page.locator('.product-table tbody').innerText(), /S25 unrelated/);
  await page.getByRole('button', { name: '上架已暂停', exact: true }).click();
  assert.equal(await page.locator('.product-table tbody tr').count(), 1);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'products-paused.png'), fullPage: true });
  await nav('上架任务');
  const current = page.locator('.queue-item').filter({ hasText: 'S25 current' });
  const next = page.locator('.queue-item').filter({ hasText: 'S25 next' });
  await current.getByText('上架已暂停', { exact: true }).waitFor();
  assert.match(await current.innerText(), /图片银行空间不足/);
  assert.doesNotMatch(await current.innerText(), /弹窗遮罩|上架失败/);
  assert.match(await next.innerText(), /等待处理/);
  assert.doesNotMatch(await next.innerText(), /图片银行空间不足|弹窗遮罩|上架失败/);
  await page.getByRole('button', { name: '继续处理剩余 2 件', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'queue-paused.png'), fullPage: true });
  // Exercise state refresh after an existing retry resumes, without uploads.
  store.patchJob('paused', { status: 'running', message: '正在处理 2/3：S25 current - 上传详情图片 3/8' });
  await current.getByText('正在上架', { exact: true }).first().waitFor();
  assert.match(await current.innerText(), /正在上架/);
  assert.doesNotMatch(await page.locator('main').innerText(), /上传详情图片 3\/8|正在处理 2\/3/);
  assert.equal(await page.locator('.compact-progress span').innerText(), '正在上架');
  assert.equal(await page.locator('.history-progress > span').first().innerText(), '正在上架');
  assert.equal(store.read().jobs[0].message, '正在处理 2/3：S25 current - 上传详情图片 3/8');
  store.patchJob('paused', { verificationState: 'waiting', metadata: { ...store.read().jobs[0].metadata, mode: 'draft' } });
  await page.waitForFunction(() => document.querySelector('.compact-progress span')?.textContent.includes('等待人工验证'));
  assert.match(await current.innerText(), /等待人工验证/);
  await page.screenshot({ path: path.join(root, 'queue-verification-wait.png'), fullPage: true });
  store.patchJob('paused', { verificationState: 'error' });
  await page.waitForFunction(() => document.querySelector('.compact-progress span')?.textContent.includes('刷新并完成验证'));
  store.patchJob('paused', { verificationState: '', metadata: { ...store.read().jobs[0].metadata, mode: 'submit' } });
  await page.waitForFunction(() => document.querySelector('.compact-progress span')?.textContent === '正在上架');
  await nav('商品工作台');
  await row.getByText('正在上架', { exact: true }).first().waitFor();
  assert.doesNotMatch(await row.innerText(), /上传详情图片/);
  assert.equal(await row.locator('.data-missing[title]').getAttribute('title'), '正在上架');
  await nav('上架任务');
  assert.doesNotMatch(await current.innerText(), /图片银行空间不足|弹窗遮罩/);
  assert.equal(store.read().products[0].publishHistory[0].result.message, oldMessage);
  store.patchJob('paused', { status: 'cancelled', message: '任务已取消' });
  await current.getByText('上架失败', { exact: true }).waitFor();
  assert.match(await current.innerText(), /弹窗遮罩/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, checked: ['workbench', 'queue', 'failure-filter', 'paused-filter', 'resume', 'verification-wait', 'verification-error', 'verification-cleared', 'cancel', 'history-preserved'] }));
} finally {
  await browser.close(); await server.shutdownServer();
}
