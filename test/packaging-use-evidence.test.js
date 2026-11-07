import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { packagingUseFromEvidence, packagingParentConflict, postingAttributeSource } from '../server/packaging-use-evidence.js';
import { descriptionSourceHash } from '../server/description-structure.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { fillCategoryAttributes, requireCategoryAttributes, requirePublicAttributeTransfer } from '../server/publisher.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const parent = { id: '19421', label: 'Industrial Use', hasValue: true, values: ['Cosmetic'],
  options: ['Cosmetic', 'Food', 'Gift & Craft', 'Pharmaceuticals'].map(label => ({ value: label, label })) };
const field = { id: '19421-19427', label: '具体用途', labels: ['Use', '具体用途'], required: true, multiple: true,
  options: ['Essential Oil', 'Lotion', 'Shampoo', 'Oil', 'Other Cosmetic'].map(label => ({ value: label, label })) };
const product = text => ({ categoryId: '201268985', attributes: [{ id: '19421', name: 'Industrial Use', value: 'Cosmetic' }],
  descriptionHtml: `<p>${text}</p>` });

test('rule mode maps all explicit packaging uses from saved text with current options and original evidence', () => {
  const input = product('Versatile Usage: Suitable for dispensing shampoo, essential oils, lotions, and more.');
  syncProductModel(input, { captureSource: true });
  const before = structuredClone(input);
  const choices = field;
  const source = packagingUseFromEvidence(input, choices, [parent, choices]);
  assert.deepEqual(source.value, ['Essential Oil', 'Lotion', 'Shampoo']);
  assert.equal(source.source, 'rule-description-evidence');
  assert.ok(source.ruleEvidence.entries.every(item => item.quote.includes('Suitable for dispensing')));
  assert.deepEqual(input, before);
  assert.equal(verifySourceIntegrity(input).valid, true);
  assert.deepEqual(packagingUseFromEvidence(JSON.parse(JSON.stringify(input)), choices, [parent, choices]), source);
});

test('rule mode reads product highlights and custom purpose facts but preserves parent and custom attributes', () => {
  const input = product('');
  input.structuredDescription = { version: 1, sourceHtmlHash: descriptionSourceHash(input.descriptionHtml), modules: [
    { type: 'highlights', items: ['Versatile Uses: Suitable for cosmetic, essential oil, lotion, and other liquid products.'] },
    { type: 'company', text: 'We make packaging suitable for Shampoo.' },
  ] };
  const choices = field;
  assert.deepEqual(packagingUseFromEvidence(input, choices, [parent, choices]).value, ['Essential Oil', 'Lotion']);
  input.descriptionHtml = '<p>Manual replacement without use facts.</p>';
  assert.equal(packagingUseFromEvidence(input, choices, [parent, choices]), null, 'Stale structured modules cannot restore edited facts');
  const food = { ...parent, values: ['Food'] };
  const child = { ...field, options: [{ value: 'candy', label: 'Candy' }] };
  const jar = { attributes: [{ id: '19421', name: 'Industrial Use', value: 'Food' },
    { name: 'Industrial Use', value: 'Food/Face Cream/Candy', isCustom: true }] };
  const before = structuredClone(jar);
  assert.deepEqual(packagingUseFromEvidence(jar, child, [food, child]).value, ['Candy']);
  assert.deepEqual(jar, before, 'Multi-use custom text is preserved, not replaced by a single option');
  const edited = { ...jar, customAttributes: [{ name: 'Industrial Use', value: '' }] };
  assert.equal(packagingUseFromEvidence(edited, child, [food, child]), null, 'Explicitly cleared custom evidence must not come back from old captures');
});

test('literal use matching rejects negations, unrelated text, partial words, unavailable options and wrong dependency state', () => {
  for (const text of [
    'Not suitable for essential oil.', 'Suitable for essential oil. Do not use for essential oil.',
    'Our company makes packaging suitable for essential oil.', 'Other products are suitable for essential oil.',
    'Suitable for essential oilproof coatings.', 'Suitable for other cosmetic products.',
    'Essential oil is discussed here.',
  ]) assert.equal(packagingUseFromEvidence(product(text), field, [parent, field]), null, text);
  const input = product('Suitable for essential oils and lotion.');
  for (const child of [{ ...field, options: [] }, { ...field, options: field.options.map(o => ({ ...o, disabled: true })) },
    { ...field, id: '999-19427' }, { ...field, required: false }, { ...field, disabled: true }, { ...field, multiple: false }]) {
    assert.equal(packagingUseFromEvidence(input, child, [parent, child]), null);
  }
  assert.equal(packagingUseFromEvidence(input, field, [{ ...parent, values: ['Gift & Craft'] }, field]), null);
  assert.equal(packagingUseFromEvidence(input, field, [{ ...parent, hasValue: false }, field]), null);
  assert.equal(packagingUseFromEvidence({ ...product(''), title: 'Essential Oil Bottle' }, field, [parent, field]), null);
  assert.equal(packagingUseFromEvidence(product('About this supplier: Suitable for essential oil.'), field, [parent, field]), null);
  assert.equal(packagingUseFromEvidence(product('<div class="recommend">Suitable for essential oil.</div>'), field, [parent, field]), null);
});

test('explicit Use edits and conflicting supplier industries are never overridden by rule fallback', () => {
  const input = product('Suitable for essential oil.');
  for (const value of ['', 'Perfume', ['Perfume', 'Lotion']]) {
    const edited = { ...input, attributes: [...input.attributes, { id: field.id, name: 'Use', value, source: 'manual' }] };
    assert.equal(packagingUseFromEvidence(edited, field, [parent, field]), null);
    if (value) assert.deepEqual(postingAttributeSource(edited, field, [parent, field]).value, value);
  }
  const gift = { ...parent, values: ['Gift & Craft'] };
  const conflicted = { ...input, attributes: [{ id: '19421', name: 'Industrial Use', value: 'Gift & Craft' },
    { name: 'Industrial Use', value: 'Pharmaceutical', isCustom: true }] };
  assert.equal(packagingUseFromEvidence(conflicted, field, [gift, field]), null);
  assert.deepEqual(packagingParentConflict(conflicted, [gift]), { parentId: '19421', sourceValues: ['Gift & Craft'], conflictingValues: ['Pharmaceutical'] });
  assert.deepEqual(packagingParentConflict(conflicted, [{ ...gift, options: [] }]), packagingParentConflict(conflicted, [gift]));
  const craft = { ...field, options: [{ value: 'craft', label: 'Craft' }] };
  const duplicated = { attributes: [{ id: '19421', name: 'Industrial Use', value: 'Gift & Craft' },
    { name: 'Industrial Use', value: 'Gift & Craft', source: 'dom' }] };
  assert.equal(packagingUseFromEvidence(duplicated, craft, [gift, craft]), null, 'A duplicate parent label cannot prove a child use');
});

test('rule-only publishing fills late-mounted uses, records actual native readback and rejects subsequent clearing', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-19421"><label class="label required">行业应用</label>
      <select><option value="">Choose</option><option>Cosmetic</option><option>Gift &amp; Craft</option><option>Pharmaceuticals</option></select></div><div id="dependent"></div>
      <script>document.querySelector('select').onchange=()=>setTimeout(()=>{
      document.querySelector('#dependent').innerHTML='<div class="sell-catProp-item" id="struct-p-19421-19427"><label class="label required">具体用途</label><select multiple><option value="oil">Essential Oil</option><option value="lotion">Lotion</option></select></div>';
      },100);</script>`);
    const input = product('Versatile Uses: Suitable for essential oils and lotion.');
    syncProductModel(input, { captureSource: true });
    const before = structuredClone(input);
    await fillCategoryAttributes(page, input);
    await requireCategoryAttributes(page, input);
    const record = (await requirePublicAttributeTransfer(page, input)).find(row => row.source === 'rule-description-evidence');
    assert.deepEqual(record.committedValues, ['Essential Oil', 'Lotion']);
    assert.equal(record.destination, 'standard-attribute');
    assert.equal(record.evidence.entries.length, 2);
    assert.deepEqual(input, before);
    await page.locator('#struct-p-19421-19427 select').selectOption([]);
    await assert.rejects(requireCategoryAttributes(page, input), error => {
      assert.deepEqual(error.unmatchedSourceFields, ['具体用途']);
      assert.deepEqual(error.missingSourceFields, []);
      return true;
    });
    await assert.rejects(requirePublicAttributeTransfer(page, input), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
    await fillCategoryAttributes(page, input);
    await requireCategoryAttributes(page, input);
    await page.locator('#struct-p-19421 select').selectOption('Gift & Craft');
    await page.waitForTimeout(150);
    const conflict = { ...input, attributes: [{ id: '19421', name: 'Industrial Use', value: 'Gift & Craft' },
      { name: 'Industrial Use', value: 'Pharmaceutical', isCustom: true }] };
    await assert.rejects(requireCategoryAttributes(page, conflict), error => {
      assert.equal(error.diagnostics.dependencies[0].reason, 'source-parent-conflict');
      assert.match(error.message, /Gift & Craft.*Pharmaceutical.*不一致/);
      assert.doesNotMatch(error.message, /原商品未提供/);
      return true;
    });
    assert.equal(verifySourceIntegrity(input).valid, true);
  } finally { await browser.close(); }
});
