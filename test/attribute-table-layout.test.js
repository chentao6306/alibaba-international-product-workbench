import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { mergeSourceAttributes, readAlibabaAttributeRows, sourceAttributeForField } from '../server/category-attributes.js';
import { collectSourceAttributeSections } from '../server/source-attributes.js';

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try { await run(await browser.newPage()); } finally { await browser.close(); }
});

browserTest('collects every paired public table property and retains its identity after save and reopen', async page => {
  await page.setContent(`<section data-testid="module-attribute-group"><table>
    <tr><td>Number of Sheets</td><td>100</td><td>Material</td><td>Paper</td></tr>
    <tr><td>Industrial Use</td><td>Cosmetic</td><td>Capacity</td><td>50 ml</td><td>Place of Origin</td><td>None</td></tr>
    <tr><td>Flower Type</td><td>Rose</td></tr>
    <tr><td class="attribute-name" data-attribute-id="99991">Unfamiliar category field</td><td class="attribute-value"><span data-value-id="a">Source choice A</span></td>
      <td class="attribute-name" data-attribute-id="99992">Another unfamiliar field</td><td class="attribute-value"><span data-value-id="b">Source choice B</span></td></tr>
    </table></section><div data-module-name="module_recommend"><table><tr><td>Material</td><td>Metal</td><td>Capacity</td><td>1 l</td></tr></table></div>`);
  const collected = await collectSourceAttributeSections(page, { timeoutMs: 3500 });
  const product = JSON.parse(JSON.stringify({ attributes: mergeSourceAttributes(collected.attributes) }));
  assert.deepEqual(product.attributes.map(row => [row.name, row.value]), [
    ['Number of Sheets', '100'], ['Material', 'Paper'], ['Industrial Use', 'Cosmetic'], ['Capacity', '50 ml'],
    ['Place of Origin', 'None'], ['Flower Type', 'Rose'], ['Unfamiliar category field', ['Source choice A']],
    ['Another unfamiliar field', ['Source choice B']],
  ]);
  assert.equal(sourceAttributeForField(product, { label: '张数' }).value, '100');
  assert.equal(sourceAttributeForField(product, { label: 'Material' }).value, 'Paper');
  assert.equal(sourceAttributeForField(product, { id: '99992', label: '陌生字段' }).matchedById, true);
  assert.deepEqual(product.attributes.at(-1).valueIds, { 'Source choice B': 'b' });
  assert.ok(product.attributes.every(row => row.source === 'dom'));
});

browserTest('splits semantically marked public pairs without guessing multi-value rows or column headers', async page => {
  await page.setContent(`<section data-testid="module-attribute-group">
    <table><tr><th scope="row">Unlisted species trait</th><td>Source A</td><th scope="row">Unlisted stem trait</th><td>Source B</td></tr></table>
    <table><tr><td>Material</td><td>Silk</td><td>Cotton</td><td>Linen</td></tr>
      <tr><td>Feature</td><td>Touchscreen</td><td>NFC</td><td>GPS</td></tr></table>
    <table><thead><tr><th>Size</th><th>Length</th><th>Width</th><th>Height</th></tr></thead>
      <tbody><tr><td>M</td><td>60 cm</td><td>40 cm</td><td>30 cm</td></tr></tbody></table>
    </section>`);
  const rows = await page.evaluate(readAlibabaAttributeRows);
  assert.deepEqual(rows.map(row => [row.name, row.value]), [
    ['Unlisted species trait', 'Source A'], ['Unlisted stem trait', 'Source B'],
    ['Material', 'Silk, Cotton, Linen'], ['Feature', 'Touchscreen, NFC, GPS'],
    ['Size', 'Length, Width, Height'], ['M', '60 cm, 40 cm, 30 cm'],
  ]);
  assert.equal(rows.some(row => ['Cotton', 'NFC', 'Width'].includes(row.name)), false);
});

browserTest('preserves description table and rowspan content without treating it as public paired properties', async page => {
  await page.setContent(`<div id="detail_decorate_root"><table><tr><td rowspan="2">Contents</td><td>Part A</td><td>Material</td><td>Paper</td></tr>
    <tr><td rowspan="0"></td><td>Part B</td><td>Ink</td><td>Black</td></tr>
    <tr><td>Material</td><td>Silk</td><td>Place of Origin</td><td>China</td></tr></table></div>`);
  for (const description of [false, true]) {
    const rows = await page.evaluate(readAlibabaAttributeRows, { description });
    assert.equal(rows.find(row => row.name === 'Contents').value, 'Part A, Material, Paper, Part B, Ink, Black');
    assert.equal(rows.find(row => row.name === 'Material').value, 'Silk, Place of Origin, China');
    assert.equal(rows.some(row => row.name === 'Place of Origin'), false);
    assert.ok(rows.every(row => row.source === (description ? 'description-iframe' : 'description-dom')));
  }
});
