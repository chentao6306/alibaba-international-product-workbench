import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillChoice } from '../server/publisher.js';

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await run(page);
  } finally { await browser.close(); }
});

browserTest('selects a native option by verified ID and keeps disabled groups unavailable', async (page) => {
  await page.setContent(`<select id="field" onchange="window.changes=(window.changes||0)+1">
    <option value="old">Indoor</option><option value="42">室外</option>
    <optgroup disabled><option value="43">Underwater</option></optgroup></select>`);
  const field = page.locator('#field');
  const committed = [];
  assert.equal(await fillChoice(page, field, 'Outdoor', {
    valueIds: { Outdoor: '42' }, onValueCommitted: (...args) => committed.push(args),
  }), true);
  assert.equal(await field.inputValue(), '42');
  assert.deepEqual(committed, [['42', '室外']]);
  assert.equal(await page.evaluate(() => window.changes), 1);
  assert.equal(await fillChoice(page, field, 'Underwater', { valueIds: { Underwater: '43' } }), false);
  assert.equal(await field.inputValue(), '42');
  assert.equal(await page.evaluate(() => window.changes), 1);
});

browserTest('keeps native multiple values distinct and preserves a complete comma-bearing option', async (page) => {
  await page.setContent(`<select multiple id="field"><option value="cotton" selected>Cotton</option>
    <option value="wool">Wool</option><option value="blend">Cotton, linen blend</option></select>`);
  const field = page.locator('#field');
  const selected = () => field.evaluate(node => [...node.selectedOptions].map(option => option.value));
  assert.equal(await fillChoice(page, field, ['Cotton', 'Wool']), true);
  assert.deepEqual(await selected(), ['cotton', 'wool']);
  assert.equal(await fillChoice(page, field, 'Cotton, linen blend'), true);
  assert.deepEqual(await selected(), ['blend']);
});

browserTest('restores every previous native selection when Other has no custom input', async (page) => {
  for (const multiple of [false, true]) {
    await page.setContent(`<div class="sell-catProp-item" id="p-7"><label>Material</label>
      <select id="field" ${multiple ? 'multiple' : ''} onchange="window.changes=(window.changes||0)+1">
        <option value="cotton" selected>Cotton</option><option value="wool" ${multiple ? 'selected' : ''}>Wool</option>
        <option value="other">Other</option></select></div>`);
    await page.evaluate(() => { window.changes = 0; });
    const field = page.locator('#field');
    const committed = [];
    assert.equal(await fillChoice(page, field, multiple ? ['Cotton', 'Bamboo'] : 'Bamboo', {
      valueIds: { Bamboo: 'other' }, onValueCommitted: (...args) => committed.push(args),
    }), false);
    assert.deepEqual(await field.evaluate(node => [...node.selectedOptions].map(option => option.value)),
      multiple ? ['cotton', 'wool'] : ['cotton']);
    assert.deepEqual(committed, []);
    assert.equal(await page.evaluate(() => window.changes), 2);
  }
});

browserTest('rejects a native selection that the form changes before committed-value readback', async (page) => {
  await page.setContent(`<select id="field" onchange="this.value='old'">
    <option value="old">Indoor</option><option value="new">Outdoor</option></select>`);
  const committed = [];
  assert.equal(await fillChoice(page, page.locator('#field'), 'Outdoor', {
    valueIds: { Outdoor: 'new' }, onValueCommitted: (...args) => committed.push(args),
  }), false);
  assert.equal(await page.locator('#field').inputValue(), 'old');
  assert.deepEqual(committed, []);
});

browserTest('uses actual option commits for readonly and role-based comboboxes', async (page) => {
  for (const attributes of ['readonly', 'readonly="false" role="combobox"', 'role="combobox"']) {
    await page.setContent(`<div class="sell-catProp-item" id="p-8"><label>Material</label>
      <div class="next-select next-select-single"><span class="next-select-values"></span>
        <input id="field" ${attributes} aria-expanded="false"></div></div>
      <div role="listbox" hidden><div role="option" data-value="silicone">Silicone</div></div>
      <script>
      {
        const input=document.querySelector('#field'), menu=document.querySelector('[role=listbox]');
        window.optionCommits=0;
        input.onclick=()=>{menu.hidden=false;input.setAttribute('aria-expanded','true')};
        document.querySelector('[role=option]').onclick=()=>{
          window.optionCommits++;
          document.querySelector('.next-select-values').innerHTML='<em>Silicone</em>';
          menu.hidden=true;input.setAttribute('aria-expanded','false');
        };
      }
      </script>`);
    assert.equal(await fillChoice(page, page.locator('#field'), 'Silicone'), true);
    assert.equal(await page.locator('.next-select-values em').textContent(), 'Silicone');
    assert.equal(await page.evaluate(() => window.optionCommits), 1);
    assert.equal(await page.locator('#field').inputValue(), '', 'Option selection must not become text-buffer filling');
  }
});

browserTest('commits ordinary input and textarea values through their change handlers', async (page) => {
  await page.setContent(`<div class="sell-catProp-item" id="p-9"><label>Model</label>
    <input id="model" onchange="window.savedModel=this.value"></div>
    <div class="sell-catProp-item" id="p-10"><label>Application</label>
    <textarea id="application" onchange="window.savedApplication=this.value"></textarea></div>`);
  assert.equal(await fillChoice(page, page.locator('#model'), 'RDS3225'), true);
  assert.equal(await fillChoice(page, page.locator('#application'), 'Consumer electronics'), true);
  assert.deepEqual(await page.evaluate(() => [window.savedModel, window.savedApplication]),
    ['RDS3225', 'Consumer electronics']);
  assert.equal(await page.locator('#model').inputValue(), 'RDS3225');
  assert.equal(await page.locator('#application').inputValue(), 'Consumer electronics');
});
