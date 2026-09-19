import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillCategoryAttributes, fillChoice, attributeFieldMatchesValue, requireCategoryAttributes } from '../server/publisher.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';

test('uses the same range acceptance for readback as for selection and keeps age boundaries strict', () => {
  assert.equal(attributeFieldMatchesValue({ label: 'Screen Size', controlType: 'combobox', values: ['6.6-6.9 inch'] }, '6.7 inch'), true);
  assert.equal(attributeFieldMatchesValue({ label: 'Age Range', controlType: 'combobox', values: ['2 to 4 Years'] }, '3 Years'), false);
});

test('waits for delayed multi-selection commits and restores values lost by a dependent field rerender', { skip: !findChromium(), timeout: 40000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-210240146"><label class="label required">年龄范围</label>
      <div class="next-select"><div class="next-select-values"></div><input role="combobox" readonly></div></div>
      <div class="sell-catProp-item" id="struct-p-80"><label class="label">Theme</label><input id="theme"></div>
      <div class="next-select-popup" style="display:none"><div role="option">2 to 4 Years</div><div role="option">5 to 7 years</div></div>
      <script>
        const input=document.querySelector('[role=combobox]'), menu=document.querySelector('.next-select-popup'), values=document.querySelector('.next-select-values');
        input.onclick=()=>{menu.style.display='block';input.setAttribute('aria-expanded','true')};
        document.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{
          setTimeout(()=>{if(menu.style.display==='none')return;const chip=document.createElement('em');chip.textContent=option.textContent;values.append(chip)}, 650);
        });
        document.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.style.display='none';input.setAttribute('aria-expanded','false')}});
        let reset=false;document.querySelector('#theme').onchange=()=>{if(!reset){reset=true;setTimeout(()=>{values.querySelector('em')?.remove()},100)}};
      </script>`);
    const product = { attributes: [{ name: 'Age Range', value: '2 to 4 Years, 5 to 7 years' }, { name: 'Theme', value: 'Animals' }] };
    await fillCategoryAttributes(page, product);
    const [age] = await page.evaluate(readPostingAttributeSchema);
    assert.deepEqual(age.values.sort(), ['2 to 4 Years', '5 to 7 years']);
    assert.equal(attributeFieldMatchesValue(age, product.attributes[0].value), true);
    assert.equal(attributeFieldMatchesValue({ ...age, values: ['5 to 7 years'] }, product.attributes[0].value), false);
  } finally { await browser.close(); }
});

test('fills native multiple controls from older joined data and preserves a literal comma option', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<select multiple><option value="a">2 to 4 Years</option><option value="b">5 to 7 years</option><option value="c">Cotton, linen blend</option></select>');
    const field = page.locator('select');
    assert.equal(await fillChoice(page, field, '2 to 4 Years, 5 to 7 years'), true);
    assert.deepEqual(await field.evaluate((node) => [...node.selectedOptions].map((option) => option.value)), ['a', 'b']);
    assert.equal(await fillChoice(page, field, 'Cotton, linen blend'), true);
    assert.equal(await field.inputValue(), 'c');
  } finally { await browser.close(); }
});

test('rechecks translated native and checkbox options using the IDs verified during selection', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="struct-p-123"><label class="label required">场景</label><select><option value="">选择</option><option value="456">室外</option></select></div><div class="sell-catProp-item" id="struct-p-124"><label class="label required">材质</label><label><input type="checkbox" value="789">木质</label></div>');
    const product = { attributes: [{ id: '123', name: 'Scene', value: 'Outdoor', valueIds: { Outdoor: '456' } }, { id: '124', name: 'Material', value: 'Wood', valueIds: { Wood: '789' } }] };
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    await page.locator('input').uncheck();
    await assert.rejects(requireCategoryAttributes(page, product), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
  } finally { await browser.close(); }
});
