import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { capturePublishFailure, readPostingFieldFeedback, readPostingDescriptionSchema } from '../server/publish-diagnostics.js';
import { sanitizeDiagnosticFailure } from '../auth-server/diagnostic-evidence.js';

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await run(page);
  } finally { await browser.close(); }
});

browserTest('captures bounded native gallery capabilities without arbitrary component data or secrets', async page => {
  await page.setContent('<div id="companyImage"><button class="add-custom-gallery-name-btn">Custom gallery</button></div>');
  await page.evaluate(() => { window.Json = { components: { companyImage: { props: {
    maxImageItem: 30, maxCustomGalleryItem: 3, maxGalleryNameLength: 50,
    privateKey: 'PRIVATE_KEY', value: 'PRIVATE_FORM_CONTENT', token: 'PRIVATE_TOKEN',
    dataSource: Array.from({ length: 80 }, (_, index) => ({ value: index, enName: 'Company ' + index, cnName: '公司', privateKey: 'PRIVATE_KEY' })),
  } } } }; });
  const schema = await readPostingDescriptionSchema(page);
  assert.equal(schema.companyImage.options.length, 40);
  assert.equal(schema.companyImage.maxCustomGalleryItem, 3);
  assert.deepEqual(schema.companyImage.customControls, [{ visible: true, disabled: false }]);
  assert.doesNotMatch(JSON.stringify(schema), /PRIVATE_|privateKey|token/);
  const sanitized = sanitizeDiagnosticFailure({ page: { descriptionSchema: schema, text: 'x'.repeat(100000) } });
  assert.deepEqual(sanitized.page.descriptionSchema, schema);
  assert.equal(sanitized.truncation.page, true);
});

browserTest('captures legacy detail validation with its field and rejected unit excerpt through diagnostic sanitization', async page => {
  const html = `<div id="struct-content"><section id="struct-superText"><label class="label">商品描述</label>
    <iframe id="description-editor" srcdoc='<body contenteditable="true"><p>${'Product detail. '.repeat(180)}1000cd/㎡ industrial screen</p></body>'></iframe>
    <div class="sell-error-message"><span class="msg-text">请不要输入非数字、非英文、非空格字符: ㎡</span></div></section></div>`;
  await page.route('https://post.alibaba.com/product/publish.htm', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://post.alibaba.com/product/publish.htm');
  await page.frameLocator('iframe').locator('body').waitFor();
  const evidence = await readPostingFieldFeedback(page);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].fieldId, 'struct-superText');
  assert.equal(evidence[0].label, '商品描述');
  assert.equal(evidence[0].values[0].type, 'rich-text');
  assert.match(evidence[0].values[0].value, /1000cd\/㎡ industrial screen/);
  assert.equal(evidence[0].values[0].valueTruncated, true);
  assert.ok(evidence[0].values[0].value.length <= 600);
  const captured = await capturePublishFailure({ page, product: {}, error: new Error('Platform rejected detail'), stage: '提交商品', mode: 'submit' });
  assert.ok(captured.page.feedback.some(text => text.includes('㎡')));
  const sanitized = sanitizeDiagnosticFailure(captured);
  assert.deepEqual(sanitized.page.fieldFeedback, evidence);
  assert.deepEqual(sanitizeDiagnosticFailure(sanitized), sanitized);
});

browserTest('captures category validation without ordinary help, unrelated notices, hidden errors or credential values', async page => {
  await page.setContent(`<aside role="alert">Unrelated service warning</aside><div id="struct-content">
    <div class="next-form-item" id="struct-p-1"><label class="next-form-item-label" for="width">Writing width</label>
      <input id="width" value="0.5 mm" aria-invalid="true"><div class="next-form-item-help">Invalid width value</div></div>
    <div class="next-form-item" id="struct-p-2"><label class="next-form-item-label">Material</label>
      <input value="Cotton"><div class="next-form-item-help">Use the material provided by the manufacturer.</div></div>
    <div class="next-form-item" id="struct-p-3"><label class="label">Private value</label>
      <input id="secret" value="PRIVATE_SECRET"><input type="hidden" value="PRIVATE_HIDDEN"><input autocomplete="one-time-code" value="PRIVATE_OTP">
      <div class="sell-error-message">Invalid credential value</div></div>
    <div class="next-form-item" id="struct-p-4"><label class="label">Password</label><input value="PRIVATE_PASSWORD">
      <div class="sell-error-message">Invalid password</div></div>
    <div class="next-form-item" id="struct-p-5" hidden><label class="label">Hidden</label><div class="sell-error-message">Hidden required value</div></div>
    <div class="next-form-item" id="struct-p-6"><label class="label">Color</label><input value="Blue">
      <div class="sell-error-message"><div class="error-message">Invalid color token=PRIVATE_TOKEN</div></div></div>
    </div>`);
  const evidence = await readPostingFieldFeedback(page);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].label, 'Writing width');
  assert.equal(evidence[0].values[0].value, '0.5 mm');
  assert.equal(evidence[1].label, 'Color');
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|Unrelated|manufacturer|Hidden required/);
  assert.match(evidence[1].message, /\[REDACTED\]/);
});

browserTest('bounds repeated field feedback and ignores non-editor embedded documents', async page => {
  await page.setContent(`<div id="struct-content">${Array.from({ length: 80 }, (_, index) => `<div class="next-form-item" id="struct-p-${index}">
    <label class="label">Field ${index}</label><textarea>${'v'.repeat(3000)}</textarea><iframe srcdoc="<body>PRIVATE_UNRELATED_PAGE</body>"></iframe>
    <div class="sell-error-message">Invalid ${index} ${'x'.repeat(2200)}</div></div>`).join('')}</div>`);
  const evidence = await readPostingFieldFeedback(page);
  assert.ok(evidence.length > 0 && evidence.length <= 30);
  assert.ok(JSON.stringify(evidence).length <= 16100);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_UNRELATED_PAGE/);
  for (const row of evidence) {
    assert.ok(row.message.length <= 2000);
    assert.equal(row.values.length, 1);
    assert.ok(row.values[0].value.length <= 600);
    assert.equal(row.values[0].valueTruncated, true);
  }
});
