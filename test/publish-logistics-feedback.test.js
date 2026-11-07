import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { applyPostingLogistics, visibleFeedback, waitForActionResult } from '../server/publisher.js';
import { publishRepairPlan, submitWithRepairs } from '../server/publish-recovery.js';

const hint = '填写完整物流信息后选择物流提供方式（即运费模版的选择） 最小起订量的发货期已填写 重量未填写 体积未填写 物流属性未填写';
async function form(page) {
  await page.setContent(`<p>当前商品类型：商机品</p><div id="pkgWeight"><input name="pkgWeight"></div>
    <div id="pkgMeasure"><input><input><input></div><div id="logisticsProperty"></div>
    <div class="next-balloon">${hint}</div><div class="readiness-feedback">重量未填写</div>
    <div class="next-notice">AI创意生图功能全新发布</div><div id="validation" role="alert"></div>
    <button id="submit">提交</button><script>window.submissions=0;document.querySelector('button').onclick=()=>window.submissions++;</script>`);
}

test('auto publishing with only packaging never treats transaction eligibility hints as a rejection or repeats an unknown submission', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const mode of ['submit', 'draft']) {
      await form(page);
      const product = { packaging: { weight: '0.943', length: '15', width: '10', height: '10' } };
      const options = { listingMode: 'auto' };
      await applyPostingLogistics(page, product, options);
      assert.equal(options.effectiveListingMode, 'inquiry');
      await assert.rejects(submitWithRepairs({
        submit: () => waitForActionResult(page, page.locator('#submit'), mode, page.url(), { timeoutMs: 600 }),
        repairs: { logistics: () => assert.fail('Eligibility hints must not cause another submission') },
      }), (error) => {
        assert.equal(error.code, 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
        assert.deepEqual(publishRepairPlan(error), []);
        assert.doesNotMatch(error.message, /重量未填写|体积未填写|物流属性未填写|AI创意/);
        return true;
      });
      assert.equal(await page.evaluate(() => window.submissions), 1);
    }
  } finally { await browser.close(); }
});

test('preserves actual logistics validation even when identical text also occurs in an eligibility checklist', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const actual of ['重量未填写', '物流属性: 请填写完整，或者全部清除', '图片格式不支持，请上传 JPG 图片']) {
      await form(page);
      await page.evaluate((message) => {
        document.querySelector('#submit').onclick = () => { window.submissions++; document.querySelector('#validation').textContent = message; };
      }, actual);
      await assert.rejects(waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 600 }), (error) => {
        assert.notEqual(error.code, 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
        assert.ok(error.message.includes(actual));
        assert.doesNotMatch(error.message, /最小起订量的发货期|AI创意/);
        return true;
      });
      assert.ok((await visibleFeedback(page)).includes(actual));
    }
  } finally { await browser.close(); }
});

test('a confirmed publication succeeds with the optional logistics checklist still visible', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await form(page);
    await page.evaluate(() => { document.querySelector('#submit').onclick = () => { window.submissions++; document.querySelector('#validation').textContent = '提交成功'; }; });
    const receipt = await waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 600 });
    assert.equal(receipt.verifiedBy, 'feedback');
    assert.equal(await page.evaluate(() => window.submissions), 1);
  } finally { await browser.close(); }
});
