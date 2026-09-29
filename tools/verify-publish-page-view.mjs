import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

const output = path.resolve(process.argv[2] || '.tmp/publish-page-view');
fs.mkdirSync(output, { recursive: true });
const app = express();
app.use(express.static('dist'));
const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
try {
  const source = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await source.setContent('<main style="padding:30px;font:20px sans-serif"><h2>Product Attributes</h2><label>Material <input value="Cotton"></label><div style="margin:20px 0;padding:20px;border:1px solid #aaa;background:#fff"><p><input type="checkbox" checked>Cotton</p><p><input type="checkbox" checked>Linen</p></div><label>Style Number <input value="A26"></label></main>');
  const image = `data:image/jpeg;base64,${(await source.screenshot({ type: 'jpeg' })).toString('base64')}`;
  await source.close();
  const job = { id: 'fixture', type: 'publish', status: 'paused', currentProductId: 'product', progress: 77, total: 236,
    createdAt: '2026-09-20T10:52:14Z', metadata: { mode: 'draft', collectionFolderId: '' },
    message: '已暂停：服装测试商品 Cotton Linen Shirt - “Style Number”的页面操作未完成，任务已暂停，已保留当前商品进度。可点击“查看暂停画面”核对。',
    diagnostics: { publishStage: '填写类目属性：Style Number' } };
  const state = { shops: [], groups: [], products: [], collectionFolders: [], jobs: [job], settings: {}, browser: {}, collectorBrowser: {} };
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let available = true;
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/publish-page')) return route.fulfill({ status: available ? 200 : 410, json: available
      ? { image, capturedAt: '2026-09-21T01:00:00Z', jobId: 'fixture', productId: 'product' }
      : { error: '本次暂停画面不可用，可能在暂停后重启过软件。任务进度已保留。' } });
    const json = url.pathname === '/api/state' ? state : url.pathname === '/api/publish/plan' ? { groups: [], total: 0, bindings: [] } : [];
    return route.fulfill({ json });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: /上架任务/ }).first().click();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '查看暂停画面', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '暂停时的发布页面' });
    await dialog.locator('img').waitFor();
    assert.equal(await dialog.locator('img').evaluate((node) => node.complete && node.naturalWidth === 1280), true);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(output, `publish-page-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: '原始大小', exact: true }).click();
    assert.equal(await dialog.locator('img').evaluate((node) => node.width), 1280);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
  }
  available = false;
  await page.getByRole('button', { name: '查看暂停画面', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '本次暂停画面不可用' }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: desktop/mobile snapshot, image pixels, zoom, Escape, unavailable state, no page errors');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
