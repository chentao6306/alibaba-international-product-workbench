import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { descriptionSourceHash } from '../server/description-structure.js';
import { buildLegacyDescriptionHtml } from '../server/publisher.js';
import { compatibleLegacyDescriptionHtml, compatibleDescriptionFingerprint, acceptCompatibleLegacyDescription, requireCompatibleLegacyDescription } from '../server/description-compatibility.js';
import { restoreDescriptionImages } from '../server/description-layout.js';

const original = '<h2>Features</h2><p>Reusable silicone</p><p><img src="https://sc04.alicdn.com/second.jpg"></p>'
  + '<table><tr><th>Size</th><td colspan="2">Small &amp; large</td></tr></table>'
  + '<p>Company facts.</p><p>Can it be reused?</p><p>Yes, wash it.</p><img src="https://sc04.alicdn.com/first.jpg">';
const product = { descriptionHtml: original, detailImages: ['https://sc04.alicdn.com/first.jpg', 'https://sc04.alicdn.com/second.jpg'],
  videos: [{ role: 'detail', url: 'https://example.com/video.mp4' }],
  structuredDescription: { version: 1, sourceHtmlHash: descriptionSourceHash(original), modules: [
    { type: 'highlights', title: 'Features', items: ['Reusable silicone'] },
    { type: 'html', html: '<table><tr><th>Size</th><td colspan="2">Small &amp; large</td></tr></table>' },
    { type: 'company', title: 'Company', text: 'Company facts.' },
    { type: 'faq', title: 'FAQ', items: [{ question: 'Can it be reused?', answer: 'Yes, wash it.' }] },
    { type: 'gallery', title: 'Gallery', scope: 'product', images: [{ url: 'https://sc04.alicdn.com/first.jpg', caption: '' }, { url: 'https://sc04.alicdn.com/second.jpg', caption: '' }] },
  ] } };

test('legacy readback tolerates editor trimming block edges while retaining meaningful inline spacing', () => {
  assert.deepEqual(compatibleDescriptionFingerprint('<div> Heading </div><div><span> Body text </span></div>'),
    compatibleDescriptionFingerprint('<div>Heading</div><div>Body text</div>'));
  assert.notDeepEqual(compatibleDescriptionFingerprint('<p>Body text</p>'), compatibleDescriptionFingerprint('<p>Bodytext</p>'));
});

test('compatible description retains source text, tables, FAQ and image order without mutating source or videos', () => {
  const before = structuredClone(product);
  const html = compatibleLegacyDescriptionHtml(product, buildLegacyDescriptionHtml(product));
  assert.match(html, /colspan="2"/);
  assert.match(html, /Can it be reused\?/);
  assert.match(html, /<h3>Company<\/h3>/);
  assert.match(html, /<h3>FAQ<\/h3>/);
  assert.ok(html.indexOf('source-image="1"') < html.indexOf('source-image="0"'));
  assert.deepEqual(product, before);
  const plan = buildLegacyDescriptionHtml(product);
  assert.throws(() => compatibleLegacyDescriptionHtml(product, plan.replace('Company facts.', '')), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
  assert.throws(() => compatibleLegacyDescriptionHtml(product, plan.replace('data-workbench-source-image="0"', 'data-workbench-source-image="8"')), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
  assert.throws(() => compatibleLegacyDescriptionHtml(product, plan.replace('colspan="2"', 'colspan="1"')));
  assert.throws(() => compatibleLegacyDescriptionHtml({ ...product, descriptionHtml: 'User edited content' }, plan), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
});

test('compatibility verifies uploaded image placement and committed form content again before submission', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe srcdoc="<body contenteditable=true></body>"></iframe>');
    const body = page.frameLocator('iframe').locator('body');
    await body.waitFor();
    await page.evaluate(() => {
      const body = document.querySelector('iframe').contentDocument.body;
      window.value = '';
      window.tinymce = { editors: [{ getBody: () => body, getContent: () => body.innerHTML, setContent: html => body.innerHTML = html,
        save: () => {}, fire: event => { if (event === 'blur') window.value = body.innerHTML; } }] };
      window.GlobalStore = { engine: { getModels: () => ({ formValues: { superText: { value: window.value } } }) } };
    });
    const html = compatibleLegacyDescriptionHtml(product, buildLegacyDescriptionHtml(product));
    await body.evaluate(node => node.innerHTML = '<img src="https://sc04.alicdn.com/upload-first.jpg"><img src="https://sc04.alicdn.com/upload-second.jpg">');
    const restored = await restoreDescriptionImages(page, html, 2);
    assert.ok(restored.indexOf('upload-second') < restored.indexOf('upload-first'));
    await acceptCompatibleLegacyDescription(page, product, restored);
    await requireCompatibleLegacyDescription(page, product);
    await page.evaluate(() => window.value = window.value.replace('Yes, wash it.', ''));
    await assert.rejects(requireCompatibleLegacyDescription(page, product));
    await page.evaluate(() => window.tinymce.editors[0].fire('blur'));
    await body.locator('td').evaluate(node => node.setAttribute('colspan', '1'));
    await assert.rejects(requireCompatibleLegacyDescription(page, product));
    await assert.rejects(requireCompatibleLegacyDescription(page, { ...product, detailImages: [] }), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
    await page.goto('about:blank#other-product');
    await assert.rejects(requireCompatibleLegacyDescription(page, product), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
  } finally { await browser.close(); }
});
