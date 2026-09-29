import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { waitForActionResult } from '../server/publisher.js';
import { publishEnvironmentBlockCode, publishRepairPlan, submitWithRepairs } from '../server/publish-recovery.js';

const backgroundHint = '最小起订量的发货期已填写 重量未填写 体积未填写 物流属性未填写';
const qualityCopy = '检测到当前商品信息质量分低于4分，请根据提示尽快修改商品信息，避免影响商品曝光！';

async function form(page, { role = true, text = qualityCopy, title = '质量分检测提示', noticeDelay = 0,
  finishDelay = 100, keepDialog = false, success = true, validation = '', receiptDialog = false } = {}) {
  await page.setContent(`<div class="posting-readiness-feedback">${backgroundHint}</div>
    <button id="publish">提交</button><div role="alert" id="result"></div>
    <section id="notice" ${role ? 'role="dialog" aria-modal="true"' : ''} style="display:none">
      <h2>${title}</h2><p>${text}</p><button id="continue">继续提交</button><button id="back">返回修改</button>
    </section><script>
      window.submissions=0;window.confirmations=0;window.returned=0;
      document.querySelector('#publish').onclick=()=>{window.submissions++;setTimeout(()=>{document.querySelector('#notice').style.display='block'},${noticeDelay})};
      document.querySelector('#back').onclick=()=>{window.returned++};
      document.querySelector('#continue').onclick=()=>{
        window.confirmations++;
        setTimeout(()=>{
          if(!${keepDialog})document.querySelector('#notice').style.display='none';
          document.querySelector('#result').textContent=${JSON.stringify(validation || (success ? '提交成功' : ''))};
          if(${receiptDialog})document.querySelector('#result').setAttribute('role','dialog');
        },${finishDelay});
      };
    </script>`);
}

test('continues the exact quality-score notice once and waits for success instead of repairing background logistics', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const role of [true, false]) {
      await form(page, { role, finishDelay: 700 });
      let repairs = 0;
      const receipt = await submitWithRepairs({
        submit: () => waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 2000 }),
        repairs: { logistics: async () => { repairs++; return true; } },
      });
      assert.equal(receipt.verifiedBy, 'feedback');
      assert.equal(repairs, 0);
      assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations, window.returned]), [1, 1, 0]);
      assert.equal(await page.locator('.posting-readiness-feedback').innerText(), backgroundHint);
    }
  } finally { await browser.close(); }
});

test('starts a fresh receipt wait after a late quality confirmation instead of timing out on the first submission deadline', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await form(page, { noticeDelay: 500, finishDelay: 600 });
    const receipt = await waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 1000 });
    assert.equal(receipt.verifiedBy, 'feedback');
    assert.equal(await page.evaluate(() => window.confirmations), 1);
  } finally { await browser.close(); }
});

test('accepts an explicit success dialog after the quality confirmation', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await form(page, { receiptDialog: true });
    const receipt = await waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 2000 });
    assert.equal(receipt.verifiedBy, 'feedback');
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [1, 1]);
  } finally { await browser.close(); }
});

test('does not repeat a quality confirmation or a publication when the dialog stays open', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await form(page, { keepDialog: true });
    await assert.rejects(submitWithRepairs({
      submit: () => waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 1000 }),
      repairs: { logistics: () => assert.fail('background hint must not be repaired') },
    }), (error) => {
      assert.equal(error.code, 'PUBLISH_CONFIRMATION_PENDING');
      assert.equal(publishEnvironmentBlockCode(error), error.code);
      assert.deepEqual(publishRepairPlan(error), []);
      assert.match(error.message, /质量分检测提示.*已点击一次/);
      assert.doesNotMatch(error.message, /重量未填写/);
      return true;
    });
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [1, 1]);
  } finally { await browser.close(); }
});

test('pauses an unknown receipt after confirmation without treating unchanged logistics readiness hints as errors', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await form(page, { success: false });
    await assert.rejects(submitWithRepairs({
      submit: () => waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 1000 }),
      repairs: { logistics: () => assert.fail('unchanged logistics must not cause resubmission') },
    }), (error) => {
      assert.equal(error.code, 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
      assert.equal(publishEnvironmentBlockCode(error), error.code);
      assert.deepEqual(publishRepairPlan(error), []);
      assert.match(error.message, /商品管理中核对/);
      assert.doesNotMatch(error.message, /重量未填写/);
      return true;
    });
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [1, 1]);
  } finally { await browser.close(); }
});

test('retains a new actual validation error returned after the quality confirmation', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await form(page, { validation: '物流属性: 请填写完整，或者全部清除' });
    await assert.rejects(waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 1000 }), (error) => {
      assert.notEqual(error.code, 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
      assert.match(error.message, /物流属性: 请填写完整/);
      assert.doesNotMatch(error.message, /重量未填写/);
      assert.ok(publishRepairPlan(error).includes('logistics'));
      return true;
    });
    assert.equal(await page.evaluate(() => window.confirmations), 1);
  } finally { await browser.close(); }
});

test('requires the known quality notice and submission mode rather than clicking every continue button', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of [
      { title: '其他确认提示', mode: 'submit' },
      { text: '请先核对其他待确认事项', mode: 'submit' },
      { mode: 'draft' },
    ]) {
      await form(page, scenario);
      await assert.rejects(waitForActionResult(page, page.locator('#publish'), scenario.mode, page.url(), { timeoutMs: 800 }),
        (error) => error.code === 'PUBLISH_CONFIRMATION_PENDING');
      assert.equal(await page.evaluate(() => window.confirmations), 0);
    }
    await form(page, { text: `${qualityCopy} 疑似涉及禁限售，会造成风控违规问题。` });
    await assert.rejects(waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 1000 }),
      (error) => error.code === 'PUBLISH_POLICY_REVIEW_REQUIRED');
    assert.equal(await page.evaluate(() => window.confirmations), 0);
  } finally { await browser.close(); }
});

test('preserves a policy warning arriving while the quality confirmation click is intercepted', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await form(page);
    await page.evaluate(() => {
      document.querySelector('#publish').addEventListener('click', () => {
        const notice = document.createElement('aside');
        notice.setAttribute('role', 'alert');
        notice.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
        notice.textContent = '正在检测';
        document.body.append(notice);
        setTimeout(() => { notice.textContent = '疑似涉及禁限售，会造成风控违规问题'; }, 1500);
      });
    });
    await assert.rejects(waitForActionResult(page, page.locator('#publish'), 'submit', page.url(), { timeoutMs: 3000 }), (error) => {
      assert.equal(error.code, 'PUBLISH_POLICY_REVIEW_REQUIRED');
      assert.match(error.message, /禁限售/);
      assert.deepEqual(publishRepairPlan(error), []);
      return true;
    });
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [1, 0]);
  } finally { await browser.close(); }
});
