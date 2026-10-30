import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonStore } from '../server/store.js';
import { CollectionCheckpoint } from '../server/collection-checkpoint.js';
import { initializeCollectionFolders } from '../server/collection-folders.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-folder-delete-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const store = new JsonStore(path.join(root, 'workspace.json'));
const seed = () => store.update((state) => {
  state.collectionFolders = [{ id: 'empty', name: '车灯' }, { id: 'other', name: '其他' }];
  state.settings.activeCollectionFolderId = 'empty';
  state.shops = []; state.groups = []; state.products = [];
  state.jobs = [
    { id: 'mic-paused', type: 'collect', status: 'paused', progress: 5, total: 121, metadata: { sourcePlatform: 'made-in-china', collectionMethod: 'shop-products', collectionFolderId: 'empty', options: { collectionFolderId: 'empty' } } },
    { id: 'other-paused', type: 'collect', status: 'paused', progress: 2, total: 10, metadata: { sourcePlatform: 'alibaba.com', collectionFolderId: 'other', options: { collectionFolderId: 'other' } } },
  ];
});
seed();
const server = await import('../server/index.js');
const listener = await server.serverReady;
const url = `http://127.0.0.1:${listener.address().port}`;
const browser = await chromium.launch({ executablePath: path.resolve('vendor/chromium/chrome.exe'), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
const dialog = () => page.getByRole('alertdialog');
const open = async () => {
  await page.getByTitle('删除空分组', { exact: true }).click();
  await dialog().getByText('中国制造网 · 采集任务', { exact: true }).waitFor();
};
const confirm = () => dialog().getByRole('button', { name: '取消暂停任务并删除分组', exact: true });
try {
  await page.goto(url);
  await page.locator('.sidebar nav button').filter({ hasText: /^店铺采集$/ }).click();
  await open();
  await dialog().getByText('商品采集 · 已暂停 · 已处理 5/121', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'other-platform-task.png') });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(store.read().jobs[0].status, 'paused');
  assert.equal(store.read().collectionFolders.length, 2);

  const checkpoint = new CollectionCheckpoint(root, 'mic-paused');
  fs.mkdirSync(path.dirname(checkpoint.file), { recursive: true });
  fs.writeFileSync(checkpoint.file, '{}');
  await open();
  await confirm().click();
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('.collection-folder-bar option[value="empty"]'));
  assert.equal(store.read().jobs[0].status, 'cancelled');
  assert.equal(store.read().jobs[1].status, 'paused');
  assert.equal(fs.existsSync(checkpoint.file), false);
  await page.getByTitle('新建采集分组', { exact: true }).click();
  await page.getByLabel('分组名称', { exact: true }).fill('删除后继续输入');
  assert.equal(await page.getByLabel('分组名称', { exact: true }).inputValue(), '删除后继续输入');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();

  // A task resumed after opening the dialog must fail atomically, even when
  // the last UI snapshot still offers the combined delete action.
  seed(); await page.reload(); await open();
  store.update((state) => { state.jobs[0].status = 'running'; });
  await confirm().click();
  await dialog().getByRole('alert').filter({ hasText: '先暂停' }).waitFor();
  assert.equal(store.read().collectionFolders.length, 2);
  assert.equal(store.read().jobs[0].status, 'running');
  await dialog().getByRole('button', { name: '暂停任务', exact: true }).click();
  await dialog().getByText('商品采集 · 正在暂停 · 已处理 5/121', { exact: true }).waitFor();
  assert.equal(await confirm().isDisabled(), true);
  // Model the collector acknowledging pause after its current work completes.
  store.update((state) => { state.jobs[0].status = 'paused'; });
  await page.waitForFunction(() => [...document.querySelectorAll('dialog button')].some((button) => button.textContent === '取消暂停任务并删除分组' && !button.disabled));
  await confirm().click(); await dialog().waitFor({ state: 'hidden' });
  assert.equal(store.read().jobs[0].status, 'cancelled');

  // A server/storage failure stays inside the dialog and may be retried.
  seed(); await page.reload(); await open();
  await page.route('**/api/collection-folders/empty', async (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：保存暂时失败，请重试' }) }));
  await confirm().click();
  await dialog().getByRole('alert').filter({ hasText: '保存暂时失败' }).waitFor();
  assert.equal(store.read().jobs[0].status, 'paused');
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.unroute('**/api/collection-folders/empty');
  await confirm().click(); await dialog().waitFor({ state: 'hidden' });

  seed();
  store.update((state) => { state.products.push({ id: 'visible', title: 'Visible', collectionFolderId: 'empty' }); });
  await page.reload(); await open();
  await dialog().getByText('分组内仍有 1 件商品，请先移动或删除商品。', { exact: true }).waitFor();
  assert.equal(await confirm().isDisabled(), true);
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  store.update((state) => {
    state.products[0].removedFromWorkbenchAt = '2026-10-09';
    state.products[0].publishHistory = [{ result: { status: 'published', url: 'https://www.alibaba.com/product-detail/Original_1600000000000.html' } }];
  });
  const productBefore = store.read().products[0];
  await page.reload(); await open();
  await dialog().getByText('已自动移出工作台的 1 件商品及发布记录会保留。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 430, height: 932 });
  await page.screenshot({ path: path.join(root, 'archive-preserved-mobile.png') });
  assert.equal(await dialog().evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await confirm().click(); await dialog().waitFor({ state: 'hidden' });
  store.update(initializeCollectionFolders);
  assert.deepEqual(store.read().products[0], productBefore);
  assert.deepEqual(store.read().collectionFolders.map((folder) => folder.id), ['other']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, checks: ['cross-platform task visibility', 'cancel leaves data intact', 'explicit delete cancels only own paused tasks', 'checkpoint cleanup', 'input focus', 'resumed task race', 'pause acknowledgement', 'retryable inline failure', 'occupied folder protection', 'archived publication preservation', 'restart migration', 'mobile layout'] }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ root, errors, message: error.message }));
  throw error;
} finally { await browser.close(); await server.shutdownServer(); }
