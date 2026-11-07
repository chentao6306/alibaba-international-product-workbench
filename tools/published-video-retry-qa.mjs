import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-recovery-ui-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
const store = new JsonStore(path.join(root, 'workspace.json'));
const receipt = { status: 'published', title: '已发布的视频商品', message: '已提交发布（视频待关联）',
  url: 'https://post.alibaba.com/product/success.htm?primaryId=12345',
  videoAssociation: { id: '6001', productId: '12345', name: 'fixture.mp4', associated: false, warning: '视频仍在审核，请稍后处理' } };
store.update(state => {
  state.collectionFolders = [{ id: 'f', name: '视频验证' }];
  state.products = [{ id: 'p', title: receipt.title, collectionFolderId: 'f', sourcePlatform: 'alibaba.com', status: 'published',
    removedFromWorkbenchAt: new Date().toISOString(), publishResult: receipt, publishHistory: [{ result: receipt }] }];
  state.jobs = [{ id: 'j', type: 'publish', status: 'completed', progress: 1, total: 1, message: '上架任务完成', createdAt: new Date().toISOString(),
    metadata: { mode: 'submit', collectionFolderId: 'f', productIds: ['p'] }, results: { p: receipt } }];
  state.jobs.unshift(...Array.from({ length: 10 }, (_, index) => ({ id: `recent-${index}`, type: 'publish', status: 'completed',
    progress: 0, total: 0, createdAt: new Date().toISOString(), metadata: { mode: 'submit', collectionFolderId: 'f' }, results: {} })));
});
let calls = 0, confirm;
const original = SellerPublisher.prototype.retryPublishedVideo;
SellerPublisher.prototype.retryPublishedVideo = async video => { calls++; if (calls === 1) throw new Error('平台审核中');
  await new Promise(resolve => { confirm = resolve; }); return { ...video, associated: true }; };
const server = await import('../server/index.js'), listener = await server.serverReady;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/announcements**', route => route.fulfill({ json: [] }));
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('采集分组', { exact: true }).selectOption('f');
  await page.locator('.sidebar nav button').filter({ hasText: '上架任务' }).click();
  const history = page.locator('.history-panel');
  assert.equal(await history.locator('.history-entry').count(), 8);
  await history.getByRole('button', { name: '下一页', exact: true }).click();
  await history.getByText('任务第 2/2 页', { exact: true }).waitFor();
  await page.getByText('已发布商品的视频待处理（1）', { exact: true }).click();
  const button = page.getByRole('button', { name: '完成视频关联', exact: true });
  await button.click(); await page.getByText('平台审核中', { exact: true }).waitFor();
  assert.equal(store.read().products[0].status, 'published');
  await button.click(); await page.getByRole('button', { name: '正在处理视频…' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '正在处理视频…' }).isDisabled(), true);
  while (!confirm) await new Promise(resolve => setTimeout(resolve, 20));
  confirm(); await page.getByText('商品视频已关联', { exact: true }).waitFor();
  assert.equal(await page.getByText('已发布商品的视频待处理（1）', { exact: true }).count(), 0);
  await page.reload();
  assert.equal(store.read().jobs.find(job => job.id === 'j').results.p.videoAssociation.associated, true);
  assert.ok(store.read().products[0].removedFromWorkbenchAt);
  assert.equal(calls, 2); assert.equal(store.read().jobs.length, 11);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'recovered.png'), fullPage: true });
  console.log(JSON.stringify({ ok: true, root, checks: ['archived-history-visible', 'older-history-pagination', 'failed-retry-preserves-publication', 'double-click-disabled', 'receipt-persisted', 'no-new-publish-job'] }));
} finally { await browser.close(); await server.shutdownServer(); SellerPublisher.prototype.retryPublishedVideo = original; }
