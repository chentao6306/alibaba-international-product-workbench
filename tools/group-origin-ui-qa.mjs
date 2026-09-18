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
  state.products[0].attributes = [{ id: '100', name: 'Place of Origin', value: 'Guangdong, China', valueIds: { 'Guangdong, China': 'CN' } }];
  state.products[0].packaging = { weight: '1', length: '30', width: '20', height: '10' };
  state.jobs = Array.from({ length: 23 }, (_, index) => ({ id: `job-${index}`, type: 'collect', status: index === 0 ? 'running' : index < 15 ? 'paused' : 'queued', progress: index === 0 ? 4 : 0, total: 24, metadata: { collectionFolderId: 'qa', groupName: `相机配件采集分组 ${index + 1}` }, message: index === 0 ? '正在读取详情 4/24，已保存 4 件' : '等待继续' }));
  Object.assign(state.jobs[1], { collectionStage: 'listing', discovered: 48, total: 0 });
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
  const rangeSelect = page.locator('label').filter({ hasText: '采集范围' }).locator('select');
  const endPageInput = page.locator('label').filter({ hasText: '结束页' }).locator('input');
  assert.equal(await rangeSelect.inputValue(), 'all');
  assert.equal(await endPageInput.isDisabled(), true);
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 932 });
    if (width < 700) await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
    await page.locator('.collection-options').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `collection-range-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await rangeSelect.selectOption('range');
  assert.equal(await endPageInput.inputValue(), '10');
  assert.equal(await endPageInput.isDisabled(), false);
  await rangeSelect.selectOption('all');
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
  const discoveredButton = page.getByRole('button', { name: '采集已发现的 48 件商品', exact: true });
  await discoveredButton.waitFor();
  let discoveryRequested = false;
  await page.route('**/api/jobs/job-1/collect-discovered', async (route) => {
    discoveryRequested = true;
    store.patchJob('job-1', { status: 'running', collectionStage: 'detail', total: 48 });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await discoveredButton.click();
  await discoveredButton.waitFor({ state: 'hidden' });
  assert.equal(discoveryRequested, true);
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByTitle('编辑完整资料').click();
  await page.locator('.editor-tabs').getByRole('button', { name: '物流信息', exact: true }).click();
  await page.getByLabel('产地国家').selectOption('Japan');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('商品修改已保存', { exact: true }).waitFor();
  assert.equal(store.read().products[0].origin, 'Japan');
  assert.equal(store.read().products[0].attributes[0].value, 'Japan');
  assert.equal(store.read().products[0].attributes[0].valueIds, undefined);
  await page.getByRole('button', { name: '批量修改 1', exact: true }).click();
  await page.getByLabel('产地国家').selectOption('United States');
  await page.getByRole('button', { name: '应用到 1 件商品', exact: true }).click();
  await page.getByText('批量修改已应用', { exact: true }).waitFor();
  assert.equal(store.read().products[0].origin, 'United States');
  assert.equal(store.read().products[0].attributes[0].value, 'United States');
  await page.getByRole('button', { name: '批量修改 1', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '物流信息', exact: true }).click();
  await page.getByLabel('产地国家').selectOption('China');
  await page.getByLabel('毛重（kg）', { exact: true }).fill('2');
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 932 });
    await page.getByLabel('产地国家').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `batch-origin-packaging-${width}.png`) });
    assert.ok(await page.locator('.batch-drawer').evaluate((node) => node.scrollWidth <= node.clientWidth));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '应用到 1 件商品', exact: true }).click();
  await page.getByText('批量修改已应用', { exact: true }).waitFor();
  assert.equal(store.read().products[0].origin, 'China');
  assert.equal(store.read().products[0].attributes[0].value, 'China');
  assert.deepEqual(store.read().products[0].packaging, { weight: 2, length: '30', width: '20', height: '10' });
  await page.getByRole('button', { name: '批量修改 1', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '国家/地区定价', exact: true }).click();
  await page.getByLabel('定价国家/地区').selectOption('Japan');
  await page.getByLabel('该地区价格').fill('120');
  await page.getByRole('button', { name: '应用到 1 件商品', exact: true }).click();
  await page.getByText('批量修改已应用', { exact: true }).waitFor();
  assert.deepEqual(store.read().products[0].regionalPricing, { country: 'Japan', price: 120 });
  assert.equal(store.read().products[0].origin, 'China');
  assert.equal(store.read().products[0].attributes[0].value, 'China');
  await page.getByTitle('编辑完整资料').click();
  await page.locator('.editor-tabs').getByRole('button', { name: '物流信息', exact: true }).click();
  await page.getByLabel('产地国家').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('.drawer').evaluate((node) => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: path.join(root, 'origin-desktop.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  store.update((state) => {
    state.jobs = [{ id: 'publish-live', type: 'publish', status: 'running', progress: 1, total: 3,
      currentProductId: 'qa-product', createdAt: new Date().toISOString(), message: '正在上传商品图片',
      metadata: { collectionFolderId: 'qa', productIds: ['done', 'qa-product', 'third'], mode: 'submit' },
      results: { done: { status: 'published' } } }];
    state.products[0].status = 'publish_failed';
    state.products[0].publishResult = { message: 'Previous failure' };
  });
  await page.locator('.sidebar nav button').filter({ hasText: '上架任务' }).click();
  await page.getByText('正在上架', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.launch-panel .publish-counts')?.textContent.includes('成功 1'));
  assert.equal(await page.locator('.queue-list').getByText('Previous failure').count(), 0);
  store.update((state) => {
    const job = state.jobs[0]; job.progress = 2; job.currentProductId = 'third';
    job.results['qa-product'] = { status: 'failed' };
  });
  await page.waitForFunction(() => document.querySelector('.launch-panel .publish-counts')?.textContent.includes('失败 1'));
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 932 });
    if (width < 700) await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
    await page.locator('.launch-panel .publish-counts').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `publish-counts-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: root }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ root, errors })); throw error;
} finally { await browser.close(); await server.shutdownServer(); }
