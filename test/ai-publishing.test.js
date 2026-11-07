import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { assistAttributeMapping } from '../server/ai-product-assistance.js';
import { createAttributeAiSession } from '../server/ai-publishing.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { fillCategoryAttributes, requireCategoryAttributes, requirePublicAttributeTransfer, attributeFieldMatchesValue } from '../server/publisher.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { submitWithRepairs } from '../server/publish-recovery.js';

const config = { mode: 'assisted', provider: 'deepseek' };
const field = { id: '19427', label: 'Use', labels: ['Use'], required: true, multiple: true,
  controlType: 'multiSelect', needsMapping: true, values: [],
  options: [{ label: 'Essential Oil', value: 'oil' }, { label: 'Shampoo', value: 'shampoo' }] };
const source = () => syncProductModel({ title: 'Bottle', categoryId: 'bottles',
  description: 'Perfume bottle', attributes: [{ id: '19427', name: 'Use', value: ['精油', '洗发水'] }] }, { captureSource: true });
const proposal = { fieldId: '19427', values: ['Essential Oil', 'Shampoo'], sourceValues: ['精油', '洗发水'], evidenceId: 'e1', quote: '精油, 洗发水', confidence: 0.99 };
const response = mappings => async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ mappings }) } }] });

test('existing source options normalize only with complete source coverage, preserving original values and snapshots', async () => {
  const product = source(), original = structuredClone(product);
  product.attributes.push({ ...product.attributes[0], section: 'public duplicate' });
  const before = structuredClone(product);
  const result = await assistAttributeMapping(product, [field], config, { apiKey: 'fixture', fetcher: response([proposal]) });
  assert.deepEqual(result.product.attributes[0].value, proposal.values);
  assert.deepEqual(result.product.attributes[1].value, proposal.values);
  assert.deepEqual(result.product.attributes[0].aiOriginal.value, proposal.sourceValues);
  assert.equal(verifySourceIntegrity(result.product).valid, true);
  assert.deepEqual(product, before);
  assert.deepEqual(product.source, original.source);
  assert.equal(result.product.attributes.length, 2);
  for (const invalid of [
    { ...proposal, sourceValues: ['精油'], values: ['Essential Oil'] },
    { ...proposal, sourceValues: ['unknown'] }, { ...proposal, sourceValues: undefined },
    { ...proposal, quote: '精油' }, { ...proposal, evidenceId: 'e3', quote: 'Perfume bottle' },
    { ...proposal, values: ['Other'] },
  ]) {
    const result = await assistAttributeMapping(product, [field], config, { apiKey: 'fixture', fetcher: response([invalid]) });
    assert.equal(result.audit.accepted.length, 0);
    assert.equal(result.product, product);
  }
  const merged = await assistAttributeMapping(product, [field], config, { apiKey: 'fixture', fetcher: response([
    { ...proposal, sourceValues: ['精油'], values: ['Essential Oil'] },
    { ...proposal, sourceValues: ['洗发水'], values: ['Shampoo'] },
  ]) });
  assert.deepEqual(merged.product.attributes[0].value, proposal.values);
});

test('existing-value AI assistance respects manual edits, conflicting rows, custom rows and already matched controls', async () => {
  const variants = [];
  const edited = source(); edited.attributes[0].value = ['perfume']; variants.push(edited);
  const manual = source(); manual.attributes[0].source = 'manual'; variants.push(manual);
  const conflicting = source(); conflicting.attributes.push({ id: '19427', name: 'Use', value: 'Food' }); variants.push(conflicting);
  const custom = source(); custom.customAttributes = custom.attributes; custom.attributes = []; variants.push(custom);
  for (const product of variants) {
    const result = await assistAttributeMapping(product, [field], config, { fetcher: () => assert.fail('Protected source must not be sent for replacement') });
    assert.equal(result.product, product); assert.equal(result.audit, undefined);
  }
  const result = await assistAttributeMapping(source(), [{ ...field, needsMapping: false, hasValue: true }], config,
    { fetcher: () => assert.fail('Matched fields do not need AI') });
  assert.equal(result.audit, undefined);
});

test('literal supported choices survive conservative model scores while partial words, negations and uncertain translations are rejected', async () => {
  const product = { title: 'Bottle', attributes: [{ name: 'Compatible liquids', value: 'dispensing shampoo, essential oils, lotions, dish soaps', isCustom: true }] };
  const proposal = { fieldId: '19427', values: ['Essential Oil', 'Shampoo'], evidenceId: 'e1',
    quote: product.attributes[0].value, confidence: 0.9 };
  const accepted = await assistAttributeMapping(product, [field], config, { apiKey: 'fixture', fetcher: response([proposal]) });
  assert.deepEqual(accepted.audit.accepted[0].value, proposal.values);
  for (const quote of ['Not for essential oils or shampoo', 'nonessential oil shampoo', '精油, 洗发水']) {
    const input = { ...product, attributes: [{ ...product.attributes[0], value: quote }] };
    const result = await assistAttributeMapping(input, [field], config, { apiKey: 'fixture', fetcher: response([{ ...proposal, quote }]) });
    assert.equal(result.audit.accepted.length, 0, quote);
  }
});

test('existing-source normalization reaches native controls and reports both original and committed transfer values', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="struct-p-19427"><label class="label required">Use</label><select multiple><option value="oil" selected>Essential Oil</option><option value="shampoo">Shampoo</option></select></div>');
    let calls = 0;
    const session = createAttributeAiSession({
      resolve: (product, schema, context) => assistAttributeMapping(product, schema, config, { apiKey: 'fixture', ...context,
        fetcher: async (...args) => { calls++; return response([proposal])(...args); } }),
      readSchema: () => page.evaluate(readPostingAttributeSchema), fill: product => fillCategoryAttributes(page, product),
      matches: (field, item) => attributeFieldMatchesValue(field, item.value),
    });
    const result = await session.run(source());
    assert.equal(result.changed, true); assert.equal(calls, 1);
    await requireCategoryAttributes(page, result.product);
    const transfer = await requirePublicAttributeTransfer(page, result.product);
    assert.deepEqual(transfer[0].originalValue, proposal.sourceValues);
    assert.deepEqual(transfer[0].committedValues, proposal.values);
    assert.equal(verifySourceIntegrity(result.product).valid, true);
    assert.equal((await session.run(result.product, { phase: 'final-check' })).changed, false);
    assert.equal(calls, 1);
    await page.locator('select').selectOption('oil');
    await assert.rejects(requirePublicAttributeTransfer(page, result.product), { code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED' });
  } finally { await browser.close(); }
});

test('explicit validation mounts a dependent field, sends bounded feedback and retries only after native readback', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage(); await page.setContent('<main></main>');
    let product = source(), submitted = 0, requests = 0;
    const session = createAttributeAiSession({ readSchema: () => page.evaluate(readPostingAttributeSchema),
      fill: input => fillCategoryAttributes(page, input), matches: (field, item) => attributeFieldMatchesValue(field, item.value),
      resolve: (input, schema, context) => assistAttributeMapping(input, schema, config, { apiKey: 'fixture', ...context, fetcher: async (_url, options) => {
        requests++; const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
        assert.deepEqual(payload.feedback, { code: 'PUBLISH_REQUIRED_DATA_MISSING', fields: ['Use'] });
        assert.deepEqual(payload.fields[0].source.values, proposal.sourceValues);
        return response([proposal])();
      } }),
    });
    product = (await session.run(product)).product;
    assert.equal(requests, 0);
    const error = Object.assign(new Error('Use required'), { code: 'PUBLISH_REQUIRED_DATA_MISSING', requiredFields: ['Use'] });
    const result = await submitWithRepairs({ submit: async () => {
      submitted++;
      if (submitted === 1) {
        await page.setContent('<div class="sell-catProp-item" id="struct-p-19427"><label class="label required">Use</label><select multiple><option value="oil">Essential Oil</option><option value="shampoo">Shampoo</option></select></div>');
        throw error;
      }
      await requireCategoryAttributes(page, product); await requirePublicAttributeTransfer(page, product); return 'saved-fixture';
    }, repairs: { attributes: async error => {
      const mapped = await session.run(product, { phase: 'validation-repair', feedback: { code: error.code, fields: error.requiredFields } });
      product = mapped.product; return mapped.changed;
    } } });
    assert.equal(result, 'saved-fixture'); assert.equal(submitted, 2); assert.equal(requests, 1);
    assert.equal(session.audits[0].readback[0].accepted, true);
    assert.equal(session.audits[0].stage, 'validation-repair');
    for (const code of ['PUBLISH_SUBMIT_RESULT_UNKNOWN', 'PUBLISH_CONFIRMATION_PENDING', 'PUBLISH_ACCOUNT_LIMIT']) {
      let attempts = 0;
      await assert.rejects(submitWithRepairs({ submit: async () => { attempts++; throw Object.assign(new Error('Use required'), { code, requiredFields: ['Use'] }); },
        repairs: { attributes: () => assert.fail('No repair/resubmission after an uncertain receipt or account restriction') } }), { code });
      assert.equal(attempts, 1);
    }
  } finally { await browser.close(); }
});

test('AI repair session suppresses repeated unchanged requests, caps changing attempts and rejects uncommitted suggestions', async () => {
  let calls = 0;
  const session = createAttributeAiSession({ readSchema: async () => [field], fill: async () => {}, matches: () => false,
    resolve: async product => { calls++; return { product, audit: { accepted: [] } }; } });
  const product = source();
  for (let i = 0; i < 3; i++) await session.run(product);
  assert.equal(calls, 1);
  for (let i = 0; i < 10; i++) await session.run(product, { feedback: { code: 'VALIDATION', fields: [`field${i}`] } });
  assert.equal(calls, 4);
  const rejected = createAttributeAiSession({ readSchema: async () => [field], fill: async () => {}, matches: () => false,
    resolve: async product => ({ product, audit: { accepted: [{ id: '19427', value: 'Essential Oil' }] } }) });
  let attempts = 0;
  await assert.rejects(submitWithRepairs({ submit: async () => { attempts++; throw Object.assign(new Error('Use required'), { requiredFields: ['Use'] }); },
    repairs: { attributes: async () => (await rejected.run(product)).changed } }));
  assert.equal(attempts, 1); assert.equal(rejected.audits[0].readback[0].accepted, false);
});
