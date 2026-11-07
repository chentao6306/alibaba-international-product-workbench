import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { load } from 'cheerio';
import { findChromium } from '../server/browser-runtime.js';
import { readAlibabaAttributeRows } from '../server/category-attributes.js';
import { buildLegacyDescriptionHtml, fillProductSubtitle, applyPostingLogistics, requireLogisticsReady } from '../server/publisher.js';
import { restoreDescriptionImages } from '../server/description-layout.js';
import { alibabaKeywordText } from '../server/product-keywords.js';
import { imageListPatch } from '../server/product-image-api.js';

test('keyword fallback preserves short models, radio bands and memory sizes across categories without inventing terms', () => {
  for (const title of ['DOOV R77C 4G 3GB 32GB Phone', 'XL 2 PC Cotton Shirt', 'A4 80 GSM Exercise Book']) {
    assert.equal(alibabaKeywordText({ title, keywords: [' ', ''] }), title);
  }
  assert.equal(alibabaKeywordText({ title: 'Ignored title', keywords: ['My own keywords'] }), 'My own keywords');
});

const browserTest = (name, fn) => test(name, { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try { await fn(await browser.newPage()); } finally { await browser.close(); }
});

browserTest('collects every continuation of a merged description property for electronics, apparel and books', async page => {
  for (const [name, values] of [['Network Bands', ['2G GSM', '3G WCDMA', '4G LTE']], ['Size chart', ['S 60cm', 'M 65cm', 'L 70cm']], ['Contents', ['Chapter 1', 'Chapter 2', 'Chapter 3']]]) {
    for (const placeholders of [true, false]) {
      await page.setContent(`<div id="detail_decorate_root"><table><tr><td rowspan="3">${name}</td><td>${values[0]}</td></tr>
        <tr>${placeholders ? '<td rowspan="0"></td>' : ''}<td>${values[1]}</td></tr>
        <tr>${placeholders ? '<td rowspan="0"></td>' : ''}<td>${values[2]}</td></tr>
        <tr><td>Material</td><td>Paper</td></tr></table></div>`);
      const rows = await page.evaluate(readAlibabaAttributeRows, { description: true });
      assert.equal(rows.find(row => row.name === name).value, values.join(', '));
      assert.equal(rows.find(row => row.name === 'Material').value, 'Paper');
    }
  }
});

browserTest('published descriptions preserve image and table order after watermarking, without repeated source summaries', async page => {
  const original = { title: 'Item', description: 'Before Facts Material Cotton After Company Profile',
    descriptionHtml: '<p>Before</p><img src="https://source.test/1.jpg"><h3>Facts</h3><table><tr><td>Material</td><td>Cotton</td></tr></table><img src="https://source.test/2.jpg"><p>After</p>',
    detailImages: ['https://source.test/1.jpg', 'https://source.test/2.jpg'],
    attributes: [{ name: 'Material', value: 'Cotton' }, { name: 'Material', value: 'Cotton' }],
  };
  const before = structuredClone(original);
  const changed = { ...original, ...imageListPatch(original, { mainImages: [], detailImages: ['/media/watermark-1.jpg', '/media/watermark-2.jpg'] }) };
  const html = buildLegacyDescriptionHtml(changed);
  assert.doesNotMatch(html, /source\.test|<img|Company Profile/);
  assert.equal((load(html).text().match(/Cotton/g) || []).length, 1);
  await page.setContent('<div id="body"><img src="https://bank.test/1.jpg"><img src="https://bank.test/2.jpg"></div>');
  await page.evaluate(() => {
    const body = document.getElementById('body');
    window.tinymce = { editors: [{ getBody: () => body, setContent: value => { body.innerHTML = value; }, save() {}, fire() {} }] };
  });
  await restoreDescriptionImages(page, html, 2);
  const saved = await page.locator('#body').innerHTML();
  assert.ok(saved.indexOf('Before') < saved.indexOf('bank.test/1.jpg'));
  assert.ok(saved.indexOf('bank.test/1.jpg') < saved.indexOf('<table'));
  assert.ok(saved.indexOf('</table>') < saved.indexOf('bank.test/2.jpg'));
  assert.ok(saved.indexOf('bank.test/2.jpg') < saved.indexOf('After'));
  assert.deepEqual(original, before);
  await assert.rejects(restoreDescriptionImages(page, html, 3), { code: 'DETAIL_IMAGE_LAYOUT_FAILED' });
  const removed = { ...original, ...imageListPatch(original, { mainImages: [], detailImages: [] }) };
  assert.doesNotMatch(buildLegacyDescriptionHtml(removed), /data-workbench-source-image/);
});

browserTest('subtitle rejection is reported while unavailable optional fields remain distinct', async page => {
  page.setDefaultTimeout(200);
  // Keep rejection retries short without imposing a 200 ms document-load
  // budget on Chromium when the complete suite runs concurrently.
  page.setDefaultNavigationTimeout(10000);
  await page.setContent('<div id="struct-productSubTitle"></div><input name="unrelated" value="Keep">');
  assert.equal(await fillProductSubtitle(page, { subtitle: 'Seller subtitle' }), false);
  await page.setContent('<div id="struct-productSubTitle"><input></div>');
  assert.equal(await fillProductSubtitle(page, { subtitle: 'Seller subtitle' }), true);
  assert.equal(await page.locator('input').inputValue(), 'Seller subtitle');
  await page.locator('input').evaluate(node => { node.oninput = () => { node.value = ''; }; });
  await assert.rejects(fillProductSubtitle(page, { subtitle: 'Rejected' }), { code: 'PUBLISH_FIELD_NOT_READY' });
});

browserTest('image layout also survives an editable iframe without a global TinyMCE instance', async page => {
  await page.setContent('<textarea id="detail"></textarea><iframe id="detail_ifr"></iframe>');
  const frame = page.frames()[1];
  await frame.setContent('<body contenteditable="true"><img src="https://bank.test/photo.jpg"></body>');
  await restoreDescriptionImages(page, '<p>Before</p><span data-workbench-source-image="0"></span><p>After</p>', 1);
  const html = await page.locator('textarea').inputValue();
  assert.ok(html.indexOf('Before') < html.indexOf('<img'));
  assert.ok(html.indexOf('<img') < html.indexOf('After'));
  assert.equal(await frame.locator('body').innerHTML(), html);
});

browserTest('an unavailable packaging form is never reported as complete logistics or written into unrelated fields', async page => {
  await page.setContent('<p>当前商品类型：商机品</p><div id="struct-sizeWeight"></div><div id="struct-pkgWeight"></div><input name="other" value="Keep">');
  const product = { title: 'Phone', packaging: { weight: '0.3', length: '19', width: '13', height: '11' } };
  const options = { listingMode: 'auto' };
  await applyPostingLogistics(page, product, options);
  await requireLogisticsReady(page, product, options);
  assert.equal(options.effectiveListingMode, 'inquiry');
  assert.equal(options.logisticsDecision.packagingControls, 'unavailable');
  assert.match(options.logisticsWarnings.join(''), /未写入平台/);
  assert.doesNotMatch(buildLegacyDescriptionHtml(product), /0.3 kg/);
  assert.equal(product.packaging.weight, '0.3');
  assert.equal(await page.locator('input').inputValue(), 'Keep');
  await assert.rejects(requireLogisticsReady(page, product, { listingMode: 'complete-logistics' }), error => error.unmatchedSourceFields.includes('包装重量和尺寸输入项'));
});
