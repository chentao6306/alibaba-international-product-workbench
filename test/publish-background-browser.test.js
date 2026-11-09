import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { findChromium, hidePage, revealPage, waitForHumanVerification } from '../server/browser-runtime.js';

async function assertBackgroundPage(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const version = await session.send('Browser.getVersion');
    assert.match(version.userAgent, /HeadlessChrome\//, 'Publishing must use Chromium without a native window');
  } finally { await session.detach(); }
  assert.deepEqual(page.viewportSize(), { width: 1280, height: 900 });
  assert.equal(await revealPage(page), false);
  assert.equal(await hidePage(page), true);
  assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 1280, height: 900 });
}

test('background publishing fills forms and preserves its hidden session across verification, reuse and page recreation', { skip: !findChromium(), timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'background-publish-'));
  const previousBridge = globalThis.__KUA_YIPU_SELLER_BRIDGE;
  let sellerWindowOpened = 0;
  let verificationWindowOpened = 0;
  globalThis.__KUA_YIPU_SELLER_BRIDGE = {
    sync: async () => true,
    open: async () => { sellerWindowOpened++; return { visible: true }; },
    humanVerification: async () => { verificationWindowOpened++; },
  };
  const publisher = new SellerPublisher(root);
  try {
    const page = await publisher.currentSellerPage('', { skipNavigation: true, backgroundPublishing: true });
    const context = page.context();
    await assertBackgroundPage(page);
    assert.equal(publisher.visible, false);
    assert.equal(publisher.publishingVisible, false);
    await page.setContent('<div style="height:1800px"></div><label>Product title<input name="productTitle"></label>');
    await page.getByLabel('Product title').fill('Background product');
    assert.equal(await page.getByLabel('Product title').inputValue(), 'Background product');
    assert.ok(await page.evaluate(() => scrollY > 0), 'A normal viewport must still allow scrolling and filling');
    await page.route('https://www.alibaba.com/background-fixture', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: '<div class="nc-container">请拖动下方滑块完成验证</div>',
    }));
    await page.goto('https://www.alibaba.com/background-fixture');
    await assert.rejects(waitForHumanVerification(page), (error) => error.code === 'HUMAN_VERIFICATION_REQUIRED' && /进度已保留/.test(error.message));
    assert.equal(sellerWindowOpened, 0);
    assert.equal(verificationWindowOpened, 0);
    assert.equal(page.isClosed(), false);
    assert.equal(publisher.context, context);
    await page.setContent('<input name="productTitle" value="Verified product">');
    assert.equal(await waitForHumanVerification(page), false);
    assert.equal(await publisher.currentSellerPage('', { skipNavigation: true, backgroundPublishing: true }), page);
    await assertBackgroundPage(page);
    await page.close();
    const reopened = await publisher.currentSellerPage('', { skipNavigation: true, backgroundPublishing: true });
    assert.equal(reopened.isClosed(), false);
    await assertBackgroundPage(reopened);
    assert.equal(publisher.visible, false);
    assert.equal(sellerWindowOpened, 0);
    // The explicit seller action remains available without exposing the
    // separate publishing session or interrupting its current page.
    assert.deepEqual(await publisher.open({ reveal: true }), { visible: true });
    assert.equal(sellerWindowOpened, 1);
    assert.equal(publisher.page, reopened);
    await assertBackgroundPage(reopened);
  } finally {
    await publisher.shutdown();
    globalThis.__KUA_YIPU_SELLER_BRIDGE = previousBridge;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the draft publishing entry stays in the background when seller login expires', { skip: !findChromium(), timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'background-draft-'));
  const previousBridge = globalThis.__KUA_YIPU_SELLER_BRIDGE;
  let sellerWindowOpened = 0;
  globalThis.__KUA_YIPU_SELLER_BRIDGE = { sync: async () => true, open: async () => { sellerWindowOpened++; } };
  const publisher = new SellerPublisher(root);
  const currentSellerPage = publisher.currentSellerPage.bind(publisher);
  publisher.currentSellerPage = async (...args) => {
    const page = await currentSellerPage(...args);
    // Publishing creates a fresh page in the same session for each product.
    // Route the session so the new page never reaches a real seller endpoint.
    await page.context().route('**/*', (route) => route.request().url().startsWith('https://post.alibaba.com/')
      // A browser navigation is a new routed request. A fulfilled HTTP 302
      // can follow its redirect outside Playwright routing and hit Alibaba.
      ? route.fulfill({ contentType: 'text/html', body: '<script>location.replace("https://login.alibaba.com/login.htm")</script>' })
      : route.fulfill({ contentType: 'text/html', body: '<main>Seller login required</main>' }));
    return page;
  };
  try {
    await assert.rejects(publisher.publishPreparedProduct({ title: 'Draft fixture', categoryId: '201346401' },
      'https://post.alibaba.com/product/publish.htm?catId=201346401', 'draft', 'Drones Accessories', '', () => {}, {}),
    (error) => error.code === 'LOGIN_REQUIRED');
    assert.equal(sellerWindowOpened, 0);
    assert.equal(publisher.visible, false);
    assert.equal(publisher.page.isClosed(), false);
    await assertBackgroundPage(publisher.page);
  } finally {
    await publisher.shutdown();
    globalThis.__KUA_YIPU_SELLER_BRIDGE = previousBridge;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
