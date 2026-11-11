import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { openBankAdvancedSearch } from '../server/posting-video-bank.js';

test('video picker accepts an expanded search without waiting for its removed button', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button disabled>Advanced Search</button><input id="productId" hidden><script>window.clicks=0;document.querySelector("button").onclick=()=>clicks++;</script>');
    const button = page.getByRole('button', { name: 'Advanced Search' });
    // Hydration can remove the old button after the initial ready check.
    await page.evaluate(() => setTimeout(() => {
      document.querySelector('button').remove();
      document.querySelector('#productId').hidden = false;
    }, 100));
    await openBankAdvancedSearch(page, button, () => page.locator('#productId').isVisible());
    assert.equal(await page.locator('#productId').isVisible(), true);
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});

test('video picker opens search once and verifies an uncertain dispatch without clicking again', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const uncertain of [false, true]) {
      await page.setContent('<button onclick="window.clicks++;document.querySelector(\'#productId\').hidden=false;this.remove()">Advanced Search</button><input id="productId" hidden><script>window.clicks=0;</script>');
      const button = page.getByRole('button', { name: 'Advanced Search' });
      const target = uncertain ? {
        click: async options => {
          await button.click(options);
          if (!options.trial) throw Object.assign(new Error('Timed out after dispatch'), { name: 'TimeoutError' });
        },
      } : button;
      await openBankAdvancedSearch(page, target, () => page.locator('#productId').isVisible());
      assert.equal(await page.evaluate(() => window.clicks), 1);
      // An already expanded destination must not use the now absent button.
      await openBankAdvancedSearch(page, button, () => page.locator('#productId').isVisible());
      assert.equal(await page.evaluate(() => window.clicks), 1);
    }
  } finally { await browser.close(); }
});

test('video picker does not treat a disabled button or unrelated input as an expanded destination', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button disabled onclick="window.clicks++">Advanced Search</button><input id="other"><input id="productId" hidden><script>window.clicks=0;</script>');
    await assert.rejects(openBankAdvancedSearch(page, page.getByRole('button', { name: 'Advanced Search' }),
      () => page.locator('#productId').isVisible(), { timeoutMs: 600 }), { code: 'PUBLISH_CONTROL_NOT_READY' });
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});

test('video picker keeps waiting for a slow undispatched control without reducing its readiness budget', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button disabled onclick="window.clicks++;document.querySelector(\'#productId\').hidden=false">Advanced Search</button><input id="productId" hidden><script>window.clicks=0;setTimeout(()=>document.querySelector("button").disabled=false,7500);</script>');
    await openBankAdvancedSearch(page, page.getByRole('button', { name: 'Advanced Search' }), () => page.locator('#productId').isVisible());
    assert.equal(await page.locator('#productId').isVisible(), true);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally { await browser.close(); }
});

test('video picker never repeats an unconfirmed real expansion click', async () => {
  let trials = 0, writes = 0;
  const button = { click: async options => {
    if (options.trial) { trials++; return; }
    writes++;
    throw new Error('Connection lost after dispatch');
  } };
  await assert.rejects(openBankAdvancedSearch({}, button, async () => false), { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' });
  assert.equal(trials, 1);
  assert.equal(writes, 1);
});
