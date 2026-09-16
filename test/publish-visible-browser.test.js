import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { findChromium, waitForHumanVerification } from '../server/browser-runtime.js';

test('publishing uses its actual maximized browser and keeps it visible after verification and reuse', { skip: !findChromium(), timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visible-publish-'));
  const previousBridge = globalThis.__KUA_YIPU_SELLER_BRIDGE;
  let sellerWindowOpened = 0;
  globalThis.__KUA_YIPU_SELLER_BRIDGE = { sync: async () => true, open: async () => { sellerWindowOpened++; } };
  const publisher = new SellerPublisher(root);
  try {
    const page = await publisher.currentSellerPage('', { skipNavigation: true, showPublishing: true });
    const context = page.context();
    const session = await context.newCDPSession(page);
    const windowState = async () => (await session.send('Browser.getWindowForTarget')).bounds;
    assert.equal((await windowState()).windowState, 'maximized');
    assert.equal(sellerWindowOpened, 0);
    assert.equal(publisher.visible, true);
    await page.route('https://www.alibaba.com/visible-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="nc-container">请拖动下方滑块完成验证</div>' }));
    await page.goto('https://www.alibaba.com/visible-fixture');
    let completed = false;
    const deadline = performance.now() + 8000;
    await waitForHumanVerification(page, { shouldStop: () => performance.now() > deadline, onWaiting: () => {
      if (!completed) { completed = true; void page.setContent('<main data-module-name="module_description">Verified product</main>'); }
    } });
    assert.equal((await windowState()).windowState, 'maximized');
    assert.equal(await publisher.currentSellerPage('', { skipNavigation: true, showPublishing: true }), page);
    assert.equal(publisher.context, context);
    assert.equal((await windowState()).windowState, 'maximized');
    await session.detach();
    await page.close();
    const reopened = await publisher.currentSellerPage('', { skipNavigation: true, showPublishing: true });
    assert.equal(reopened.isClosed(), false);
    assert.equal(publisher.visible, true);
  } finally {
    await publisher.shutdown();
    globalThis.__KUA_YIPU_SELLER_BRIDGE = previousBridge;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
