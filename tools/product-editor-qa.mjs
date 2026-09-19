import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-editor-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const image = process.env.QA_PRODUCT_IMAGE;
if (image) await sharp(image).resize(240, 240, { fit: 'contain' }).png().toFile(path.join(root, 'media', 'product.png'));
else await sharp({ create: { width: 240, height: 240, channels: 3, background: '#80aab5' } }).png().toFile(path.join(root, 'media', 'product.png'));
const target = { id: 'target', sourceId: '123456789', collectionFolderId: 'qa', sourcePlatform: 'alibaba.com', sourceUrl: 'https://www.alibaba.com/product-detail/qa_123456789.html',
  title: 'Gwrc 10-Inch Plastic Three-Blade Propeller with 10-Inch Frame Remote Control Drones Accessories',
  categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Camera, Photo & Accessories', 'Drones Accessories'],
  brand: 'GWRC', origin: 'China', province: 'Guangdong', currencySymbol: '$', price: 3.5, stock: 0, moq: 2, selected: true, status: 'publish_failed',
  mainImages: Array.from({ length: 5 }, () => '/media/product.png'), mainImage: '/media/product.png', detailImages: ['/media/product.png'],
  attributes: [{ id: '2', name: 'Brand Name', value: 'GWRC' }, { name: 'Place of Origin', value: 'China' }, { name: 'Province', value: 'Guangdong' }, { name: 'Compatible Brand', value: ['For FPV'] }, { name: 'Material', value: ['Plastic'] }, { name: 'Private Mold', value: 'No' }],
  variantGroups: [{ name: 'Color', options: ['Black'], optionImages: { Black: '/media/product.png' } }, { name: 'Compatible Model', options: ['10-Inch 1050'] }, { name: 'Type', options: ['Propellers'] }],
  skus: [{ attributes: { Color: 'Black', 'Compatible Model': '10-Inch 1050', Type: 'Propellers' }, stock: 0, code: 'ORIGINAL', price: 3.5, enabled: true }],
  priceTiers: [{ minQuantity: 2, price: 3.5 }, { minQuantity: 500, price: 2.9 }, { minQuantity: 2000, price: 2.7 }],
  deliveryTime: [['Quantity', '1 - 500', '501 - 2000'], ['Lead time', '7', '15']],
  packaging: { weight: '0.010', length: '7', width: '7', height: '3.5' },
  description: 'Three-Blade Propeller: Enhances drone flight stability and performance.', descriptionHtml: '<p>Original propeller detail.</p><img src="/media/product.png">',
  publishResult: { message: '已采集但发布页未接受：品牌名称', requiredFields: ['品牌名称'], status: 'failed' },
};
const reference = { ...structuredClone(target), id: 'reference', title: 'Published VTX reference', status: 'published', brand: 'PUSD',
  attributes: [{ name: 'Brand Name', value: 'PUSD' }, { name: 'Material', value: ['Metal', 'Rubber'] }, { name: 'Compatible Brand', value: ['DJI', 'Others'] }, { name: 'Private Mold', value: 'Yes' }],
  variantGroups: [{ name: 'Compatible Model', options: ['Other'] }, { name: 'Model Number', options: ['5.8G 3W'], optionImages: { '5.8G 3W': '/media/product.png' } }, { name: 'Type', options: ['FPV VTX'] }],
  skus: [{ attributes: { 'Compatible Model': 'Other', 'Model Number': '5.8G 3W', Type: 'FPV VTX' }, price: 500, stock: 999, code: 'WRONG' }],
};
store.update((state) => { state.collectionFolders = [{ id: 'qa', name: '编辑验收' }]; state.settings.activeCollectionFolderId = 'qa'; state.products = [target, reference]; });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const tabs = ['基础信息', '商品属性', '自定义属性', '产品规格', '交易信息', '物流信息', '商品服务与证书', '商品描述', '国家/地区差异设置'];
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('采集分组', { exact: true }).selectOption('qa');
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByTitle('编辑完整资料').first().click();
  assert.equal(await page.getByRole('tablist', { name: '商品编辑页签' }).getByRole('tab').count(), 9);
  for (const width of [1500, 430]) {
    await page.setViewportSize({ width, height: 1050 });
    for (let index = 0; index < tabs.length; index++) {
      await page.getByRole('tab', { name: tabs[index], exact: true }).click();
      await page.locator('.pe-scroll').evaluate((node) => { node.scrollTop = 0; });
      assert.ok(await page.locator('.pe-window').evaluate((node) => node.scrollWidth <= node.clientWidth), `${tabs[index]} overflows at ${width}`);
      assert.ok(await page.locator('.pe-pane:visible').evaluate((node) => node.scrollWidth <= node.clientWidth), `${tabs[index]} pane overflows at ${width}`);
      await page.screenshot({ path: path.join(root, `editor-${width}-${index + 1}.png`) });
    }
  }
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.getByRole('tab', { name: '基础信息', exact: true }).click();
  await page.getByLabel('商品名称', { exact: true }).fill('Unsaved propeller title');
  await page.getByRole('button', { name: '引用类目与属性', exact: true }).click();
  await page.getByLabel('选择引用商品', { exact: true }).selectOption('reference');
  await page.getByRole('button', { name: '预览修改', exact: true }).click();
  await page.getByRole('button', { name: '应用到编辑窗口', exact: true }).click();
  assert.equal(await page.getByLabel('商品名称', { exact: true }).inputValue(), 'Unsaved propeller title');
  assert.equal(store.read().products[0].brand, 'GWRC', 'Reference remains unsaved');
  await page.getByRole('tab', { name: '商品属性', exact: true }).click();
  assert.equal(await page.getByLabel('品牌名称', { exact: true }).inputValue(), 'PUSD');
  await page.screenshot({ path: path.join(root, 'reference-attributes.png') });
  await page.getByRole('tab', { name: '产品规格', exact: true }).click();
  assert.equal(await page.getByLabel('SKU 1 编码', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('SKU 1 库存', { exact: true }).inputValue(), '0');
  assert.equal(await page.locator('.pe-skus tbody').innerText().then((text) => text.includes('Black')), false);
  await page.screenshot({ path: path.join(root, 'reference-specifications.png') });
  await page.getByRole('tab', { name: '交易信息', exact: true }).click();
  assert.equal(await page.getByLabel('交期 2 天数', { exact: true }).inputValue(), '15');
  await page.getByLabel('交期 2 天数', { exact: true }).fill('20');
  await page.getByRole('tab', { name: '自定义属性', exact: true }).click();
  await page.getByLabel('自定义属性 1 名称', { exact: true }).fill('Custom label');
  await page.getByLabel('自定义属性 1 值', { exact: true }).fill('Custom value');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog', { name: '编辑产品', exact: true }).waitFor({ state: 'hidden' });
  const saved = store.read().products[0];
  assert.equal(saved.title, 'Unsaved propeller title'); assert.equal(saved.brand, 'PUSD');
  assert.deepEqual(saved.priceTiers, target.priceTiers); assert.equal(saved.descriptionHtml, target.descriptionHtml); assert.deepEqual(saved.packaging, target.packaging);
  assert.deepEqual(saved.deliveryTime, [['Quantity', '1 - 500', '501 - 2000'], ['Lead time', '7', '20']]);
  assert.equal(saved.referenceRecovery.failure.message, target.publishResult.message); assert.equal(saved.publishResult, undefined);
  assert.equal(saved.customAttributes[0].value, 'Custom value');
  await page.getByTitle('编辑完整资料').first().click();
  await page.getByLabel('商品名称', { exact: true }).fill('Discarded title');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并返回', exact: true }).click();
  assert.equal(store.read().products[0].title, saved.title);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: root, verified: ['nine-tabs-desktop-mobile', 'unsaved-reference-preview', 'atomic-save-and-recovery', 'commercial-data-preserved', 'delivery-tiers', 'cancel-discards'] }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); console.error(JSON.stringify({ root, errors })); throw error; }
finally { await browser.close(); await server.shutdownServer(); }
