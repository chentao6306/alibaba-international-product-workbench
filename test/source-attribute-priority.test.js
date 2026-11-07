import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { mergeSourceAttributes, readAlibabaAttributeRows, sourceAttributeForField } from '../server/category-attributes.js';
import { productOrigin } from '../server/origin-country.js';

test('keeps supplier detail values separate and uses category attributes before translated labels or bound IDs', () => {
  const rows = [
    { name: 'Model Number', value: 'CN0144', source: 'dom' },
    { name: '型号', value: 'Detail model', id: '3', source: 'description-dom' },
    { name: 'Model Number', value: 'Another detail model', source: 'description-iframe' },
    { name: 'Place of Origin', value: 'China', source: 'dom' },
    { name: '原产地', value: 'Japan', source: 'description-dom' },
    { name: 'Material', value: 'Metal', source: 'description-iframe' },
  ];
  const attributes = mergeSourceAttributes(rows), before = structuredClone(rows);
  assert.equal(attributes.length, rows.length);
  assert.deepEqual(sourceAttributeForField({ attributes }, { id: '3', label: '型号' }).value, 'CN0144');
  assert.equal(sourceAttributeForField({ attributes }, { label: '材质' }).value, 'Metal');
  assert.equal(productOrigin({ attributes }), 'China');
  assert.equal(productOrigin({ attributes: [rows[4]] }), 'Japan');
  assert.equal(sourceAttributeForField({ attributes: [...attributes, { name: 'Model Number', value: 'Conflicting core', source: 'dom' }] }, { label: '型号' }).conflict, true);
  assert.equal(sourceAttributeForField({ attributes: [{ id: '4', name: 'Model Number', value: 'Other property', source: 'dom' }, rows[1]] }, { id: '3', label: '型号' }).value, 'Detail model');
  assert.deepEqual(rows, before);
});

test('ignores nested expand controls while preserving actual attribute values, legacy tables and detail provenance', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-testid="module-attribute-group">
      <div data-testid="module-attribute-row"><span data-testid="module-attribute-name">Feature</span>
        <div data-testid="module-attribute-value"><div><span>Dual SIM Card, Quick Charge</span><button>Show more</button></div></div></div>
      </div><table><tr><td>Age Range</td><td>3-6 years</td></tr></table>
      <dl><dt>Single gross weight</dt><dd>250 g</dd></dl>
      <div data-module-name="module_description"><table><tr><td>Feature</td><td>Supplier description</td></tr>
        <tr><td>CAUTION: Pre-Buy Notice</td><td>This is a replica, not an original brand product.</td></tr></table></div>`);
    const rows = mergeSourceAttributes(await page.evaluate(readAlibabaAttributeRows));
    assert.equal(rows.length, 5, JSON.stringify(rows));
    assert.equal(rows.find((item) => item.name === 'Feature' && item.source === 'dom').value, 'Dual SIM Card, Quick Charge');
    assert.equal(rows.find((item) => item.name === 'Feature' && item.source === 'description-dom').value, 'Supplier description');
    assert.equal(rows.some((item) => /show more/i.test(item.name + item.value)), false);
    assert.equal(rows.find((item) => item.name === 'CAUTION: Pre-Buy Notice').value, 'This is a replica, not an original brand product.');
    const framed = await page.evaluate(readAlibabaAttributeRows, { description: true });
    assert.ok(framed.every((item) => item.source === 'description-iframe'));
  } finally { await browser.close(); }
});
