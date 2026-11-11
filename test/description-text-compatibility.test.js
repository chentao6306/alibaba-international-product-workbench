import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { prepareLegacyDescriptionText, legacyDescriptionTextConversions } from '../server/description-text-compatibility.js';
import { SellerPublisher, waitForActionResult, classifyAlibabaActionResult } from '../server/publisher.js';
import { compatibleDescriptionFingerprint } from '../server/description-compatibility.js';
import { publishRepairPlan } from '../server/publish-recovery.js';

test('legacy unit spelling preserves text meaning, table structure, other Unicode and media addresses', () => {
  const html = '<p>1000cd/㎡ · Ω ± 25℃ 中文 Ａ</p><table><tr><td colspan="2">2&#13217; and 3&#x33a1;</td></tr></table>'
    + '<a href="https://example.com/㎡">unit</a><img src="https://example.com/㎡.png" alt="㎡">';
  const result = prepareLegacyDescriptionText(html);
  assert.deepEqual(result.conversions, [{ from: '㎡', to: 'm2', count: 3, reason: 'legacy-editor-unit-compatibility' }]);
  assert.match(result.html, /1000cd\/m2 · Ω ± 25℃ 中文 Ａ/);
  assert.match(result.html, /colspan="2"/);
  assert.match(result.html, /href="https:\/\/example.com\/㎡"/);
  assert.match(result.html, /src="https:\/\/example.com\/㎡.png" alt="㎡"/);
  assert.deepEqual(compatibleDescriptionFingerprint(result.html), compatibleDescriptionFingerprint(html));
  assert.deepEqual(prepareLegacyDescriptionText(result.html), { html: result.html, conversions: [] });
  for (const value of ['<p>Clothing 100% Cotton</p>', '<p>Flowers 30–40 cm</p>', '<p>Medical ±3 mmHg</p>', '<p>Plastic 10×20 cm</p>']) {
    assert.deepEqual(prepareLegacyDescriptionText(value), { html: value, conversions: [] });
  }
});

test('legacy publisher uses the same normalized body through image restoration and draft or submit receipts', { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://sc04.alicdn.com/**', route => route.abort());
    const product = { title: 'Synthetic tablet', descriptionHtml: '<table><tr><td>Screen</td><td>1000cd/㎡</td></tr></table><img src="https://sc04.alicdn.com/source.jpg">',
      detailImages: ['https://sc04.alicdn.com/source.jpg'], source: { snapshot: { descriptionHtml: 'Source 1000cd/㎡' } } };
    const before = structuredClone(product);
    for (const mode of ['draft', 'submit']) {
      await page.goto('about:blank#' + mode);
      await page.setContent('<input name="productTitle"><div id="desc-card-title">商品详情</div><div id="struct-superText">'
        + '<iframe srcdoc="<body class=mce-content-body contenteditable=true></body>"></iframe></div><button id="save">保存</button><div role="alert"></div>');
      await page.frameLocator('iframe').locator('body').waitFor();
      await page.evaluate(mode => {
        const body = document.querySelector('iframe').contentDocument.body;
        window.value = ''; window.saves = 0;
        window.tinymce = { editors: [{ hidden: false, getBody: () => body, getContent: () => body.innerHTML,
          setContent: html => { body.innerHTML = html; }, save() {}, fire: () => { window.value = body.innerHTML; } }] };
        window.GlobalStore = { engine: { getModels: () => ({ formValues: { productDescType: { value: 1 }, superText: { value: window.value } } }) } };
        document.querySelector('#save').onclick = () => {
          window.saves++;
          document.querySelector('[role=alert]').textContent = window.value.includes('㎡')
            ? '请不要输入非数字、非英文、非空格字符: ㎡' : mode === 'draft' ? '保存成功' : '提交成功';
        };
      }, mode);
      const publisher = new SellerPublisher('unused-fixture');
      publisher.uploadLegacyDetailImages = async () => {
        await page.frameLocator('iframe').locator('body').evaluate(body => { body.innerHTML = '<img src="https://sc04.alicdn.com/upload.jpg">'; });
        return 1;
      };
      await publisher.fillLegacyDescription(page, product);
      const html = await page.frameLocator('iframe').locator('body').innerHTML();
      assert.match(html, /1000cd\/m2/);
      assert.match(html, /<table>/);
      assert.match(html, /upload.jpg/);
      assert.equal(await page.evaluate(() => window.value), html);
      assert.equal(legacyDescriptionTextConversions(page)[0].count, 1);
      await waitForActionResult(page, page.locator('#save'), mode, page.url(), { timeoutMs: 1000 });
      assert.equal(await page.evaluate(() => window.saves), 1);
      assert.deepEqual(product, before);
    }
    await page.goto('about:blank#next-product');
    assert.deepEqual(legacyDescriptionTextConversions(page), []);
  } finally { await browser.close(); }
});

test('a rejected character has a stable error code and cannot be mistaken for a success or blindly resubmitted', { skip: !findChromium(), timeout: 15000 }, async () => {
  const feedback = '请不要输入非数字、非英文、非空格字符: ㎡';
  assert.deepEqual(publishRepairPlan({ code: 'PUBLISH_INVALID_CHARACTERS', requiredFields: ['商品详情'], message: feedback }), []);
  assert.equal(classifyAlibabaActionResult({ mode: 'submit', feedback: ['提交成功', feedback] }).succeeded, false);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const message of [feedback, `${feedback}；请上传产品图片`]) {
      await page.setContent('<button id="save">保存</button><div class="sell-error-message"><span class="msg-text"></span></div>');
      await page.evaluate(feedback => {
        window.saves = 0;
        document.querySelector('#save').onclick = () => { window.saves++; document.querySelector('.msg-text').textContent = feedback; };
      }, message);
      await assert.rejects(waitForActionResult(page, page.locator('#save'), 'draft', page.url(), { timeoutMs: 700 }), error => {
        assert.equal(error.code, 'PUBLISH_INVALID_CHARACTERS');
        assert.ok(error.diagnostics.feedback.some(text => text.includes('㎡')));
        assert.deepEqual(publishRepairPlan(error), []);
        return true;
      });
      assert.equal(await page.evaluate(() => window.saves), 1);
    }
  } finally { await browser.close(); }
});

test('fresh inline rejection ends the wait early but stale validation cannot interrupt a pending draft', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const feedback = '请不要输入非数字、非英文、非空格字符: ㎡';
    for (const stale of [false, true]) {
      await page.setContent('<button id="save">保存</button><div id="struct-superText"><label>商品详情</label>'
        + '<div class="sell-error-message"><span class="msg-text"></span></div></div><div role="alert" id="receipt"></div>');
      await page.evaluate(({ feedback, stale }) => {
        window.saves = 0;
        const error = document.querySelector('.msg-text');
        if (stale) error.textContent = feedback;
        document.querySelector('#save').onclick = () => {
          window.saves++; error.textContent = feedback;
          if (stale) setTimeout(() => { error.textContent = ''; document.querySelector('#receipt').textContent = '保存成功'; }, 1600);
        };
      }, { feedback, stale });
      const start = Date.now();
      const action = () => waitForActionResult(page, page.locator('#save'), 'draft', page.url(), { timeoutMs: 7000 });
      if (stale) assert.equal((await action()).verifiedBy, 'feedback');
      else {
        await assert.rejects(action(), error => {
          assert.equal(error.code, 'PUBLISH_INVALID_CHARACTERS');
          assert.equal(error.diagnostics.section, 'description');
          assert.deepEqual(error.requiredFields, ['商品详情']);
          return true;
        });
        assert.ok(Date.now() - start < 6000, 'A confirmed field rejection must not spend the whole receipt window');
      }
      assert.equal(await page.evaluate(() => window.saves), 1);
    }
  } finally { await browser.close(); }
});
