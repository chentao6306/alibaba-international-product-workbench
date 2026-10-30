// Exercise background sampling through the real editor, API and saved product.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && !fs.existsSync(root), 'Use a new isolated QA directory');
fs.mkdirSync(root, { recursive: true });
process.env.DATA_DIR = root;
process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const imagePath = path.join(root, 'media', 'source.png');
const fixture = process.env.QA_REPAIR_IMAGE_FILE || Buffer.from('<svg width="480" height="360"><rect width="480" height="360" fill="#d4dedb"/><rect x="280" y="100" width="100" height="180" fill="#222"/><rect x="160" y="140" width="80" height="50" fill="#555"/></svg>');
await sharp(fixture).png().toFile(imagePath);
const selections = process.env.QA_REPAIR_REGIONS ? JSON.parse(process.env.QA_REPAIR_REGIONS) : [
  { x: 160 / 480, y: 140 / 360, width: 80 / 480, height: 50 / 360, sample: { x: 0.2, y: 0.2 } },
];
assert.ok(selections.length > 0);
const original = fs.readFileSync(imagePath);
store.update(s => {
  s.products = [syncProductModel({ id: 'sample', sourceId: 'qa-sample', title: 'Background repair QA', sourcePlatform: 'alibaba.com',
    collectionFolderId: 'qa', selected: true, status: 'ready', price: 10, stock: 100, moq: 1,
    mainImages: ['/media/source.png'], detailImages: ['/media/source.png'], descriptionHtml: '<p>Original description</p>',
  })];
  s.collectionFolders = [{ id: 'qa', name: '修复背景验收' }];
  s.settings.activeCollectionFolderId = 'qa';
});
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [], operations = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/media/process' && request.method() === 'POST') operations.push(request.postDataJSON());
});
await page.route('**/api/announcements**', route => route.fulfill({ json: [] }));
const images = page.getByRole('region', { name: '批量图片编辑', exact: true });
const settle = () => page.waitForFunction(() => !document.querySelector('.batch-image-editor [role="status"]'));
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByRole('button', { name: '批量修改 1', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click();
  await images.getByLabel('预览商品', { exact: true }).waitFor();
  await settle();
  for (const [index, selection] of selections.entries()) {
    await images.getByRole('button', { name: '修复原图水印', exact: true }).first().click();
    const area = images.locator('.bie-selection');
    await area.scrollIntoViewIfNeeded();
    const bounds = await area.boundingBox();
    assert.ok(bounds);
    const point = (x, y) => [bounds.x + x * bounds.width, bounds.y + y * bounds.height];
    await page.mouse.move(...point(selection.x, selection.y)); await page.mouse.down();
    await page.mouse.move(...point(selection.x + selection.width, selection.y + selection.height), { steps: 8 }); await page.mouse.up();
    if (selection.sample) {
      await images.getByRole('button', { name: '选择背景取样点', exact: true }).click();
      await area.click({ position: { x: bounds.width * selection.sample.x, y: bounds.height * selection.sample.y } });
    }
    await images.getByRole('button', { name: '修复框选水印并预览', exact: true }).click();
    await settle();
    assert.equal(operations.length, index + 1);
    assert.equal(operations[index].action, 'repair');
    if (selection.sample) {
      assert.ok(Math.abs(operations[index].sample.x - selection.sample.x) < 0.02);
      assert.ok(Math.abs(operations[index].sample.y - selection.sample.y) < 0.02);
    } else assert.equal(operations[index].sample, null);
  }
  await page.screenshot({ path: path.join(root, 'repair-preview.png'), fullPage: true });
  await images.getByRole('button', { name: '保存图片修改', exact: true }).click();
  await images.waitFor({ state: 'hidden' });
  const product = store.read(s => s.products.find(p => p.id === 'sample'));
  assert.notEqual(product.mainImages[0], '/media/source.png');
  assert.deepEqual(product.detailImages, ['/media/source.png']);
  assert.ok(verifySourceIntegrity(product).valid);
  assert.deepEqual(fs.readFileSync(imagePath), original);
  fs.copyFileSync(path.join(root, product.mainImages[0]), path.join(root, 'saved-image.png'));
  await page.reload();
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByRole('button', { name: '批量修改 1', exact: true }).click();
  await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click();
  await images.getByLabel('预览商品', { exact: true }).waitFor(); await settle();
  assert.equal(await images.getByAltText('主图 1', { exact: true }).getAttribute('src'), product.mainImages[0]);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, sourcePreserved: true, savedAndReopened: true, operations }, null, 2));
  console.log(JSON.stringify({ passed: true, output: root }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: false, error: error.message, errors, operations }, null, 2));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => listener.close(resolve));
  await server.shutdownServices?.();
}
