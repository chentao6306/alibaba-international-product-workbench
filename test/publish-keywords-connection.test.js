import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { browserStep } from '../server/browser-step.js';
import { fillProductKeywords, SellerPublisher } from '../server/publisher.js';

test('keywords survive removal of hidden clones and input replacement without modifying other textareas', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300);
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
    await page.setContent('<div class="posting-field-keywords"><textarea oninput="this.remove()"></textarea></div>');
    await assert.rejects(fillProductKeywords(page, { keywords: ['Watch'] }), { code: 'PUBLISH_FIELD_NOT_READY' });
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
