import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { userFacingError } from '../server/browser-error.js';
import { recoverRequiredAttributes, setImageUploadFiles } from '../server/publisher.js';

test('fills collected headphone and tablet values in Chinese fields and commits loaded dropdown options', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <div class="sell-catProp-item" id="struct-noise"><div class="label">降噪</div>
        <span class="next-select"><span class="next-select-values"></span><input readonly role="combobox"></span>
      </div>
      <div class="sell-o-select-options" style="display:none">
        <div class="options-search"><input></div>
        <div class="options-item">Active Noise Cancellation (ANC)</div>
        <div class="options-item">Environmental Noise Cancellation (ENC)</div>
      </div>
      <div class="sell-catProp-item" id="struct-water"><div class="label">防水等级</div><input></div>
      <div class="sell-catProp-item" id="struct-resolution"><div class="label">显示分辨率</div><input></div>
      <div class="sell-catProp-item" id="struct-processor"><div class="label">处理器型号</div>
        <select><option value="">Select</option><option>Other</option></select>
      </div>
      <script>
        const trigger = document.querySelector('[role="combobox"]');
        const menu = document.querySelector('.sell-o-select-options');
        trigger.onclick = () => { menu.style.display = 'block'; trigger.setAttribute('aria-expanded', 'true'); };
        document.querySelector('.options-search input').oninput = () => {
          document.querySelectorAll('.options-item').forEach(item => item.remove());
        };
        document.querySelectorAll('.options-item').forEach(item => item.onclick = () => {
          const selected = document.createElement('em'); selected.textContent = item.textContent;
          document.querySelector('.next-select-values').replaceChildren(selected);
          menu.style.display = 'none'; trigger.setAttribute('aria-expanded', 'false');
        });
      </script>
    `);
    const product = { attributes: [
      { name: 'Noise Cancelling', value: 'Environmental Noise Cancellation (ENC)' },
      { name: 'waterproof standard', value: 'IPX-5' },
      { name: 'display resolution', value: '2560X1600' },
      { name: 'processor type', value: 'Other' },
    ] };
    const original = structuredClone(product);
    const fields = ['降噪', '防水等级', '显示分辨率', '处理器型号'];
    assert.deepEqual(await recoverRequiredAttributes(page, product, fields), fields);
    assert.equal(await page.locator('.next-select-values em').textContent(), product.attributes[0].value);
    assert.equal(await page.locator('#struct-water input').inputValue(), 'IPX-5');
    assert.equal(await page.locator('#struct-resolution input').inputValue(), '2560X1600');
    assert.equal(await page.locator('#struct-processor select').inputValue(), 'Other');
    assert.deepEqual(product, original);
    await page.locator('.next-select-values').evaluate((node) => node.replaceChildren());
    product.attributes[0].value = 'Unavailable option';
    assert.deepEqual(await recoverRequiredAttributes(page, product, ['降噪']), []);
    assert.equal(await page.locator('[role="combobox"]').inputValue(), '');
  } finally {
    await browser.close();
  }
});

test('retries unaccepted image files but never dispatches an accepted upload twice', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-upload-test-'));
  const file = path.join(directory, 'image.jpg');
  fs.writeFileSync(file, 'fixture');
  try {
    let attempts = 0;
    const transient = { setInputFiles: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('locator.setInputFiles: Timeout exceeded');
    }, evaluate: async () => [] };
    await setImageUploadFiles(transient, [file]);
    assert.equal(attempts, 2);
    for (const queued of [false, true]) {
      attempts = 0;
      await setImageUploadFiles({
        setInputFiles: async () => { attempts += 1; throw new Error('locator.setInputFiles: Timeout exceeded'); },
        evaluate: async () => queued ? [] : [{ name: 'image.jpg', size: 7 }],
      }, [file], { hasStarted: async () => queued });
      assert.equal(attempts, 1);
    }
    attempts = 0;
    await assert.rejects(setImageUploadFiles({
      setInputFiles: async () => { attempts += 1; throw new Error('Element is not attached'); },
      evaluate: async () => [],
    }, [file]), (error) => error.code === 'IMAGE_UPLOAD_TIMEOUT');
    assert.equal(attempts, 2);
    const fatal = new Error('File type is unsupported');
    await assert.rejects(setImageUploadFiles({ setInputFiles: async () => { throw fatal; } }, [file]), (error) => error === fatal);
    assert.equal(userFacingError(new Error('locator.setInputFiles: Timeout 5000ms exceeded. Call log: waiting for input')), '国际站图片上传控件响应超时，请重试该商品');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
