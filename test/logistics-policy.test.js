import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { applyPostingLogistics, requireLogisticsReady, buildLegacyDescriptionHtml, fillCartonMode } from '../server/publisher.js';
import { DEFAULT_FREIGHT_TEMPLATE } from '../server/publish-policy.js';
import { createEditorForm, editorPayload } from '../src/product-editor-model.js';
import { logisticsControlValue, missingLogisticsFields } from '../server/posting-logistics.js';

const packaging = { weight: 2, length: 26.5, width: 23.1, height: 24.7 };
const form = ({ opportunity = true, required = false, selected = '', freight = '' } = {}) => `
  <p>当前商品类型：${opportunity ? '商机品' : '交易品'}</p>
  <div class="sell-catProp-item"><input value="China" id="origin"></div>
  <div id="pkgWeight"><input name="pkgWeight" ${required ? 'required' : ''}></div>
  <div id="pkgMeasure"><input><input><input></div>
  <div id="logisticsProperty"><span class="logistics-property-content">${selected}</span></div>
  <div id="shippingTemplateId"><input readonly value="${freight}"></div>`;
function browserTest(name, fn) {
  test(name, { skip: !findChromium() }, async () => {
    const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    try { await fn(await browser.newPage()); } finally { await browser.close(); }
  });
}

test('logistics validation rejects positive values changed by a rerender and checks converted units', () => {
  const source = { weight: 0.5, length: 14, width: 10, height: 6 };
  const fields = [{ key: 'weight', unit: 'g' }, { key: 'length', unit: 'mm' },
    { key: 'width', unit: 'in' }, { key: 'height', unit: 'm' }, { key: 'volume', unit: 'm3' }]
    .map(field => ({ ...field, value: logisticsControlValue(source, field) }));
  assert.deepEqual(missingLogisticsFields(fields, source, { complete: true }), []);
  for (const field of fields) {
    const changed = fields.map(item => item === field ? { ...item, value: String(Number(item.value) * 2) } : item);
    assert.deepEqual(missingLogisticsFields(changed, source).map(item => [item.field, item.reason]), [[field.key, 'not_committed']]);
  }
  assert.deepEqual(missingLogisticsFields([{ key: 'weight', unit: 'kg', value: 'Infinity' }], source, { complete: true })
    .map(item => item.reason), ['not_committed']);
  assert.deepEqual(missingLogisticsFields([{ key: 'weight', unit: 'kg', value: '2' }], {}), []);
});

browserTest('submission readiness detects a positive package value replaced after the initial fill', async page => {
  await page.setContent(form({ selected: '普货', freight: 'My freight' }));
  const product = { packaging, logisticsAttributes: ['普货'] };
  const options = { listingMode: 'complete-logistics' };
  await applyPostingLogistics(page, product, options);
  await requireLogisticsReady(page, product, options);
  await page.locator('#pkgWeight input').fill('3');
  await assert.rejects(requireLogisticsReady(page, product, options), error => error.unmatchedSourceFields.includes('包装重量'));
  await applyPostingLogistics(page, product, options);
  await requireLogisticsReady(page, product, options);
  assert.equal(await page.locator('#pkgWeight input').inputValue(), '2');
});

browserTest('auto preserves supplied and existing packaging independently of missing inquiry cargo and freight', async (page) => {
  for (const source of [{}, packaging, { weight: 2 }]) {
    const product = { title: 'Toy', packaging: source, source: { snapshot: { packaging: structuredClone(source) } } };
    const before = structuredClone(product);
    await page.setContent(form());
    // A previous editor pass can leave a partial package in the form.
    await page.locator('#pkgWeight input').fill('2');
    const stages = [];
    const options = { listingMode: 'auto', onLogisticsDecision: stage => stages.push(stage) };
    await applyPostingLogistics(page, product, options);
    await requireLogisticsReady(page, product, options);
    assert.equal(options.listingMode, 'auto');
    assert.equal(options.effectiveListingMode, 'inquiry');
    assert.ok(options.logisticsDecision.missingFields.includes('物流属性'));
    assert.match(stages[0], /已有包装资料填写到可用控件并核对/);
    assert.deepEqual(await page.locator('#pkgWeight input, #pkgMeasure input').evaluateAll(nodes => nodes.map(node => node.value)),
      ['2', source.length ? String(source.length) : '', source.width ? String(source.width) : '', source.height ? String(source.height) : '']);
    assert.equal(await page.locator('#origin').inputValue(), 'China');
    assert.deepEqual(product, before);
    assert.doesNotMatch(buildLegacyDescriptionHtml(product), /2 kg/);
    // Repeated form passes must make the same decision.
    await applyPostingLogistics(page, product, options);
    assert.equal(options.effectiveListingMode, 'inquiry');
  }
});

browserTest('complete logistics rejects both all-empty and partially filled data with exact missing dependencies', async (page) => {
  for (const source of [{}, packaging]) {
    await page.setContent(form());
    const product = { packaging: source };
    const options = { listingMode: 'complete-logistics' };
    await applyPostingLogistics(page, product, options);
    await assert.rejects(requireLogisticsReady(page, product, options), error => {
      assert.equal(error.code, 'PUBLISH_REQUIRED_DATA_MISSING');
      assert.ok(error.missingSourceFields.includes('物流属性'));
      assert.ok(error.unmatchedSourceFields.includes('运费模板'));
      assert.equal(error.missingSourceFields.includes('包装重量'), !source.weight);
      assert.match(error.message, /自动判断\/询盘展示/);
      return true;
    });
    assert.equal(options.effectiveListingMode, 'complete-logistics');
  }
});

browserTest('auto uses verified complete shipping without substituting a different cargo attribute', async (page) => {
  await page.setContent(form({ selected: '内置电池', freight: 'My freight' }));
  const product = { packaging, logisticsAttributes: ['内置电池'] };
  const options = { listingMode: 'auto' };
  await applyPostingLogistics(page, product, options);
  await requireLogisticsReady(page, product, options);
  assert.equal(options.effectiveListingMode, 'complete-logistics');
  assert.equal(await page.locator('#pkgWeight input').inputValue(), '2');
  assert.equal(await page.locator('.logistics-property-content').textContent(), '内置电池');
  await page.locator('.logistics-property-content').evaluate(node => node.textContent = '普货');
  await assert.rejects(requireLogisticsReady(page, product, options), error => error.unmatchedSourceFields.includes('物流属性'));
  await page.locator('.logistics-property-content').evaluate(node => node.textContent = '不含内置电池');
  await assert.rejects(requireLogisticsReady(page, product, options), error => error.unmatchedSourceFields.includes('物流属性'));
});

browserTest('auto does not clear shipping on transactional or required shipping forms', async (page) => {
  for (const config of [{ opportunity: false }, { required: true }]) {
    await page.setContent(form(config));
    const product = { packaging };
    const options = { listingMode: 'auto' };
    await applyPostingLogistics(page, product, options);
    assert.equal(options.effectiveListingMode, 'complete-logistics');
    assert.equal(await page.locator('#pkgWeight input').inputValue(), '2');
    await assert.rejects(requireLogisticsReady(page, product, options), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
  }
  await page.setContent(form());
  await page.locator('#logisticsProperty').evaluate(node => node.setAttribute('aria-required', 'true'));
  await assert.rejects(applyPostingLogistics(page, { packaging }, { listingMode: 'inquiry' }), { code: 'PUBLISH_SALES_MODE_MISMATCH' });
});

browserTest('complete logistics detects a freight selection lost after rendering', async (page) => {
  await page.setContent(form({ selected: '普货', freight: 'My freight' }));
  const product = { packaging, logisticsAttributes: ['普货'], freightTemplate: 'My freight' };
  await page.locator('#pkgWeight input').fill('2');
  const dimensions = page.locator('#pkgMeasure input');
  for (const [index, value] of [26.5, 23.1, 24.7].entries()) await dimensions.nth(index).fill(String(value));
  await requireLogisticsReady(page, product, { listingMode: 'complete-logistics' });
  await page.locator('#shippingTemplateId input').evaluate(node => node.value = 'Different template');
  await assert.rejects(requireLogisticsReady(page, product, { listingMode: 'complete-logistics' }), error => error.unmatchedSourceFields.includes('运费模板'));
  await page.locator('#shippingTemplateId input').evaluate(node => node.value = 'Ocean 1');
  await assert.rejects(requireLogisticsReady(page, { ...product, freightTemplate: 'Air 1' }, { listingMode: 'complete-logistics' }), error => error.unmatchedSourceFields.includes('运费模板'));
  await page.locator('#shippingTemplateId input').evaluate(node => node.value = '');
  await assert.rejects(requireLogisticsReady(page, product, { listingMode: 'complete-logistics' }), error => error.unmatchedSourceFields.includes('运费模板'));
});

browserTest('auto selects negotiated freight for missing settings and retains factual packaging without inventing cargo attributes', async (page) => {
  const product = { packaging: { weight: '0.943', length: '15', width: '10', height: '10' } };
  const before = structuredClone(product);
  const editable = createEditorForm(product);
  assert.equal(editable.freightTemplate, DEFAULT_FREIGHT_TEMPLATE);
  assert.equal(editable.shipping.cartonMode, '一箱多件');
  assert.deepEqual(editable.packaging, product.packaging);
  assert.deepEqual(editable.logisticsAttributes, []);
  assert.equal(editorPayload(editable).freightTemplate, DEFAULT_FREIGHT_TEMPLATE);
  assert.equal(editorPayload(editable).shipping.cartonMode, '一箱多件');
  assert.deepEqual(createEditorForm({ shipping: 'Source delivery notes' }).shipping, { notes: 'Source delivery notes', cartonMode: '一箱多件' });
  for (const cargo of ['', '内置电池']) {
    await page.setContent(form({ selected: cargo }).replace('<input readonly value="">',
      `<select><option value="">请选择</option><option value="paid">店铺空运模板</option><option value="negotiated">${DEFAULT_FREIGHT_TEMPLATE}</option></select>`));
    const source = { ...product, ...(cargo ? { logisticsAttributes: [cargo] } : {}) };
    const options = { listingMode: 'auto' };
    await applyPostingLogistics(page, source, options);
    await requireLogisticsReady(page, source, options);
    assert.equal(await page.locator('#shippingTemplateId select').inputValue(), 'negotiated');
    assert.equal(options.effectiveListingMode, cargo ? 'complete-logistics' : 'inquiry');
    assert.equal(await page.locator('#pkgWeight input').inputValue(), '0.943');
    assert.equal(await page.locator('.logistics-property-content').textContent(), cargo);
    assert.doesNotMatch(buildLegacyDescriptionHtml(source), /0.943 kg/);
  }
  assert.deepEqual(product, before);
});

browserTest('carton defaults choose multiple items per carton while keeping explicit edits and unrelated radios', async (page) => {
  await page.setContent(form({ selected: '普货', freight: DEFAULT_FREIGHT_TEMPLATE }) + `
    <fieldset><legend>箱规</legend><label><input type="radio" name="carton" value="single" checked>一箱一件</label>
    <label><input type="radio" name="carton" value="multiple">一箱多件</label><label><input type="radio" name="carton" value="managed">智能托管</label></fieldset>
    <label><input type="radio" name="service" checked>不支持</label>`);
  await applyPostingLogistics(page, { packaging }, { listingMode: 'auto' });
  assert.equal(await page.getByRole('radio', { name: '一箱多件', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('radio', { name: '不支持', exact: true }).isChecked(), true);
  const edited = { shipping: { cartonMode: '一箱一件' } };
  assert.equal(createEditorForm(edited).shipping.cartonMode, '一箱一件');
  assert.equal(await fillCartonMode(page, edited), true);
  assert.equal(await page.getByRole('radio', { name: '一箱一件', exact: true }).isChecked(), true);
  await page.setContent('<label>箱规<select><option value="">请选择</option><option value="multi">一箱多件</option></select></label>');
  assert.equal(await fillCartonMode(page, {}), true);
  assert.equal(await page.locator('select').inputValue(), 'multi');
});

browserTest('freight defaults preserve an existing choice and cannot substitute an unrelated or disabled template', async (page) => {
  assert.equal(createEditorForm({ freightTemplate: '店铺空运模板' }).freightTemplate, '店铺空运模板');
  for (const chosen of ['', 'paid']) {
    await page.setContent(form({ selected: '普货' }).replace('<input readonly value="">',
      `<select><option value="">请选择</option><option value="paid" ${chosen ? 'selected' : ''}>店铺空运模板</option><option value="negotiated" disabled>${DEFAULT_FREIGHT_TEMPLATE}</option></select>`));
    const source = { packaging, logisticsAttributes: ['普货'] };
    const options = { listingMode: 'auto' };
    await applyPostingLogistics(page, source, options);
    assert.equal(await page.locator('#shippingTemplateId select').inputValue(), chosen);
    await requireLogisticsReady(page, source, options);
    assert.equal(options.effectiveListingMode, chosen ? 'complete-logistics' : 'inquiry');
    assert.equal(await page.locator('#pkgWeight input').inputValue(), '2');
  }
});

browserTest('inquiry validates supplied package and cargo values after rerender without requiring absent optional dimensions', async page => {
  await page.setContent(form({ selected: '内置电池' }));
  const product = { packaging: { weight: 0.5 }, logisticsAttributes: ['内置电池'] };
  const options = { listingMode: 'inquiry' };
  await applyPostingLogistics(page, product, options);
  await requireLogisticsReady(page, product, options);
  assert.equal(await page.locator('#pkgWeight input').inputValue(), '0.5');
  for (const replaced of ['', '1']) {
    await page.locator('#pkgWeight input').fill(replaced);
    await assert.rejects(requireLogisticsReady(page, product, options), error => error.unmatchedSourceFields.includes('包装重量'));
  }
  await applyPostingLogistics(page, product, options);
  await page.locator('.logistics-property-content').evaluate(node => node.textContent = '普货');
  await assert.rejects(requireLogisticsReady(page, product, options), error => error.unmatchedSourceFields.includes('物流属性'));
});

browserTest('inquiry preserves a deliberate freight choice and reports an unavailable custom selection', async page => {
  await page.setContent(form({ freight: 'Seller air freight' }));
  const product = { packaging, freightTemplate: 'Seller air freight' };
  const options = { listingMode: 'inquiry' };
  await applyPostingLogistics(page, product, options);
  await requireLogisticsReady(page, product, options);
  await page.locator('#shippingTemplateId input').evaluate(node => node.value = 'Different freight');
  await assert.rejects(requireLogisticsReady(page, product, options), error => error.unmatchedSourceFields.includes('运费模板'));
});

browserTest('English opportunity forms with either native colon preserve packaging without fabricating freight', async page => {
  for (const separator of [':', '：']) {
    await page.setContent(form().replace('当前商品类型：商机品', `Current Item Type${separator} Business opportunity product`));
    const product = { packaging };
    const options = { listingMode: 'auto' };
    await applyPostingLogistics(page, product, options);
    assert.equal(options.effectiveListingMode, 'inquiry');
    await requireLogisticsReady(page, product, options);
    assert.equal(await page.locator('#pkgWeight input').inputValue(), '2');
    assert.equal(await page.locator('.logistics-property-content').textContent(), '');
  }
});
