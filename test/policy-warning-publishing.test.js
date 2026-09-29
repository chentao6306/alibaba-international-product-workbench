import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { findChromium } from '../server/browser-runtime.js';
import { dismissPostingOverlays, waitForActionResult, classifyAlibabaActionResult } from '../server/publisher.js';
import { withPostingPolicy, policyAcknowledgements, policyWarningPublishingAllowed, acknowledgeSalesRules } from '../server/posting-policy.js';

const warning = '疑似涉及禁限售，会造成风控违规问题，请根据商品发布规则修改后提交发布';
const browserTest = { skip: !findChromium(), timeout: 30000 };
async function fixture(page, { text = warning, stays = false, success = true, close = false, immediate = false, mixedQuality = false } = {}) {
  await page.setContent(`<button id="submit">发布商品</button><div role="alert" id="receipt"></div>
    <div class="next-dialog" style="display:${immediate ? 'block' : 'none'}">
    <h2>${mixedQuality ? '质量分检测提示' : '警告'}</h2>
    ${mixedQuality ? '<p>商品信息质量分低于4分，影响商品曝光</p>' : ''}<p>${text}</p>
    <button id="confirm">${close ? '确定' : '继续提交'}</button><button>返回修改</button></div>
    <script>window.submissions=0;window.confirmations=0;
    document.querySelector('#submit').onclick=()=>{window.submissions++;document.querySelector('.next-dialog').style.display='block'};
    document.querySelector('#confirm').onclick=()=>{window.confirmations++;
      if(!${stays})document.querySelector('.next-dialog').style.display='none';
      if(${success})document.querySelector('#receipt').textContent='提交成功'};</script>`);
}

test('policy publishing permission is strict and isolated between concurrent operations', async () => {
  assert.equal(policyWarningPublishingAllowed(), false);
  await Promise.all([true, false, 'true', undefined].map(value => withPostingPolicy({ allowPolicyWarningPublish: value }, async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(policyWarningPublishingAllowed(), value === true);
  })));
  assert.equal(policyWarningPublishingAllowed(), false);
  for (const allowed of [false, true]) assert.equal(classifyAlibabaActionResult({ mode: 'submit', url: 'https://post.alibaba.com/product/success.htm',
    allowPolicyWarningPublish: allowed, feedback: ['疑似涉及禁限售，禁止发布'] }).succeeded, false);
});

async function salesRulesFixture(page, { delayed = false, text = '请确认《阿里巴巴国际站禁限售规则》', rejects = false, reverts = false } = {}) {
  await page.setContent(`<button id="submit">提交</button><div role="alert" id="receipt"></div>
    <label><input type="checkbox" id="unrelated">Other agreement</label>
    <div class="sales-range" style="display:${delayed ? 'none' : 'block'}"><label class="next-checkbox-wrapper">
      <input type="checkbox" id="rules"><span>${text}</span></label></div>
    <script>window.submissions=0;window.confirmations=0;
    document.querySelector('#rules').onchange=()=>{window.confirmations++; if(${reverts})setTimeout(()=>document.querySelector('#rules').checked=false,30)};
    document.querySelector('#submit').onclick=()=>{window.submissions++;
      document.querySelector('.sales-range').style.display='block';
      document.querySelector('#receipt').textContent=${rejects}?'疑似涉及禁限售，禁止发布':
        document.querySelector('#rules').checked?'提交成功':'错误项请确认禁限售规则1项';};</script>`);
}

test('acknowledges the server sales rule field only with permission, in both languages, without changing other agreements', browserTest, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const text of ['请确认《阿里巴巴国际站禁限售规则》', 'Please confirm the "Alibaba International Station Ban and Restriction Rules"']) {
      for (const allowed of [false, true]) {
        await salesRulesFixture(page, { text });
        const action = () => withPostingPolicy({ allowPolicyWarningPublish: allowed }, async () => {
          const result = await waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 900 });
          assert.equal(policyAcknowledgements()[0].action, 'acknowledge-sales-rules');
          return result;
        });
        if (allowed) assert.equal((await action()).verifiedBy, 'feedback');
        else await assert.rejects(action(), { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
        assert.equal(await page.locator('#unrelated').isChecked(), false);
        assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), allowed ? [1, 1] : [0, 0]);
      }
    }
  } finally { await browser.close(); }
});

test('repairs a late sales rule validation once and never retries a hard platform refusal', browserTest, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await salesRulesFixture(page, { delayed: true });
    await withPostingPolicy({ allowPolicyWarningPublish: true }, () => waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 900 }));
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [2, 1]);
    await salesRulesFixture(page, { rejects: true });
    await assert.rejects(withPostingPolicy({ allowPolicyWarningPublish: true }, () =>
      waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 900 })), { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
    assert.equal(await page.evaluate(() => window.submissions), 1);
    await salesRulesFixture(page, { reverts: true });
    await assert.rejects(withPostingPolicy({ allowPolicyWarningPublish: true }, () =>
      waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 900 })), { code: 'PUBLISH_CONFIRMATION_PENDING' });
    assert.equal(await page.evaluate(() => window.submissions), 0);
  } finally { await browser.close(); }
});

test('rule handling leaves drafts unchanged and refuses missing, ambiguous or disabled controls', browserTest, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await salesRulesFixture(page);
    await page.locator('#submit').evaluate(node => node.onclick = () => document.querySelector('#receipt').textContent = '保存成功');
    await withPostingPolicy({ allowPolicyWarningPublish: true }, () => waitForActionResult(page, page.locator('#submit'), 'draft', page.url(), { timeoutMs: 900 }));
    assert.equal(await page.locator('#rules').isChecked(), false);
    for (const change of ['missing', 'duplicate', 'disabled']) {
      await salesRulesFixture(page);
      await page.evaluate(change => {
        const field = document.querySelector('.sales-range');
        if (change === 'missing') field.remove();
        if (change === 'duplicate') field.after(field.cloneNode(true));
        if (change === 'disabled') field.querySelector('input').disabled = true;
      }, change);
      await assert.rejects(withPostingPolicy({ allowPolicyWarningPublish: true }, () => acknowledgeSalesRules(page, { required: true })), { code: 'PUBLISH_CONFIRMATION_PENDING' });
    }
  } finally { await browser.close(); }
});

test('confirmed setting continues a policy notice once and requires an actual success receipt', browserTest, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const allowed of [undefined, false, true]) {
      await fixture(page);
      await withPostingPolicy({ allowPolicyWarningPublish: allowed }, async () => {
        const action = () => waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 1000 });
        if (allowed) {
          assert.equal((await action()).verifiedBy, 'feedback');
          assert.equal(policyAcknowledgements().length, 1);
          assert.equal(policyAcknowledgements()[0].action, 'continue-submission');
        } else await assert.rejects(action(), { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
        assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [1, allowed ? 1 : 0]);
      });
    }
  } finally { await browser.close(); }
});

test('enabled warnings retain platform rejection and never turn a draft into a submission', browserTest, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of [{ text: warning + '，禁止发布', mode: 'submit' }, { mode: 'draft' }]) {
      await fixture(page, scenario);
      await assert.rejects(withPostingPolicy({ allowPolicyWarningPublish: true }, () =>
        waitForActionResult(page, page.locator('#submit'), scenario.mode, page.url(), { timeoutMs: 1000 })), { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
      assert.equal(await page.evaluate(() => window.confirmations), 0);
    }
  } finally { await browser.close(); }
});

test('keeps an unconfirmed result pending without repeated policy or quality confirmations', browserTest, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of [{ stays: true, mixedQuality: true }, { success: false }]) {
      await fixture(page, scenario);
      await assert.rejects(withPostingPolicy({ allowPolicyWarningPublish: true }, () =>
        waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 1000 })), error => {
        assert.equal(error.code, scenario.stays ? 'PUBLISH_CONFIRMATION_PENDING' : 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
        assert.equal(error.diagnostics.policyAcknowledgements.length, 1);
        return true;
      });
      assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [1, 1]);
    }
  } finally { await browser.close(); }
});

test('an enabled informational warning can be acknowledged during entry without submitting the form', browserTest, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await fixture(page, { close: true, immediate: true, success: false });
    await withPostingPolicy({ allowPolicyWarningPublish: true }, async () => {
      assert.equal(await dismissPostingOverlays(page), true);
      assert.equal(policyAcknowledgements()[0].action, 'acknowledge-notice');
    });
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.confirmations]), [0, 1]);
  } finally { await browser.close(); }
});

test('settings switch confirms enabling, cancels without saving, and reverts after a failed save', browserTest, async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import PublishingRiskSetting from './src/PublishingRiskSetting.jsx';
    window.requests=[];window.notifications=[];window.saved=false;
    const request=async(path,options)=>{const body=JSON.parse(options.body);window.requests.push(body);
      if(window.fail)throw new Error('Save failed');window.saved=body.allowPolicyWarningPublish;return body};
    createRoot(document.getElementById('root')).render(<PublishingRiskSetting settings={{}} request={request}
      refresh={async()=>{}} notify={message=>window.notifications.push(message)}/>);` }, bundle: true, write: false, jsx: 'automatic', format: 'iife' });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const toggle = page.getByRole('switch');
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    page.once('dialog', dialog => dialog.dismiss());
    await toggle.click();
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    page.once('dialog', dialog => { assert.match(dialog.message(), /是否确认启用/); return dialog.accept(); });
    await toggle.click();
    await page.waitForFunction(() => window.saved);
    assert.equal(await toggle.isChecked(), true);
    assert.deepEqual(await page.evaluate(() => window.requests[0]), { allowPolicyWarningPublish: true, confirmPolicyWarningPublish: true });
    await toggle.click();
    await page.waitForFunction(() => !window.saved);
    assert.equal(await toggle.isChecked(), false);
    await page.evaluate(() => { window.fail = true; });
    page.once('dialog', dialog => dialog.accept());
    await toggle.click();
    await page.waitForFunction(() => window.notifications.includes('Save failed'));
    assert.equal(await toggle.isChecked(), false);
  } finally { await browser.close(); }
});
