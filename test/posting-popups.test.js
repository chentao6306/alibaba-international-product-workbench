import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { attributeMenuForControl, closePostingAttributeMenus } from '../server/posting-popups.js';
import { clickPostingControl, fillCategoryAttributes, fillChoice, requireCategoryAttributes } from '../server/publisher.js';

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    page.setDefaultTimeout(2000);
    await run(page, t);
  } finally { await browser.close(); }
});

// Synthetic forms reproduce observed Fusion DOM, with unrelated property IDs
// and labels. They verify shared control behavior, not live category coverage.
browserTest('commits Fusion multi-select portals before adding the next field across unrelated category schemas', async (page, t) => {
  for (const [category, label, values, nextLabel] of [
    ['Phones', 'Cellular Network', ['LTE', 'CDMA'], 'Model Number'],
    ['Clothing', 'Fabric Treatment', ['Washed', 'Brushed'], 'Style Number'],
    ['Machinery', 'Power Source', ['Electric', 'Hydraulic'], 'Equipment Code'],
    ['Food', 'Packaging Type', ['Bag', 'Box'], 'Product Code'],
    ['Furniture', 'Surface Finish', ['Matte', 'Polished'], 'Series Number'],
    ['Lighting', 'Socket Type', ['E27', 'E14'], 'Fixture Code'],
  ]) await t.test(category, async () => {
    await page.goto('about:blank');
    await page.setContent(`<style>.next-overlay-inner{position:fixed;top:110px;left:0;width:650px;height:420px;background:white;z-index:100}#struct-p-98002{margin-top:160px}</style>
      <div class="sell-catProp-item" id="struct-p-98001"><label class="label required">${label}</label>
        <div class="next-select next-select-multiple"><div class="next-select-values"></div><input readonly role="combobox" aria-controls="choices"></div></div>
      <div class="sell-catProp-item" id="struct-p-98002"><label class="label required">${nextLabel}</label>
        <div class="posting-field-multi-text"><button class="add-button">Add</button></div></div>
      <div class="next-overlay-wrapper"><div class="next-overlay-inner" hidden><ul id="choices" class="next-menu">
        ${values.map((value) => `<li class="next-menu-item next-select-menu-item" role="option"><div class="next-menu-item-inner"><input class="next-checkbox-input" type="checkbox"><span class="next-menu-item-text">${value}</span></div></li>`).join('')}
      </ul></div></div><script>(() => {
      const input=document.querySelector('[role=combobox]'),menu=document.querySelector('.next-overlay-inner'); window.adds=0;window.choices=0;
      input.onclick=()=>{menu.hidden=false;input.setAttribute('aria-expanded','true')};
      menu.onclick=e=>{const option=e.target.closest('[role=option]');if(!option)return;window.choices++;
        option.querySelector('input').checked=true;document.querySelector('.next-select-values').insertAdjacentHTML('beforeend','<em>'+option.textContent.trim()+'</em>')};
      document.addEventListener('mousedown',e=>{if(!menu.contains(e.target)&&e.target!==input){setTimeout(()=>{menu.hidden=true;input.setAttribute('aria-expanded','false')},100)}});
      document.querySelector('.add-button').onclick=function(){window.adds++;this.insertAdjacentHTML('beforebegin','<input>');this.remove()};
      })();</script>`);
    const product = { attributes: [{ id: '98001', name: label, value: values }, { id: '98002', name: nextLabel, value: 'CODE-26' }] };
    const stages = [];
    await fillCategoryAttributes(page, product, (stage) => stages.push(stage));
    await requireCategoryAttributes(page, product);
    assert.equal(await page.locator('.next-overlay-inner').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => [window.adds, window.choices]), [1, 2]);
    assert.equal(await page.locator('#struct-p-98002 input').inputValue(), 'CODE-26');
    assert.ok(stages.some((stage) => stage.endsWith(nextLabel)));
    await fillCategoryAttributes(page, product);
    assert.deepEqual(await page.evaluate(() => [window.adds, window.choices]), [1, 2]);
  });
});

browserTest('recovers the observed checkbox portal covering Add without requiring select-popup or listbox', async (page) => {
  await page.setContent(`<style>body{margin:0;min-height:100vh}button{position:absolute;top:200px;left:80px}.next-menu{position:fixed;top:120px;left:40px;width:350px;height:240px;background:white;z-index:100}</style>
    <button onclick="window.adds++">Add</button><ul class="next-menu"><li class="next-menu-item next-select-menu-item" role="option"><input class="next-checkbox-input" type="checkbox" checked>Checked value</li></ul>
    <script>window.adds=0;window.changes=0;document.querySelector('input').onchange=()=>window.changes++;
    document.addEventListener('mousedown',e=>{const m=document.querySelector('.next-menu');if(m&&!m.contains(e.target))m.style.display='none'})</script>`);
  await clickPostingControl(page, page.locator('button'), { timeout: 500 });
  assert.deepEqual(await page.evaluate(() => [window.adds, window.changes]), [1, 0]);
  assert.equal(await page.locator('input').isChecked(), true);
});

browserTest('keeps an actively selected Fusion option open while recovering partial obstruction', async (page) => {
  await page.setContent(`<ul class="next-menu"><li class="next-select-menu-item" role="option" style="position:fixed;left:100px;top:200px;width:400px;height:50px" onclick="window.selected=true">Cotton</li></ul>
    <aside style="position:fixed;left:240px;top:190px;width:160px;height:90px;background:white">Help</aside>
    <script>window.escapes=0;document.onkeydown=e=>{if(e.key==='Escape'){window.escapes++;document.querySelector('ul').remove()}}</script>`);
  await clickPostingControl(page, page.getByRole('option'), { timeout: 500 });
  assert.deepEqual(await page.evaluate(() => [window.selected, window.escapes]), [true, 0]);
});

browserTest('selects from the owning popup and refuses ambiguous unowned portals', async (page) => {
  await page.setContent(`<input id="field" aria-controls="own" readonly role="combobox">
    <div id="wrong" role="listbox"><div role="option" onclick="window.wrongClicked=true">Blue</div></div>
    <div id="own" role="listbox"><div role="option" onclick="document.querySelector('input').value='Blue'">Blue</div></div>`);
  assert.equal(await (await attributeMenuForControl(page, page.locator('input'))).getAttribute('id'), 'own');
  await page.locator('input').evaluate((node) => node.removeAttribute('aria-controls'));
  assert.equal(await attributeMenuForControl(page, page.locator('input')), null);
  assert.equal(await page.evaluate(() => Boolean(window.wrongClicked)), false);
});

browserTest('finds searchable options in a Fusion portal outside the attribute row', async (page) => {
  await page.setContent(`<div class="sell-catProp-item"><label class="label">Material</label><input id="field" readonly role="combobox" aria-controls="material-options"></div>
    <div class="next-overlay-inner" hidden><input id="search"><ul class="next-menu" id="material-options"><li class="next-select-menu-item" role="option">Other</li></ul></div>
    <script>const field=document.querySelector('#field'),menu=document.querySelector('.next-overlay-inner');field.onclick=()=>{menu.hidden=false;field.setAttribute('aria-expanded','true')};
    document.querySelector('#search').oninput=()=>{document.querySelector('li').textContent='Stainless Steel'};
    document.querySelector('li').onclick=()=>{field.value='Stainless Steel'};
    document.onkeydown=e=>{if(e.key==='Escape'){menu.hidden=true;field.setAttribute('aria-expanded','false')}};</script>`);
  assert.equal(await fillChoice(page, page.locator('#field'), 'Stainless Steel'), true);
  assert.equal(await page.locator('#field').inputValue(), 'Stainless Steel');
});

browserTest('keyword recommendations cannot supply attribute values or make the attribute menu ambiguous', async (page) => {
  await page.setContent(`<input readonly role="combobox"><ul role="menu" class="next-menu next-overlay-inner posting-field-keywords-overlay">
    <li role="menuitem" class="next-menu-item"><div class="next-menu-item-inner">China</div></li></ul>`);
  assert.equal(await attributeMenuForControl(page, page.locator('input')), null);
  await page.locator('body').evaluate((node) => node.insertAdjacentHTML('beforeend', '<div role="listbox" id="countries"><div role="option">China</div></div>'));
  assert.equal(await (await attributeMenuForControl(page, page.locator('input'))).getAttribute('id'), 'countries');
});

browserTest('dismissing keyword suggestions preserves navigation menus and never confirms an unrelated modal', async (page) => {
  await page.setContent(`<h2>Basic information</h2><nav class="next-menu next-overlay-inner" role="menu"><a class="next-menu-item" href="#">Products</a></nav>
    <ul class="next-menu next-overlay-inner posting-field-keywords-overlay" role="menu"><li role="menuitem">Suggested keyword</li></ul>
    <script>document.addEventListener('mousedown',e=>{const menu=document.querySelector('ul');if(!menu.contains(e.target))menu.hidden=true})</script>`);
  assert.equal(await closePostingAttributeMenus(page), true);
  assert.equal(await page.locator('ul').isVisible(), false);
  assert.equal(await page.locator('nav').isVisible(), true);
  await page.locator('ul').evaluate((node) => { node.hidden = false; });
  await page.locator('body').evaluate((node) => node.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true"><button onclick="window.confirmed=true">Confirm publishing</button></div>'));
  assert.equal(await closePostingAttributeMenus(page), false);
  assert.equal(await page.locator('ul').isVisible(), true);
  assert.equal(await page.evaluate(() => Boolean(window.confirmed)), false);
});

browserTest('closes a dropdown inside a logistics modal before confirmation without closing the parent modal', async (page) => {
  await page.setContent(`<div class="next-dialog" role="dialog" aria-modal="true" style="position:fixed;inset:30px;background:white"><div class="next-dialog-header">Logistics</div>
    <button id="confirm" style="position:absolute;top:200px;left:100px" onclick="window.confirmed++">Confirm</button>
    <ul class="next-menu" style="position:absolute;left:50px;top:100px;width:350px;height:240px;background:white"><li role="option" class="next-select-menu-item">Box</li></ul></div>
    <script>window.confirmed=0;window.escapes=0;document.onkeydown=e=>{if(e.key==='Escape'){window.escapes++;document.querySelector('.next-dialog').remove()}};
    document.addEventListener('mousedown',e=>{const menu=document.querySelector('ul');if(!menu.contains(e.target))menu.style.display='none'});</script>`);
  await clickPostingControl(page, page.locator('#confirm'), { timeout: 500 });
  assert.deepEqual(await page.evaluate(() => [window.confirmed, window.escapes]), [1, 0]);
  assert.equal(await page.locator('.next-dialog').isVisible(), true);
});

browserTest('never dismisses an unrelated modal or treats a navigation menu as an attribute portal', async (page) => {
  await page.setContent('<nav class="next-menu"><a class="next-menu-item" href="#">Products</a></nav>');
  assert.equal(await closePostingAttributeMenus(page), true);
  assert.equal(await page.locator('nav').isVisible(), true);
  await page.setContent('<div role="dialog" aria-modal="true"><div class="next-overlay-inner"><ul class="next-menu"><li class="next-select-menu-item" role="option">Keep</li></ul></div><button onclick="window.confirmed=true">Confirm</button></div>');
  assert.equal(await closePostingAttributeMenus(page), false);
  assert.equal(await page.evaluate(() => Boolean(window.confirmed)), false);
});

browserTest('closes a new feature notice above an active option without losing the active menu', async (page) => {
  await page.setContent(`<div role="listbox"><div role="option" onclick="window.selected=true">Cotton</div></div>
    <div class="next-dialog" role="dialog" style="position:fixed;inset:0;background:white">Feature notice<button onclick="this.parentElement.remove()">知道了</button></div>`);
  await clickPostingControl(page, page.getByRole('option'), { timeout: 500 });
  assert.equal(await page.evaluate(() => window.selected), true);
  assert.equal(await page.getByRole('listbox').isVisible(), true);
  assert.equal(await page.locator('.next-dialog').count(), 0);
});

browserTest('preserves an image selection dialog and its selection while dismissing a notice above it', async (page) => {
  await page.setContent(`<div class="next-overlay-inner"><div class="next-dialog" role="dialog" id="images">
      <input type="checkbox" checked><button id="upload" onclick="window.uploaded++">Upload</button>
      <button onclick="window.cancelled++">取消</button></div></div>
    <div class="next-dialog" role="dialog" style="position:fixed;inset:0;background:white">Feature notice<button onclick="this.parentElement.remove()">关闭</button></div>
    <script>window.uploaded=0;window.cancelled=0</script>`);
  await clickPostingControl(page, page.locator('#upload'), { timeout: 500 });
  assert.deepEqual(await page.evaluate(() => [window.uploaded, window.cancelled]), [1, 0]);
  assert.equal(await page.locator('#images input').isChecked(), true);
  assert.equal(await page.locator('#images').isVisible(), true);
});

browserTest('closes an observed dismissible Fusion guide over a field without accepting its recommended content', async (page) => {
  await page.setContent(`<button id="next" style="position:absolute;top:200px;left:100px" onclick="window.adds++">Add model</button>
    <div class="next-balloon next-overlay-inner product-sub-title-guide-balloon" role="tooltip" style="position:fixed;inset:0;background:white;z-index:100">
      <a role="button" aria-label="关闭" class="next-balloon-close" onclick="this.parentElement.remove()">Close</a>
      <button onclick="window.recommended++">Use recommended content</button></div>
    <script>window.adds=0;window.recommended=0;</script>`);
  await clickPostingControl(page, page.locator('#next'), { timeout: 500 });
  assert.deepEqual(await page.evaluate(() => [window.adds, window.recommended]), [1, 0]);
  assert.equal(await page.locator('[role=tooltip]').count(), 0);
});
