import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { applyPostingLogistics, requireLogisticsReady, buildLegacyDescriptionHtml } from '../server/publisher.js';

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

browserTest('auto accepts both absent and partial shipping data as inquiry without erasing source packaging or origin', async (page) => {
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
    assert.match(stages[0], /包装资料保留在详情/);
    assert.deepEqual(await page.locator('#pkgWeight input, #pkgMeasure input').evaluateAll(nodes => nodes.map(node => node.value)), ['', '', '', '']);
    assert.equal(await page.locator('#origin').inputValue(), 'China');
    assert.deepEqual(product, before);
    if (source.weight) assert.match(buildLegacyDescriptionHtml(product), /2 kg/);
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
      assert.ok(error.missingSourceFields.includes('运费模板'));
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
