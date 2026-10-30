import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { clickPostingControl, fillChoice, fillVariantSpecs, recoverPostingClick, waitForActionResult } from '../server/publisher.js';
import { fillLogisticsAttributes } from '../server/posting-logistics.js';
import { choosePostingFile, configurePostingInteractions, isUndispatchedPointerError } from '../server/posting-interaction.js';

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    page.setDefaultTimeout(1000);
    page.setDefaultNavigationTimeout(15000);
    await run(page);
  } finally { await browser.close(); }
});

test('retries only pointer interception before dispatch', () => {
  assert.equal(isUndispatchedPointerError(new Error('locator.click: Timeout exceeded. footer intercepts pointer events')), true);
  for (const message of ['Timeout exceeded', 'intercepts pointer events\nclick action done', 'intercepts pointer events\nwaiting for scheduled navigations']) {
    assert.equal(isUndispatchedPointerError(new Error(message)), false);
  }
});

browserTest('centers a form control hidden by a sticky footer and adds exactly one row', async (page) => {
  await page.setContent(`<style>body{margin:0;height:1800px}button{position:absolute;top:530px}footer{position:fixed;bottom:0;height:100px;width:100%;background:white}</style>
    <button id="add" onclick="window.adds++">Add</button><footer>Publish controls</footer><script>window.adds=0</script>`);
  await clickPostingControl(page, page.locator('#add'), { timeout: 1000 });
  assert.equal(await page.evaluate(() => window.adds), 1);
  assert.ok(await page.evaluate(() => scrollY) > 0);
});

browserTest('uses the exposed part of a button without clicking or hiding a fixed help panel', async (page) => {
  await page.setContent(`<style>button{position:fixed;left:100px;top:200px;width:400px;height:50px}aside{position:fixed;left:240px;top:190px;width:160px;height:90px;background:white}</style>
    <button onclick="window.adds++">Add</button><aside onclick="window.help++">Help</aside><script>window.adds=0;window.help=0</script>`);
  await clickPostingControl(page, page.locator('button'), { timeout: 1000 });
  assert.deepEqual(await page.evaluate(() => [window.adds, window.help]), [1, 0]);
  assert.equal(await page.locator('aside').isVisible(), true);
});

browserTest('dismisses an unrelated open dropdown before clicking a specification control', async (page) => {
  await page.setContent(`<button onclick="window.adds++">Add</button><div class="next-select-popup" style="position:fixed;inset:0;background:white">Options</div>
    <script>window.adds=0;document.onkeydown=e=>{if(e.key==='Escape')document.querySelector('.next-select-popup')?.remove()}</script>`);
  await clickPostingControl(page, page.locator('button'), { timeout: 1000 });
  assert.equal(await page.evaluate(() => window.adds), 1);
});

browserTest('closes a dismissible notice that covers a form action and continues in place', async (page) => {
  await page.setContent(`<button id="add" onclick="window.adds++">Add</button>
    <div class="next-dialog" style="position:fixed;inset:0;background:white"><button onclick="this.parentElement.remove()">知道了</button></div><script>window.adds=0</script>`);
  await clickPostingControl(page, page.locator('#add'), { timeout: 1000 });
  assert.equal(await page.evaluate(() => window.adds), 1);
});

browserTest('keeps the active dropdown open while recovering a covered option', async (page) => {
  await page.setContent(`<div role="listbox"><button role="option" style="position:fixed;left:100px;top:200px;width:400px;height:50px" onclick="window.selected=true">Blue</button></div>
    <aside style="position:fixed;left:240px;top:190px;width:160px;height:90px;background:white">Help</aside>
    <script>window.selected=false;window.escapes=0;document.onkeydown=e=>{if(e.key==='Escape'){window.escapes++;document.querySelector('[role=listbox]')?.remove()}}</script>`);
  await clickPostingControl(page, page.getByRole('option'), { timeout: 1000 });
  assert.deepEqual(await page.evaluate(() => [window.selected, window.escapes]), [true, 0]);
});

browserTest('waits out a transient loading layer and clicks only once', async (page) => {
  await page.setContent(`<button onclick="window.adds++">Add</button><div class="loading" style="position:fixed;inset:0;background:white">Loading</div>
    <script>window.adds=0;setTimeout(()=>document.querySelector('.loading').remove(),1600)</script>`);
  await clickPostingControl(page, page.locator('button'), { timeout: 1000 });
  assert.equal(await page.evaluate(() => window.adds), 1);
});

browserTest('never retries a dispatched click when a timeout still contains an earlier interception log', async (page) => {
  await page.setContent('<button onclick="window.adds++">Add</button><script>window.adds=0</script>');
  const button = page.locator('button');
  const target = { click: async options => {
    await button.click(options);
    if (!options.trial) throw new Error('locator.click: Timeout exceeded. loading intercepts pointer events');
  } };
  await assert.rejects(clickPostingControl(page, target), { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.adds), 1);
});

browserTest('reads a successful draft receipt after an uncertain click without sending a second save', async (page) => {
  await page.setContent('<button onclick="window.saves++;document.querySelector(\'[role=alert]\').textContent=\'保存成功\'">Save</button><div role="alert"></div><script>window.saves=0</script>');
  const button = page.locator('button');
  const target = { click: async options => {
    await button.click(options);
    if (!options.trial) throw new Error('locator.click: Timeout exceeded. loading intercepts pointer events');
  } };
  const result = await waitForActionResult(page, target, 'draft', page.url(), { timeoutMs: 1000 });
  assert.equal(result.verifiedBy, 'feedback');
  assert.equal(await page.evaluate(() => window.saves), 1);
});

browserTest('retains a bounded actionable diagnostic when a control stays covered without forcing any click', async (page) => {
  await page.setContent(`<button id="add" aria-label="Add model" onclick="window.adds++">Add</button><aside id="blocking-panel" style="position:fixed;inset:0;background:white" onclick="window.panels++">Panel</aside>
    <script>window.adds=0;window.panels=0</script>`);
  await assert.rejects(clickPostingControl(page, page.locator('button'), { timeout: 1000 }), (error) => {
    assert.equal(error.code, 'PUBLISH_CONTROL_OBSCURED');
    assert.equal(error.diagnostics.attempts, 3);
    assert.equal(error.diagnostics.target.id, 'add');
    assert.equal(error.diagnostics.target.label, 'Add model');
    assert.equal(error.diagnostics.blockers[0].id, 'blocking-panel');
    return true;
  });
  assert.deepEqual(await page.evaluate(() => [window.adds, window.panels]), [0, 0]);
});

browserTest('does not dismiss or confirm a platform policy warning during recovery', async (page) => {
  await page.setContent(`<button id="add" onclick="window.adds++">Add</button><div role="dialog" style="position:fixed;inset:0;background:white">
    疑似涉及禁限售，会造成风控违规问题<button onclick="window.confirms++">继续提交</button><button onclick="window.closes++">关闭</button></div>
    <script>window.adds=0;window.confirms=0;window.closes=0</script>`);
  await assert.rejects(clickPostingControl(page, page.locator('#add'), { timeout: 1000 }), (error) => error.code === 'PUBLISH_POLICY_REVIEW_REQUIRED');
  assert.deepEqual(await page.evaluate(() => [window.adds, window.confirms, window.closes]), [0, 0, 0]);
});

browserTest('honors pause requested during recovery before dispatching another click', async (page) => {
  await page.setContent('<button onclick="window.adds++">Add</button><aside style="position:fixed;inset:0">Panel</aside><script>window.adds=0</script>');
  const abort = new AbortController();
  configurePostingInteractions(page, { signal: abort.signal, onProgress: () => abort.abort() });
  await assert.rejects(clickPostingControl(page, page.locator('button'), { timeout: 1000 }), (error) => error.code === 'PUBLISH_PAUSED');
  assert.equal(await page.evaluate(() => window.adds), 0);
});

browserTest('recovers a custom specification Add button before committing and verifying its value', async (page) => {
  await page.setContent(`<style>body{margin:0;height:1800px}#row{position:absolute;top:530px}footer{position:fixed;bottom:0;height:100px;width:100%;background:white}</style>
    <div id="row" class="sell-catProp-item"><label><input type="checkbox" value="8g">8g</label>
    <div class="sell-sequential-combocheckbox"><button class="add-button">Add</button></div></div><footer>Publish controls</footer>
    <script>window.adds=0;document.querySelector('button').onclick=function(){
      window.adds++;const wrap=document.createElement('div');wrap.className='sell-sequential-combobox-custom-wrap';
      const input=document.createElement('input');input.onblur=()=>addValue(input);wrap.append(input);this.parentElement.append(wrap);
    };function addValue(input){if(!input.value)return;const label=document.createElement('label');const box=document.createElement('input');box.type='checkbox';box.value=input.value;label.append(box,document.createTextNode(input.value));document.querySelector('#row').append(label);input.value=''}</script>`);
  const filled = await fillChoice(page, page.locator('#row input[type=checkbox]').first(), '16g');
  assert.equal(filled, true, await page.locator('#row').innerHTML());
  assert.equal(await page.evaluate(() => window.adds), 1);
  assert.deepEqual(await page.locator('input[type=checkbox]:checked').evaluateAll((nodes) => nodes.map((node) => node.value)), ['16g']);
});

browserTest('recovers a draft save covered by a footer and still requires its real receipt', async (page) => {
  await page.setContent(`<style>body{margin:0;height:1800px}button{position:absolute;top:530px}footer{position:fixed;bottom:0;height:100px;width:100%;background:white}</style>
    <button onclick="window.saves++;document.querySelector('[role=alert]').textContent='保存成功'">保存草稿</button><footer>Controls</footer><div role="alert"></div><script>window.saves=0</script>`);
  const result = await waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 1000 });
  assert.equal(result.verifiedBy, 'feedback');
  assert.equal(await page.evaluate(() => window.saves), 1);
});

browserTest('waits once for a slow busy draft receipt and never repeats an unknown save', async (page) => {
  for (const completes of [true, false]) {
    await page.setContent(`<button id="save">保存</button><div role="alert"></div><script>
      window.saves=0;document.querySelector('button').onclick=function(){window.saves++;this.disabled=true;
        ${completes ? "setTimeout(()=>document.querySelector('[role=alert]').textContent='保存成功',1200)" : ''}
      };</script>`);
    const result = waitForActionResult(page, page.locator('#save'), 'draft', page.url(), { timeoutMs: 500, busyGraceMs: 1800 });
    if (completes) assert.equal((await result).verifiedBy, 'feedback');
    else await assert.rejects(result, { code: 'PUBLISH_SUBMIT_RESULT_UNKNOWN' });
    assert.equal(await page.evaluate(() => window.saves), 1);
  }
});

browserTest('recovers the RAM Add control and preserves all source storage options without adding a second value', async (page) => {
  await page.setContent(`<style>body{margin:0;height:1800px}#p-200001046{position:absolute;top:530px}#p-210188933{position:absolute;top:850px}footer{position:fixed;bottom:0;height:100px;width:100%;background:white}</style>
    <div id="saleAttributesItems"><label><input type="checkbox" value="200001046" checked>RAM</label><label><input type="checkbox" value="210188933" checked>Storage</label></div>
    <div id="struct-specification"><div id="p-200001046"><label>RAM</label><div class="sell-sequential-combocheckbox"><button class="add-button">Add</button></div></div>
    <div id="p-210188933"><label><input type="checkbox" value="128">128 GB</label><label><input type="checkbox" value="256">256 GB</label><label><input type="checkbox" value="512">512 GB</label></div></div><footer>Publish controls</footer>
    <script>window.adds=0;document.querySelector('button').onclick=function(){
      window.adds++;const wrap=document.createElement('div');wrap.className='sell-sequential-combobox-custom-wrap';const input=document.createElement('input');
      input.onblur=()=>{if(!input.value)return;const label=document.createElement('label');const box=document.createElement('input');box.type='checkbox';box.value=input.value;label.append(box,document.createTextNode(input.value));document.querySelector('#p-200001046').append(label);wrap.remove()};
      wrap.append(input);this.parentElement.append(wrap);
    }</script>`);
  const product = { variantGroups: [{ id: '200001046', name: 'ram', options: ['16g'] },
    { id: '210188933', name: 'storage capacity', options: ['128 GB', '256 GB', '512 GB'] }] };
  const progress = [];
  const result = await fillVariantSpecs(page, product, message => progress.push(message));
  assert.deepEqual(result.unmapped, []);
  assert.ok(progress.includes('已填写规格 ram：1/1'));
  assert.ok(progress.includes('已填写规格 storage capacity：3/3'));
  assert.equal(await page.evaluate(() => window.adds), 1);
  assert.deepEqual(await page.locator('#struct-specification input:checked').evaluateAll((nodes) => nodes.map((node) => node.value)), ['16g', '128', '256', '512']);
  await fillVariantSpecs(page, product);
  assert.equal(await page.evaluate(() => window.adds), 1);
});

browserTest('recovers inside the logistics dialog without cancelling its selected source value', async (page) => {
  await page.setContent(`<div id="logisticsProperty"><div class="logistics-property-content"></div><button id="edit">Edit</button></div>
    <div class="product-attr-dialog" role="dialog" style="display:none"><div class="tagWrapper"><span class="tag" style="position:fixed;left:100px;top:200px;width:400px;height:50px">含电池</span></div>
    <button id="confirm">确认</button><button id="cancel">取消</button><aside style="position:fixed;left:240px;top:190px;width:160px;height:90px;background:white">Help</aside></div>
    <script>window.cancelled=0;const dialog=document.querySelector('[role=dialog]');document.querySelector('#edit').onclick=()=>dialog.style.display='block';
    document.querySelector('.tag').onclick=function(){this.classList.toggle('isSelected')};document.querySelector('#confirm').onclick=()=>{document.querySelector('.logistics-property-content').textContent=document.querySelector('.isSelected')?.textContent||'';dialog.style.display='none'};
    document.querySelector('#cancel').onclick=()=>{window.cancelled++;dialog.style.display='none'}</script>`);
  configurePostingInteractions(page, { recover: (target) => recoverPostingClick(page, target) });
  assert.equal(await fillLogisticsAttributes(page, { logisticsAttributes: ['含电池'] }), true);
  assert.equal(await page.locator('.logistics-property-content').textContent(), '含电池');
  assert.equal(await page.evaluate(() => window.cancelled), 0);
});

browserTest('captures the image chooser after a recovery longer than its chooser timeout and detaches listeners', async (page) => {
  await page.setContent(`<input type="file" hidden><button onclick="window.clicks++;document.querySelector('input').click()">Upload</button>
    <aside style="position:fixed;inset:0;background:white">Loading</aside><script>window.clicks=0;setTimeout(()=>document.querySelector('aside').remove(),900)</script>`);
  const initialListeners = page.listenerCount('filechooser');
  const chooser = await choosePostingFile(page, page.locator('button'), { timeout: 500, chooserTimeout: 200, recover: (target) => recoverPostingClick(page, target) });
  assert.ok(chooser);
  await chooser.setFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('image fixture') });
  assert.deepEqual(await page.evaluate(() => [window.clicks, document.querySelector('input').files[0].name]), [1, 'fixture.png']);
  assert.equal(page.listenerCount('filechooser'), initialListeners);
  await page.setContent('<button>Not an upload</button>');
  assert.equal(await choosePostingFile(page, page.locator('button'), { chooserTimeout: 100 }), null);
  assert.equal(page.listenerCount('filechooser'), initialListeners);
});
