import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher } from '../server/publisher.js';
import { fillSalesUnit, requireSalesUnit, salesUnitIdentity } from '../server/posting-sales-unit.js';
import { configurePostingInteractions } from '../server/posting-interaction.js';

test('pausing publication during unit selection preserves the pause signal and current value', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="priceUnit" class="next-select"><span class="next-select-values"><em>Piece/Pieces</em></span><input role="combobox" readonly></div>');
    const controller = new AbortController();
    configurePostingInteractions(page, { signal: controller.signal });
    controller.abort();
    await assert.rejects(fillSalesUnit(page, { salesUnit: 'set' }), error => error.code === 'PUBLISH_PAUSED');
    assert.equal(await page.locator('em').textContent(), 'Piece/Pieces');
  } finally { await browser.close(); }
});

test('sales unit identities preserve commercial meaning across categories and languages', () => {
  for (const [raw, unit] of [['Sets', 'set'], ['Set/Sets', 'set'], ['套', 'set'], ['Pair/Pairs', 'pair'], ['双', 'pair'],
    ['Kg', 'kilogram'], ['公斤', 'kilogram'], ['Square Meter/Square Meters', 'square meter'], ['m²', 'square meter'], ['平方米', 'square meter'],
    ['Cubic Meter/Cubic Meters', 'cubic meter'], ['Dozen/Dozens', 'dozen'], ['件', 'piece']]) assert.equal(salesUnitIdentity(raw), unit);
  for (const [a, b] of [['Set', 'Piece'], ['Pair', 'Piece'], ['Carton', 'Box'], ['Metric Ton', 'Ton'], ['Set/Piece', 'Set'], ['12 pieces/set', 'set']]) {
    assert.notEqual(salesUnitIdentity(a), salesUnitIdentity(b));
  }
  assert.equal(salesUnitIdentity('Custom exact unit'), 'custom exact unit');
});

test('publishing applies the source sales unit before entering prices and quantities', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="priceUnit"><select><option value="piece">Piece/Pieces</option><option value="set">Set/Sets</option></select></div>
      <input role="input-quantity" value="1"><input role="input-price" value="1">
      <script>document.querySelector('select').onchange=()=>document.querySelectorAll('input').forEach(input=>input.value='');</script>`);
    await SellerPublisher.prototype.fillPriceFields.call({}, page, { salesUnit: 'set', price: 13, minOrder: 5000 });
    assert.equal(await page.locator('select').inputValue(), 'set');
    assert.equal(await page.locator('[role="input-quantity"]').inputValue(), '5000');
    assert.equal(Number(await page.locator('[role="input-price"]').inputValue()), 13);
  } finally { await browser.close(); }
});

test('sales units support native category choices and block unavailable, ambiguous and rejected values', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const [value, label] of [['双', 'Pair/Pairs'], ['公斤', 'Kilogram/Kilograms'], ['m²', 'Square Meter/Square Meters'], ['set', '套']]) {
      await page.setContent(`<select id="priceUnit"><option>Piece/Pieces</option><option>${label}</option></select>`);
      assert.deepEqual(await fillSalesUnit(page, { salesUnit: value }), { expected: value, actual: label });
    }
    await page.setContent('<select id="priceUnit"><option>Piece/Pieces</option><option disabled>Set/Sets</option><option>Other</option></select>');
    await assert.rejects(fillSalesUnit(page, { salesUnit: 'set' }), error => error.diagnostics.reason === 'unavailable-option');
    assert.equal(await page.locator('select').inputValue(), 'Piece/Pieces');
    await page.setContent('<select id="priceUnit"><option>Piece/Pieces</option><option>Set</option><option>Sets</option></select>');
    await assert.rejects(fillSalesUnit(page, { salesUnit: 'set' }), error => error.diagnostics.reason === 'ambiguous-option');
    await page.setContent('<select id="priceUnit"><option>Piece/Pieces</option><option>Set/Sets</option></select><script>document.querySelector("select").onchange=e=>e.target.selectedIndex=0;</script>');
    await assert.rejects(fillSalesUnit(page, { salesUnit: 'set' }, { timeoutMs: 600 }), error => error.diagnostics.reason === 'not-committed');
    await page.setContent('<select id="sampleUnit"><option>Set/Sets</option></select>');
    await assert.rejects(fillSalesUnit(page, { salesUnit: 'set' }, { timeoutMs: 200 }), error => error.diagnostics.reason === 'missing-control');
    assert.equal(await fillSalesUnit(page, {}), null);
    await page.setContent('<select id="priceUnit"><option>Set/Sets</option></select><select id="priceUnit"><option>Set/Sets</option></select>');
    await assert.rejects(requireSalesUnit(page, { salesUnit: 'set' }), error => error.diagnostics.reason === 'ambiguous-control');
  } finally { await browser.close(); }
});

test('sales unit dropdown waits for search and committed replacement instead of accepting search text', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="priceUnit"><div class="next-select"><span class="next-select-values"><em>Piece/Pieces</em></span><input role="combobox" readonly aria-controls="units"></div></div>
      <div role="listbox" id="unrelated"><div role="option" onclick="window.wrong=true">Set/Sets</div></div>
      <div role="listbox" id="units" hidden><input placeholder="Search"><div id="unit-options"></div></div>
      <script>const root=document.querySelector('#priceUnit'),menu=document.querySelector('#units');window.unitClicks=0;
      const bind=()=>root.querySelector('input').onclick=()=>{setTimeout(()=>menu.hidden=false,100);
        setTimeout(()=>{document.querySelector('#unit-options').innerHTML='<div role="option">Kilogram/Kilograms</div>';},300);};bind();
      menu.querySelector('input').oninput=()=>setTimeout(()=>{document.querySelector('#unit-options').innerHTML='<div role="option">Set/Sets</div>';
        document.querySelector('#unit-options [role="option"]').onclick=()=>{window.unitClicks++;setTimeout(()=>{root.querySelector('em').textContent='Set/Sets';root.querySelector('input').outerHTML='<input role="combobox" readonly aria-controls="units">';bind();menu.hidden=true;},250);};},120);
      document.onkeydown=e=>{if(e.key==='Escape')menu.hidden=true;};</script>`);
    assert.deepEqual(await fillSalesUnit(page, { salesUnit: 'set' }, { timeoutMs: 4000 }), { expected: 'set', actual: 'Set/Sets' });
    assert.deepEqual(await page.evaluate(() => [window.unitClicks, Boolean(window.wrong)]), [1, false]);
    await page.locator('#priceUnit em').evaluate(node => node.textContent = 'Piece/Pieces');
    await assert.rejects(requireSalesUnit(page, { salesUnit: 'set' }), error => error.diagnostics.actual === 'Piece/Pieces');
    await page.setContent('<div id="priceUnit"><input role="combobox" value="Set/Sets"></div>');
    await assert.rejects(requireSalesUnit(page, { salesUnit: 'set' }), error => error.diagnostics.actual === '');
  } finally { await browser.close(); }
});

test('SKU pricing applies the sales unit before controls reset and retains the source MOQ', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<select id="priceUnit"><option>Piece/Pieces</option><option>Set/Sets</option></select>
      <label><input type="radio" name="mode">Tiered pricing by quantity</label><label><input type="radio" name="mode" checked>SKU pricing</label>
      <div id="sku"><input data-name="unused"></div><input id="minOrderQuantity" value="1">
      <script>document.querySelector('select').onchange=()=>document.querySelector('#minOrderQuantity').outerHTML='<input id="minOrderQuantity" value="1">';</script>`);
    const product = { salesUnit: 'set', priceMode: 'sku', minOrder: 5000, skus: [{ price: 13 }] };
    await SellerPublisher.prototype.fillPriceFields.call({}, page, product);
    assert.equal(await page.locator('#minOrderQuantity').inputValue(), '5000');
    assert.equal((await requireSalesUnit(page, product)).actual, 'Set/Sets');
  } finally { await browser.close(); }
});
