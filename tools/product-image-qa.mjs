import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel } from '../server/product-model.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-image-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const image = path.join(root, 'media', 'fixture.png');
await sharp(Buffer.from('<svg width="480" height="360"><rect width="480" height="360" fill="#edf6f4"/><rect x="155" y="50" width="170" height="225" rx="35" fill="#27a69d"/><rect x="192" y="30" width="96" height="40" rx="9" fill="#154e52"/><text x="190" y="180" font-size="22" fill="white">DEMO</text><rect x="350" y="310" width="60" height="15" fill="#ff4848"/></svg>')).png().toFile(image);
const make = (id) => syncProductModel({ id, sourceId: id, collectionFolderId: 'image-qa', sourcePlatform: 'alibaba.com',
  title: `图片编辑验收 ${id}`, categoryId: '201774004', categoryPath: ['Mother, Kids & Toys', 'Plush Toys'],
  mainImages: ['/media/fixture.png'], images: ['/media/fixture.png'], mainImage: '/media/fixture.png', detailImages: ['/media/fixture.png', '/media/fixture.png'],
  descriptionHtml: '<p>保留商品说明</p><img src="/media/fixture.png">', selected: true, status: 'ready', price: 5, stock: 100, moq: 1,
});
const products = ['A', 'B'].map(make);
store.update((s) => { s.collectionFolders = [{ id: 'image-qa', name: '图片验收' }]; s.settings.activeCollectionFolderId = 'image-qa'; s.products = products; });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1450, height: 1080 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const editor = page.getByRole('region', { name: '批量图片编辑' });
async function open() {
  await page.getByRole('button', { name: '批量修改 2', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click();
  await editor.getByLabel('预览商品').waitFor();
  await editor.getByRole('button', { name: '清空全部详情图', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.batch-image-editor fieldset')?.disabled);
}
async function settled() { await page.waitForFunction(() => !document.querySelector('.batch-image-editor [role="status"]')); }
async function save() { await editor.getByRole('button', { name: '保存图片修改', exact: true }).click(); await editor.waitFor({ state: 'hidden' }); }
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('采集分组', { exact: true }).selectOption('image-qa');
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await open();
  await editor.getByRole('button', { name: '删除详情图 1', exact: true }).click();
  assert.equal(await editor.getByAltText('详情图 2', { exact: true }).count(), 0);
  assert.equal(store.read().products[0].detailImages.length, 2, 'delete remains a draft');
  await editor.getByRole('button', { name: '撤销上一步', exact: true }).click();
  await editor.getByRole('button', { name: '清空全部详情图', exact: true }).click();
  assert.ok(await editor.getByText('暂无详情图', { exact: true }).isVisible());
  await editor.getByLabel('上传详情图', { exact: true }).setInputFiles(image); await settled();
  await editor.getByLabel('上传主图', { exact: true }).setInputFiles(image); await settled();
  await editor.getByLabel('水印文字', { exact: true }).fill('我的店铺 SAMPLE');
  await editor.getByLabel('水印颜色').fill('#ff8800');
  await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).click(); await settled();
  await editor.getByAltText('处理后', { exact: true }).waitFor();
  assert.equal(store.read().products[0].mainImages.length, 1, 'processing remains a draft');
  await page.locator('.batch-tabs').getByRole('button', { name: '基础信息', exact: true }).click();
  assert.ok(await editor.isVisible(), 'unsaved images cannot be silently dropped by switching tabs');
  await editor.getByAltText('处理后', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'watermark-preview-desktop.png') });
  await save();
  const marked = store.read().products;
  for (let i = 0; i < 2; i++) { assert.equal(marked[i].mainImages.length, 2); assert.equal(marked[i].detailImages.length, 1); assert.deepEqual(marked[i].source, products[i].source); }
  await open();
  await editor.getByRole('button', { name: '删除本软件水印', exact: true }).click(); await settled();
  await save();
  assert.equal(store.read().products[0].mainImages[0], '/media/fixture.png');
  await open();
  await editor.getByRole('button', { name: '修复原图水印', exact: true }).first().click();
  const canvas = editor.locator('.bie-selection'); await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + rect.width * 0.72, rect.y + rect.height * 0.85);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width * 0.87, rect.y + rect.height * 0.92, { steps: 10 }); await page.mouse.up();
  await editor.getByRole('button', { name: '修复框选水印并预览', exact: true }).click(); await settled();
  await editor.getByAltText('处理后', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'repair-preview-desktop.png') });
  assert.equal(store.read().products[0].mainImages[0], '/media/fixture.png');
  await save();
  assert.notEqual(store.read().products[0].mainImages[0], '/media/fixture.png');
  assert.equal(store.read().products[1].mainImages[0], '/media/fixture.png', 'single-image repair does not change other products');
  await open();
  await page.setViewportSize({ width: 430, height: 900 });
  await page.locator('.batch-body').scrollIntoViewIfNeeded();
  assert.ok(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'no mobile horizontal overflow');
  await page.screenshot({ path: path.join(root, 'images-mobile.png') });
  await editor.getByRole('button', { name: '清空全部详情图', exact: true }).click();
  await save();
  for (const p of store.read().products) { assert.deepEqual(p.detailImages, []); assert.doesNotMatch(p.descriptionHtml, /<img/); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scenarios: ['single delete and undo', 'clear detail', 'main/detail upload', 'batch watermark', 'saved watermark removal', 'region repair preview and save', 'immutable source', 'draft tab guard', 'mobile layout'], root }, null, 2));
} finally { await browser.close(); await server.shutdownServer(); }
