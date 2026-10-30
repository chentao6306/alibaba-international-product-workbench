import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

test('keeps shop collection platforms independent of product and publish filters', { timeout: 120000 }, async (t) => {
  // Exercise the real React menu with synthetic API data; never start a seller
  // session, collect public pages, or read the customer's workspace.
  const state = {
    revision: 'navigation-fixture',
    shops: [
      { id: 'alibaba', name: '国际站测试店铺', url: 'https://fixture.en.alibaba.com/', sourcePlatform: 'alibaba.com' },
      { id: 'legacy', name: '国际站旧版店铺', url: 'https://legacy.en.alibaba.com/' },
      { id: 'mic', name: '中国制造网测试店铺', url: 'https://fixture.en.made-in-china.com/', sourcePlatform: 'made-in-china' },
    ],
    groups: ['alibaba', 'legacy', 'mic'].map(id => ({ id: `${id}-group`, shopId: id, name: `${id} 商品分组`, status: 'ready' })),
    collectionFolders: [{ id: 'qa', name: '测试采集分组' }],
    products: ['alibaba.com', 'alibaba.com', 'made-in-china', '1688', 'aliexpress'].map((sourcePlatform, index) => ({
      id: `product-${index}`, title: `${sourcePlatform} 测试商品 ${index}`, sourcePlatform, collectionFolderId: 'qa', status: 'ready', price: 12,
    })),
    jobs: [
      // Older international shop tasks did not store sourcePlatform.
      { id: 'alibaba-job', type: 'collect', status: 'running', metadata: { collectionFolderId: 'qa', groupName: '国际站测试任务' } },
      { id: 'mic-job', type: 'collect', status: 'running', metadata: { collectionFolderId: 'qa', sourcePlatform: 'made-in-china', groupName: '中国制造网测试任务' } },
      { id: 'other-folder-job', type: 'collect', status: 'running', metadata: { collectionFolderId: 'other', sourcePlatform: 'alibaba.com', groupName: '其他采集分组任务' } },
    ],
    settings: { activeCollectionFolderId: 'qa' }, browser: {}, collectorBrowser: {},
  };
  const bundle = await build({ entryPoints: ['src/main.jsx'], bundle: true, write: false, outdir: 'navigation-fixture', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  let browser;
  const errors = [];
  const requests = [];
  try {
    const endpoint = 'http://navigation.test';
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--mute-audio'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== endpoint) return route.abort();
      const name = path.basename(url.pathname);
      const file = bundle.outputFiles.find(item => path.basename(item.path) === name);
      if (file) return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: file.text });
      if (name === 'brand.png') return route.fulfill({ contentType: 'image/png', body: fs.readFileSync('public/brand.png') });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>' });
    });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/state') return route.fulfill({ json: state });
      if (url.pathname === '/api/announcements') return route.fulfill({ json: [] });
      const body = request.postDataJSON();
      requests.push({ path: url.pathname, body });
      if (url.pathname === '/api/shops/read-groups') return route.fulfill({ json: { shop: state.shops.find(shop => shop.url === body.url) } });
      if (/^\/api\/groups\/[^/]+\/collect$/.test(url.pathname)) return route.fulfill({ json: {} });
      if (url.pathname === '/api/publish/plan') return route.fulfill({ json: { groups: [], unresolved: [] } });
      errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
    });
    const nav = label => page.locator('.sidebar nav button').filter({ hasText: label }).click();
    async function checkShops(mic = false) {
      const label = mic ? '中国制造网' : '国际站';
      await page.locator('.collection-folder-bar option[value="qa"]').waitFor({ state: 'attached' });
      await page.getByRole('heading', { level: 1, name: mic ? '中国制造网采集' : '店铺采集', exact: true }).waitFor();
      await page.getByLabel(`${label}同行店铺链接`, { exact: true }).waitFor();
      assert.deepEqual(await page.locator('.shop-info strong').allTextContents(), mic ? ['中国制造网测试店铺'] : ['国际站测试店铺', '国际站旧版店铺']);
      assert.deepEqual(await page.locator('.metrics strong').allTextContents(), mic ? ['1', '1', '1'] : ['2', '2', '2']);
      assert.equal(await page.locator('.collection-current-task').innerText(), `${label}测试任务：`);
      assert.equal(await page.getByRole('group', { name: '中国制造网采集方式' }).count(), mic ? 1 : 0);
      assert.equal(await page.getByText('交货地国家', { exact: true }).count(), mic ? 0 : 1);
    }
    async function screenshot(name) {
      if (!process.env.COLLECTION_NAVIGATION_SCREENSHOTS) return;
      fs.mkdirSync(process.env.COLLECTION_NAVIGATION_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.COLLECTION_NAVIGATION_SCREENSHOTS, `${name}.png`), fullPage: true });
    }
    await t.test('initial international entry retains both current and legacy Alibaba shops', async () => {
      await page.goto(endpoint);
      await checkShops();
    });
    await t.test('returning from Made-in-China products does not replace international shop collection', async () => {
      await page.goto(endpoint);
      await nav('中国制造网采集');
      await checkShops(true);
      await page.getByRole('button', { name: '单个商品 / 多链接采集', exact: true }).click();
      await page.getByRole('button', { name: '查看商品', exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: /中国制造网/ }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('.product-table tbody tr').count(), 1);
      await nav('店铺采集');
      await checkShops();
      await screenshot('alibaba-shop');
      await nav('中国制造网采集');
      await checkShops(true);
      await screenshot('made-in-china-shop');
      await nav('商品工作台');
      assert.equal(await page.getByRole('tab', { name: /中国制造网/ }).getAttribute('aria-selected'), 'true');
    });
    await t.test('all platform filters preserve the distinct menus, shops, groups and task summaries', async () => {
      await page.goto(endpoint);
      for (const name of ['全部平台', '阿里巴巴国际站', '1688', '速卖通', '中国制造网']) {
        await nav('商品工作台');
        await page.getByRole('tab', { name: new RegExp(name) }).click();
        await nav('店铺采集');
        await checkShops();
        await nav('中国制造网采集');
        await checkShops(true);
        await nav('上架任务');
        assert.equal(await page.getByRole('tab', { name: new RegExp(name) }).getAttribute('aria-selected'), 'true');
        await page.getByRole('tab', { name: /1688/ }).click();
        await nav('店铺采集');
        await checkShops();
      }
    });
    await t.test('read and collect actions only target shops belonging to the selected menu', async () => {
      await page.goto(endpoint);
      for (const mic of [true, false]) {
        await nav(mic ? '中国制造网采集' : '店铺采集');
        await checkShops(mic);
        const shop = state.shops.find(item => item.id === (mic ? 'mic' : 'alibaba'));
        await page.getByLabel(`${mic ? '中国制造网' : '国际站'}同行店铺链接`, { exact: true }).fill(shop.url);
        await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/shops/read-groups')),
          page.getByRole('button', { name: '读取分组', exact: true }).click(),
        ]);
        assert.deepEqual(requests.findLast(item => item.path === '/api/shops/read-groups').body, { url: shop.url, platform: shop.sourcePlatform });
        await page.locator('.group-row').getByText(`${shop.id} 商品分组`, { exact: true }).waitFor();
        const start = requests.length;
        await page.getByRole('button', { name: '采集全部分组', exact: true }).click();
        await page.getByText(`已开始读取 ${mic ? 1 : 2} 个分组`, { exact: true }).waitFor();
        assert.deepEqual(requests.slice(start).map(item => item.path), (mic ? ['mic'] : ['alibaba', 'legacy']).map(id => `/api/groups/${id}-group/collect`));
        assert.ok(requests.slice(start).every(item => item.body.collectionFolderId === 'qa'));
      }
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
  }
});
