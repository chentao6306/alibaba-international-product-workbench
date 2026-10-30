import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { browserStep } from '../server/browser-step.js';
import { fillProductKeywords, fillOriginCountry, SellerPublisher } from '../server/publisher.js';

test('keywords survive removal of hidden clones and input replacement without modifying other textareas', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.setContent(`<textarea role="input">Unrelated description</textarea><div class="posting-field-keywords">
      <textarea hidden></textarea><textarea id="keyword"></textarea></div><script>
      document.querySelector('#keyword').oninput=function(){
        document.querySelector('[hidden]').remove();
        const replacement=document.createElement('textarea');replacement.id='keyword';
        this.replaceWith(replacement);
      };</script>`);
    assert.equal(await fillProductKeywords(page, { keywords: ['Smart Watch', 'Earphone Combo'] }), true);
    assert.equal(await page.locator('#keyword').inputValue(), 'Smart Watch\nEarphone Combo');
    assert.equal(await page.locator('[role=input]').inputValue(), 'Unrelated description');
    await page.setContent('<textarea role="input">Keep description</textarea>');
    assert.equal(await fillProductKeywords(page, { keywords: ['Do not insert here'] }), false);
    await page.setContent('<div class="posting-field-keywords" hidden><textarea>Old editor value</textarea></div><div id="textDesc">New description</div>');
    assert.equal(await fillProductKeywords(page, { keywords: ['Hidden fields are not writable'] }), false);
    assert.equal(await page.locator('textarea').inputValue(), 'Old editor value');
    await page.setContent('<div class="posting-field-keywords"><textarea oninput="this.remove()"></textarea></div>');
    // Missing controls are intentional here; do not spend the setup timeout
    // on every retry while verifying the actionable failure.
    page.setDefaultTimeout(300);
    await assert.rejects(fillProductKeywords(page, { keywords: ['Watch'] }), { code: 'PUBLISH_FIELD_NOT_READY' });
  } finally { await browser.close(); }
});

test('commits keywords and selects origin without accepting immediate or delayed keyword recommendations', { skip: !findChromium(), timeout: 45000 }, async (t) => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    for (const delayed of [false, true]) await t.test(`recommendations arrive ${delayed ? 'after keywords commit' : 'immediately'}`, async () => {
      await page.goto('about:blank');
      await page.setContent(`<style>body{margin:0;min-height:100vh}.sell-catProp-item{position:absolute;top:210px;left:100px}
        .posting-field-keywords-overlay{position:fixed;top:150px;left:50px;width:650px;height:350px;background:white;z-index:100}
        .next-menu-item-inner{height:300px}</style>
        <h2>Basic information</h2><div class="posting-field-keywords"><textarea></textarea></div>
        <div class="sell-catProp-item"><label class="label">Place of Origin</label><input readonly role="combobox"></div>
        <div class="next-overlay-wrapper"><ul class="next-menu next-ver next-overlay-inner posting-field-keywords-overlay" role="menu" hidden>
          <li role="menuitem" class="next-menu-item next-menu-group-item"><div class="next-menu-item-inner"><span class="next-menu-item-text">Unrelated recommendation</span></div></li></ul></div>
        <div class="sell-o-select-options" hidden><div class="options-item" role="option">中国</div></div>
        <script>(()=>{
          const field=document.querySelector('textarea'),suggestions=document.querySelector('ul'),origin=document.querySelector('[role=combobox]'),countries=document.querySelector('.sell-o-select-options');
          window.recommended=0;window.selected=0;
          window.showRecommendations=()=>{suggestions.hidden=false};
          field.oninput=()=>{${delayed ? '' : 'window.showRecommendations()'}};
          suggestions.onclick=()=>{window.recommended++;field.value='Unrelated recommendation'};
          document.addEventListener('mousedown',e=>{if(!suggestions.contains(e.target)&&e.target!==field)suggestions.hidden=true});
          origin.onclick=()=>{countries.hidden=false};
          countries.onclick=()=>{window.selected++;origin.value='China';countries.hidden=true};
        })();</script>`);
      const keywords = 'Drone Battery Charger';
      assert.equal(await fillProductKeywords(page, { keywords: [keywords] }), true);
      // Release the delayed response only after keyword commit, independently
      // of CPU load. A fixed timer could fire and be correctly dismissed early.
      if (delayed) {
        await page.evaluate(() => window.showRecommendations());
        await page.locator('.posting-field-keywords-overlay').waitFor({ state: 'visible' });
      }
      else assert.equal(await page.locator('.posting-field-keywords-overlay').isVisible(), false);
      assert.equal(await fillOriginCountry(page, 'China'), true);
      assert.equal(await page.locator('.posting-field-keywords-overlay').isVisible(), false);
      assert.equal(await page.locator('textarea').inputValue(), keywords);
      assert.equal(await page.locator('[role=combobox]').inputValue(), 'China');
      assert.deepEqual(await page.evaluate(() => [window.recommended, window.selected]), [0, 1]);
    });
  } finally { await browser.close(); }
});

test('connection step releases callers on timeout and disposes a browser that arrives late', async () => {
  let finish; let disposed = false;
  const result = browserStep(() => new Promise((resolve) => { finish = resolve; }), {
    timeoutMs: 20, label: 'Starting browser', onLateResolve: (value) => value.close()
  });
  await assert.rejects(result, { code: 'PUBLISH_BROWSER_NOT_READY' });
  finish({ close: () => { disposed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, true);
});

test('pause while connecting prevents a late login synchronization from launching or navigating', async () => {
  const previous = globalThis.__KUA_YIPU_SELLER_BRIDGE;
  let finishSync;
  globalThis.__KUA_YIPU_SELLER_BRIDGE = { sync: () => new Promise((resolve) => { finishSync = resolve; }) };
  const publisher = new SellerPublisher('unused-fixture');
  try {
    const pending = publisher.publishPreparedProduct({}, 'https://post.alibaba.com/product/publish.htm?catId=201346401',
      'draft', '', 'paused-connection', () => {}, {});
    const rejected = assert.rejects(pending, { code: 'PUBLISH_PAUSED' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(publisher.requestPublishStop('paused-connection'), true);
    await rejected;
    finishSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(publisher.context, null);
    assert.equal(publisher.page, null);
  } finally { globalThis.__KUA_YIPU_SELLER_BRIDGE = previous; }
});

test('connection failures are actionable browser errors and cannot enter the product submission stage', async () => {
  const publisher = new SellerPublisher('unused-fixture');
  publisher.open = async () => { throw new Error('Browser connection lost'); };
  await assert.rejects(publisher.currentSellerPage(), (error) => error.code === 'PUBLISH_BROWSER_NOT_READY'
    && error.message.includes('Browser connection lost'));
});

test('a stage cancellation aborts the pending browser connection before the next product starts', async () => {
  const previous = globalThis.__KUA_YIPU_SELLER_BRIDGE;
  let finishSync;
  globalThis.__KUA_YIPU_SELLER_BRIDGE = { sync: () => new Promise((resolve) => { finishSync = resolve; }) };
  const publisher = new SellerPublisher('unused-fixture');
  const controller = new AbortController();
  try {
    const pending = publisher.publishPreparedProduct({}, 'https://post.alibaba.com/product/publish.htm?catId=201346401',
      'draft', '', 'timed-out-connection', () => {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'PUBLISH_PAUSED' });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    finishSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(publisher.context, null);
    assert.equal(publisher.page, null);
  } finally { globalThis.__KUA_YIPU_SELLER_BRIDGE = previous; }
});
