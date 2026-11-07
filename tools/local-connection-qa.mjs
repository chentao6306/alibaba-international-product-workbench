import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-connection-qa-'));
process.env.DATA_DIR = root;
process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1450, height: 1050 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(15000);
let fail = false, fault = false, mutations = 0;
page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/publish')) mutations++; });
await page.route('**/api/announcements**', route => route.fulfill({ json: [] }));
await page.route('**/api/state?**', async route => {
  if (fail) return route.abort('connectionfailed');
  if (!fault) return route.continue();
  const response = await route.fetch();
  const state = await response.json();
  state.service = { status: 'error', code: 'ENOSPC', message: '任务已停止：磁盘可用空间不足，请释放空间；继续上架前先核对当前商品的发布结果。' };
  await route.fulfill({ json: state });
});
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}/`);
  const footer = page.locator('.sidebar-foot');
  await footer.getByText('运行正常', { exact: true }).waitFor();
  fail = true;
  await page.locator('.local-service-error').filter({ hasText: '暂时无法连接本地服务' }).waitFor();
  await footer.getByText('连接或任务异常', { exact: true }).waitFor();
  assert.equal(await footer.locator('.system-dot.online').count(), 0);
  await page.evaluate(() => { window.kuaYipu = { serviceStatus: async () => ({ status: 'stopped', freeBytes: 7 * 1024 * 1024 }) }; });
  await page.locator('.local-service-error').filter({ hasText: '磁盘空间不足' }).waitFor();
  await page.screenshot({ path: path.join(root, 'disk-space-error.png') });
  fail = false; fault = true;
  await page.locator('.local-service-error').filter({ hasText: '任务已停止' }).waitFor();
  await footer.getByText('连接或任务异常', { exact: true }).waitFor();
  fault = false;
  await footer.getByText('运行正常', { exact: true }).waitFor();
  assert.equal(await page.locator('.local-service-error').count(), 0);
  assert.equal(mutations, 0, 'reconnecting must only reread, never resubmit products');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, verified: ['disconnect', 'disk-status', 'job-failure', 'automatic-read-recovery', 'no-publish-retry'] }));
} finally {
  await browser.close();
  await server.shutdownServer();
}
