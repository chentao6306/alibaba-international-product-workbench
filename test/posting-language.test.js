import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { ensureSimplifiedChinese } from '../server/posting-language.js';
import { SellerPublisher } from '../server/publisher.js';

const executablePath = findChromium();
const browserTest = { skip: !executablePath, timeout: 20000 };
const postingUrl = 'https://post.alibaba.com/product/publish.htm?from=common&catId=201346401';
const fixture = (chinese = false, action = 'location.reload()', hover = false) => `<!doctype html><html><body>
  <style>header { display:flex; justify-content:flex-end; height:60px; }
    #menu { position:absolute; right:8px; top:45px; background:white; }</style>
  <header><button id="language" onclick="document.querySelector('#menu').hidden=false"
    ${hover ? `onmouseover="document.querySelector('#menu').hidden=false"` : ''}>${chinese ? '简体中文' : 'English'}</button></header>
  <div id="menu" role="menu" hidden><button role="menuitem" id="traditional">繁體中文</button>
    <button role="menuitem" id="simplified">简体中文</button></div>
  <h2>${chinese ? '基本信息' : 'Basic information'}</h2>
  <label>${chinese ? '商品名称' : 'Product name'}<input name="productTitle"></label>
  <script>window.selections=0;window.wrongLanguage=false;
    document.querySelector('#traditional').onclick=()=>window.wrongLanguage=true;
    document.querySelector('#simplified').onclick=()=>{window.selections=(window.selections||0)+1;${action}};</script>
  </body></html>`;

test('switches a hover language menu to simplified Chinese, follows the reload and preserves the target URL', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    let navigations = 0;
    await page.route('https://post.alibaba.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: fixture(++navigations > 1, 'location.reload()', true) }));
    await page.goto(postingUrl);
    const stages = [];
    assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 5000, onProgress: stage => stages.push(stage) }), { switched: true });
    assert.equal(page.url(), postingUrl);
    assert.equal(navigations, 2);
    assert.equal(await page.locator('#language').innerText(), '简体中文');
    assert.equal(await page.locator('h2').innerText(), '基本信息');
    assert.equal(await page.locator('[name=productTitle]').inputValue(), '');
    assert.ok(stages.some(stage => /继续当前商品/.test(stage)));
    assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 1000 }), { switched: false });
    assert.equal(navigations, 2, 'A Chinese page must not reload on every product');
  } finally { await browser.close(); }
});

test('click menus wait for the translated form even when the language label changes first', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture(false, `document.querySelector('#language').textContent='简体中文';
      document.querySelector('#menu').hidden=true;setTimeout(()=>{
        document.querySelector('h2').textContent='基本信息';
        document.querySelector('label').firstChild.textContent='商品名称';window.translated=true;},700)`));
    assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 5000 }), { switched: true });
    assert.equal(await page.evaluate(() => window.translated), true);
    assert.equal(await page.evaluate(() => window.selections), 1);
    assert.equal(await page.evaluate(() => window.wrongLanguage), false);
  } finally { await browser.close(); }
});

test('Chinese forms leave product language values, hidden menus and existing content untouched', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h2>基本信息</h2><div class="posting-field" style="position:absolute;right:0;top:0">
      <button onclick="window.changed=true">English</button></div><div hidden>English</div>
      <input name="productTitle" value="Original English product title">`);
    assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 1000 }), { switched: false });
    assert.equal(await page.locator('[name=productTitle]').inputValue(), 'Original English product title');
    assert.equal(await page.evaluate(() => window.changed), undefined);
  } finally { await browser.close(); }
});

test('reselects the real Chinese menu option when the header is Chinese but the form is English', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture(false, `document.querySelector('h2').textContent='基本信息';
      document.querySelector('label').firstChild.textContent='商品名称';document.querySelector('#menu').hidden=true;`)
      .replace('>English</button></header>', '>简体中文</button></header>'));
    assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 5000 }), { switched: true });
    assert.equal(await page.evaluate(() => window.selections), 1);
    assert.equal(await page.locator('h2').innerText(), '基本信息');
  } finally { await browser.close(); }
});

test('reloads a stale translated header once before product entry while preserving the category URL', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    let navigations = 0;
    await page.route('https://post.alibaba.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: ++navigations === 1 ? fixture(false, '').replace('>English</button></header>', '>简体中文</button></header>') : fixture(true) }));
    await page.goto(postingUrl);
    assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 9000, reloadOnMismatch: true }), { switched: true });
    assert.equal(navigations, 2);
    assert.equal(page.url(), postingUrl);
    assert.equal(await page.locator('h2').innerText(), '基本信息');
  } finally { await browser.close(); }
});

test('selects Alibaba native language links inside the header without treating them as the current language', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const label of ['English', '简体中文']) {
      await page.setContent(`<header style="display:flex;justify-content:flex-end;height:60px">
        <a class="ui-header-lan-display" onmouseover="document.querySelector('ul').hidden=false">
          <span class="ui-header-lan-display-text">${label}</span></a>
        <ul hidden style="position:absolute;right:8px;top:40px">
          <li><a data-role="item" rel="en_US" href="javascript:void(0)">English</a></li>
          <li><a data-role="item" rel="zh_CN" href="javascript:void(0)" onclick="
            window.selections=(window.selections||0)+1;
            document.querySelector('.ui-header-lan-display-text').textContent='简体中文';
            document.querySelector('h2').textContent='基本信息';">简体中文</a></li>
        </ul></header><h2>Basic information</h2>`);
      assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 5000 }), { switched: true });
      assert.equal(await page.evaluate(() => window.selections), 1);
      assert.equal(await page.locator('h2').innerText(), '基本信息');
      assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 1000 }), { switched: false });
      await page.evaluate(() => { window.selections = 0; });
    }
  } finally { await browser.close(); }
});

test('failed switches pause explicitly instead of accepting the menu text as a translated page', { ...browserTest, timeout: 45000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const action of ['', `document.querySelector('#language').textContent='简体中文'`]) {
      await page.setContent(fixture(false, action));
      await assert.rejects(ensureSimplifiedChinese(page, { timeoutMs: 4000 }), { code: 'PUBLISH_LANGUAGE_NOT_READY' });
      assert.equal(await page.locator('h2').innerText(), 'Basic information');
      assert.equal(await page.evaluate(() => window.selections), 1);
    }
    await page.setContent('<header><button>English</button></header><h2>Basic information</h2>');
    await assert.rejects(ensureSimplifiedChinese(page, { timeoutMs: 1200 }), { code: 'PUBLISH_LANGUAGE_NOT_READY' });
  } finally { await browser.close(); }
});

test('language readiness preserves verification waits, cancellation and expired-login errors', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<h2>Verification fixture</h2>');
    assert.deepEqual(await ensureSimplifiedChinese(page, { timeoutMs: 200, verify: async () => {
      await page.waitForTimeout(350);
      await page.setContent(fixture(true));
    } }), { switched: false });
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(ensureSimplifiedChinese(page, { signal: stop.signal }), { code: 'PUBLISH_PAUSED' });
    await page.route('https://login.alibaba.com/**', route => route.fulfill({ body: '<h2>Login</h2>' }));
    await page.goto('https://login.alibaba.com/');
    await assert.rejects(ensureSimplifiedChinese(page), { code: 'LOGIN_REQUIRED' });
  } finally { await browser.close(); }
});

test('publishing switches language before writing any product fields or entering the description editor', browserTest, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    let navigations = 0;
    await page.route('https://post.alibaba.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: fixture(++navigations > 1) }));
    const publisher = new SellerPublisher('unused-language-fixture');
    const product = { title: 'Original product', categoryId: '201346401' };
    const reachedDescription = new Error('Stop before saving any product');
    publisher.currentSellerPage = async () => page;
    publisher.fillLegacyDescription = async (_page, received) => {
      assert.equal(received, product);
      assert.equal(page.url(), postingUrl);
      assert.equal(await page.locator('h2').innerText(), '基本信息');
      assert.equal(await page.locator('[name=productTitle]').inputValue(), '');
      throw reachedDescription;
    };
    await assert.rejects(publisher.publishPreparedProduct(product, postingUrl, 'draft', '', '', () => {}, {}), error => error === reachedDescription);
    assert.equal(navigations, 2);
  } finally { await browser.close(); }
});
