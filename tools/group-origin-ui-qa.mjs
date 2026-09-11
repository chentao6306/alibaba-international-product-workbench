import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-origin-ui-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
store.update((state) => {
  state.collectionFolders = [{ id: 'qa', name: '相机配件' }]; state.settings.activeCollectionFolderId = 'qa';
  state.products = [{ id: 'qa-product', sourceId: '123456789', sourcePlatform: 'alibaba.com', collectionFolderId: 'qa', title: 'Gimbal Camera', origin: 'Guangdong, China', price: 100, stock: 100, categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'], status: 'ready', selected: true }];
  state.jobs = Array.from({ length: 23 }, (_, index) => ({ id: `job-${index}`, type: 'collect', status: index === 0 ? 'running' : index < 15 ? 'paused' : 'queued', progress: index === 0 ? 4 : 0, total: 24, metadata: { collectionFolderId: 'qa', groupName: `相机配件采集分组 ${index + 1}` }, message: index === 0 ? '正在读取详情 4/24，已保存 4 件' : '等待继续' }));
});
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await page.route('**/api/jobs/*/pause', async (route) => {
  const id = new URL(route.request().url()).pathname.split('/')[3];
  store.patchJob(id, { status: 'paused' });
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('采集分组', { exact: true }).selectOption('qa');
  await page.getByRole('button', { name: '查看任务', exact: true }).waitFor();
  assert.equal(await page.locator('.collection-task-row').count(), 0);
  assert.ok((await page.locator('.collection-tasks').boundingBox()).height < 160);
  await page.getByRole('button', { name: '查看任务', exact: true }).click();
  assert.equal(await page.locator('.collection-task-row').count(), 5);
  await page.getByTitle('下一页任务').click();
  assert.match(await page.locator('.collection-task-row').first().innerText(), /分组 6/);
  await page.getByLabel('采集任务状态').selectOption('running');
  assert.equal(await page.locator('.collection-task-row').count(), 1);
  await page.getByTitle('暂停采集', { exact: true }).click();
  await page.getByText('共 0 项', { exact: true }).waitFor();
  await page.getByLabel('采集任务状态').selectOption('all');
  for (const width of [1440, 1280, 430]) {
    await page.setViewportSize({ width, height: 932 });
    if (width < 700) await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
    await page.locator('.collection-tasks').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `tasks-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const row of await page.locator('.collection-task-row').all()) {
      const [detail, status, actions] = await Promise.all(['.collection-task-detail', '.collection-task-status', '.collection-task-actions'].map((selector) => row.locator(selector).boundingBox()));
      assert.ok(detail.x + detail.width <= status.x && status.x + status.width <= actions.x);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByTitle('编辑完整资料').click();
  await page.locator('.editor-tabs').getByRole('button', { name: '物流信息', exact: true }).click();
  await page.getByLabel('产地国家').selectOption('Japan');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('商品修改已保存', { exact: true }).waitFor();
  assert.equal(store.read().products[0].origin, 'Japan');
  await page.getByRole('button', { name: '批量修改 1', exact: true }).click();
  await page.getByLabel('产地国家').selectOption('United States');
  await page.getByRole('button', { name: '应用到 1 件商品', exact: true }).click();
  await page.getByText('批量修改已应用', { exact: true }).waitFor();
  assert.equal(store.read().products[0].origin, 'United States');
  await page.getByTitle('编辑完整资料').click();
  await page.locator('.editor-tabs').getByRole('button', { name: '物流信息', exact: true }).click();
  await page.getByLabel('产地国家').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('.drawer').evaluate((node) => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: path.join(root, 'origin-desktop.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: root }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ root, errors })); throw error;
} finally { await browser.close(); await server.shutdownServer(); }
