import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel } from '../server/product-model.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-watermark-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const media = path.join(root, 'media');
await sharp(Buffer.from('<svg width="480" height="360"><rect width="480" height="360" fill="#edf6f4"/><rect x="155" y="50" width="170" height="225" rx="35" fill="#27a69d"/><rect x="192" y="30" width="96" height="40" rx="9" fill="#154e52"/><text x="190" y="180" font-size="22" fill="white">DEMO</text></svg>')).png().toFile(path.join(media, 'main.png'));
await sharp(path.join(media, 'main.png')).resize(400, 600, { fit: 'contain', background: '#ffffff' }).png().toFile(path.join(media, 'detail.png'));
const logo = path.join(root, 'store-logo.png');
await sharp(Buffer.from('<svg width="200" height="80"><circle cx="40" cy="40" r="30" fill="#ff7020"/><path d="M23 40 L36 53 L58 27" stroke="white" stroke-width="7" fill="none"/><text x="78" y="46" font-size="25" font-family="sans-serif" fill="#154e52">SHOP</text></svg>')).png().toFile(logo);
const make = (id) => syncProductModel({ id, sourceId: id, collectionFolderId: 'qa', sourcePlatform: 'alibaba.com',
  title: `图片水印验收 ${id}`, categoryId: '201774004', selected: true, status: 'ready',
  mainImages: ['/media/main.png'], images: ['/media/main.png'], mainImage: '/media/main.png', detailImages: ['/media/detail.png'],
  descriptionHtml: '<p>保留商品说明</p><img src="/media/detail.png">',
});
const products = ['A', 'B'].map(make);
store.update((s) => { s.collectionFolders = [{ id: 'qa', name: '图片水印验收' }]; s.settings.activeCollectionFolderId = 'qa'; s.products = products; });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1450, height: 1080 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const editor = page.getByRole('region', { name: '批量图片编辑' });
async function settled() { await page.waitForFunction(() => !document.querySelector('.batch-image-editor [role="status"]')); }
async function open() {
  await page.getByRole('button', { name: '批量修改 2', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click();
  await editor.getByLabel('预览商品').waitFor(); await settled();
}
async function save() { await editor.getByRole('button', { name: '保存图片修改', exact: true }).click(); await editor.waitFor({ state: 'hidden' }); }
async function chooseImage() {
  await editor.getByLabel('水印类型').selectOption('image');
  await editor.getByLabel('上传水印图片', { exact: true }).setInputFiles(logo); await settled();
  await editor.getByAltText('已上传的水印图片').waitFor();
}
async function apply() { await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).click(); await settled(); await editor.getByAltText('处理后', { exact: true }).waitFor(); }
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('采集分组', { exact: true }).selectOption('qa');
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await open();
  await editor.getByLabel('水印类型').selectOption('image');
  await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).click(); await settled();
  assert.match(await editor.getByRole('alert').innerText(), /先上传水印图片/);
  await chooseImage();
  assert.deepEqual(store.read().products.map((p) => p.mainImages), products.map((p) => p.mainImages), 'uploading logo does not add a product image');
  const uploaded = await editor.getByAltText('已上传的水印图片').getAttribute('src');
  await editor.getByLabel('上传水印图片', { exact: true }).setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') }); await settled();
  assert.match(await editor.getByRole('alert').innerText(), /JPG/);
  assert.equal(await editor.getByAltText('已上传的水印图片').getAttribute('src'), uploaded);
  await editor.getByLabel('水印作用范围').selectOption('mainImages');
  await apply();
  assert.equal(await editor.getByAltText('详情图 1', { exact: true }).getAttribute('src'), '/media/detail.png');
  const mainMark = await editor.getByAltText('主图 1', { exact: true }).getAttribute('src');
  assert.notEqual(mainMark, '/media/main.png');
  await save();
  assert.ok(store.read().products.every((p) => p.mainImages[0] === mainMark && p.detailImages[0] === '/media/detail.png'));
  await open(); await chooseImage();
  await editor.getByLabel('水印作用范围').selectOption('detailImages');
  await editor.getByLabel('水印位置').selectOption('northwest');
  await apply();
  assert.equal(await editor.getByAltText('主图 1', { exact: true }).getAttribute('src'), mainMark);
  await save();
  assert.ok(store.read().products.every((p) => p.detailImages[0] !== '/media/detail.png' && p.descriptionHtml.includes(p.detailImages[0])));
  await open(); await chooseImage();
  await editor.getByLabel('水印大小').fill('40');
  await editor.getByLabel('水印透明度').fill('0.85');
  await editor.getByLabel('水印位置').selectOption('southeast');
  await editor.getByLabel('水印作用范围').selectOption('both');
  await apply();
  await editor.getByLabel('水印类型').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'image-watermark-settings.png') });
  await editor.getByAltText('处理后', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'image-watermark-preview.png') });
  for (const [alt, file] of [['主图 1', 'main-result.png'], ['详情图 1', 'detail-result.png']]) {
    fs.copyFileSync(path.join(media, path.basename(await editor.getByAltText(alt, { exact: true }).getAttribute('src'))), path.join(root, file));
  }
  await page.setViewportSize({ width: 430, height: 950 });
  await editor.getByLabel('水印类型').scrollIntoViewIfNeeded();
  assert.ok(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'no mobile overflow');
  await page.screenshot({ path: path.join(root, 'image-watermark-mobile.png') });
  await save();
  for (let i = 0; i < products.length; i++) {
    assert.deepEqual(store.read().products[i].source, products[i].source);
    assert.equal(store.read().products[i].mainImages.length, 1);
    assert.equal(store.read().products[i].detailImages.length, 1);
  }
  await page.setViewportSize({ width: 1450, height: 1080 });
  await open();
  await editor.getByRole('button', { name: '删除本软件水印', exact: true }).click(); await settled(); await save();
  for (const saved of store.read().products) { assert.deepEqual(saved.mainImages, ['/media/main.png']); assert.deepEqual(saved.detailImages, ['/media/detail.png']); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, verified: ['uploaded-transparent-logo', 'invalid-file-retains-logo', 'main-only', 'detail-only', 'both', 'size-position-opacity', 'preview-before-save', 'detail-html-updated', 'source-preserved', 'reopen-and-remove', 'desktop-mobile'] }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png') }); console.error(JSON.stringify({ root, errors })); throw error; }
finally { await browser.close(); await server.shutdownServer(); }
