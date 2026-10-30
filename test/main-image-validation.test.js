import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher, mainImageFormState, mainImageUploadFeedback, visibleFeedback, requireSpecificationImagesAccepted } from '../server/publisher.js';
import { publishRepairPlan, submitWithRepairs } from '../server/publish-recovery.js';

test('does not report native FAQ rejection or onboarding text as a main-image upload failure', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="next-notice">产品图片设置说明</div><div id="companyFaqDesc"><div class="sell-error-message">字符不符合要求: ’</div></div>'
      + '<div id="detailImage"><div class="sell-error-message">上传失败</div></div><div id="struct-scImages"></div>');
    assert.deepEqual(await mainImageUploadFeedback(page), []);
    await page.locator('#struct-scImages').evaluate(node => { node.innerHTML = '<div class="sell-error-message">上传失败：文件过大</div>'; });
    assert.deepEqual(await mainImageUploadFeedback(page), ['上传失败：文件过大']);
    await page.locator('#struct-scImages').evaluate(node => { node.replaceChildren(); });
    await page.evaluate(() => { const toast = document.createElement('div'); toast.role = 'alert'; toast.textContent = 'Image upload failed'; document.body.append(toast); });
    assert.deepEqual(await mainImageUploadFeedback(page), ['Image upload failed']);
  } finally { await browser.close(); }
});

test('repairs the customer product-image validation wording and still bounds repeated rejection', async () => {
  const message = '国际站提示:错误项产品图片1项;报错反馈1错误项产品图片1项';
  assert.ok(publishRepairPlan(new Error(message)).includes('mainImages'));
  let attempts = 0, repairs = 0;
  await assert.rejects(submitWithRepairs({
    submit: () => { attempts++; throw new Error(message); },
    repairs: { mainImages: () => { repairs++; return true; } },
  }), { message });
  assert.equal(attempts, 3);
  assert.equal(repairs, 2);
});

test('routes ambiguous product-image validation by its field instead of reuploading accepted main images', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const message = '商品图片项必填项不能为空';
    await page.setContent(`<div id="struct-scImages"><div class="sell-error-message">${message}</div></div><div id="struct-specification"><div class="sell-error-message" style="display:none">${message}</div><p>配置图片有利于提升买家转化</p></div>`);
    await requireSpecificationImagesAccepted(page, [message]);
    assert.ok(publishRepairPlan(new Error(message)).includes('mainImages'));
    await page.locator('#struct-specification .sell-error-message').evaluate(node => { node.style.display = 'block'; });
    await assert.rejects(requireSpecificationImagesAccepted(page, [message]), error => {
      assert.equal(error.code, 'PUBLISH_SPEC_IMAGE_REQUIRED');
      assert.equal(error.diagnostics.platformMessage, message);
      assert.deepEqual(publishRepairPlan(error), ['specifications']);
      return true;
    });
    await page.setContent('<div id="struct-specification"></div>');
    await assert.rejects(requireSpecificationImagesAccepted(page, ['请选择一个规格上传图片']), { code: 'PUBLISH_SPEC_IMAGE_REQUIRED' });
    await requireSpecificationImagesAccepted(page, []);
  } finally { await browser.close(); }
});

test('reads a concrete image error after hidden messages instead of retaining only the error counter', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="alert">错误项 产品图片 1项</div>'
      + '<div class="sell-error-message" style="display:none"><span class="msg-text">旧错误</span></div>'.repeat(25)
      + '<div id="struct-scImages"><div class="sell-error-message"><span class="msg-text">第 5 张图片上传失败：图片尺寸不符合要求</span></div></div>');
    const feedback = await visibleFeedback(page);
    assert.ok(feedback.includes('第 5 张图片上传失败：图片尺寸不符合要求'));
    assert.ok(!feedback.some(text => text.includes('旧错误')));
  } finally { await browser.close(); }
});

test('repairs a late failed receipt and a lost image even when four other main images are accepted', { skip: !findChromium(), timeout: 25000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-late-receipt-'));
  const paths = Array.from({ length: 6 }, (_, i) => path.join(root, `image-${i + 1}.png`));
  paths.forEach(file => fs.writeFileSync(file, 'fixture'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="image-uploader"></div>');
    await page.evaluate(() => {
      window.files = []; window.dispatched = []; window.removed = [];
      window.render = () => {
        const root = document.querySelector('.image-uploader'); root.replaceChildren();
        const props = { fileList: window.files,
          onRemove: file => { window.removed.push(file.name); window.files = window.files.filter(f => f !== file); window.render(); },
          onSort: files => { window.files = files; window.render(); } };
        root.__reactFiber$test = { memoizedProps: props };
        for (let i = 0; i < 6; i++) {
          const slot = document.createElement('div'); slot.className = 'image-upload-list-item';
          slot.style.cssText = 'display:inline-block;width:100px;height:100px';
          const file = window.files[i];
          slot.__reactFiber$test = { memoizedProps: { file }, return: { memoizedProps: props } };
          if (file) slot.innerHTML = `<img src="${file.fileURL}" width="80" height="80">`;
          else {
            slot.innerHTML = '<span id="image-placeholder-span">上传图片</span><input type="file" accept="image/png" multiple>';
            slot.querySelector('input').onchange = event => {
              const names = [...event.target.files].map(f => f.name); window.dispatched.push(names);
              for (const name of names) window.files.push({ name, uid: `${window.dispatched.length}-${name}`, status: 'done', fileURL: `https://example.test/${name}` });
              window.render();
            };
          }
          root.append(slot);
        }
      };
      window.render();
    });
    const publisher = new SellerPublisher(root);
    publisher.downloadImageSet = async () => paths;
    const product = { mainImages: paths };
    await publisher.uploadMainImages(page, product);
    const acceptedIds = await page.evaluate(() => window.files.slice(0, 4).map(f => f.uid));
    await page.evaluate(() => {
      window.files.pop();
      window.files[4].status = 'error';
      window.files[4].error = { code: 503, isRequestError: true, message: '图片服务繁忙' };
      window.render();
    });
    assert.equal((await mainImageFormState(page)).occupied, 4);
    await publisher.reconcileMainImages(page, product);
    assert.equal((await mainImageFormState(page)).occupied, 6);
    assert.deepEqual(await page.evaluate(() => window.dispatched), [paths.map(p => path.basename(p)), ['image-5.png', 'image-6.png']]);
    assert.deepEqual(await page.evaluate(() => window.files.slice(0, 4).map(f => f.uid)), acceptedIds);
    assert.deepEqual(await page.evaluate(() => window.removed), ['image-5.png']);
    await page.evaluate(() => { window.files.pop(); window.render(); });
    await publisher.reconcileMainImages(page, product);
    assert.equal((await mainImageFormState(page)).occupied, 6);
    assert.deepEqual(await page.evaluate(() => window.dispatched.at(-1)), ['image-6.png']);
    const requests = await page.evaluate(() => window.dispatched.length);
    await page.evaluate(() => {
      window.files[4].status = 'error';
      window.files[4].error = { code: 400, message: '图片格式不符合要求' };
      window.render();
    });
    await assert.rejects(publisher.reconcileMainImages(page, product), error => {
      assert.equal(error.code, 'MAIN_IMAGE_UPLOAD_FAILED');
      assert.match(error.message, /第 5 张（image-5.png）：图片格式不符合要求/);
      assert.deepEqual(error.diagnostics.failedImages, [{ index: 5, name: 'image-5.png', code: 400, message: '图片格式不符合要求', retryable: false }]);
      return true;
    });
    assert.equal(await page.evaluate(() => window.dispatched.length), requests);
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
