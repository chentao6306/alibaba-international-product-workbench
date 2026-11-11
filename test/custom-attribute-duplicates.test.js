import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { supplierCustomAttributes, fillCustomAttributes, readCustomAttributes, requireCustomAttributes } from '../server/custom-attributes.js';
import { fillAndVerify } from '../server/publisher.js';
import { planPublicAttributeTransfer } from '../server/attribute-transfer.js';
import { createEditorForm, editorPayload } from '../src/product-editor-model.js';

const capture = (value, extra = {}) => ({ name: 'Material', value, isCustom: true,
  source: 'detailData.attributes', section: 'supplier properties', ...extra });

test('preserves all captured values in one custom row with provenance through editor save and reopen', () => {
  for (const identity of [{}, { propertyId: 'shared-material' }]) {
    const attributes = [capture(['Cotton', 'Linen'], identity), capture('Linen', identity), capture('Silk', identity)];
    const product = { attributes, source: { snapshot: { attributes: structuredClone(attributes) } } };
    const original = structuredClone(product);
    const custom = supplierCustomAttributes(product);
    assert.equal(custom.length, 1);
    assert.equal(custom[0].value, 'Cotton, Linen, Silk');
    assert.deepEqual(custom[0].customValueSources.map(item => item.value), [['Cotton', 'Linen'], 'Linen', 'Silk']);
    assert.deepEqual(custom[0].customValueSources.map(item => item.propertyId), Array(3).fill(identity.propertyId || ''));
    assert.equal(planPublicAttributeTransfer(product, []).custom[0].value, 'Cotton, Linen, Silk');
    // The API applies editable fields to the existing record; the editor
    // payload intentionally cannot replace private source evidence.
    const payload = editorPayload(createEditorForm(product));
    assert.equal(Object.hasOwn(payload, 'source'), false);
    const saved = { ...product, ...payload };
    const reopened = createEditorForm(saved);
    assert.equal(reopened.customAttributes[0].value, custom[0].value);
    assert.deepEqual(reopened.customAttributes[0].customValueSources, custom[0].customValueSources);
    assert.deepEqual(saved.source.snapshot, original.source.snapshot);
    assert.deepEqual(product, original);
  }
});

test('explicit edits and clears own old captured duplicates without resurrecting their source values', () => {
  const attributes = [capture('Cotton'), capture('Linen')];
  for (const value of ['User supplied fabric', '']) {
    const product = { attributes, customAttributes: [{ name: 'Material', value }] };
    const result = supplierCustomAttributes(product);
    assert.deepEqual(result.map(item => item.value), value ? [value] : []);
    assert.deepEqual(supplierCustomAttributes(createEditorForm(editorPayload(createEditorForm(product)))).map(item => item.value), value ? [value] : []);
  }
});

test('ambiguous duplicates remain visible instead of overwriting a different identity or manual value', () => {
  for (const attributes of [
    [capture('Cotton', { id: 'a' }), capture('Linen', { id: 'b' })],
    [capture('Cotton', { id: 'a' }), capture('Cotton', { id: 'b' })],
    [capture('Cotton', { source: 'manual' }), capture('Linen', { source: 'manual' })],
    [capture('Cotton'), capture('Linen', { section: 'different source section' })],
  ]) {
    const result = supplierCustomAttributes({ attributes });
    assert.deepEqual(result.map(item => item.value), attributes.map(item => item.value));
    assert.equal(createEditorForm({ attributes }).customAttributes.length, 2);
  }
  const explicit = supplierCustomAttributes({ customAttributes: [{ name: 'Material', value: 'Cotton' }, { name: 'Material', value: '' }] });
  assert.deepEqual(explicit.map(item => item.value), ['Cotton', '']);
  for (const identity of [{}, { propertyId: 'old-id' }]) {
    // ProductEditor preserves old source metadata on a manual name/value edit.
    const edited = { customAttributes: [capture('Edited cotton', identity), capture('Edited linen', identity)] };
    assert.deepEqual(supplierCustomAttributes(edited).map(item => item.value), ['Edited cotton', 'Edited linen']);
  }
});

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="customMoreProperty"><div class="item"><div class="attr-title"><input maxlength="40"></div>
      <div class="attr-value"><input maxlength="80"></div></div><button class="add-attr-btn" onclick="window.additions++">Add</button></div>
      <script>window.additions=0</script>`);
    await run(page);
  } finally { await browser.close(); }
});

browserTest('writes and verifies every joined custom value without spending extra custom slots', async page => {
  const product = { attributes: [capture('Cotton'), capture('Linen'), capture('Silk')] };
  const original = structuredClone(product);
  await fillCustomAttributes(page, product, fillAndVerify);
  assert.deepEqual(await readCustomAttributes(page), [{ name: 'Material', value: 'Cotton, Linen, Silk' }]);
  await requireCustomAttributes(page, product);
  assert.equal(await page.evaluate(() => window.additions), 0);
  await page.locator('.attr-value input').fill('Silk');
  await assert.rejects(requireCustomAttributes(page, product), /未被发布页完整保留/);
  assert.deepEqual(product, original);
});

browserTest('rejects ambiguous source and duplicate manual identities before any form write', async page => {
  for (const product of [
    { attributes: [capture('Cotton', { id: 'a' }), capture('Linen', { id: 'b' })] },
    { attributes: [capture('Cotton', { id: 'a' }), capture('Cotton', { id: 'b' })] },
    { customAttributes: [{ name: 'Material', value: 'Cotton' }, { name: 'Material', value: 'Linen' }] },
    { customAttributes: [{ name: 'Material', value: 'Cotton' }, { name: 'Material', value: '' }] },
    { customAttributes: [capture('Edited cotton'), capture('Edited linen')] },
  ]) {
    await assert.rejects(fillCustomAttributes(page, product, fillAndVerify), error => {
      assert.deepEqual(error.requiredFields, ['Material']);
      return error.code === 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED';
    });
    assert.deepEqual(await readCustomAttributes(page), [{ name: '', value: '' }]);
    assert.equal(await page.evaluate(() => window.additions), 0);
  }
});

browserTest('a joined custom value still honors the native length limit without truncating its source', async page => {
  const product = { attributes: [capture('Cotton'), capture('Linen')] };
  const original = structuredClone(product);
  await page.locator('.attr-value input').evaluate(input => input.maxLength = 10);
  await assert.rejects(fillCustomAttributes(page, product, fillAndVerify), /值超过平台 10 字符限制/);
  assert.equal(await page.locator('.attr-value input').inputValue(), '');
  assert.deepEqual(product, original);
});
