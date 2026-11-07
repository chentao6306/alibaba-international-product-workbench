// Isolated desktop UI acceptance: no customer data or seller browser is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-500-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const media = path.join(root, 'media');
const source = await sharp({ create: { width: 480, height: 360, channels: 3, background: '#abd5ce' } }).png().toBuffer();
for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(media, `source-${i}.png`), source);
fs.writeFileSync(path.join(media, 'broken.png'), 'not an image');
await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#adcddd' } }).jpeg().toFile(path.join(media, 'large.jpg'));
const logo = path.join(root, 'logo.png');
await sharp(Buffer.from('<svg width="150" height="60"><rect width="150" height="60" fill="#176557"/><text x="20" y="40" fill="white" font-size="30">SHOP</text></svg>')).png().toFile(logo);
const products = Array.from({ length: 500 }, (_, i) => syncProductModel({ id: `product-${i}`, sourceId: `qa-${i}`, title: `批量验收商品 ${String(i).padStart(3, '0')}`, sourcePlatform: 'alibaba.com',
  collectionFolderId: 'qa', selected: true, status: 'ready', price: 10, stock: 100, moq: 1,
  mainImages: [i === 13 ? '/media/broken.png' : i === 14 ? '/media/large.jpg' : `/media/source-${i % 15}.png`],
  detailImages: [`/media/source-${i % 15}.png`], description: 'Original description '.repeat(100),
  descriptionHtml: '<p>Original description</p>', structuredDescription: { html: '<p>Original description</p>' },
}));
store.update((s) => { s.products = products; s.collectionFolders = [{ id: 'qa', name: '500 件批量验收' }]; s.settings.activeCollectionFolderId = 'qa'; s.descriptionTemplates = [{ id: 'company', name: '批量公司介绍', version: 1, html: '<h2>{{title}}</h2><p>Company description</p><p>{{productImages}}</p>' }]; });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1550, height: 1050 } });
page.setDefaultTimeout(60000);
const errors = [], requests = [], metrics = {};
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (request) => { if (request.url().includes('/api/')) requests.push({ url: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() }); });
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const images = page.getByRole('region', { name: '批量图片编辑', exact: true });
const details = page.getByRole('region', { name: '商品详情模板', exact: true });
const settled = async (selector) => page.waitForFunction((selector) => !document.querySelector(selector + ' [role="status"]'), selector);
const output = path.resolve('.data/batch-qa'); fs.mkdirSync(output, { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  const started = Date.now();
  await page.getByRole('button', { name: '批量修改 500', exact: true }).click();
  await page.getByRole('heading', { name: '已选择 500 件商品', exact: true }).waitFor();
  metrics.openBatchMs = Date.now() - started;
  assert.equal(requests.filter((r) => /^\/api\/products\/product-/.test(r.url)).length, 0, 'opening batch editor must not fetch 500 full details');
  assert.equal(await page.locator('.batch-preview-row').count(), 30);
  await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click();
  await images.getByLabel('预览商品', { exact: true }).waitFor(); await settled('.batch-image-editor');
  assert.equal(await images.getByLabel('预览商品', { exact: true }).locator('option').count(), 500);
  assert.equal(requests.filter((r) => r.url === '/api/products/image-drafts').length, 5);
  await images.getByLabel('水印类型').selectOption('image');
  await images.getByLabel('上传水印图片', { exact: true }).setInputFiles(logo); await settled('.batch-image-editor');
  const processStart = Date.now();
  await images.getByRole('button', { name: '一键添加／更新水印', exact: true }).click(); await settled('.batch-image-editor');
  metrics.process1000SlotsMs = Date.now() - processStart;
  const failure = images.getByRole('region', { name: '批量操作失败清单' });
  assert.match(await failure.innerText(), /批量验收商品 013/); assert.match(await failure.innerText(), /主图 1/);
  assert.match(await failure.innerText(), /图片损坏/);
  assert.equal(requests.filter((r) => r.url === '/api/media/process').length, 17, 'shared images are processed once');
  await failure.getByRole('button', { name: '查看商品' }).click();
  assert.equal(await images.getByLabel('预览商品', { exact: true }).inputValue(), 'product-13');
  await page.screenshot({ path: path.join(output, '500-products-image-failure.png') });
  fs.writeFileSync(path.join(media, 'broken.png'), source);
  await failure.getByRole('button', { name: '只重试失败图片' }).click(); await settled('.batch-image-editor');
  assert.equal(await images.getByRole('region', { name: '批量操作失败清单' }).count(), 0);
  assert.equal(requests.filter((r) => r.url === '/api/media/process').length, 18);
  const saveStart = Date.now();
  await images.getByRole('button', { name: '保存图片修改', exact: true }).click(); await images.waitFor({ state: 'hidden' });
  metrics.save500ImagesMs = Date.now() - saveStart;
  const saves = requests.filter((r) => r.url === '/api/products/save-images');
  assert.ok(saves.length > 1, 'large selections must be saved in bounded batches');
  assert.ok(saves.every((r) => r.body.items.length <= 25), 'image saves must respect the memory bound');
  assert.equal(saves.reduce((total, r) => total + r.body.items.length, 0), 500, 'all selected products must be saved');
  assert.ok(store.read((s) => s.products.every((p) => p.mainImages[0] !== products[Number(p.id.split('-')[1])].mainImages[0] && verifySourceIntegrity(p).valid)));
  await page.getByRole('button', { name: '批量修改 500', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '详情描述', exact: true }).click();
  await details.getByLabel('选择详情模板').waitFor(); await settled('.batch-description-editor');
  await details.getByRole('button', { name: '预览批量应用', exact: true }).click(); await settled('.batch-description-editor');
  assert.equal(await details.getByLabel('模板预览商品').locator('option').count(), 500);
  await details.getByLabel('模板预览商品').selectOption('product-499'); await settled('.batch-description-editor');
  assert.match(await details.frameLocator('iframe[title="模板应用后"]').locator('body').innerText(), /批量验收商品 499/);
  store.update((s) => { s.jobs.push({ id: 'qa-busy', type: 'publish', status: 'running', metadata: { productIds: ['product-7'] } }); });
  await details.getByRole('button', { name: '确认应用到 500 件商品', exact: true }).click(); await settled('.batch-description-editor');
  assert.match(await details.getByRole('region', { name: '批量操作失败清单' }).innerText(), /批量验收商品 007/);
  assert.equal(store.read((s) => s.products.filter((p) => p.descriptionTemplate).length), 499);
  await page.screenshot({ path: path.join(output, '500-products-description-partial.png') });
  store.update((s) => { s.jobs = []; });
  await details.getByRole('button', { name: '预览批量应用', exact: true }).click(); await settled('.batch-description-editor');
  assert.equal(await details.getByLabel('模板预览商品').locator('option').count(), 1);
  await details.getByRole('button', { name: '确认应用到 1 件商品', exact: true }).click(); await details.waitFor({ state: 'hidden' });
  assert.equal(store.read((s) => s.products.filter((p) => p.descriptionTemplate).length), 500);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ passed: true, metrics, screenshots: output }));
} finally {
  await browser.close(); await new Promise((resolve) => listener.close(resolve));
  // The resolved target is the unique temporary fixture created by this run.
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
