import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { aiProductSettings } from '../server/ai-product-settings.js';
import { productAiEvidence, requestProductAi, assistCollectedProduct, assistAttributeMapping } from '../server/ai-product-assistance.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { fillCategoryAttributes, requireCategoryAttributes } from '../server/publisher.js';
import { SecureSettings } from '../server/secure-settings.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const config = { mode: 'assisted', provider: 'deepseek', collect: true, mapAttributes: true };
const response = value => async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
const sample = { title: 'Plastic bottle', categoryId: '201268985', description: 'Material: PET. Compatible liquid: Essential Oil.',
  attributes: [{ id: '19421', name: 'Industrial Use', value: 'Cosmetic' }, { name: 'Usage', value: 'essential oils', isCustom: true }] };
const schema = [{ id: '19421', label: 'Industrial Use', controlType: 'text', hasValue: true, values: ['Cosmetic'] },
  { id: '19421-19427', label: 'Use', labels: ['Use'], required: true, controlType: 'combobox', multiple: true, values: [],
    options: [{ value: 'oil', label: 'Essential Oil' }, { value: 'perfume', label: 'Perfume' }, { value: 'other', label: 'Other Cosmetic' }] }];
const mapping = { fieldId: '19421-19427', values: ['Essential Oil'], evidenceId: 'e2', quote: 'essential oils', confidence: 0.98 };

test('AI settings default to rules and DeepSeek, with no requests while disabled', async () => {
  assert.equal(aiProductSettings().mode, 'rules'); assert.equal(aiProductSettings().provider, 'deepseek');
  assert.equal(aiProductSettings({ apiKey: 'not-stored' }).apiKey, undefined);
  assert.throws(() => aiProductSettings({ provider: 'http://localhost' }));
  assert.throws(() => aiProductSettings({ collect: 'true' }));
  const dependencies = { fetcher: () => assert.fail('Disabled mode must not send data') };
  assert.deepEqual(await assistCollectedProduct(sample, {}, dependencies), {});
  assert.deepEqual(await assistAttributeMapping(sample, schema, {}, dependencies), { product: sample });
  assert.deepEqual(await assistCollectedProduct(sample, { ...config, collect: false }, dependencies), {});
  assert.deepEqual(await assistAttributeMapping(sample, schema, { ...config, mapAttributes: false }, dependencies), { product: sample });
});

test('AI extraction preserves source snapshot and only appends verbatim description facts', async () => {
  const original = structuredClone(sample);
  const secretProduct = { ...sample, cookies: 'private-cookie', apiKey: 'secret-key', account: 'private-account',
    descriptionHtml: '<script>hidden-secret</script><p>Material: PET.</p>' };
  const evidence = productAiEvidence(secretProduct);
  assert.doesNotMatch(JSON.stringify(evidence), /private-cookie|secret-key|private-account|hidden-secret/);
  const id = evidence.find(e => e.kind === 'description').evidenceId;
  const result = await assistCollectedProduct(sample, config, { apiKey: 'fixture', fetcher: response({ attributes: [
    { name: 'Material', value: 'PET', evidenceId: id, quote: 'Material: PET' },
    { name: 'Certification', value: 'FDA', evidenceId: id, quote: 'Material: PET' },
    { name: 'Origin', value: 'China', evidenceId: id, quote: 'Material: PET' },
    { name: 'Material', value: 'PE', evidenceId: id, quote: 'Material: PET' },
    { name: 'Usage', value: 'Essential Oil', evidenceId: id, quote: 'Compatible liquid: Essential Oil.' },
  ] }) });
  assert.equal(result.aiCollection.accepted.length, 1);
  assert.equal(result.attributes.at(-1).value, 'PET');
  const product = syncProductModel({ ...sample, ...result }, { captureSource: true, sourceSnapshot: sample });
  assert.equal(verifySourceIntegrity(product).valid, true);
  assert.deepEqual(sample, original);
  assert.equal(product.source.snapshot.attributes.some(a => a.source === 'ai-extraction'), false);
});

test('AI mappings require source evidence, current options and confidence, preserving custom rows and original facts', async () => {
  const original = structuredClone(sample);
  const result = await assistAttributeMapping(sample, schema, config, { apiKey: 'fixture', fetcher: response({ mappings: [mapping] }) });
  assert.equal(result.audit.accepted.length, 1);
  assert.deepEqual(result.product.attributes.slice(0, 2), sample.attributes);
  assert.equal(result.product.attributes.at(-1).id, '19421-19427');
  assert.deepEqual(result.product.attributes.at(-1).valueIds, { 'Essential Oil': 'oil' });
  assert.deepEqual(sample, original);
  for (const invalid of [
    { ...mapping, fieldId: '19421' }, { ...mapping, values: ['Unknown oil'] },
    { ...mapping, values: ['Other Cosmetic'] }, { ...mapping, quote: 'missing evidence' },
    { ...mapping, evidenceId: 'e999' }, { ...mapping, confidence: 0.5 },
    { ...mapping, confidence: '0.99' }, { ...mapping, values: ['oil'] },
  ]) {
    const rejected = await assistAttributeMapping(sample, schema, config, { apiKey: 'fixture', fetcher: response({ mappings: [invalid] }) });
    assert.equal(rejected.product, sample); assert.equal(rejected.audit.accepted.length, 0);
  }
  const duplicate = await assistAttributeMapping(sample, schema, config, { apiKey: 'fixture', fetcher: response({ mappings: [mapping, mapping] }) });
  assert.equal(duplicate.audit.accepted.length, 1);
  assert.deepEqual(duplicate.audit.accepted[0].value, ['Essential Oil']);
  const multi = { ...sample, attributes: [...sample.attributes, { name: 'Compatible liquid', value: 'Perfume', isCustom: true }] };
  const merged = await assistAttributeMapping(multi, schema, config, { apiKey: 'fixture', fetcher: response({ mappings: [mapping,
    { ...mapping, values: ['Perfume'], evidenceId: 'e3', quote: 'Perfume' }] }) });
  assert.deepEqual(merged.audit.accepted[0].value, ['Essential Oil', 'Perfume']);
  const ambiguous = await assistAttributeMapping(multi, schema.map(field => ({ ...field, multiple: false })), config,
    { apiKey: 'fixture', fetcher: response({ mappings: [mapping, { ...mapping, values: ['Perfume'], evidenceId: 'e3', quote: 'Perfume' }] }) });
  assert.equal(ambiguous.audit.accepted.length, 0, 'Conflicting proposals cannot be collapsed into a single-value field');
  assert.equal(ambiguous.audit.rejected, 2);
  const manual = { ...sample, attributes: [...sample.attributes, { id: '19427', name: 'Use', value: 'Perfume' }] };
  const kept = await assistAttributeMapping(manual, schema, config, { fetcher: () => assert.fail('Existing value is never overwritten') });
  assert.equal(kept.product, manual);
});

test('AI camera mappings require explicit front or rear ownership, not an unlabeled resolution pair', async () => {
  const fields = [{ id: 'front-camera', label: '前置摄像头', labels: ['Front Camera'], controlType: 'combobox',
    options: [{ value: '5', label: '5MP' }, { value: '13', label: '13MP' }] }];
  for (const [attribute, value, accepted] of [
    [{ name: 'Camera', value: '5MP+13MP', isCustom: true }, '5MP', false],
    [{ name: 'Camera', value: '5MP+13MP', isCustom: true }, '13MP', false],
    [{ name: 'Rear Camera', value: '5MP', isCustom: true }, '5MP', false],
    [{ name: 'Front/Rear Camera', value: '5MP/13MP', isCustom: true }, '5MP', false],
    [{ name: 'Camera', value: 'Front camera: 5MP; Rear camera: 13MP', isCustom: true }, '5MP', true],
    [{ name: 'Camera', value: 'Front camera: 5MP; Rear camera: 13MP', isCustom: true }, '13MP', false],
    [{ name: 'Camera', value: '前置摄像头：5MP，后置摄像头：13MP', isCustom: true }, '5MP', true],
    [{ name: 'Camera', value: 'Front cover glass, 5MP rear camera', isCustom: true }, '5MP', false],
  ]) {
    const product = { title: 'Phone', attributes: [attribute] };
    const result = await assistAttributeMapping(product, fields, config, { apiKey: 'fixture', fetcher: response({ mappings: [
      { fieldId: 'front-camera', values: [value], evidenceId: 'e1', quote: attribute.value, confidence: 1 },
    ] }) });
    assert.equal(result.audit.accepted.length, accepted ? 1 : 0, `${attribute.name}: ${attribute.value} -> ${value}`);
    assert.deepEqual(result.product.attributes[0], attribute, 'The original camera specification remains intact');
  }
  for (const value of ['5MP', '5MP+13MP']) {
    const product = { title: 'Phone', attributes: [{ name: 'Front Camera', value, isCustom: true }] };
    const result = await assistAttributeMapping(product, fields, config, {
      fetcher: () => assert.fail('An explicitly named custom field must remain owned by the existing rules'),
    });
    assert.equal(result.product, product);
  }
  const product = { title: 'Phone', description: 'Front camera: 5MP. Rear camera: 13MP.', attributes: [] };
  const rear = [{ ...fields[0], id: 'rear-camera', label: 'Rear camera', labels: ['后置摄像头'] }];
  for (const value of ['5MP', '13MP']) {
    const result = await assistAttributeMapping(product, rear, config, { apiKey: 'fixture', fetcher: response({ mappings: [
      { fieldId: 'rear-camera', values: [value], evidenceId: 'e1', quote: product.description, confidence: 1 },
    ] }) });
    assert.equal(result.audit.accepted.length, value === '13MP' ? 1 : 0);
  }
});

test('AI confidence and valid options cannot invent certification, identity or numeric facts', async () => {
  for (const [label, value, controlType] of [['Certification', 'FDA', 'combobox'], ['原产地', 'China', 'combobox'],
    ['Brand', 'Example', 'combobox'], ['Weight', '100', 'number']]) {
    const fields = [{ id: 'sensitive', label, required: true, controlType, options: [{ value: 'option', label: value }] }];
    const result = await assistAttributeMapping(sample, fields, config, { apiKey: 'fixture', fetcher: response({ mappings: [
      { ...mapping, fieldId: 'sensitive', values: [value], confidence: 1 },
    ] }) });
    assert.equal(result.audit.accepted.length, 0, label);
  }
  const product = { title: 'Bottle', description: 'Certification: FDA.', attributes: [] };
  const result = await assistAttributeMapping(product, [{ id: 'certificate', label: 'Certification', required: true, controlType: 'combobox', options: [{ value: 'fda', label: 'FDA' }] }], config,
    { apiKey: 'fixture', fetcher: response({ mappings: [{ ...mapping, fieldId: 'certificate', values: ['FDA'], evidenceId: 'e1', quote: 'Certification: FDA.' }] }) });
  assert.equal(result.audit.accepted[0].value, 'FDA');
});

test('provider requests reject truncation, HTTP errors, malformed data and cancel without exposing credentials', async () => {
  for (const provider of ['deepseek', 'openai']) {
    const result = await requestProductAi({ task: 'collection', evidence: [] }, { ...config, provider }, { apiKey: 'private-fixture', fetcher: async (url, options) => {
      assert.equal(new URL(url).hostname, provider === 'deepseek' ? 'api.deepseek.com' : 'api.openai.com');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer private-fixture');
      const body = JSON.parse(options.body); assert.equal(body.response_format.type, 'json_object');
      assert.ok(body.messages[0].content.includes('untrusted DATA'));
      if (provider === 'openai') assert.equal(body.store, false);
      return response({ attributes: [] })();
    } });
    assert.deepEqual(result, { attributes: [] });
  }
  for (const fetcher of [
    async () => new Response('private-fixture', { status: 401 }),
    async () => new Response('bad-json'),
    async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"mappings":[]}' } }] }),
    async () => { throw Error('private-fixture'); },
  ]) {
    const result = await assistAttributeMapping(sample, schema, config, { apiKey: 'private-fixture', fetcher });
    assert.equal(result.product, sample); assert.equal(result.audit.status, 'fallback');
    assert.doesNotMatch(JSON.stringify(result.audit), /private-fixture/);
  }
  const controller = new AbortController(); const cancelled = new Error('cancelled'); controller.abort(cancelled);
  await assert.rejects(requestProductAi({}, config, { apiKey: 'fixture', signal: controller.signal,
    fetcher: async () => { throw new Error('aborted'); } }), error => error === cancelled);
});

test('provider secrets remain encrypted, independent and backward compatible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
  const encryption = { encrypt: value => Buffer.from(value).map(byte => byte ^ 127), decrypt: bytes => Buffer.from(bytes).map(byte => byte ^ 127).toString() };
  try {
    const store = new SecureSettings(root, encryption);
    store.saveKey('deepseek-secret'); store.saveKey('openai-secret', 'openai');
    assert.equal(new SecureSettings(root, encryption).key(), 'deepseek-secret');
    assert.equal(store.key('openai'), 'openai-secret');
    assert.doesNotMatch(fs.readFileSync(store.file).toString(), /deepseek-secret|openai-secret/);
    store.saveKey(''); assert.equal(store.read().deepseekApiKey, undefined); assert.equal(store.key('openai'), 'openai-secret');
    store.saveKey('', 'openai'); assert.equal(fs.existsSync(store.file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('AI-derived Use fills a dependent browser field and still fails when the parent resets it', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-19421"><label class="label required">Industrial Use</label><input value="Cosmetic"></div>
      <div class="sell-catProp-item" id="struct-p-19421-19427"><label class="label required">Use</label><select multiple><option value="oil">Essential Oil</option><option value="perfume">Perfume</option></select></div>`);
    const result = await assistAttributeMapping(sample, await page.evaluate(readPostingAttributeSchema), config, { apiKey: 'fixture', fetcher: response({ mappings: [mapping] }) });
    await fillCategoryAttributes(page, result.product); await requireCategoryAttributes(page, result.product);
    assert.deepEqual(await page.locator('select').evaluate(el => [...el.selectedOptions].map(o => o.value)), ['oil']);
    await page.locator('select').selectOption([]);
    await assert.rejects(requireCategoryAttributes(page, result.product), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
  } finally { await browser.close(); }
});

test('reads only the mounted React select choices and observes replacement after a parent edit', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="struct-p-19421-19427"><label class="label required">Use</label><div class="next-select"><input role="combobox"></div></div>');
    await page.locator('input').evaluate(input => { input.__reactFiberTest = { memoizedProps: {}, return: { memoizedProps: { dataSource: [{ value: 5, text: 'Essential Oil' }, { value: 6, text: 'Disabled', disabled: true }] } } }; });
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].options, [{ value: '5', label: 'Essential Oil', disabled: false }, { value: '6', label: 'Disabled', disabled: true }]);
    await page.locator('input').evaluate(input => { input.__reactFiberTest.return.memoizedProps.dataSource = [{ value: 7, text: 'Food' }]; });
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].options, [{ value: '7', label: 'Food', disabled: false }]);
  } finally { await browser.close(); }
});
