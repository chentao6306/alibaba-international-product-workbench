import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { userFacingError } from '../server/browser-error.js';
import { publishEnvironmentBlockCode, publishRepairPlan, submitWithRepairs } from '../server/publish-recovery.js';
import { classifyAlibabaActionResult, enableImageBackedVariantSpecs, preparePublishProduct, waitForActionResult } from '../server/publisher.js';

const requiredImage = '请选择一个规格上传图片，上传图片有利于提升买家转化';

test('distinguishes missing specification images and sticky controls from actual modal blockers', () => {
  assert.deepEqual(publishRepairPlan(new Error(requiredImage)), ['specifications']);
  assert.deepEqual(publishRepairPlan(new Error('Please select one specification to upload an image')), ['specifications']);
  const footer = new Error('locator.click: Timeout 1000ms exceeded. <div class="posting-footer"> intercepts pointer events');
  assert.equal(publishEnvironmentBlockCode(footer), 'PUBLISH_CONTROL_OBSCURED');
  assert.doesNotMatch(userFacingError(footer), /弹窗遮罩/);
  assert.deepEqual(publishRepairPlan(footer), []);
  const modal = new Error('locator.click: Timeout 1000ms exceeded. <div class="next-overlay-backdrop"> intercepts pointer events');
  assert.equal(publishEnvironmentBlockCode(modal), 'PUBLISH_OVERLAY_BLOCKED');
  assert.deepEqual(publishRepairPlan(modal), []);
  assert.match(userFacingError(modal), /页面提示/);
  assert.doesNotMatch(userFacingError(modal), /弹窗遮罩/);
  assert.equal(classifyAlibabaActionResult({ mode: 'submit', feedback: [requiredImage, '上一次发布成功'] }).succeeded, false);
});

test('preserves explicit SKU and editor image associations without guessing from main images or conflicting SKUs', () => {
  const product = {
    mainImages: ['https://example.test/main.jpg'],
    variantGroups: [
      { id: '3', name: 'Model Number', options: ['Bando 5', 'Bando 6', 'Unknown'], optionImages: { 'Bando 5': 'explicit.jpg' } },
      { id: '191288010', name: 'Color', options: ['Blue', 'Red', 'Black'] },
    ],
    modelImages: { 'Bando 6': 'model.jpg' },
    colorImages: { Blue: 'blue.jpg' },
    skus: [
      { attributes: { 'Model Number': 'Bando 5', Color: 'Red' }, image: 'sku-red.jpg' },
      { attributes: { 'Model Number': 'Bando 6', Color: 'Black' }, image: 'black-one.jpg' },
      { attributes: { 'Model Number': 'Bando 5', Color: 'Black' }, image: 'black-two.jpg' },
    ],
  };
  const before = structuredClone(product);
  const prepared = preparePublishProduct(product);
  assert.deepEqual(prepared.variantGroups[0].optionImages, { 'Bando 5': 'explicit.jpg', 'Bando 6': 'model.jpg' });
  assert.deepEqual(prepared.variantGroups[1].optionImages, { Blue: 'blue.jpg', Red: 'sku-red.jpg' });
  assert.deepEqual(product, before);
  const descriptive = preparePublishProduct({ variantGroups: [{ name: 'Compatible Model', options: ['Other'] }],
    skus: [{ attributes: { 'Compatible Model': 'Other' }, image: 'whole-sku.jpg' }] });
  assert.deepEqual(descriptive.variantGroups[0].optionImages, {});
});

test('reports the customer specification validation after submission without classifying it as a paused overlay', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-specification"><label><input type="checkbox" checked>使用型号</label>
      <label><input type="checkbox" checked>附件类型</label></div>
      <div class="sell-error-message"><span class="msg-text"></span></div>
      <button id="publish">发布</button><script>window.submissions=0;
      document.querySelector('button').onclick=()=>{window.submissions++;document.querySelector('.msg-text').textContent=${JSON.stringify(requiredImage)}};</script>`);
    await assert.rejects(waitForActionResult(page, page.locator('#publish'), 'submit', page.url()), (error) => {
      assert.equal(error.code, 'PUBLISH_SPEC_IMAGE_REQUIRED');
      assert.equal(publishEnvironmentBlockCode(error), '');
      assert.deepEqual(publishRepairPlan(error), ['specifications']);
      assert.match(userFacingError(error), /产品规格.*对应图片/);
      assert.doesNotMatch(userFacingError(error), /弹窗遮罩/);
      return true;
    });
    assert.equal(await page.evaluate(() => window.submissions), 1);
  } finally { await browser.close(); }
});

test('a failed click preserves the visible missing-image reason instead of inventing a dialog', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div role="alert">${requiredImage}</div>`);
    const action = { click: async () => { throw new Error('locator.click: Timeout 1000ms exceeded. <footer> intercepts pointer events'); } };
    await assert.rejects(waitForActionResult(page, action, 'submit', page.url()), (error) => error.code === 'PUBLISH_SPEC_IMAGE_REQUIRED');
  } finally { await browser.close(); }
});

test('uploads a stored SKU image and resubmits once even when old validation stays visible until the next submission', { skip: !findChromium() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-image-feedback-test-'));
  const file = path.join(directory, 'bando.png');
  fs.writeFileSync(file, 'source-image');
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="saleAttributesItems"><label><input type="checkbox" value="3" checked>型号 支持传图</label></div>
      <div id="struct-specification"><div id="p-3"><div class="posting-feild-color-item">
        <input role="colorCombobox" value="Bando 5"><div class="custom-upload-image">上传<input type="file"></div>
      </div></div></div><div role="alert"></div><button id="publish">发布</button>
      <script>window.submissions=0;window.uploads=0;
      document.querySelector('[type=file]').onchange=function(){window.uploads++;this.parentNode.insertAdjacentHTML('beforeend','<div class="value-preview uploaded"><img src="https://example.test/bando.png"></div>')};
      document.querySelector('#publish').onclick=()=>{window.submissions++;if(document.querySelector('.uploaded'))setTimeout(()=>{document.querySelector('[role=alert]').textContent='发布成功'},900);else document.querySelector('[role=alert]').textContent=${JSON.stringify(requiredImage)}};</script>`);
    const product = preparePublishProduct({ variantGroups: [{ id: '3', name: 'Model Number', options: ['Bando 5'] }],
      skus: [{ attributes: { 'Model Number': 'Bando 5' }, image: 'https://example.test/source.png' }] });
    const result = await submitWithRepairs({
      submit: () => waitForActionResult(page, page.locator('#publish'), 'submit', page.url()),
      repairs: { specifications: () => enableImageBackedVariantSpecs(page, product, product.variantGroups, async ([url]) => {
        assert.equal(url, 'https://example.test/source.png'); return [file];
      }) },
    });
    assert.equal(result.verifiedBy, 'feedback');
    assert.deepEqual(await page.evaluate(() => ({ submissions: window.submissions, uploads: window.uploads })), { submissions: 2, uploads: 1 });
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('dismisses a late modal before retrying a click that was never dispatched', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="alert"></div><button id="save" onclick="window.saves++;document.querySelector(\'[role=alert]\').textContent=\'保存成功\'">保存草稿</button><script>window.saves=0</script>');
    const save = page.locator('#save');
    let attempts = 0;
    let dispatches = 0;
    const action = {
      evaluate: (...args) => save.evaluate(...args),
      click: async (...args) => {
        if (!args[0]?.trial) dispatches++;
        if (attempts++ === 0) {
          await page.evaluate(() => {
            const dialog = document.createElement('div'); dialog.className = 'next-dialog';
            dialog.innerHTML = '<button onclick="this.parentElement.remove()">关闭</button>'; document.body.append(dialog);
          });
          throw new Error('locator.click: Timeout exceeded. next-overlay-backdrop intercepts pointer events');
        }
        return save.click(...args);
      },
    };
    await waitForActionResult(page, action, 'draft', page.url());
    assert.equal(attempts, 3); // blocked trial, successful trial, one real click
    assert.equal(dispatches, 1);
    assert.equal(await page.evaluate(() => window.saves), 1);
  } finally { await browser.close(); }
});

test('never repeats an already-dispatched click when its old call log also mentions pointer interception', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>发布</button>');
    const error = new Error('locator.click: Timeout 1000ms exceeded\n<footer> intercepts pointer events\nclick action done\nwaiting for scheduled navigations to finish');
    let clicks = 0;
    const action = { click: async () => { clicks++; throw error; } };
    await assert.rejects(waitForActionResult(page, action, 'submit', page.url()), (result) => result === error);
    assert.equal(clicks, 1);
  } finally { await browser.close(); }
});

test('keeps a closed page after dispatch as an uncertain receipt without repairs or another submission', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    for (const mode of ['draft', 'submit']) {
      const page = await browser.newPage();
      await page.setContent('<button id="action">Save</button>');
      const button = page.locator('#action');
      let dispatches = 0, repairs = 0;
      const action = {
        evaluate: (...args) => button.evaluate(...args),
        click: async options => {
          await button.click(options);
          if (!options?.trial) { dispatches++; await page.close(); }
        },
      };
      await assert.rejects(submitWithRepairs({
        submit: () => waitForActionResult(page, action, mode, 'about:blank', { timeoutMs: 1000 }),
        repairs: { attributes: async () => { repairs++; return true; }, specifications: async () => { repairs++; return true; } },
      }), error => {
        assert.equal(error.code, 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
        assert.equal(error.diagnostics.reason, 'receipt-unavailable');
        assert.match(error.diagnostics.browserError, /closed/i);
        assert.match(error.message, /核对/);
        assert.deepEqual(publishRepairPlan(error), []);
        return true;
      });
      assert.equal(dispatches, 1);
      assert.equal(repairs, 0);
    }
  } finally { await browser.close(); }
});
