import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { ORIGIN_COUNTRIES, originCountry, productOrigin, sourceOriginRegion } from '../server/origin-country.js';

test('reads a province explicitly contained in native origin without guessing cities or conflicting countries', () => {
  for (const [value, expected] of [['Guangdong, China', 'Guangdong'], ['China Zhejiang', 'Zhejiang'],
    ['Guangdong Province China', 'Guangdong'], ['中国浙江省', '浙江']]) {
    const product = { attributes: [{ name: 'Place of Origin', value }] };
    assert.equal(sourceOriginRegion(product, 'Province'), expected);
    assert.equal(sourceOriginRegion(product, 'City'), '');
    assert.equal(sourceOriginRegion({ ...product, origin: 'Japan' }, 'Province'), '');
  }
  for (const value of ['Shenzhen, China', 'Guangdong, Zhejiang, China', 'Guangdong, China, Japan', 'China']) {
    assert.equal(sourceOriginRegion({ attributes: [{ name: 'Place of Origin', value }] }, 'Province'), '', value);
  }
});

test('reads province and country without a comma while refusing ambiguous origin text', () => {
  for (const value of ['Zhejiang China', 'China Zhejiang', 'Guangdong Province China', '浙江省中国', '中国浙江省']) {
    assert.equal(originCountry(value), 'China', value);
  }
  assert.equal(productOrigin({ attributes: [{ name: 'Place of Origin', value: 'Zhejiang China' }] }), 'China');
  for (const value of ['Zhejiang China / Vietnam', 'China supplier', 'Not China', 'Georgia China']) {
    assert.equal(originCountry(value), '', value);
  }
});
import { recordProductMutation, syncProductModel } from '../server/product-model.js';
import { extractAlibabaAttributes, packagingFromAttributes, readAlibabaAttributeRows } from '../server/category-attributes.js';
import { fillOriginCountry, fillLogisticsFields, preparePublishProduct } from '../server/publisher.js';
import { configurePostingInteractions } from '../server/posting-interaction.js';
import { publishEnvironmentBlockCode } from '../server/publish-recovery.js';

test('origin recognizes the committed Alibaba autocomplete model without opening its search menu again', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="struct-p-1"><div class="label">产地</div><span class="next-select next-select-auto-complete"><input aria-autocomplete="list" value="China"></span></div>');
    await page.evaluate(() => {
      const row = document.querySelector('#struct-p-1');
      row.__reactFiber$qa = { memoizedProps: { id: 'struct-p-1' }, return: { memoizedProps: {
        id: 'icbuCatProp', name: 'p-1', value: { value: 458, text: 'China' }, dataSource: [{ value: 458, text: 'China' }],
      } } };
      window.opens = 0; row.querySelector('input').onclick = () => window.opens++;
    });
    assert.equal(await fillOriginCountry(page, 'China'), true);
    assert.equal(await page.evaluate(() => window.opens), 0);
    // A stale React alternate or a typed search value cannot overrule the
    // current committed property. The actual selection changes asynchronously.
    await page.evaluate(() => {
      const row = document.querySelector('#struct-p-1'), old = row.__reactFiber$qa;
      const current = { memoizedProps: old.memoizedProps, return: { memoizedProps: {
        id: 'icbuCatProp', name: 'p-1', value: { value: 600, text: 'Japan' }, dataSource: [{ value: 600, text: 'Japan' }, { value: 458, text: 'China' }],
      } } };
      old.alternate = current; old.return.return = { stateNode: { current: {} } };
      const popup = document.createElement('div'); popup.className = 'sell-o-select-options'; popup.style.display = 'none';
      popup.innerHTML = '<div class="options-item">China</div>'; document.body.append(popup);
      row.querySelector('input').onclick = () => { window.opens++; popup.style.display = 'block'; };
      popup.onclick = () => { popup.style.display = 'none'; setTimeout(() => { current.return.memoizedProps.value = { value: 458, text: 'China' }; window.committed = true; }, 200); };
    });
    assert.equal(await fillOriginCountry(page, 'China'), true);
    assert.equal(await page.evaluate(() => window.opens), 1);
    assert.equal(await page.evaluate(() => window.committed), true);
  } finally { await browser.close(); }
});

test('origin rejects a typed autocomplete value until its own property commits the selection', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="struct-p-1"><div class="label">产地</div><input aria-autocomplete="list" value="China"></div><div class="sell-o-select-options" style="display:none"><div class="options-item">China</div></div>');
    await page.evaluate(() => {
      const row = document.querySelector('#struct-p-1');
      row.__reactFiber$qa = { memoizedProps: { id: 'struct-p-1' }, return: { memoizedProps: {
        id: 'icbuCatProp', name: 'p-1', value: { value: 600, text: 'Japan' }, dataSource: [{ value: 600, text: 'Japan' }],
      }, return: { memoizedProps: { id: 'icbuCatProp', name: 'p-2', value: { value: 458, text: 'China' } } } } };
      const popup = document.querySelector('.sell-o-select-options');
      row.querySelector('input').onclick = () => { popup.style.display = 'block'; };
      // The UI search text changes but the platform rejects its selection.
      popup.onclick = () => { row.querySelector('input').value = 'China'; popup.style.display = 'none'; };
    });
    assert.equal(await fillOriginCountry(page, 'China'), false);
    assert.equal(await page.locator('input').inputValue(), 'China');
  } finally { await browser.close(); }
});

test('origin edits synchronize both representations and invalidate old option IDs without changing source or sales region', () => {
  const product = syncProductModel({ title: 'Paddle', origin: 'China', attributes: [
    { id: '100', name: 'Place of Origin', value: 'China', valueIds: { China: 'CN' } },
    { name: 'Brand', value: 'DKS' },
  ], customAttributes: [{ name: '原产地', value: 'China' }], regionalPricing: { country: 'United States', price: 10 },
  packaging: { weight: '1', length: '30', width: '20', height: '10' } });
  const source = structuredClone(product.source);
  recordProductMutation(product, { origin: 'Japan', packaging: { weight: '2' } });
  assert.equal(product.origin, 'Japan');
  assert.deepEqual(product.attributes[0], { id: '100', name: 'Place of Origin', value: 'Japan' });
  assert.equal(product.customAttributes[0].value, 'Japan');
  assert.deepEqual(product.packaging, { weight: '2', length: '30', width: '20', height: '10' });
  assert.equal(product.regionalPricing.country, 'United States');
  assert.deepEqual(product.source, source);
  recordProductMutation(product, { origin: 'Japan', attributes: [{ ...product.attributes[0], value: '中国' }, product.attributes[1]] });
  assert.equal(product.origin, 'China');
  assert.equal(product.customAttributes[0].value, 'China');
  recordProductMutation(product, { attributes: [{ ...product.attributes[0], value: 'Japan', valueIds: { China: 'CN' } }, product.attributes[1]] });
  assert.equal(product.attributes[0].valueIds, undefined);
  assert.equal(product.origin, 'Japan');
  recordProductMutation(product, { origin: 'China' });
  recordProductMutation(product, { regionalPricing: { country: 'Japan', price: 20 } });
  assert.equal(product.origin, 'China');
  recordProductMutation(product, { origin: '' });
  assert.equal(product.attributes[0].value, '');
  assert.equal(product.customAttributes[0].value, '');
  assert.equal(product.sourceIntegrity.valid, true);
});

test('origin retries when Alibaba replaces the field before the first selection is committed', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item"><label>原产地</label><span class="next-select-values"></span><input id="origin" role="combobox"></div>
      <div class="next-select-popup" style="display:none"><div role="listbox"></div></div>
      <script>(() => {
        const popup = document.querySelector('.next-select-popup');
        const list = popup.querySelector('[role=listbox]');
        window.selections = 0;
        const mount = () => {
          const trigger = document.querySelector('#origin');
          trigger.onclick = () => { popup.style.display = 'block'; list.innerHTML = '<div role="option">日本</div>'; };
          list.onclick = () => {
            window.selections += 1;
            popup.style.display = 'none';
            const replacement = trigger.cloneNode(true);
            replacement.removeAttribute('data-codex-field');
            trigger.remove();
            setTimeout(() => {
              document.querySelector('.sell-catProp-item').appendChild(replacement);
              if (window.selections > 1) document.querySelector('.next-select-values').innerHTML = '<em>日本</em>';
              mount();
            }, 150);
          };
        };
        mount();
      })();</script>`);
    assert.equal(await fillOriginCountry(page, 'Japan'), true);
    assert.equal(await page.locator('.next-select-values').innerText(), '日本');
    assert.equal(await page.evaluate(() => window.selections), 2);
    assert.equal(await fillOriginCountry(page, 'Japan'), true);
    assert.equal(await page.evaluate(() => window.selections), 2);
  } finally { await browser.close(); }
});

test('origin recovers a timed-out open, waits for asynchronously mounted options and preserves other fields', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`<input id="title" value="Saved charger"><div class="sell-catProp-item"><label>产地</label>
      <span class="next-select-values"></span><input readonly role="combobox"></div>
      <div class="sell-catProp-item"><label>省份</label><input value=""></div>
      <div class="next-select-popup" hidden><div role="listbox"></div></div><script>(() => {
        window.opens = 0; window.selections = 0;
        document.querySelector('[role=combobox]').onclick = () => {
          if (++window.opens === 1) return;
          const popup = document.querySelector('.next-select-popup'); popup.hidden = false;
          setTimeout(() => {
            popup.querySelector('[role=listbox]').innerHTML = '<div role="option">中国</div>';
            popup.querySelector('[role=option]').onclick = () => {
              window.selections++; document.querySelector('.next-select-values').textContent = 'China'; popup.hidden = true;
            };
          }, 250);
        };
      })();</script>`);
    assert.equal(await fillOriginCountry(page, 'China'), true);
    assert.deepEqual(await page.evaluate(() => [window.opens, window.selections]), [2, 1]);
    assert.equal(await page.locator('#title').inputValue(), 'Saved charger');
    assert.equal(await page.locator('.sell-catProp-item').last().locator('input').inputValue(), '');
  } finally { await browser.close(); }
});

test('origin reports bounded control diagnostics when its dropdown never opens', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-catProp-item"><label>产地</label><input readonly role="combobox" onclick="window.opens++"></div><script>window.opens=0</script>');
    await assert.rejects(fillOriginCountry(page, 'China'), (error) => {
      assert.equal(error.code, 'PUBLISH_FIELD_NOT_READY');
      assert.equal(publishEnvironmentBlockCode(error), 'PUBLISH_FIELD_NOT_READY');
      assert.match(error.message, /产地.*3 次/);
      assert.equal(error.diagnostics.field, '产地');
      assert.equal(error.diagnostics.step, 'open-menu');
      assert.equal(error.diagnostics.attempts, 3);
      assert.equal(error.diagnostics.control.role, 'combobox');
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /Call log:|data-codex-field|country=/);
      return true;
    });
    assert.equal(await page.evaluate(() => window.opens), 3);
  } finally { await browser.close(); }
});

test('origin propagates cancellation and page closure without additional selections', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const controller = new AbortController();
    configurePostingInteractions(page, { signal: controller.signal });
    controller.abort();
    await page.setContent('<div class="sell-catProp-item"><label>产地</label><input readonly role="combobox" onclick="window.opens++"></div><script>window.opens=0</script>');
    await assert.rejects(fillOriginCountry(page, 'China'), { code: 'PUBLISH_PAUSED' });
    assert.equal(await page.evaluate(() => window.opens), 0);
    await page.close();
    await assert.rejects(fillOriginCountry(page, 'China'), (error) => {
      assert.match(error.message, /closed/);
      assert.notEqual(error.code, 'PUBLISH_FIELD_NOT_READY');
      return true;
    });
  } finally { await browser.close(); }
});

test('origin recovery preserves platform policy review without clicking its confirmation', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item"><label>产地</label><input readonly role="combobox"></div>
      <div class="next-dialog" role="dialog" style="position:fixed;inset:0;background:white;z-index:100">
        疑似涉及禁限售，会造成风控违规问题，请根据商品发布规则修改后提交发布
        <button onclick="window.confirmations++">继续提交</button>
      </div><script>window.confirmations=0</script>`);
    await assert.rejects(fillOriginCountry(page, 'China'), { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
    assert.equal(await page.evaluate(() => window.confirmations), 0);
    assert.equal(await page.locator('[role=dialog]').isVisible(), true);
  } finally { await browser.close(); }
});

test('preparing old products reconciles origin without inventing an absent or conflicting country', () => {
  const product = { title: 'Paddle', origin: 'Japan', attributes: [{ name: '原产地', value: 'China', valueIds: { China: 'CN' } }] };
  const prepared = preparePublishProduct(product);
  assert.equal(prepared.attributes[0].value, 'Japan');
  assert.equal(prepared.attributes[0].valueIds, undefined);
  assert.equal(product.attributes[0].value, 'China');
  assert.equal(productOrigin({ attributes: [{ name: 'Country of Origin', value: 'Japan' }] }), 'Japan');
  assert.equal(productOrigin({ attributes: [{ name: '产地', value: 'Japan' }, { name: '原产地', value: 'China' }] }), '');
  assert.equal(productOrigin({ origin: 'Unknown', attributes: [{ name: '产地', value: 'China' }] }), '');
  for (const country of ORIGIN_COUNTRIES) assert.equal(originCountry(`${country.name}（${country.label}）`), country.name);
});

test('collects package units in labels, individual dimensions and structured packaging without using product net size', () => {
  assert.deepEqual(packagingFromAttributes([{ name: 'Single gross weight (g)', value: '750' }, { name: 'Single package size (mm)', value: '300x200x100' }]),
    { weight: '0.75', length: '30', width: '20', height: '10' });
  assert.deepEqual(packagingFromAttributes([{ name: '单件包装尺寸', value: '30cm x 200mm x 0.1m' }]), { length: '30', width: '20', height: '10' });
  assert.deepEqual(packagingFromAttributes([{ name: '包装长（厘米）', value: '30' }, { name: 'Package width (in)', value: '2' }, { name: 'Package height', value: '100mm' }]),
    { length: '30', width: '5.08', height: '10' });
  assert.deepEqual(packagingFromAttributes([{ name: 'Single gross weight (stone)', value: '2' }, { name: 'Size', value: '1x2x3' }, { name: 'Single package size', value: '1-2x3x4cm' }]), {});
  assert.deepEqual(packagingFromAttributes(extractAlibabaAttributes({ nodeMap: { module_packaging: { privateData: {
    singleGrossWeight: 750, singleGrossWeightUnit: 'g', singlePackageSize: '30x20x10', singlePackageSizeUnit: 'cm',
  } } } })), { weight: '0.75', length: '30', width: '20', height: '10' });
});

test('normalizes explicit mainland provinces for publishing while preserving collected evidence and unknown countries', () => {
  for (const value of ['Fujian', '福建省', 'Guangdong Province', '浙江', 'Shaanxi', 'Shanxi', 'Inner Mongolia']) {
    assert.equal(originCountry(value), 'China');
    const product = { origin: '', attributes: [{ name: 'Place of Origin', value }] };
    const prepared = preparePublishProduct(product);
    assert.equal(prepared.origin, 'China');
    assert.equal(prepared.attributes[0].value, value);
    assert.equal(product.attributes[0].value, value);
  }
  for (const value of ['Unknown', 'Guangdong factory', 'China, United States', '']) assert.equal(originCountry(value), '');
  assert.equal(originCountry('Hong Kong'), 'Hong Kong S.A.R.');
  assert.equal(originCountry('Taiwan, China'), 'Taiwan, China');
  assert.equal(originCountry('Japan'), 'Japan');
});

test('collected definition-list origin and packaging survive editing and fill native publishing controls', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<dl><dt>Country of Origin</dt><dd>Japan</dd><dt>Single gross weight (g)</dt><dd>750</dd><dt>Single package size</dt><dd>30x20x10 cm</dd></dl>');
    const attributes = await page.evaluate(readAlibabaAttributeRows);
    assert.equal(attributes.length, 3);
    const product = syncProductModel({ title: 'Paddle', attributes, packaging: packagingFromAttributes(attributes) });
    recordProductMutation(product, { origin: 'CC', packaging: { weight: '0.8' } });
    const prepared = preparePublishProduct(product);
    await page.setContent(`<div class="sell-catProp-item"><label>原产地</label><select><option value="">请选择</option><option value="CN">中国</option><option value="CC">科科斯（基林）群岛</option></select></div>
      <div id="struct-logistics"><label>包装重量<input></label><label>包装长<input></label><label>包装宽<input></label><label>包装高<input></label></div>`);
    assert.equal(await fillOriginCountry(page, prepared.origin), true);
    assert.equal(await page.locator('select').inputValue(), 'CC');
    assert.deepEqual(prepared.packaging, { weight: '0.8', length: '30', width: '20', height: '10' });
    assert.equal(await fillLogisticsFields(page, prepared.packaging), true);
    assert.deepEqual(await page.locator('#struct-logistics input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['0.8', '30', '20', '10']);
  } finally { await browser.close(); }
});

test('origin selects translated portal options and waits for committed tags instead of search text', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const rejected of [false, true]) {
      await page.setContent(`<div class="sell-catProp-item"><label>原产地</label><span class="next-select-values"></span><input role="combobox"></div>
        <div class="next-select-popup" style="display:none"><input><div role="listbox"></div></div>
        <script>(()=>{
        const trigger=document.querySelector('[role=combobox]'),popup=document.querySelector('.next-select-popup'),search=popup.querySelector('input'),list=popup.querySelector('[role=listbox]');
        trigger.onclick=()=>{popup.style.display='block';list.innerHTML='<div role="option">中国</div>';};
        search.oninput=()=>{list.innerHTML=search.value==='日本'?'<div role="option">日本</div>':'';};
        list.onclick=()=>{trigger.value='Japan';popup.style.display='none';${rejected ? '' : "setTimeout(()=>document.querySelector('.next-select-values').innerHTML='<em>日本</em>',150);"}};
        })();</script>`);
      assert.equal(await fillOriginCountry(page, 'Japan'), !rejected);
    }
    await page.setContent(`<div class="sell-catProp-item"><label>原产地</label><input readonly role="combobox"></div>
      <div role="listbox" style="display:none"><div role="option" data-value="CC">Cocos (Keeling) Islands</div></div>
      <script>const input=document.querySelector('input'),menu=document.querySelector('[role=listbox]');input.onclick=()=>menu.style.display='block';menu.onclick=()=>{input.value='CC';menu.style.display='none';};</script>`);
    assert.equal(await fillOriginCountry(page, 'CC'), true);
    assert.equal(await fillOriginCountry(page, 'China'), false);
    assert.equal(await page.locator('input').inputValue(), 'CC');
  } finally { await browser.close(); }
});
