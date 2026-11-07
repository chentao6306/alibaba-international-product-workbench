import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillChoice, fillCategoryAttributes, requireCategoryAttributes } from '../server/publisher.js';
import { extractAlibabaAttributes, readPostingAttributeSchema } from '../server/category-attributes.js';
import { clickPostingControl, configurePostingInteractions } from '../server/posting-interaction.js';
import { assignStructuredImageFiles, uploadStructuredImages } from '../server/structured-description.js';
import { publishEnvironmentBlockCode, submitWithRepairs } from '../server/publish-recovery.js';

const timeout = () => Object.assign(new Error('locator operation: Timeout after dispatch'), { name: 'TimeoutError' });

test('unknown control or image receipts never trigger validation-based resubmission in any category', async () => {
  for (const code of ['PUBLISH_CONTROL_RESULT_UNKNOWN', 'PUBLISH_IMAGE_RECEIPT_UNKNOWN']) {
    const error = Object.assign(new Error('Product images required; 属性值不能为空'), { code });
    assert.equal(publishEnvironmentBlockCode(error), code);
    let attempts = 0, repairs = 0;
    await assert.rejects(submitWithRepairs({ submit: async () => { attempts++; throw error; },
      repairs: { attributes: () => { repairs++; return true; }, mainImages: () => { repairs++; return true; } },
    }), value => value === error);
    assert.equal(attempts, 1); assert.equal(repairs, 0);
  }
});
// Inject a lost automation acknowledgement after real DOM events. The actual
// browser controls and their values remain the source of the recovery receipt.
function delayedAcknowledgement(target, intercept) {
  return new Proxy(target, { get(object, key) {
    const member = Reflect.get(object, key);
    if (typeof member !== 'function') return member;
    return (...args) => {
      if (key === 'click' || key === 'setInputFiles') return intercept(object, key, args, () => member.apply(object, args));
      const result = member.apply(object, args);
      return result && typeof result.locator === 'function' && typeof result.click === 'function' ? delayedAcknowledgement(result, intercept) : result;
    };
  } });
}
const browserTest = (name, run, timeoutMs = 30000) => test(name, { skip: !findChromium(), timeout: timeoutMs }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'late-publish-receipt-'));
  try { await run(await browser.newPage(), directory); }
  finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

browserTest('a type dropdown and option can commit after lost click acknowledgements without another click', async page => {
  await page.setContent(`<div class="sell-catProp-item"><label>类型</label><div class="next-select next-select-single">
    <input readonly role="combobox" aria-expanded="false" aria-controls="types"><span class="next-select-values"><em></em></span></div></div>
    <div id="types" role="listbox" hidden><div role="option" data-value="digital">Digital</div></div>
    <script>window.opens=0;window.choices=0;
    const input=document.querySelector('input'),menu=document.querySelector('#types');
    input.onclick=()=>{window.opens++;input.setAttribute('aria-expanded','true');menu.hidden=false};
    menu.onclick=()=>{window.choices++;setTimeout(()=>{document.querySelector('em').textContent='Digital';menu.hidden=true;input.setAttribute('aria-expanded','false')},150)};
    document.onkeydown=e=>{if(e.key==='Escape')menu.hidden=true};</script>`);
  const wrapped = delayedAcknowledgement(page, async (target, action, args, invoke) => {
    const result = await invoke();
    if (action === 'click' && !args[0]?.trial) throw timeout();
    return result;
  });
  assert.equal(await fillChoice(wrapped, wrapped.locator('input'), 'Digital', { multiple: false }), true);
  assert.deepEqual(await page.evaluate(() => [window.opens, window.choices, document.querySelector('em').textContent]), [1, 1, 'Digital']);
});

browserTest('uncertain clicks stay failed when their specific receipt is absent and cancellation stops readback', async page => {
  await page.setContent('<button onclick="window.clicks++">Submit</button><script>window.clicks=0</script>');
  const button = page.locator('button');
  const target = delayedAcknowledgement(button, async (_target, action, args, invoke) => {
    await invoke(); if (action === 'click' && !args[0]?.trial) throw timeout();
  });
  await assert.rejects(clickPostingControl(page, target, { confirmationTimeout: 200, confirmResult: async () => false }), { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.clicks), 1);
  const controller = new AbortController(); configurePostingInteractions(page, { signal: controller.signal });
  await assert.rejects(clickPostingControl(page, target, { confirmResult: async () => { controller.abort(); return true; } }), { code: 'PUBLISH_PAUSED' });
  assert.equal(await page.evaluate(() => window.clicks), 2);
});

browserTest('late option receipts remain isolated when reusing a page across category and multi-select controls', async page => {
  // These are control fixtures, not claims of live category acceptance. The
  // medical property identity/value comes from the older customer diagnostic.
  const cases = [
    ['191284229', 'Type', '类型', ['Digital'], false],
    ['800001', 'Type', '类型', ['Adapter'], false],
    ['800002', 'Writing width', '书写宽度', ['0.7 mm'], false],
    ['800003', 'Application', '具体用途', ['Oil'], false],
    ['800004', 'Fabric Blend', '面料', ['Cotton, linen blend', 'Wool'], true],
    ['800005', 'Body Material', '灯体材质', ['Glass', 'Brass'], true],
    ['800006', 'Type', '类型', ['Preserved'], false],
  ];
  const wrapped = delayedAcknowledgement(page, async (_target, action, args, invoke) => {
    const result = await invoke(); if (action === 'click' && !args[0]?.trial) throw timeout(); return result;
  });
  for (const [id, name, label, values, multiple] of cases) {
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-${id}"><label class="label required">${label}</label>
      <div class="next-select next-select-${multiple ? 'multiple' : 'single'}"><div class="next-select-values"></div>
      <input ${multiple ? '' : 'readonly'} role="combobox" aria-expanded="false" aria-controls="current-options"></div></div>
      <div id="unrelated" class="next-select"><em>Digital</em></div><div id="current-options" role="listbox" hidden></div>`);
    await page.evaluate(values => {
      const input = document.querySelector('input'), menu = document.querySelector('#current-options');
      window.choices = [];
      for (const value of [...values, 'Unrelated']) {
        const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = value;
        option.onclick = () => { window.choices.push(value); setTimeout(() => {
          const chip = document.createElement('em'); chip.textContent = value;
          document.querySelector('.next-select-values').append(chip); menu.hidden = true; input.setAttribute('aria-expanded', 'false');
        }, 50); }; menu.append(option);
      }
      input.onclick = () => { menu.hidden = false; input.setAttribute('aria-expanded', 'true'); };
      document.onkeydown = event => { if (event.key === 'Escape') { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); } };
    }, values);
    const product = { attributes: extractAlibabaAttributes({ globalData: { product: {
      properties: [{ propertyId: id, propertyName: name, value: multiple ? values : values[0] }],
    } } }) };
    const original = structuredClone(product);
    await fillCategoryAttributes(wrapped, product);
    await requireCategoryAttributes(wrapped, product);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema))[0].values, values);
    assert.deepEqual(await page.evaluate(() => window.choices), values, 'Each option is clicked only once');
    assert.deepEqual(product, original);
  }
}, 90000); // Seven full control flows also run through the encrypted package.

browserTest('a receipt read can remount without repeating the action or accepting another property value', async page => {
  await page.setContent('<button onclick="window.clicks++">Type</button><script>window.clicks=0</script>');
  const target = delayedAcknowledgement(page.locator('button'), async (_target, action, args, invoke) => {
    await invoke(); if (action === 'click' && !args[0]?.trial) throw timeout();
  });
  let reads = 0;
  await clickPostingControl(page, target, { confirmResult: async () => { if (++reads === 1) throw timeout(); return true; } });
  assert.equal(reads, 2); assert.equal(await page.evaluate(() => window.clicks), 1);
  await page.setContent('<div class="sell-catProp-item"><div class="next-select"><input readonly role="combobox" aria-expanded="true" aria-controls="menu"></div></div><div class="next-select"><em>Digital</em></div><div id="menu" role="listbox"><div role="option" onclick="window.choices++">Digital</div></div><script>window.choices=0</script>');
  const wrapped = delayedAcknowledgement(page, async (_target, action, args, invoke) => {
    const result = await invoke(); if (action === 'click' && !args[0]?.trial) throw timeout(); return result;
  });
  await assert.rejects(fillChoice(wrapped, wrapped.locator('input'), 'Digital', { multiple: false }), { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.choices), 1);
});

browserTest('structured uploads keep source order and accept each file once after lost upload acknowledgements', async (page, directory) => {
  await page.setContent(`<div id="detailImage"><label><input type="checkbox">Other product images</label>
    <input type="file" multiple><div id="images"></div></div><script>window.uploads=[];
    document.querySelector('input[type=file]').onchange=e=>{const files=[...e.target.files];window.uploads.push(files.map(f=>f.name));
    files.forEach(file=>setTimeout(()=>{const row=document.createElement('div');row.className='gallery-item-image';
    row.innerHTML='<img alt="'+file.name+'" src="https://sc01.alicdn.com/kf/'+file.name+'">';document.querySelector('#images').append(row)},150))};</script>`);
  const files = ['one.jpg', 'two.jpg'].map(name => { const file = path.join(directory, name); fs.writeFileSync(file, 'fixture'); return file; });
  const wrapped = delayedAcknowledgement(page, async (_target, action, _args, invoke) => {
    const result = await invoke(); if (action === 'setInputFiles') throw timeout(); return result;
  });
  const urls = await uploadStructuredImages(wrapped, files, () => {}, { ordered: true });
  assert.deepEqual(urls, files.map(file => 'https://sc01.alicdn.com/kf/' + path.basename(file)));
  assert.deepEqual(await page.evaluate(() => window.uploads), [['one.jpg'], ['two.jpg']]);
});

browserTest('a removed upload input requires matching gallery receipts and never retries an unknown upload', async (page, directory) => {
  const file = path.join(directory, 'one.jpg'); fs.writeFileSync(file, 'fixture');
  for (const accepted of [true, false]) {
    await page.setContent(`<div id="target"><input type="file"></div><div id="unrelated"><div class="gallery-item-image"><img alt="one.jpg" src="https://sc01.alicdn.com/kf/one.jpg"></div></div>`);
    let calls = 0;
    const input = delayedAcknowledgement(page.locator('#target input'), async (_target, _action, _args, invoke) => {
      calls++; await invoke(); await page.locator('#target input').evaluate(node => node.remove());
      if (accepted) await page.evaluate(() => setTimeout(() => { document.querySelector('#target').innerHTML='<div class="gallery-item-image"><img alt="one.jpg" src="https://sc01.alicdn.com/kf/one.jpg"></div>'; },150));
      throw timeout();
    });
    const action = assignStructuredImageFiles(page, input, [file], { gallery: page.locator('#target'), label: '公司图片 / Company overview', receiptTimeoutMs: 200 });
    if (accepted) await action;
    else await assert.rejects(action, error => error.code === 'PUBLISH_IMAGE_RECEIPT_UNKNOWN' && /公司图片/.test(error.message));
    assert.equal(calls, 1);
  }
});
