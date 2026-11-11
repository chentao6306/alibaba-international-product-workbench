import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { buildLegacyDescriptionHtml, preparePublishProduct } from '../server/publisher.js';
import { currentDescriptionStructure, descriptionSourceHash, extractDescriptionStructure, materializeLegacyFaqHtml } from '../server/description-structure.js';
import { compatibleLegacyDescriptionHtml, acceptCompatibleLegacyDescription, requireCompatibleLegacyDescription } from '../server/description-compatibility.js';

const items = [
  { question: 'Where are you based?', answer: 'Our factory is in Shenzhen.' },
  { question: 'What products do you supply?', answer: 'Screens and repair parts. Please contact us for the full range.' },
  { question: 'How long is the warranty?', answer: 'The warranty lasts 12 months.' },
  { question: 'What if a part arrives damaged?', answer: 'Please contact us and we will check the order.' },
];
const faqItems = html => extractDescriptionStructure(html)?.modules.find(module => module.type === 'faq')?.items;

function legacyProduct() {
  // Synthetic old-release capture: the HTML sanitizer lost contact spans,
  // while the structured source snapshot retained all four exact FAQ rows.
  const original = '<div data-module-name="module_structure_descption_companyInfo"><div data-testid="product-detail-text">Original supplier.</div></div>'
    + '<div data-module-name="module_structure_descption_faqInfo"><div data-testid="product-detail-title">FAQs</div><div data-testid="product-detail-qa">'
    + items.map(item => `<div><div><span>${item.question}</span></div><div><span>${item.answer}</span></div></div>`).join('') + '</div></div>'
    + '<table><tr><th>Packaging</th><td colspan="2">One set per box</td></tr></table>';
  const html = original.replace(`<span>${items[1].answer}</span>`, '').replace(`<span>${items[3].answer}</span>`, '');
  const structuredDescription = { ...extractDescriptionStructure(original), sourceHtmlHash: descriptionSourceHash(html) };
  const snapshot = { sourceId: 'fixture-faq', descriptionHtml: html, structuredDescription };
  return { sourceId: snapshot.sourceId, descriptionHtml: html, structuredDescription: structuredClone(structuredDescription), detailImages: [],
    source: { snapshot, snapshotHashVersion: 2, snapshotHash: descriptionSourceHash(JSON.stringify(snapshot)) } };
}

test('legacy conversion materializes only proven missing contact FAQ answers and preserves tables and current company text', () => {
  const product = legacyProduct();
  product.descriptionHtml = product.descriptionHtml.replace('Original supplier.', 'Edited supplier.');
  product.structuredDescription.modules.find(module => module.type === 'company').text = 'Edited supplier.';
  product.structuredDescription.sourceHtmlHash = descriptionSourceHash(product.descriptionHtml);
  const before = structuredClone(product);
  const prepared = preparePublishProduct(JSON.parse(JSON.stringify(product)));
  const converted = compatibleLegacyDescriptionHtml(prepared, buildLegacyDescriptionHtml(prepared));
  assert.deepEqual(faqItems(converted), items);
  assert.match(converted, /Edited supplier\./);
  assert.match(converted, /<td colspan="2">\s*One set per box\s*<\/td>/);
  assert.deepEqual(product, before);
  assert.equal(materializeLegacyFaqHtml(product, converted), converted);
});

test('FAQ conversion does not restore manually changed, deleted, reordered or unverified content', () => {
  const changes = [
    product => { delete product.source; },
    product => { product.source.snapshotHash = 'invalid'; },
    product => { product.source.snapshot.descriptionHtml += '<p>tampered</p>'; },
    product => { product.sourceId = 'another-product'; },
    product => { product.descriptionHtml = product.descriptionHtml.replace(items[0].answer, 'Edited answer.'); },
    product => { product.descriptionHtml = product.descriptionHtml.replace(`<span>${items[2].answer}</span>`, ''); },
    product => { product.descriptionHtml = product.descriptionHtml.replace(items[1].question, 'Changed question?'); },
    product => { product.descriptionHtml = product.descriptionHtml.replace(`<div><div><span>${items[1].question}</span></div><div></div></div>`, ''); },
    product => { product.structuredDescription.modules.find(module => module.type === 'faq').items.reverse(); },
    product => { product.structuredDescription.modules.find(module => module.type === 'faq').items[1].answer = 'Manually edited module.'; },
  ];
  for (const [index, change] of changes.entries()) {
    const product = legacyProduct(); change(product);
    const html = buildLegacyDescriptionHtml(product);
    assert.equal(materializeLegacyFaqHtml(product, html), html);
    if ([0, 1, 2, 3, 8, 9].includes(index)) {
      assert.throws(() => compatibleLegacyDescriptionHtml(product, html), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
    } else {
      const converted = compatibleLegacyDescriptionHtml(product, html);
      assert.deepEqual(faqItems(converted), faqItems(product.descriptionHtml));
      assert.ok(!converted.includes(items[1].answer) && !converted.includes(items[3].answer));
    }
  }
  const product = legacyProduct(), html = buildLegacyDescriptionHtml(product);
  const altered = html.replace(items[0].question, 'Different conversion question?');
  assert.equal(materializeLegacyFaqHtml(product, altered), altered);
  const duplicate = html + html;
  assert.equal(materializeLegacyFaqHtml(product, duplicate), duplicate);
});

test('FAQ materialization rejects missing unrelated facts and contact details even in an internally consistent source capture', () => {
  for (const answer of ['An unrelated warranty fact.', 'Contact us at sales@example.test', 'Contact us via Phone: +1 555 123 4567']) {
    const product = legacyProduct();
    for (const structure of [product.structuredDescription, product.source.snapshot.structuredDescription]) structure.modules.find(module => module.type === 'faq').items[1].answer = answer;
    product.source.snapshotHash = descriptionSourceHash(JSON.stringify(product.source.snapshot));
    const html = buildLegacyDescriptionHtml(product);
    assert.equal(materializeLegacyFaqHtml(product, html), html);
    assert.throws(() => compatibleLegacyDescriptionHtml(product, html), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
  }
});

test('a complete manually edited FAQ stays authoritative over the original snapshot', () => {
  const product = legacyProduct();
  product.descriptionHtml = materializeLegacyFaqHtml(product, product.descriptionHtml).replace(items[0].answer, 'Edited answer.');
  product.structuredDescription = extractDescriptionStructure(product.descriptionHtml);
  const html = compatibleLegacyDescriptionHtml(product, buildLegacyDescriptionHtml(product));
  assert.equal(faqItems(html)[0].answer, 'Edited answer.');
  assert.deepEqual(faqItems(html), currentDescriptionStructure(product).modules.find(module => module.type === 'faq').items);
});

test('restored FAQ survives a legacy browser save and is rechecked in editor and committed form before submission', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe srcdoc="<body contenteditable=true></body>"></iframe>');
    const body = page.frameLocator('iframe').locator('body');
    await body.waitFor();
    await page.evaluate(() => {
      const body = document.querySelector('iframe').contentDocument.body;
      window.value = '';
      window.tinymce = { editors: [{ getBody: () => body, getContent: () => body.innerHTML,
        setContent: html => body.innerHTML = html, save: () => window.value = body.innerHTML }] };
      window.GlobalStore = { engine: { getModels: () => ({ formValues: { superText: { value: window.value } } }) } };
    });
    const product = preparePublishProduct(legacyProduct());
    const html = compatibleLegacyDescriptionHtml(product, buildLegacyDescriptionHtml(product));
    await page.evaluate(html => { window.tinymce.editors[0].setContent(html); window.tinymce.editors[0].save(); }, html);
    await acceptCompatibleLegacyDescription(page, product, html);
    await body.evaluate(node => { node.innerHTML = ''; });
    await page.evaluate(() => window.tinymce.editors[0].setContent(window.value));
    await requireCompatibleLegacyDescription(page, product);
    assert.deepEqual(faqItems(await body.innerHTML()), items);
    await page.evaluate(answer => window.value = window.value.replace(answer, ''), items[1].answer);
    await assert.rejects(requireCompatibleLegacyDescription(page, product), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
    await page.evaluate(() => window.tinymce.editors[0].save());
    await body.locator('[data-testid="product-detail-qa"] > div').nth(3).locator(':scope > div').nth(1).evaluate(node => node.textContent = '');
    assert.equal(faqItems(await body.innerHTML())[3].answer, '');
    await assert.rejects(requireCompatibleLegacyDescription(page, product), { code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE' });
  } finally { await browser.close(); }
});
