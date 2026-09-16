import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { dismissPostingOverlays, waitForActionResult } from '../server/publisher.js';

// Alibaba's TinyMCE table toolbar is labelled as a dialog, although it is
// non-modal and remains mounted far below the submission controls.
const inlineToolbar = `<div class="mce-tinymce mce-tinymce-inline mce-floatpanel"
  role="dialog" aria-label="Inline toolbar" style="position:absolute;top:2000px">
  <div role="toolbar"><button aria-label="Delete table" onclick="document.querySelector('table').remove()">×</button></div>
</div>`;

test('saves a draft with an open TinyMCE inline table toolbar without changing editor content', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<table><tr><td>Original product specifications</td></tr></table>${inlineToolbar}
      <button id="save" onclick="window.saves++;document.querySelector('[role=alert]').textContent='保存成功'">保存草稿</button>
      <div role="alert"></div><script>window.saves=0;window.keys=0;document.onkeydown=()=>window.keys++;</script>`);
    const result = await waitForActionResult(page, page.locator('#save'), 'draft', page.url());
    assert.ok(result.verifiedBy);
    assert.equal(await page.evaluate(() => window.saves), 1);
    assert.equal(await page.evaluate(() => window.keys), 0);
    assert.equal(await page.locator('table').innerText(), 'Original product specifications');
    assert.equal(await page.locator('.mce-tinymce-inline').count(), 1);
  } finally { await browser.close(); }
});

test('still closes real editor dialogs and blocks unknown or modal prompts beside an inline toolbar', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`${inlineToolbar}<div class="mce-window" role="dialog"><button onclick="this.parentElement.remove()">关闭</button></div>`);
    assert.equal(await dismissPostingOverlays(page), true);
    assert.equal(await page.locator('.mce-window').count(), 0);
    assert.equal(await page.locator('.mce-tinymce-inline').count(), 1);

    for (const modal of ['<div role="dialog">', '<div class="mce-tinymce-inline" role="dialog" aria-modal="true"><div role="toolbar"></div>']) {
      await page.setContent(`${inlineToolbar}${modal}<button onclick="window.confirmed=true">确认发布</button></div>`);
      assert.equal(await dismissPostingOverlays(page), false);
      assert.equal(await page.evaluate(() => Boolean(window.confirmed)), false);
    }
    await page.setContent(`${inlineToolbar}<div class="next-overlay-backdrop" style="position:fixed;inset:0"></div>`);
    assert.equal(await dismissPostingOverlays(page), false);
  } finally { await browser.close(); }
});
