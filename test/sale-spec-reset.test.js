import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { clearSaleAttributeSelections, ensureColorSpecificationReady, fillColorSpec } from '../server/publisher.js';

async function mountForm(page, configuration) {
  await page.setContent('<div id="saleAttributesItems"></div><div id="struct-specification"><input id="color" value="Black"></div>');
  await page.evaluate(({ options, selected, reject = false }) => {
    const root = document.querySelector('#saleAttributesItems');
    window.events = [];
    const props = { id: root.id, dataSource: options, value: selected,
      fireEvent(id, event, value) {
        window.events.push({ id, event, value });
        if (reject) return;
        // Model the native event's destructive dependency: removed specs lose
        // their editors and their previously entered values.
        if (!value.some(item => String(item.value) === '191288010')) document.querySelector('#color')?.remove();
        props.value = value;
      },
    };
    class SaleAttributesItems {
      constructor() { this.props = props; }
      onChange(ids) { props.fireEvent(props.id, 'valueChange', props.dataSource.filter(item => ids.includes(item.value))); }
    }
    root.__reactFiberFixture = { memoizedProps: props, child: { stateNode: new SaleAttributesItems() } };
  }, configuration);
}

test('initializing an existing listing preserves fixed specification rows with no selectable options', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const selected of [[], [{ value: '191288010', text: 'Color' }]]) {
      await mountForm(page, { options: [], selected });
      assert.equal(await clearSaleAttributeSelections(page), true);
      assert.equal(await page.locator('#color').inputValue(), 'Black');
      assert.deepEqual(await page.evaluate(() => window.events), []);
    }
  } finally { await browser.close(); }
});

test('initializing a new listing removes optional defaults but retains required and locked dimensions', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const id of [191288010, '191288010']) {
      const options = [{ value: id, text: 'Color', disabled: true }, { value: 'size', text: 'Size', must: true }, { value: 'default-image', text: 'Unrelated image spec' }];
      await mountForm(page, { options, selected: [options[0], options[2]] });
      assert.equal(await clearSaleAttributeSelections(page), true);
      assert.equal(await page.locator('#color').inputValue(), 'Black');
      assert.deepEqual(await page.evaluate(() => window.events.at(-1).value.map(item => item.value)), [id, 'size']);
      assert.equal(await clearSaleAttributeSelections(page), true);
      assert.equal(await page.evaluate(() => window.events.length), 1, 'Unchanged selections must not trigger another destructive reset');
    }
  } finally { await browser.close(); }
});

test('removing a selectable default does not discard fixed dimensions absent from the option list', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const fixed = { value: '191288010', text: 'Color', metadata: 'existing' };
    const removable = { value: 'image', text: 'Optional image' };
    await mountForm(page, { options: [removable], selected: [fixed, removable] });
    assert.equal(await clearSaleAttributeSelections(page), true);
    assert.equal(await page.locator('#color').inputValue(), 'Black');
    assert.deepEqual(await page.evaluate(() => window.events.at(-1).value), [fixed]);
  } finally { await browser.close(); }
});

test('a rejected specification reset is not reported as accepted', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const optional = { value: 'image', text: 'Optional image' };
    await mountForm(page, { options: [optional], selected: [optional], reject: true });
    assert.equal(await clearSaleAttributeSelections(page), false);
  } finally { await browser.close(); }
});

test('color selection reveals an offscreen specification group before trying to enable its dependent editor', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.setContent(`<div style="height:2200px">Attributes</div><div id="struct-specification">
      <div id="saleAttributesItems" style="min-height:60px">Specification dimensions</div><div id="rows"></div></div>
      <script>
        const root = document.getElementById('saleAttributesItems');
        new IntersectionObserver(entries => {
          if (!entries.some(entry => entry.isIntersecting) || root.querySelector('input')) return;
          root.innerHTML = '<label><input type="checkbox" value="191288010">颜色</label>';
          root.querySelector('input').onchange = event => {
            document.getElementById('rows').innerHTML = event.target.checked
              ? '<div id="p-191288010"><span>颜色</span><input role="colorCombobox"></div>' : '';
          };
        }).observe(root);
      </script>`);
    assert.equal(await page.locator('#saleAttributesItems input').count(), 0);
    const row = await ensureColorSpecificationReady(page);
    assert.ok(row);
    assert.equal(await row.locator('input[role="colorCombobox"]').isVisible(), true);
    assert.equal(await page.locator('#saleAttributesItems input').isChecked(), true);
  } finally { await browser.close(); }
});

test('a re-enabled empty color dimension creates its first input and commits every supplied color', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="saleAttributesItems"><label><input type="checkbox" value="191288010" checked>颜色</label></div>
      <div id="struct-specification"><div id="p-191288010"><label>颜色</label><div class="posting-field-color"><div class="list"></div><span class="add-color-btn" role="btn-add">+ 添加</span></div></div></div>
      <button id="unrelated">Add</button>
      <script>
        window.committed = [];
        document.querySelector('.add-color-btn').onclick = () => setTimeout(() => {
          const row = document.createElement('div'); row.className = 'posting-field-color-select';
          row.innerHTML = '<input role="colorCombobox">';
          document.querySelector('.list').append(row);
          row.querySelector('input').onblur = () => { window.committed = [...document.querySelectorAll('[role="colorCombobox"]')].map(input => input.value).filter(Boolean); };
        }, 100);
        document.getElementById('unrelated').onclick = () => { window.wrongControl = true; };
      </script>`);
    assert.ok(await ensureColorSpecificationReady(page));
    assert.equal(await fillColorSpec(page, ['Black', 'Blue']), true);
    assert.deepEqual(await page.evaluate(() => window.committed), ['Black', 'Blue']);
    assert.equal(await page.evaluate(() => Boolean(window.wrongControl)), false);
  } finally { await browser.close(); }
});
