import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { ensureColorSpecificationReady, fillColorSpec } from '../server/publisher.js';

test('enables a numeric native color identity without dropping existing numeric dimensions', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="saleAttributesItems">规格</div><div id="struct-specification"></div>');
    await page.evaluate(() => {
      const root = document.getElementById('saleAttributesItems');
      const props = { id: root.id, dataSource: [{ value: 191288010, text: '颜色' }, { value: 42, text: '尺寸' }], value: [{ value: 42, text: '尺寸' }] };
      class SaleAttributesItems {
        onChange(ids) {
          window.receivedIds = ids;
          props.value = props.dataSource.filter((item) => ids.includes(item.value));
          document.getElementById('struct-specification').innerHTML = props.value.some((item) => item.value === 191288010)
            ? '<div id="p-191288010"><label>颜色</label><input role="colorCombobox"></div>' : '';
        }
      }
      root.__reactFiberFixture = { memoizedProps: props, child: { stateNode: new SaleAttributesItems() } };
    });
    assert.ok(await ensureColorSpecificationReady(page, 1200));
    assert.deepEqual(await page.evaluate(() => window.receivedIds), [42, 191288010]);
    assert.equal(await fillColorSpec(page, ['Black']), true);
  } finally { await browser.close(); }
});

test('enables the visible color label for a hidden checkbox using the current category identity', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const id of ['191288010', '77331']) {
      await page.setContent(`<div id="saleAttributesItems">
        <label><input type="checkbox" value="999">Color Temperature</label>
        <label>Color<input style="display:none" type="checkbox" value="${id}"></label>
        <label><input type="checkbox" value="888">Lens Color</label></div><div id="struct-specification"></div>
        <script>document.querySelector('input[value="${id}"]').onchange = function() {
          document.getElementById('struct-specification').innerHTML = this.checked
            ? '<div id="p-${id}"><label>Color</label><div class="posting-field-color-select"><input role="colorCombobox" placeholder="Please enter"></div></div>' : '';
        };</script>`);
      assert.ok(await ensureColorSpecificationReady(page, 1200), id);
      assert.equal(await page.locator(`input[value="${id}"]`).isChecked(), true);
      assert.equal(await fillColorSpec(page, ['Black']), true);
      assert.equal(await page.locator('input[value="999"]').isChecked(), false);
      assert.equal(await page.locator('input[value="888"]').isChecked(), false);
    }
  } finally { await browser.close(); }
});

test('does not claim a color dimension is enabled when native selection is rejected or its editor never mounts', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const attributes of ['disabled', 'checked']) {
      await page.setContent(`<div id="saleAttributesItems"><label>Color<input type="checkbox" value="191288010" ${attributes}></label></div>
        <div class="customizedServices"><label>Color<input type="checkbox" value="191288010" checked></label><input role="colorCombobox"></div>`);
      assert.equal(Boolean(await ensureColorSpecificationReady(page, 500)), false);
    }
    await page.setContent('<div id="saleAttributesItems"><label>Color Temperature<input type="checkbox" value="999"></label></div><div id="struct-specification"><div id="p-999"><label>Color Temperature</label><input role="colorCombobox"></div></div>');
    assert.equal(Boolean(await ensureColorSpecificationReady(page, 500)), false);
    assert.equal(await page.locator('input[type=checkbox]').isChecked(), false);
  } finally { await browser.close(); }
});
