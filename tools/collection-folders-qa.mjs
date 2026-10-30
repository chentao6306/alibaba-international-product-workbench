import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';
import { readSellerGroups, applySellerGroup } from '../server/seller-groups.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-folders-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const image = process.env.QA_WORKSPACE_DIR ? JSON.parse(fs.readFileSync(path.join(process.env.QA_WORKSPACE_DIR, 'workspace.json'), 'utf8')).products.flatMap((p) => [p.mainImage, ...(p.mainImages || [])]).find((url) => /^https:\/\/[^/]*alicdn\.com\/kf\/.*\.(?:jpg|png)/i.test(url)) || '' : '';
ShopCollector.prototype.collectLinks = async (links, progress) => {
  const product = { sourceId: links[0].sourceId, sourceUrl: links[0].url, sourcePlatform: links[0].platform, title: 'QA Original Product', price: 12, currencySymbol: '$', stock: 100, mainImage: image, mainImages: image ? [image] : [], categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'] };
  progress({ key: `${links[0].platform}:${links[0].sourceId}`, current: 1, total: 1, product });
  return [product];
};
SellerPublisher.prototype.listSellerGroups = async () => [{ id: '100', name: '配件', path: '航模 > 配件' }, { id: '200', name: '手机', path: '手机' }];
const server = await import('../server/index.js');
const listener = await server.serverReady;
const url = `http://127.0.0.1:${listener.address().port}`;
const browser = await chromium.launch({ executablePath: path.resolve('vendor/chromium/chrome.exe'), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
const nav = (label) => page.locator('.sidebar nav button').filter({ hasText: label }).click();
const getState = async () => (await fetch(url + '/api/state')).json();
async function newFolder(name) {
  await page.getByTitle('新建采集分组', { exact: true }).click();
  await page.getByLabel('分组名称', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
try {
  await page.goto(url);
  await nav('单个商品采集');
  await page.getByLabel('采集链接').fill('https://www.alibaba.com/product-detail/Original_1601637470777.html');
  assert.equal(await page.getByRole('button', { name: '开始采集', exact: true }).isDisabled(), true);
  await newFolder('航模配件');
  const a = (await getState()).collectionFolders[0].id;
  await page.getByRole('button', { name: '开始采集', exact: true }).click();
  await page.getByText('采集完成，成功 1 件，失败 0 件', { exact: true }).waitFor();
  await newFolder('手机新品');
  const b = (await getState()).collectionFolders[1].id;
  await nav('商品工作台');
  await page.getByText('当前分组暂无匹配商品', { exact: true }).waitFor();
  await page.getByLabel('采集分组', { exact: true }).selectOption(a);
  await page.locator('.product-table tbody tr').first().waitFor();
  if (image) await page.locator('.product-table img').first().evaluate((node) => new Promise((resolve, reject) => { if (node.complete) return node.naturalWidth ? resolve() : reject(new Error('Product image did not load')); node.onload = resolve; node.onerror = () => reject(new Error('Product image did not load')); }));
  assert.equal(await page.locator('.product-table tbody tr').count(), 1);
  await page.getByRole('button', { name: '全选当前结果 1', exact: true }).click();
  await page.getByRole('button', { name: '选中商品上架 1', exact: true }).waitFor();
  await page.getByRole('button', { name: '选中商品上架 1', exact: true }).click();
  await page.getByTitle('读取国际站分组', { exact: true }).click();
  await page.locator('#seller-group option[value="100"]').waitFor({ state: 'attached' });
  await page.locator('#seller-group').selectOption('100');
  assert.equal(await page.getByLabel('销售方式', { exact: true }).inputValue(), 'auto');
  await page.getByLabel('销售方式', { exact: true }).selectOption('complete-logistics');
  await page.getByText('完整物流会检查包装、物流属性和运费设置；全部留空也不能视为完整。资料不足可改选自动判断，保留已有包装资料。', { exact: true }).waitFor();
  await page.getByLabel('销售方式', { exact: true }).selectOption('auto');
  await page.screenshot({ path: path.join(root, 'publish-desktop.png'), fullPage: true });
  let payload;
  await page.route('**/api/publish', async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }); });
  await page.getByRole('button', { name: '开始处理 1 件', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('批量上架任务已开始', { exact: true }).waitFor();
  assert.equal(payload.collectionFolderId, a);
  assert.equal(payload.sellerGroup.id, '100');
  assert.equal(payload.ids.length, 1);
  assert.equal(payload.listingMode, 'auto');
  // Exercise an upgraded/paused job through the UI, not only a new job.
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'));
  saved.jobs.unshift({ id: 'qa-paused', type: 'publish', status: 'paused', progress: 1, total: 2,
    metadata: { mode: 'submit', listingMode: 'complete-logistics', productIds: payload.ids, collectionFolderId: a },
    results: { finished: { status: 'published' } }, message: 'QA paused' });
  fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify(saved));
  await page.reload();
  await nav('上架任务');
  await page.getByRole('button', { name: '继续处理剩余 1 件', exact: true }).waitFor();
  assert.equal(await page.getByLabel('销售方式', { exact: true }).inputValue(), 'complete-logistics');
  await page.getByLabel('销售方式', { exact: true }).selectOption('auto');
  let resumePayload;
  await page.route('**/api/jobs/qa-paused/resume', async (route) => { resumePayload = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await page.getByRole('button', { name: '继续处理剩余 1 件', exact: true }).click();
  await page.getByText('任务已继续执行', { exact: true }).waitFor();
  assert.equal(resumePayload.listingMode, 'auto');
  saved.jobs = saved.jobs.filter((job) => job.id !== 'qa-paused');
  fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify(saved));
  await page.getByLabel('采集分组', { exact: true }).selectOption(b);
  await page.getByText('上架队列为空', { exact: true }).waitFor();
  await page.getByLabel('采集分组', { exact: true }).selectOption(a);
  await nav('商品工作台');
  await page.getByLabel('移动到分组', { exact: true }).selectOption(b);
  await page.getByTitle('移动已选商品', { exact: true }).click();
  await page.getByText('当前分组暂无匹配商品', { exact: true }).waitFor();
  await page.getByLabel('采集分组', { exact: true }).selectOption(b);
  await page.locator('.product-table tbody tr').first().waitFor();
  assert.equal(await page.locator('.product-table tbody input[type="checkbox"]').first().isChecked(), false);
  await page.screenshot({ path: path.join(root, 'products-desktop.png'), fullPage: true });
  await page.getByLabel('采集分组', { exact: true }).selectOption(a);
  await page.getByTitle('删除空分组', { exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.collection-folder-bar option').length === 2);
  await nav('设置');
  assert.equal(await page.getByLabel('来源未公开库存时', { exact: true }).inputValue(), 'minimum-order');
  await page.getByLabel('来源未公开库存时', { exact: true }).selectOption('fixed');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await page.getByText('默认规则已保存', { exact: true }).waitFor();
  assert.equal((await getState()).settings.stockPolicy, 'fixed');
  await page.getByLabel('来源未公开库存时', { exact: true }).selectOption('minimum-order');
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PATCH' && response.ok()),
    page.getByRole('button', { name: '保存规则', exact: true }).click(),
  ]);
  assert.equal((await getState()).settings.stockPolicy, 'minimum-order');
  await page.screenshot({ path: path.join(root, 'inventory-settings.png'), fullPage: true });
  await nav('商品工作台');
  for (const width of [1280, 430]) {
    await page.setViewportSize({ width, height: 932 });
    await page.screenshot({ path: path.join(root, `products-${width}.png`), fullPage: true, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  // Match the live Alibaba tree structure, including nested duplicate labels.
  const treePage = await browser.newPage();
  await treePage.setContent(`<div id="struct-productGroup"><button class="product-group-select" aria-expanded="false">请选择分组</button></div><div class="posting-field-group" style="display:none"><ul role="tree"><li class="next-tree-node" value="10"><div role="treeitem" aria-label="Parent" aria-expanded="false"><span class="next-tree-switcher">+</span><div class="next-tree-node-label">Parent</div></div><ul style="display:none"><li class="next-tree-node" value="11"><div role="treeitem" aria-label="Same" aria-selected="false" aria-expanded="false"><span class="next-tree-switcher next-noop-noline"></span><div class="next-tree-node-label">Same</div></div></li></ul></li><li class="next-tree-node" value="20"><div role="treeitem" aria-label="Same" aria-selected="false" aria-expanded="false"><span class="next-tree-switcher next-noop-noline"></span><div class="next-tree-node-label">Same</div></div></li></ul></div><script>const control=document.querySelector('button'), popup=document.querySelector('.posting-field-group');control.onclick=()=>{control.setAttribute('aria-expanded','true');popup.style.display='block';};document.addEventListener('keydown',e=>{if(e.key==='Escape'){popup.style.display='none';control.setAttribute('aria-expanded','false');}});document.querySelectorAll('.next-tree-switcher:not(.next-noop-noline)').forEach(n=>n.onclick=()=>{n.parentNode.setAttribute('aria-expanded','true');n.parentNode.nextElementSibling.style.display='block';});document.querySelectorAll('.next-tree-node-label').forEach(n=>n.onclick=()=>{document.querySelectorAll('[role=treeitem]').forEach(t=>t.setAttribute('aria-selected','false'));n.parentNode.setAttribute('aria-selected','true');popup.style.display='none';control.setAttribute('aria-expanded','false');});</script>`);
  const groups = await readSellerGroups(treePage);
  assert.deepEqual(groups.map((g) => g.path), ['Parent', 'Parent > Same', 'Same']);
  assert.equal((await applySellerGroup(treePage, groups[1])).id, '11');
  await assert.rejects(applySellerGroup(treePage, { id: '999', name: 'Removed' }), /不存在/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: root }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ root, errors, text: await page.locator('body').innerText() }));
  throw error;
} finally { await browser.close(); await server.shutdownServer(); }
