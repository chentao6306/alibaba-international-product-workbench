import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { sourceAttributeForField } from '../server/category-attributes.js';
import { isLogisticsReadinessHint } from '../server/posting-logistics.js';
import { fillCategoryAttributes, requireCategoryAttributes, repairPostingLogistics, visibleFeedback, waitForActionResult } from '../server/publisher.js';
import { submitWithRepairs } from '../server/publish-recovery.js';

test('recognizes only complete optional lead-time checklist phrases and maps sheet counts without guessing from dimensions', () => {
  for (const label of ['最小起订量的发货期', '最小起订量对应的发货期']) {
    assert.equal(isLogisticsReadinessHint(`填写完整物流信息后选择物流提供方式（即运费模板的选择） ${label}未填写 重量未填写 体积未填写 物流属性未填写`), true);
    assert.equal(isLogisticsReadinessHint(`${label}未填写，请填写正确的发货期`), false);
  }
  const field = { id: '123', label: '张数', controlType: 'text' };
  for (const name of ['Number of Sheets', 'Number Of Sheets', 'Sheets Number', '张数']) {
    assert.equal(sourceAttributeForField({ attributes: [{ name, value: '100' }] }, field).value, '100');
  }
  for (const name of ['Pages', 'Number of Pages', 'Size', 'Paper Size']) {
    assert.equal(sourceAttributeForField({ attributes: [{ name, value: '76*76 mm' }] }, field), null);
  }
});

test('ignores the alternate optional checklist but still rejects the same text in a real validation alert', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const hint = '最小起订量对应的发货期未填写';
    await page.setContent(`<div class="next-balloon">${hint}</div><div role="alert"></div>`);
    assert.deepEqual(await visibleFeedback(page), []);
    await page.locator('[role="alert"]').evaluate((node, text) => { node.textContent = text; }, hint);
    assert.deepEqual(await visibleFeedback(page), [hint]);
  } finally { await browser.close(); }
});

test('repairs reset source lead times before retrying even when all other logistics values are unchanged', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<p>当前商品类型：商机品</p>
      <div id="struct-ladderPeriod"><input><input></div><div role="alert" id="validation"></div>
      <button id="submit">提交</button><script>window.submits=0;document.querySelector('button').onclick=()=>{
        window.submits++; const values=[...document.querySelectorAll('input')].map(n=>n.value);
        document.querySelector('#validation').textContent=values.join(',')==='100,7'?'提交成功':'最小起订量对应的发货期未填写';
      };</script>`);
    const product = { deliveryTime: [['Quantity (pieces)', '1 - 100', '> 100'], ['Lead time (days)', '7', 'To be negotiated']] };
    const original = structuredClone(product);
    const options = { listingMode: 'inquiry' };
    const result = await submitWithRepairs({
      submit: () => waitForActionResult(page, page.locator('#submit'), 'submit', page.url(), { timeoutMs: 600 }),
      repairs: { logistics: () => repairPostingLogistics(page, product, options) },
    });
    assert.equal(result.verifiedBy, 'feedback');
    assert.equal(await page.evaluate(() => window.submits), 2);
    assert.equal(await repairPostingLogistics(page, product, options), false);
    assert.deepEqual(product, original);
    await page.locator('input').nth(1).fill('');
    assert.equal(await repairPostingLogistics(page, {}, options), false);
    assert.equal(await page.locator('input').nth(1).inputValue(), '');
  } finally { await browser.close(); }
});

test('writes an explicit sheet count into the native field and rejects dimensions-only source data', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="p-123"><div class="label required">张数</div><input required></div>');
    const product = { title: 'Sticky note 76*76mm', attributes: [{ name: 'Number of Sheets', value: '100' }] };
    await fillCategoryAttributes(page, product);
    assert.equal(await page.locator('input').inputValue(), '100');
    await requireCategoryAttributes(page, product);
    await page.locator('input').fill('');
    const missing = { title: 'Sticky note 76*76mm', attributes: [{ name: 'Size', value: '76*76mm' }] };
    await fillCategoryAttributes(page, missing);
    assert.equal(await page.locator('input').inputValue(), '');
    await assert.rejects(requireCategoryAttributes(page, missing), error => error.requiredFields.includes('张数'));
  } finally { await browser.close(); }
});
