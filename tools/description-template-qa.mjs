import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel } from '../server/product-model.js';
import { placeTemplateImages } from '../server/description-templates.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'description-template-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const image = path.join(root, 'media', 'fixture.png');
await sharp({ create: { width: 500, height: 180, channels: 3, background: '#238cba' } }).png().toFile(image);
const products = ['A', 'B'].map((id) => syncProductModel({ id, sourceId: id, collectionFolderId: 'template-qa', sourcePlatform: 'alibaba.com',
  title: '模板验收产品 ' + id, categoryId: '201774004', categoryPath: ['Mother, Kids & Toys', 'Plush Toys'],
  mainImages: ['/media/fixture.png'], images: ['/media/fixture.png'], detailImages: ['/media/fixture.png'],
  description: '旧公司说明', descriptionHtml: '<p>旧公司说明</p><img src="/media/fixture.png">', selected: true, status: 'ready', price: 5, stock: 100, moq: 1,
}));
store.update((s) => { s.collectionFolders = [{ id: 'template-qa', name: '模板验收' }]; s.settings.activeCollectionFolderId = 'template-qa'; s.products = products; });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1450, height: 1080 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const editor = page.getByRole('region', { name: '商品详情模板' });
async function settled() { await page.waitForFunction(() => !document.querySelector('.batch-description-editor [role="status"]')); }
async function open() {
  await page.getByRole('button', { name: '批量修改 2', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '详情描述', exact: true }).click();
  await editor.getByLabel('选择详情模板').waitFor(); await settled();
}
async function source(html) {
  if (!await editor.getByLabel('详情 HTML').isVisible()) await editor.getByRole('button', { name: 'HTML 源码', exact: true }).click();
  await editor.getByLabel('详情 HTML').fill(html);
}
async function save() { await editor.getByRole('button', { name: '保存模板', exact: true }).click(); await settled(); assert.ok(await editor.getByText('模板已保存', { exact: true }).isVisible()); }
try {
  await page.goto('http://127.0.0.1:' + listener.address().port);
  await page.getByLabel('采集分组', { exact: true }).selectOption('template-qa');
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await open();
  await editor.getByRole('button', { name: '新建模板', exact: true }).click();
  await editor.getByLabel('模板名称', { exact: true }).fill('我的公司通用模板');
  await source('<h2>{{title}}</h2><p>{{productImages}}</p><h3>Company Information</h3><table><tr><td>QA COMPANY</td></tr></table>');
  await editor.getByLabel('上传模板图片').setInputFiles(image); await settled();
  await page.locator('.batch-tabs').getByRole('button', { name: '基础信息', exact: true }).click();
  assert.ok(await editor.isVisible(), 'unsaved template cannot be silently lost');
  assert.equal(store.read().descriptionTemplates?.length || 0, 0);
  await save();
  const first = store.read().descriptionTemplates[0];
  assert.match(first.html, /\/media\//);
  assert.deepEqual(store.read().products, products);
  await editor.getByRole('button', { name: '复制为新模板', exact: true }).click();
  await editor.getByLabel('模板名称', { exact: true }).fill('服装专用模板');
  await source('<h2>{{title}}</h2><p>{{productImages}}</p><p>CLOTHING COMPANY</p>'); await save();
  assert.equal(store.read().descriptionTemplates.length, 2);
  await editor.getByLabel('选择详情模板').selectOption(first.id);
  await editor.getByRole('button', { name: '预览批量应用', exact: true }).click(); await settled();
  await page.frameLocator('iframe[title="模板应用后"]').getByText('QA COMPANY', { exact: true }).waitFor();
  assert.equal(await page.frameLocator('iframe[title="模板应用后"]').getByText('旧公司说明', { exact: true }).count(), 0);
  assert.ok(await page.frameLocator('iframe[title="模板应用前"]').getByText('旧公司说明', { exact: true }).isVisible());
  await editor.getByLabel('模板预览商品').selectOption('B');
  await page.frameLocator('iframe[title="模板应用后"]').getByRole('heading', { name: '模板验收产品 B', exact: true }).waitFor();
  assert.deepEqual(store.read().products, products, 'preview has no product side effects');
  await editor.locator('.bde-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'templates-preview.png') });
  await editor.getByRole('button', { name: '确认应用到 2 件商品', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  for (const product of store.read().products) {
    assert.match(product.descriptionHtml, /QA COMPANY/); assert.doesNotMatch(product.descriptionHtml, /旧公司说明/);
    assert.equal(product.detailImages.length, 2); assert.deepEqual(product.mainImages, ['/media/fixture.png']);
    assert.deepEqual(product.source, products.find((p) => p.id === product.id).source);
  }
  const applied = structuredClone(store.read().products);
  await open(); await editor.getByLabel('选择详情模板').selectOption(first.id);
  await source(first.html.replace('QA COMPANY', 'QA COMPANY V2')); await save();
  assert.deepEqual(store.read().products, applied, 'editing saved template does not auto-apply');
  await editor.getByLabel('模板应用方式').selectOption('append');
  await editor.getByRole('button', { name: '预览批量应用', exact: true }).click(); await settled();
  await page.frameLocator('iframe[title="模板应用后"]').getByText('QA COMPANY V2', { exact: true }).waitFor();
  assert.equal(await page.frameLocator('iframe[title="模板应用后"]').locator('img').count(), 2, 'old template images are not duplicated');
  await page.setViewportSize({ width: 430, height: 900 });
  assert.ok(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: path.join(root, 'templates-mobile.png') });
  await editor.getByRole('button', { name: '确认应用到 2 件商品', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1450, height: 1080 });
  await open(); await editor.getByLabel('选择详情模板').selectOption(first.id);
  await editor.getByRole('button', { name: '删除模板', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click(); await settled();
  assert.equal(store.read().descriptionTemplates.length, 1);
  assert.match(store.read().products[0].descriptionHtml, /QA COMPANY V2/);
  assert.deepEqual(errors, []);

  // Exercise actual browser DOM reconstruction with uploaded image URLs, image
  // duplication, tables and custom sizes. This does not submit to Alibaba.
  const fixture = await browser.newPage();
  await fixture.setContent('<div id="detail"><img src="https://example.com/uploaded-product.png"><img src="https://example.com/uploaded-company.png"></div>');
  await fixture.evaluate(() => {
    const body = document.querySelector('#detail');
    window.tinymce = { editors: [{ hidden: false, getBody: () => body, setContent: (html) => { body.innerHTML = html; }, save() {}, fire() {} }] };
  });
  const published = { detailImages: ['/media/product.png', '/media/company.png'], descriptionHtml: '<h2>Company Information</h2><table><tr><td><img width="100" style="width:100px" src="/media/company.png"></td><td>Company text</td></tr></table><img src="/media/product.png"><img src="/media/company.png">' };
  await placeTemplateImages(fixture, published);
  assert.deepEqual(await fixture.locator('#detail img').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src'))), ['https://example.com/uploaded-company.png', 'https://example.com/uploaded-product.png', 'https://example.com/uploaded-company.png']);
  assert.equal(await fixture.locator('#detail table img').getAttribute('width'), '100');
  await fixture.locator('#detail').evaluate((node) => { node.innerHTML = '<img src="https://example.com/incomplete.png">'; });
  await assert.rejects(placeTemplateImages(fixture, published), /未能恢复排版/);
  console.log(JSON.stringify({ passed: true, root, scenarios: ['template create/copy/edit/delete', 'persistence', 'company image upload', 'per-product preview', 'replace/append', 'reapply without duplication', 'unchanged collected source', 'mobile layout', 'published DOM image mapping', 'missing-image failure'] }, null, 2));
} finally { await browser.close(); await server.shutdownServer(); }
