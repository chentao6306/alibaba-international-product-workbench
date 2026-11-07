import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { ShopCollector } from '../server/collector.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-search-controls-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const calls = [], checks = [];
let finish = false;
ShopCollector.prototype.collectSearch = async (link, progress, options) => {
  calls.push({ link, options: { ...options } });
  progress({ stage: 'listing', page: options.startPage, found: 2 });
  while (!finish) {
    if (options.shouldStop()) throw Object.assign(new Error('已暂停采集'), { code: 'COLLECT_PAUSED' });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const products = [1, 2].map((i) => ({ sourceId: `160100000000${i}`, sourcePlatform: 'alibaba.com', title: `Image result ${i}`, price: 12, currencySymbol: '$', mainImages: [`https://example.test/${i}.jpg`] }));
  for (const [i, product] of products.entries()) progress({ stage: 'detail', key: `alibaba.com:${product.sourceId}`, current: i + 1, total: 2, product });
  return products;
};
const server = await import('../server/index.js');
const listener = await server.serverReady;
const base = `http://127.0.0.1:${listener.address().port}`;
const state = async () => fetch(base + '/api/state').then((response) => response.json());
const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
const nav = (name) => page.locator('.sidebar nav button').filter({ hasText: name }).click();
const start = () => page.getByRole('button', { name: '开始采集', exact: true });
const link = 'https://www.alibaba.com/search/page?SearchScene=imageTextSearch&imagePath=https%3A%2F%2Fexample.test%2Fphoto.jpg&tab=all';
try {
  await page.goto(base); await nav('以图搜品采集');
  await page.getByLabel('采集链接').fill(link);
  assert.equal(await start().isDisabled(), true); checks.push('没有采集分组时不能启动');
  const a = await (await post('/api/collection-folders', { name: '原分组' })).json();
  const b = await (await post('/api/collection-folders', { name: '切换分组' })).json();
  await page.reload(); await nav('以图搜品采集');
  await page.getByLabel('采集分组', { exact: true }).selectOption(a.id);
  assert.equal(await start().isDisabled(), true); checks.push('空链接时不能启动');
  await page.getByLabel('采集链接').fill('https://attacker.example/search/page?imagePath=x'); await start().click();
  await page.getByText('链接与当前采集平台不一致', { exact: true }).waitFor();
  assert.equal((await state()).jobs.length, 0); checks.push('拒绝非平台结果链接且不创建任务');
  await page.getByLabel('采集链接').fill(link);
  await page.getByLabel('起始页', { exact: true }).fill('2'); await page.getByLabel('结束页', { exact: true }).fill('1'); await start().click();
  await page.getByText('结束页不能小于起始页', { exact: true }).waitFor(); checks.push('结束页早于起始页时显示原因');
  await page.getByLabel('结束页', { exact: true }).fill('3');
  for (const [label, value] of [['起始页', '0'], ['结束页', '101'], ['商品上限', '1001'], ['采集间隔（秒）', '-1']]) {
    const input = page.getByLabel(label, { exact: true }); const before = await input.inputValue();
    await input.fill(value); assert.equal(await input.evaluate((node) => node.checkValidity()), false); await input.fill(before); checks.push(`数值边界：${label}`);
  }
  await page.getByLabel('商品上限', { exact: true }).fill('2'); await page.getByLabel('采集间隔（秒）', { exact: true }).fill('0.5');
  await start().click(); await page.getByTitle('暂停任务', { exact: true }).waitFor();
  assert.equal(calls.length, 1); assert.equal(calls[0].link.url, link);
  assert.deepEqual(['startPage', 'endPage', 'maxProducts', 'delaySeconds'].map((key) => calls[0].options[key]), [2, 3, 2, 0.5]);
  checks.push('完整图片参数、页码、上限、小数间隔传入任务');
  const job = (await state()).jobs[0];
  const duplicate = await post('/api/collect/links', { urls: link, platform: 'alibaba.com', method: 'image-search', collectionFolderId: a.id });
  assert.equal(duplicate.status, 409); assert.equal(await page.getByRole('button', { name: '采集任务未完成', exact: true }).isDisabled(), true); checks.push('运行期间界面与接口均阻止重复任务');
  await page.getByTitle('暂停任务', { exact: true }).click(); await page.getByTitle('继续任务', { exact: true }).waitFor(); checks.push('暂停后显示继续和取消入口');
  await page.getByLabel('采集分组', { exact: true }).selectOption(b.id);
  await page.getByText('暂无任务', { exact: true }).waitFor();
  assert.equal(await page.getByTitle('继续任务', { exact: true }).count(), 0); checks.push('切换分组不展示其他分组任务');
  await page.getByLabel('采集分组', { exact: true }).selectOption(a.id); finish = true;
  await page.getByTitle('继续任务', { exact: true }).click();
  await page.getByText('采集完成，成功 2 件，失败 0 件', { exact: true }).waitFor();
  const after = await state(); assert.equal(calls.length, 2); assert.equal(after.products.length, 2);
  assert.ok(after.products.every((product) => product.collectionFolderId === a.id)); checks.push('继续原任务、两个结果入原分组、没有重复商品');
  await page.getByRole('button', { name: '查看商品', exact: true }).click(); await page.locator('.product-table tbody tr').first().waitFor();
  assert.equal(await page.locator('.product-table tbody tr').count(), 2); checks.push('查看商品跳转工作台并保持平台和分组');
  await nav('以图搜品采集'); await page.getByLabel('采集链接').fill(link); finish = false; await start().click();
  await page.getByTitle('暂停任务', { exact: true }).first().click(); await page.getByTitle('取消任务', { exact: true }).click();
  await page.getByText('任务已取消，已完成数据会保留', { exact: true }).waitFor();
  assert.equal((await state()).products.length, 2); assert.equal((await state()).jobs.filter((item) => item.status === 'cancelled').length, 1); checks.push('取消未完成任务不删除先前入库商品');
  await nav('单个商品采集'); assert.equal(await page.getByLabel('起始页', { exact: true }).count(), 0);
  await nav('店铺采集'); await page.getByRole('heading', { name: '读取国际站同行店铺', exact: true }).waitFor();
  await nav('中国制造网采集'); await page.getByRole('heading', { name: '读取中国制造网同行店铺', exact: true }).waitFor();
  checks.push('以图、单品、国际站店铺和中国制造网入口保持各自功能');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'checks.json'), JSON.stringify({ ok: true, checks }, null, 2));
  console.log(JSON.stringify({ ok: true, root, checks: checks.length }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png') }); console.error(JSON.stringify({ root, checks, error: error.message })); throw error; }
finally { finish = true; await browser.close(); await server.shutdownServer(); }
