import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

test('confirmations wait for explicit acceptance, cancel safely, and return keyboard focus', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input aria-label="text"><button id="open">Open</button>');
    const source = fs.readFileSync(new URL('../src/confirm-action.js', import.meta.url), 'utf8');
    await page.addScriptTag({ content: source.replace('export function', 'function') + '\nwindow.confirmAction=confirmAction;' });
    page.on('dialog', () => { throw new Error('Native dialogs must not be used'); });
    await page.evaluate(() => {
      document.querySelector('#open').onclick = async () => { window.result = await window.confirmAction('<img src=x onerror=alert(1)>'); };
    });
    const dialog = page.getByRole('alertdialog'), input = page.getByLabel('text');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    assert.equal(await page.evaluate(() => window.result), undefined);
    assert.equal(await dialog.locator('img').count(), 0, 'product titles are treated as plain text');
    assert.equal(await page.evaluate(() => window.confirmAction('duplicate')), false);
    assert.equal(await dialog.count(), 1);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.result), false);
    assert.equal(await page.locator('#open').evaluate(node => node === document.activeElement), true);
    await input.click(); await page.keyboard.type('after cancel');
    assert.equal(await input.inputValue(), 'after cancel');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    assert.equal(await page.evaluate(() => window.result), true);
    await input.click(); await page.keyboard.press('Control+A'); await page.keyboard.type('after accept');
    assert.equal(await input.inputValue(), 'after accept');
  } finally { await browser.close(); }
});
