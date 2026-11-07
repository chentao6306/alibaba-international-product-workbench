import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChromium, launchPersistent, hidePage, revealPage } from '../server/browser-runtime.js';
import { nativeBrowserWindows } from '../server/native-browser-window.js';

test('hides only owned native windows, retaining the verified session and working viewport', {
  skip: process.platform !== 'win32' || !findChromium(), timeout: 120000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-browser-'));
  let context, other;
  try {
    context = await launchPersistent(path.join(root, 'verified'), { headless: false, args: ['--enable-automation'] });
    const commandSession = await context.newCDPSession(context.pages()[0]);
    assert.ok((await commandSession.send('Browser.getBrowserCommandLine')).arguments.includes('--mute-audio'));
    await commandSession.detach();
    other = await launchPersistent(path.join(root, 'other'), { headless: false });
    // The fallback retains Chromium's initial blank tab and opens a separate
    // verification tab; closing the sole native tab would terminate Chromium.
    const page = await context.newPage();
    assert.equal((await nativeBrowserWindows(context, 'inspect')).visible, 0, 'New fallback pages must be hidden before navigation');
    await context.route('https://www.alibaba.com/window-fixture', route => route.fulfill({
      contentType: 'text/html', body: '<h1>Verified page</h1><div style="height:1500px"></div><input aria-label="Title"><button onclick="document.title=\'clicked\'">Continue</button>',
    }));
    await page.goto('https://www.alibaba.com/window-fixture');
    await context.addCookies([{ name: 'qa_verified', value: 'yes', url: 'https://www.alibaba.com/' }]);
    await page.evaluate(() => localStorage.setItem('qa_verified', 'yes'));
    const otherBefore = await nativeBrowserWindows(other, 'inspect');
    assert.ok(otherBefore.count > 0);
    assert.equal(await hidePage(page), true);
    const hidden = await nativeBrowserWindows(context, 'inspect');
    assert.ok(hidden.count > 0); assert.equal(hidden.visible, 0);
    assert.deepEqual(await nativeBrowserWindows(other, 'inspect'), otherBefore);
    await page.getByLabel('Title').fill('Still collecting');
    await page.getByRole('button', { name: 'Continue' }).click();
    assert.equal(await page.title(), 'clicked');
    assert.equal((await nativeBrowserWindows(context, 'inspect')).visible, 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('qa_verified')), 'yes');
    assert.equal((await context.cookies()).find(c => c.name === 'qa_verified').value, 'yes');
    assert.ok((await page.evaluate(() => innerWidth)) > 500);
    assert.equal(await revealPage(page), true);
    assert.ok((await nativeBrowserWindows(context, 'inspect')).visible > 0);
    const humanPopup = await context.newPage();
    assert.ok((await nativeBrowserWindows(context, 'inspect')).visible > 0, 'New pages must not conceal active human verification');
    await humanPopup.close();
    await hidePage(page);
    assert.equal((await nativeBrowserWindows(context, 'inspect')).visible, 0);
    await page.close();
    const next = await context.newPage();
    assert.equal((await nativeBrowserWindows(context, 'inspect')).visible, 0, 'A new collection page inherits background visibility');
    await next.goto('https://www.alibaba.com/window-fixture');
    await next.getByLabel('Title').fill('Next collected product');
    assert.equal(await next.evaluate(() => localStorage.getItem('qa_verified')), 'yes');
    assert.equal((await nativeBrowserWindows(context, 'inspect')).visible, 0);
    const popupPromise = context.waitForEvent('page');
    await next.evaluate(() => window.open('https://www.alibaba.com/window-fixture', '_blank', 'width=600,height=500'));
    const popup = await popupPromise;
    const deadline = Date.now() + 15000;
    let native;
    do {
      native = await nativeBrowserWindows(context, 'inspect');
      if (native?.visible === 0) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    assert.equal(native?.visible, 0, 'Background page popups must also be hidden');
    await popup.close();
    assert.deepEqual(await nativeBrowserWindows(other, 'inspect'), otherBefore);
  } finally {
    await context?.close().catch(() => {}); await other?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
