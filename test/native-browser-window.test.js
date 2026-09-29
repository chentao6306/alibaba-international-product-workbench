import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChromium, launchPersistent, hidePage, revealPage } from '../server/browser-runtime.js';
import { nativeBrowserWindows } from '../server/native-browser-window.js';

test('hides only owned native windows, retaining the verified session and working viewport', {
  skip: process.platform !== 'win32' || !findChromium(), timeout: 90000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-browser-'));
  let context, other;
  try {
    context = await launchPersistent(path.join(root, 'verified'), { headless: false });
    other = await launchPersistent(path.join(root, 'other'), { headless: false });
    // The fallback retains Chromium's initial blank tab and opens a separate
    // verification tab; closing the sole native tab would terminate Chromium.
    const page = await context.newPage();
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
    await hidePage(page);
    assert.equal((await nativeBrowserWindows(context, 'inspect')).visible, 0);
    await page.close();
    const next = await context.newPage();
    await hidePage(next);
    await next.goto('https://www.alibaba.com/window-fixture');
    await next.getByLabel('Title').fill('Next collected product');
    assert.equal(await next.evaluate(() => localStorage.getItem('qa_verified')), 'yes');
    assert.equal((await nativeBrowserWindows(context, 'inspect')).visible, 0);
  } finally {
    await context?.close().catch(() => {}); await other?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
