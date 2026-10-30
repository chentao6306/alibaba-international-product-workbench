import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium, launchPersistent, waitForHumanVerification } from '../server/browser-runtime.js';
import { inspectVerificationDocument, waitForVerification, verificationOptions, withVerificationContext, verificationUrlAllowed } from '../server/human-verification.js';

test('verification accepts the supported supplier domains and rejects spoofed or credential-bearing destinations', () => {
  for (const host of ['www.alibaba.com', 'detail.1688.com', 'www.aliexpress.com', 'g.alicdn.com', 'supplier.en.made-in-china.com']) assert.equal(verificationUrlAllowed(`https://${host}/verify`), true);
  for (const url of ['https://made-in-china.com.evil.test/verify', 'https://evil-made-in-china.com/verify', 'https://user:secret@supplier.en.made-in-china.com/', 'http://supplier.en.made-in-china.com/', 'https://supplier.en.made-in-china.com:8443/', 'file:///tmp/test']) assert.equal(verificationUrlAllowed(url), false);
});

test('human verification waits beyond days and requires consecutive healthy pages after refresh', async () => {
  let elapsed = 0;
  let reads = 0;
  const messages = [];
  const states = [
    { challenge: true }, { error: true }, {}, { ready: true, url: 'page-a' },
    { error: true }, { ready: true, url: 'page-a' }, { ready: true, url: 'page-b' }, { ready: true, url: 'page-b' }
  ];
  const result = await waitForVerification({
    inspect: async () => states[reads++], sleep: async () => { elapsed += 3 * 86400000; },
    onWaiting: (message) => messages.push(message)
  });
  assert.equal(reads, 8);
  assert.ok(elapsed > 15 * 86400000);
  assert.equal(result.url, 'page-b');
  assert.ok(messages.some((message) => /刷新/.test(message)));
});

test('closing or pausing verification preserves pause semantics and never reports success', async () => {
  for (const closed of [true, false]) {
    let cancelled = false;
    await assert.rejects(waitForVerification({
      inspect: async () => { throw new Error('Navigation destroyed execution context'); },
      sleep: async () => { cancelled = true; },
      shouldStop: () => !closed && cancelled,
      isClosed: () => closed && cancelled,
    }), (error) => error.code === 'COLLECT_PAUSED');
  }
});

test('verification progress and cancellation belong to the calling job only', async () => {
  await Promise.all(['collect', 'publish'].map((job) => withVerificationContext({ job }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(verificationOptions().job, job);
  })));
  assert.deepEqual(verificationOptions(), {});
});

test('pausing the verification window propagates out of a nested page inspection', async () => {
  await assert.rejects(waitForVerification({ inspect: async () => {
    throw Object.assign(new Error('Paused from desktop window'), { code: 'COLLECT_PAUSED' });
  } }), (error) => error.code === 'COLLECT_PAUSED');
});

test('an unresponsive verification renderer still allows cancellation and progress heartbeats', async () => {
  let ticks = 0;
  let heartbeats = 0;
  await assert.rejects(waitForVerification({
    inspect: () => new Promise(() => {}), sleep: async () => { ticks++; },
    shouldStop: () => ticks >= 3, onWaiting: () => { heartbeats++; }
  }), (error) => error.code === 'COLLECT_PAUSED');
  assert.equal(heartbeats, 2);
});

test('verification resumes at the healthy destination and bounds ineffective session handoffs', { skip: !findChromium(), timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-handoff-'));
  const previousBridge = globalThis.__KUA_YIPU_SELLER_BRIDGE;
  const context = await launchPersistent(root, { headless: true });
  try {
    const page = await context.newPage();
    await page.route('https://www.alibaba.com/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      new URL(route.request().url()).pathname === '/product-detail/verified.html'
        ? '<main data-module-name="module_description">Real product</main>'
        : '<div class="nc-container">请拖动下方滑块完成验证</div>' }));
    let calls = 0;
    await context.addCookies([{ name: 'qa-challenge', value: 'current', domain: '.alibaba.com', path: '/' }]);
    globalThis.__KUA_YIPU_SELLER_BRIDGE = { humanVerification: async (_url, options) => {
      calls++;
      assert.ok(options.userAgent);
      assert.ok(options.requestCookies.some((cookie) => cookie.name === 'qa-challenge' && cookie.value === 'current'));
      return { verified: true, url: 'https://www.alibaba.com/product-detail/verified.html' };
    } };
    await page.goto('https://www.alibaba.com/punish');
    assert.equal(await waitForHumanVerification(page, { shouldStop: () => calls >= 3 }), true);
    assert.equal(calls, 1);
    assert.equal(page.url(), 'https://www.alibaba.com/product-detail/verified.html');
    calls = 0;
    globalThis.__KUA_YIPU_SELLER_BRIDGE.humanVerification = async () => { calls++; return true; };
    await page.goto('https://www.alibaba.com/punish');
    await assert.rejects(waitForHumanVerification(page, { shouldStop: () => calls >= 3 }),
      (error) => error.code === 'HUMAN_VERIFICATION_REQUIRED' && /同步/.test(error.message));
    assert.equal(calls, 2, 'Healthy desktop probes must not loop forever when the collector remains blocked');
  } finally {
    globalThis.__KUA_YIPU_SELLER_BRIDGE = previousBridge;
    await context.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('challenge errors, empty refreshes and login pages do not count as verification completion', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    let markup = '';
    await page.route('https://www.alibaba.com/**', (route) => route.fulfill({ contentType: 'text/html', body: markup }));
    await page.route('https://captcha.alibaba.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Verification frame</p>' }));
    for (const [url, html, expected] of [
      ['product-detail/example.html', '<div>亲，请拖动下方滑块完成验证</div>', false],
      ['punish', '<div>请点我重试(error:FrgxUe)</div>', false],
      ['punish', '<body></body>', false],
      ['product-detail/example.html', '<div>ERR_INTERNET_DISCONNECTED</div>', false],
      ['login', `<div>${'Login '.repeat(30)}</div>`, false],
      ['product-detail/example.html', '<div data-module-name="module_description">Real product description</div>', true],
      ['product-detail/example.html', '<div class="captcha" style="display:none">Captcha</div><div data-module-name="module_description">Real product</div>', true],
      ['product-detail/example.html', '<div class="baxia-container" style="height:300px"></div><div data-module-name="module_description">Real product</div>', true],
      ['product-detail/example.html', '<div class="nc-container" style="height:40px"></div><div data-module-name="module_description">Real product</div>', true],
      ['product-detail/example.html', '<main data-module-name="module_description"><div class="challenge-description">Challenging conditions camera</div></main>', true],
      ['product-detail/example.html', '<div style="opacity:0"><div class="nc-container">请拖动下方滑块完成验证</div></div><main data-module-name="module_description">Phone</main>', true],
      ['product-detail/example.html', '<div style="opacity:0"><div class="nc-container">请点我重试(error:FrgxUe)</div></div><main data-module-name="module_description">Phone</main>', true],
      ['product-detail/example.html', '<div style="position:absolute;left:-10000px"><div class="nc-container">请拖动下方滑块完成验证</div></div><main data-module-name="module_description">Phone</main>', true],
      ['product-detail/example.html', '<main data-module-name="module_description">Phone</main><iframe style="width:1px;height:1px;border:0" src="https://captcha.alibaba.com/captcha"></iframe>', true],
      ['product-detail/example.html', '<main data-module-name="module_description">Phone</main><iframe style="width:400px;height:300px" src="https://captcha.alibaba.com/captcha"></iframe>', false],
      ['product-detail/example.html', '<main data-module-name="module_description">Phone</main><div role="dialog"><div class="nc_scale" style="width:300px;height:40px"></div></div>', false],
    ]) {
      markup = html;
      await page.goto(`https://www.alibaba.com/${url}`);
      const state = await page.evaluate(inspectVerificationDocument);
      assert.equal(state.ready, expected, url + html);
      if (expected) {
        assert.equal(state.challenge, false, url + html);
        assert.equal(await waitForHumanVerification(page), false, 'Normal collection must not enter human verification');
      }
    }
  } finally { await browser.close(); }
});
