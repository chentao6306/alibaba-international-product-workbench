import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { userFacingError } from '../server/browser-error.js';
import { dismissPostingOverlays, enableImageBackedVariantSpecs, enableSpecImageUpload, ensureColorSpecImageSwitch, fillVariantSpecs, forceClearLogisticsSection, recoverRequiredAttributes, setImageUploadFiles, waitForActionResult } from '../server/publisher.js';
import { submitWithRepairs, publishRepairPlan } from '../server/publish-recovery.js';

test('English logistics validation receives the same complete-section repair as Chinese validation', () => {
  assert.deepEqual(publishRepairPlan(new Error('Logistics attribute: Please fill in completely, or please remove all the weight, volume and logistics attributes')), ['logistics']);
});

test('reports platform policy warnings before stale logistics errors and never confirms or retries them', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id="publish">发布商品</button><div role="alert">物流属性: 请填写完整，或者全部清除</div>
      <div class="next-dialog" style="display:none"><h2>警告</h2>疑似涉及禁限售，会造成风控违规问题。商品名称: drone
        <button id="continue">继续提交</button><button id="back">返回编辑</button></div>
      <script>window.clicks = 0; window.confirmed = false;
        document.querySelector('#publish').onclick = () => { window.clicks++; document.querySelector('.next-dialog').style.display = 'block'; };
        document.querySelector('#continue').onclick = () => { window.confirmed = true; };</script>`);
    let repairs = 0;
    await assert.rejects(submitWithRepairs({
      submit: () => waitForActionResult(page, page.locator('#publish'), 'submit', page.url()),
      repairs: { logistics: async () => { repairs++; return true; } },
    }), (error) => error.code === 'PUBLISH_POLICY_REVIEW_REQUIRED' && /drone/.test(error.message));
    assert.equal(repairs, 0);
    assert.deepEqual(await page.evaluate(() => ({ clicks: window.clicks, confirmed: window.confirmed })), { clicks: 1, confirmed: false });
    await assert.rejects(dismissPostingOverlays(page), (error) => error.code === 'PUBLISH_POLICY_REVIEW_REQUIRED');
  } finally { await browser.close(); }
});

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

test('opens an unlabelled specification image switch and waits for asynchronous state without toggling twice', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    for (const wrapper of ['', 'upload-image-switch']) {
      await page.setContent(`<div id="row"><span class="${wrapper}">
        <button role="switch" aria-checked="false" class="next-switch next-switch-off">图片</button>
        </span><div id="slot"></div></div>
        <script>
          window.toggleCount = 0;
          document.querySelector('button').onclick = function () {
            window.toggleCount++;
            setTimeout(() => {
              const enabled = this.getAttribute('aria-checked') !== 'true';
              this.setAttribute('aria-checked', String(enabled));
              this.className = 'next-switch next-switch-' + (enabled ? 'on' : 'off');
              document.querySelector('#slot').innerHTML = enabled ? '<div class="custom-upload-image">上传</div>' : '';
            }, 180);
          };
        </script>`);
      assert.equal(await ensureColorSpecImageSwitch(page, page.locator('#row')), true);
      assert.equal(await page.evaluate(() => window.toggleCount), 1);
      assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
    }
    await page.setContent('<div id="row"><button role="switch">A</button><button role="switch">B</button></div>');
    assert.equal(await ensureColorSpecImageSwitch(page, page.locator('#row')), false);
  } finally {
    await browser.close();
  }
});

test('uploads every color even when the first color already has a preview', { skip: !findChromium() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'color-recovery-test-'));
  const file = path.join(directory, 'blue.png');
  fs.writeFileSync(file, 'source-blue-image');
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <div id="saleAttributesItems"><label>Color<input type="checkbox" value="191288010" checked></label></div>
      <div id="p-191288010">
        <div class="posting-feild-color-item"><input role="colorCombobox" value="Red">
          <div class="custom-upload-image"><div class="value-preview uploaded"><img src="https://example.test/red.png"></div></div>
        </div>
        <div class="posting-feild-color-item"><input role="colorCombobox" value="Blue">
          <div class="custom-upload-image">上传<input type="file" accept="image/*"></div>
        </div>
      </div>
      <script>
        window.uploads = [];
        document.querySelector('[type="file"]').onchange = function () {
          window.uploads.push(this.files[0].name);
          const preview = document.createElement('div');
          preview.className = 'value-preview uploaded';
          preview.innerHTML = '<img src="https://example.test/blue.png">';
          this.parentNode.append(preview);
        };
      </script>
    `, { waitUntil: 'domcontentloaded' });
    const group = { name: 'Color', options: ['Red', 'Blue'], optionImages: { Red: 'red-source', Blue: 'blue-source' } };
    const product = { title: 'Original title', price: '25', variantGroups: [group] };
    const original = structuredClone(product);
    const downloads = [];
    const download = async (urls) => { downloads.push(...urls); return [file]; };
    const stages = [];
    assert.equal(await enableSpecImageUpload(page, product, group, download, (stage) => stages.push(stage)), true);
    assert.equal(stages.length, 2);
    assert.match(stages[1], /2\/2/);
    assert.deepEqual(downloads, ['blue-source']);
    assert.deepEqual(await page.evaluate(() => window.uploads), ['blue.png']);
    assert.equal(await enableSpecImageUpload(page, product, group, download), true);
    assert.deepEqual(await page.evaluate(() => window.uploads), ['blue.png']);
    assert.deepEqual(product, original);
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps page-wide file chooser uploads assigned to the correct specification option', { skip: !findChromium() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-chooser-test-'));
  for (const name of ['small', 'large']) fs.writeFileSync(path.join(directory, `${name}.png`), name);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <div id="saleAttributesItems"><label>Model<input type="checkbox" value="3" checked></label></div>
      <div id="struct-specification"><div id="p-3">
        <div class="posting-feild-color-item" data-option="small"><input role="colorCombobox" value="Small"><div class="custom-upload-image">上传 Small</div></div>
        <div class="posting-feild-color-item" data-option="large"><input role="colorCombobox" value="Large"><div class="custom-upload-image">上传 Large</div></div>
      </div></div>
      <input id="shared" type="file" accept="image/*" style="display:none">
      <script>
        window.uploads = [];
        let active;
        document.querySelectorAll('.custom-upload-image').forEach(trigger => trigger.onclick = () => {
          active = trigger.parentNode;
          document.querySelector('#shared').value = '';
          document.querySelector('#shared').click();
        });
        document.querySelector('#shared').onchange = function () {
          const target = active;
          window.uploads.push([target.dataset.option, this.files[0].name]);
          setTimeout(() => {
            const preview = document.createElement('div');
            preview.className = 'value-preview uploaded';
            preview.innerHTML = '<img src="https://example.test/' + target.dataset.option + '.png">';
            target.append(preview);
          }, 100);
        };
      </script>
    `);
    const group = { id: '3', name: 'Model', type: 'IMAGE', options: ['Small', 'Large'], optionImages: { Small: 'small', Large: 'large' } };
    const download = async ([name]) => [path.join(directory, `${name}.png`)];
    const stages = [];
    assert.equal(await enableImageBackedVariantSpecs(page, {}, [group], download, (stage) => stages.push(stage)), true);
    assert.equal(stages.length, 2);
    assert.match(stages[1], /2\/2/);
    assert.deepEqual(await page.evaluate(() => window.uploads), [['small', 'small.png'], ['large', 'large.png']]);
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves complete custom specification values when the input is replaced on each edit', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <div id="saleAttributesItems"><label>Model<input type="checkbox" value="3" checked></label></div>
      <div id="struct-specification"><div id="p-3"><label>Model</label><input role="colorCombobox" placeholder="请输入"><button role="btn-add">添加</button></div></div>
      <script>
        function bind(input) {
          input.oninput = () => {
            const next = input.cloneNode(true);
            next.value = input.value;
            input.replaceWith(next);
            bind(next);
          };
        }
        bind(document.querySelector('[role="colorCombobox"]'));
        document.querySelector('button').onclick = () => {
          const input = document.createElement('input');
          input.setAttribute('role', 'colorCombobox');
          document.querySelector('button').before(input);
          bind(input);
        };
      </script>
    `);
    const product = { variantGroups: [{ id: '3', name: 'Model', options: ['Mark4 V2 8inch', 'Mark4 V2 10inch'] }] };
    const result = await fillVariantSpecs(page, product);
    assert.deepEqual(result.unmapped, []);
    assert.deepEqual(await page.locator('[role="colorCombobox"]').evaluateAll((nodes) => nodes.map((node) => node.value)), product.variantGroups[0].options);
  } finally {
    await browser.close();
  }
});

test('maps a source specification to a differently identified target 规格 sale attribute', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <div id="saleAttributesItems"><label>规格<input type="checkbox" value="987654" /></label></div>
      <div id="struct-specification"><div id="p-987654" style="display:none"><label>规格</label><input role="colorCombobox" placeholder="请输入"><button role="btn-add">添加</button></div></div>
      <script>
        document.querySelector('#saleAttributesItems input').onclick = function () {
          this.checked = true;
          document.querySelector('#p-987654').style.display = 'block';
        };
        document.querySelector('#p-987654 button').onclick = () => {
          const input = document.createElement('input');
          input.setAttribute('role', 'colorCombobox');
          input.placeholder = '请输入';
          document.querySelector('#p-987654 button').before(input);
        };
      </script>
    `);
    const product = { variantGroups: [{ id: 'source-spec', name: 'Specification', options: ['Left', 'Right'] }] };
    const result = await fillVariantSpecs(page, product);
    assert.deepEqual(result.unmapped, []);
    assert.equal(await page.locator('#saleAttributesItems input').isChecked(), true);
    assert.deepEqual(await page.locator('#p-987654 input').evaluateAll((nodes) => nodes.map((node) => node.value).filter(Boolean)), ['Left', 'Right']);
  } finally { await browser.close(); }
});

test('clears incomplete logistics without erasing unrelated fields whose labels mention shipping', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`
      <label>Product title (shipping information remains below)<input name="productTitle" value="Original motor title"></label>
      <label>Price<input name="price" value="73.60"></label>
      <label>Model<input role="colorCombobox" value="Mark4 V2 10inch"></label>
      <div id="logistics"><input name="pkgWeight" value="1"><input name="pkgLength" value="30"><input name="pkgWidth" value="20"><input name="pkgHeight" value="10"></div>
    `);
    await forceClearLogisticsSection(page);
    assert.deepEqual(await page.locator('#logistics input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['', '', '', '']);
    assert.equal(await page.locator('[name="productTitle"]').inputValue(), 'Original motor title');
    assert.equal(await page.locator('[name="price"]').inputValue(), '73.60');
    assert.equal(await page.locator('[role="colorCombobox"]').inputValue(), 'Mark4 V2 10inch');
  } finally {
    await browser.close();
  }
});
