// Runs the real image editor and persistence API against isolated fixtures.
// Image processing is intentionally mocked to measure UI queue cancellation;
// real watermark pixels are covered by image-watermark-qa.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { registerProductImageApi } from '../server/product-image-api.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-image-navigation-qa-'));
const store = new JsonStore(path.join(root, 'workspace.json'));
const mediaDir = path.join(root, 'media'); fs.mkdirSync(mediaDir, { recursive: true });
const products = Array.from({ length: 2000 }, (_, i) => syncProductModel({
  id: `product-${i}`, sourceId: `fixture-${i}`, sourcePlatform: 'alibaba.com', title: `图片商品 ${String(i).padStart(4, '0')}`,
  mainImages: Array.from({ length: 6 }, (_, n) => `https://example.test/${i}/main-${n}.png`),
  detailImages: Array.from({ length: 30 }, (_, n) => `https://example.test/${i}/detail-${n}.png`),
  descriptionHtml: `<p>商品 ${i} 的说明与视频必须保留</p><video src="https://example.test/video.mp4"></video>`,
}));
store.update((state) => { state.products = products; });
const summaries = products.map(({ id, title }) => ({ id, title }));
await build({
  stdin: { contents: `import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import BatchImageEditor from './src/BatchImageEditor.jsx'; import './src/styles.css';
    const products = ${JSON.stringify(summaries)};
    const notify = (message) => { document.getElementById('notice').textContent = message; };
    const onSaved = () => { window.savedCount = (window.savedCount || 0) + 1; };
    const guard = () => {};
    function App() { const [session, setSession] = useState(0), [count, setCount] = useState(2000); return <main style={{maxWidth:1100,margin:'auto',padding:20}}><button onClick={() => setSession(session + 1)}>重新打开图片编辑</button><button onClick={() => { setCount(9); setSession(session + 1); }}>查看九件商品</button><p id="notice"/><BatchImageEditor key={session} products={products.slice(0, count)} onSaved={onSaved} notify={notify} onGuardChange={guard}/></main>; }
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, jsx: 'automatic', minify: true, outfile: path.join(root, 'editor.js'), define: { 'process.env.NODE_ENV': '"production"' },
});
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/editor.css"><div id="root"></div><script src="/editor.js"></script></html>');
const app = express(); app.use(express.json({ limit: '12mb' }));
let processing = 0, maximumProcessing = 0, processCalls = 0;
app.post('/api/media/process', async (request, response) => {
  processing++; maximumProcessing = Math.max(maximumProcessing, processing); processCalls++;
  await new Promise((resolve) => setTimeout(resolve, 70));
  processing--; response.json({ url: `${request.body.url}?watermark=1`, changed: true });
});
registerProductImageApi(app, { store, mediaDir });
app.use(express.static(root));
app.use((error, request, response, next) => response.status(error.status || 500).json({ error: error.message }));
const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
page.setDefaultTimeout(30000);
const errors = [], draftBatchSizes = [], saveBatches = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (request.url().endsWith('/api/products/image-drafts')) draftBatchSizes.push(request.postDataJSON().ids.length);
  if (request.url().endsWith('/api/products/save-images')) saveBatches.push(request.postDataJSON().items.map(({ id }) => id));
});
await page.route('https://example.test/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="180"><rect width="200" height="180" fill="#d4eae3"/><text x="25" y="95" fill="#176354">IMAGE FIXTURE</text></svg>' }));
const editor = page.getByRole('region', { name: '批量图片编辑', exact: true });
const settled = async () => { await editor.getByRole('navigation', { name: '已选商品图片导航' }).waitFor(); await page.waitForFunction(() => !document.querySelector('.batch-image-editor [role="status"]')); };
const current = () => editor.locator('.bie-images');
const select = async (query, id) => {
  await editor.getByLabel('搜索已选商品').fill(query);
  await editor.locator('.bie-product-card').filter({ hasText: query }).click();
  assert.equal(await current().getAttribute('data-product-id'), id);
};
async function save() {
  const before = await page.evaluate(() => window.savedCount || 0);
  await editor.getByRole('button', { name: '保存图片修改', exact: true }).click();
  await page.waitForFunction((count) => (window.savedCount || 0) > count, before);
  await settled();
}
const metrics = { products: 2000, imageSlots: 72000 };
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`); await settled();
  assert.equal(await editor.locator('.bie-product-card').count(), 12);
  assert.equal(draftBatchSizes.length, 20); assert.ok(draftBatchSizes.every((size) => size <= 100));
  metrics.imageNodes = await editor.locator('img').count();
  assert.equal(metrics.imageNodes, 26, '12 thumbnails + 6 main + 8 detail images, independent of 72,000 slots');
  assert.ok(await editor.locator('option').count() < 30, 'product options must not grow with selection');
  await editor.getByRole('button', { name: '下一页商品', exact: true }).click();
  assert.match(await editor.locator('.bie-product-card').first().innerText(), /0012/);
  await select('1999', 'product-1999');
  await editor.getByRole('button', { name: '删除主图 1', exact: true }).click();
  assert.equal(await editor.getByAltText('主图 1', { exact: true }).getAttribute('src'), products[1999].mainImages[1]);
  await editor.getByRole('button', { name: '下一页详情图', exact: true }).click();
  await editor.getByRole('button', { name: '删除详情图 9', exact: true }).click();
  await save();
  assert.deepEqual(saveBatches.at(-1), ['product-1999']);
  let saved = store.read((state) => state.products.find(({ id }) => id === 'product-1999'));
  assert.deepEqual(saved.mainImages, products[1999].mainImages.slice(1));
  assert.deepEqual(saved.detailImages, products[1999].detailImages.filter((_, index) => index !== 8));
  assert.deepEqual(store.read((state) => state.products[0].mainImages), products[0].mainImages);
  await page.getByRole('button', { name: '重新打开图片编辑' }).click(); await settled(); await select('1999', 'product-1999');
  await editor.getByRole('button', { name: '恢复原始采集图片并预览', exact: true }).click();
  assert.equal(await editor.getByAltText('主图 1', { exact: true }).getAttribute('src'), products[1999].mainImages[0]);
  await save();
  saved = store.read((state) => state.products.find(({ id }) => id === 'product-1999'));
  assert.deepEqual(saved.mainImages, products[1999].mainImages);
  assert.deepEqual(saved.detailImages, products[1999].detailImages);
  assert.ok(saved.descriptionHtml.includes('说明与视频必须保留') && saved.descriptionHtml.includes('<video'));
  assert.ok(verifySourceIntegrity(saved).valid);
  await editor.getByRole('button', { name: '清空范围内主图', exact: true }).click();
  await editor.getByRole('button', { name: '撤销上一步', exact: true }).click();
  assert.equal(await editor.getByAltText('主图 1', { exact: true }).getAttribute('src'), products[1999].mainImages[0]);
  await editor.getByLabel('搜索已选商品').fill('');
  await editor.getByLabel('图片编辑商品范围').selectOption('all');
  await editor.getByLabel('水印文字').fill('QA');
  await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).click();
  await editor.getByRole('button', { name: '停止后续图片处理', exact: true }).click(); await settled();
  metrics.processRequestsBeforeStop = processCalls; metrics.maximumConcurrentProcessing = maximumProcessing;
  assert.ok(processCalls > 0 && processCalls < 72000);
  assert.equal(maximumProcessing, 2);
  assert.ok(await editor.getByRole('region', { name: '批量操作失败清单' }).count());
  assert.ok(await editor.locator('img').count() <= 28, 'cancellation results must not expand the image DOM');
  await editor.getByRole('button', { name: '恢复全部商品本次编辑前图片', exact: true }).click();
  assert.equal(await editor.getByRole('button', { name: '保存图片修改', exact: true }).isDisabled(), true);
  await editor.getByRole('navigation', { name: '已选商品图片导航' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'desktop.png') });
  await page.setViewportSize({ width: 430, height: 950 });
  assert.ok(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'no mobile editor overflow');
  await page.screenshot({ path: path.join(root, 'mobile.png') });
  await page.setViewportSize({ width: 1450, height: 1000 });
  await page.getByRole('button', { name: '查看九件商品' }).click(); await settled();
  assert.equal(await editor.locator('.bie-product-card').count(), 9, 'all nine selected products are discoverable on the first page');
  await editor.locator('.bie-product-card').filter({ hasText: '0008' }).click();
  assert.equal(await current().getAttribute('data-product-id'), 'product-8');
  assert.equal(await editor.getByAltText('主图 1', { exact: true }).getAttribute('src'), products[8].mainImages[0]);
  await editor.getByRole('navigation', { name: '已选商品图片导航' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'nine-products.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, metrics, verified: ['nine-products-visible-and-last-selectable', '2000-products-72000-image-slots', 'bounded-dom', 'search-and-pagination', 'last-product-deletion-isolated', 'detail-page-correct-slot', 'source-restore-after-save-reopen', 'text-video-source-preserved', 'sparse-undo', 'cancel-drains-two-workers', 'desktop-mobile'] }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png') }); console.error(JSON.stringify({ root, errors })); throw error; }
finally { await browser.close(); await new Promise((resolve) => listener.close(resolve)); }
