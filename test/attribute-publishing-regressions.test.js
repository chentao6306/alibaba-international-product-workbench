import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { attributeOptionMatchScore, measurementFits } from '../server/attribute-values.js';
import { bindSourceAttributesToPostingSchema, mergeSourceAttributes, readPostingAttributeSchema, sourceAttributeForField } from '../server/category-attributes.js';
import { categoryReadiness, categoryRequirementSchema } from '../server/category-readiness.js';
import { originCountry } from '../server/origin-country.js';
import { attributeFieldMatchesValue, fillCategoryAttributes, SellerPublisher, requireCategoryAttributes, requiredAttributeFailure, recoverRequiredAttributes } from '../server/publisher.js';

const field = (id, label, controlType = 'combobox') => ({ id, label, labels: [label], required: true, controlType });
const resolve = (attributes, label) => sourceAttributeForField({ attributes }, field('', label));

test('maps already collected English earbud fields to Chinese labels without confusing unit-qualified battery capacity', () => {
  const attributes = [
    { name: 'Estimated Battery Life', value: '3-5 hours' }, { name: 'touch screen', value: 'No' },
    { name: 'battery capacity(mah)', value: '200-500mah' }, { name: 'Battery capacity', value: '35mAh * 2' },
    { name: 'headphone form factor', value: 'Ear-clip' }, { name: 'Waterproof Standard', value: 'IPX-3' },
  ];
  for (const [label, value] of [['预计电池续航时间', '3-5 hours'], ['触摸屏', 'No'], ['电池容量 (mAh)', '200-500mah'], ['耳机佩戴方式', 'Ear-clip'], ['防水标准', 'IPX-3']]) {
    assert.equal(resolve(attributes, label).value, value);
  }
});

test('speaker properties keep battery presence, capacity and unit-qualified ranges separate in Chinese forms', () => {
  const tuples = [
    ['battery', '电池', 'Yes'], ['Battery Capacity', '电池容量', '1800mah'],
    ['Battery Capacity(mAh)', '电池容量(毫安)', '1000-2000mah'],
    ['cabinet material', '柜体材质', 'Plastic'], ['channels', '通道', '1'],
    ['built-in microphone', '内置麦克风', 'No'], ['remote control', '遥控器', 'No'],
    ['support app', '支持APP', 'No'], ['bluetooth standard', '蓝牙标准', 'Bluetooth v5.3'],
    ['number of loudspeaker enclosure', '扬声器数量', '1'], ['support microphone', '支持麦克风', 'No'],
    ['Audio Crossover', '主扬声器的分频类型', 'Full-Range'], ['battery charging time', '电池充电时间', '3-5 hours'],
    ['Connection', '连接方式', 'Wireless'], ['display screen', '显示屏', 'No'],
    ['frequency range', '频率范围', '100HZ-20KHZ'], ['pmpo', '峰值功率', '5-10W'],
    ['power source', '电源', 'Rechargeable Battery'], ['support memory card', '支持内存卡', 'No'],
    ['voice control', '语音控制', 'No'], ['with handheld microphone', '带手持麦克风', 'No'],
    ['woofer size/full-range size', '低音单元尺寸/全频单元尺寸', '1.8"'],
  ];
  const product = { attributes: tuples.map(([name, , value]) => ({ name, value })) };
  const original = structuredClone(product);
  const schema = tuples.map(([, label], index) => field(String(100000 + index), label));
  for (const current of [product, bindSourceAttributesToPostingSchema(product, schema)]) {
    schema.forEach((f, index) => assert.equal(sourceAttributeForField(current, f)?.value, tuples[index][2], f.label));
  }
  assert.deepEqual(product, original);
  assert.equal(resolve([{ name: 'battery', value: 'No' }], '电池容量'), null);
  assert.equal(resolve([{ name: 'battery capacity', value: '1800mah' }], '电池'), null);
  assert.equal(resolve([{ name: 'battery', value: 'Yes' }, { name: 'Battery', value: 'No' }], '电池').conflict, true);
});

test('category passes and field repairs preserve SKU colors instead of adding descriptive colors without images', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const [id, options, description] of [
      ['210190015', ['Blue'], ['Picture', 'Blue']],
      ['210190015', ['Dark Grey'], 'Dark Gray'],
      ['191288010', ['Black', 'Blue'], ['Picture', 'Black, Blue']],
    ]) {
      await page.setContent(`<div class="sell-catProp-item" id="struct-p-3"><label class="label">型号</label><input></div>
        <div id="struct-specification"><div id="p-${id}"><label class="label required">颜色</label>
        ${options.map((value) => `<input role="colorCombobox" value="${value}">`).join('')}</div></div>`);
      const product = { attributes: [{ name: 'Color', value: description }, { name: 'Model Number', value: 'B6 Neo+' }],
        variantGroups: [{ id, name: 'color', options, optionImages: Object.fromEntries(options.map((value) => [value, `${value}.jpg`])) }] };
      const original = structuredClone(product);
      await fillCategoryAttributes(page, product);
      assert.deepEqual(await recoverRequiredAttributes(page, product, ['颜色']), []);
      assert.deepEqual(await page.locator('[role=colorCombobox]').evaluateAll((nodes) => nodes.map((node) => node.value)), options);
      assert.equal(await page.locator('#struct-p-3 input').inputValue(), 'B6 Neo+');
      assert.deepEqual(product, original);
    }
  } finally { await browser.close(); }
});

test('verifies complete joined values only in plain text fields without accepting lost values or conflating choices', () => {
  const source = ['G630', 'SKYRC G630'];
  const text = { label: '型号', controlType: 'text', values: ['G630,SKYRC G630'] };
  assert.equal(attributeFieldMatchesValue(text, source), true);
  assert.equal(attributeFieldMatchesValue({ ...text, values: ['G630'] }, source), false);
  assert.equal(attributeFieldMatchesValue({ ...text, values: ['G630, SKYRC G631'] }, source), false);
  assert.equal(attributeFieldMatchesValue({ ...text, controlType: 'combobox' }, source), false);
  assert.equal(attributeFieldMatchesValue({ ...text, values: ['G630, SKYRC G630', 'Unexpected'] }, source), false);
});

test('round trips collected arrays through model, product type and feature text fields across category schemas', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-3"><label class="label">型号</label><input></div>
      <div class="sell-catProp-item" id="struct-p-238738566"><label class="label required">产品类型</label><input></div>
      <div class="sell-catProp-item" id="struct-p-373265001"><label class="label">功能</label><textarea></textarea></div>`);
    const product = { attributes: [
      { id: '3', name: 'Model Number', value: ['SKYRC PC1080Neo', 'PC1080Neo'] },
      { id: '238738566', name: 'Product Type', value: ['For drone', 'Thermometer'] },
      { id: '373265001', name: 'Function', value: ['Camber Toe Steering', 'Multi-function'] },
    ] };
    const original = structuredClone(product);
    await fillCategoryAttributes(page, product);
    await requireCategoryAttributes(page, product);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema)).map((f) => f.values), [
      ['SKYRC PC1080Neo, PC1080Neo'], ['For drone, Thermometer'], ['Camber Toe Steering, Multi-function'],
    ]);
    assert.deepEqual(product, original);
    await page.locator('#struct-p-3 input').fill('PC1080Neo');
    await assert.rejects(requireCategoryAttributes(page, product), (error) => error.unmatchedSourceFields.includes('型号'));
  } finally { await browser.close(); }
});

test('recognizes collected charger fields by Chinese posting labels without a reference product', () => {
  const attributes = [{ name: 'output power', value: '35 W' }, { name: 'multi-function integrated', value: 'With lamp' }];
  const schema = [field('210216587', '输出功率'), field('227522851', '多功能一体化')];
  const bound = bindSourceAttributesToPostingSchema({ attributes }, schema);
  assert.deepEqual(schema.map((f) => sourceAttributeForField(bound, f).value), ['35 W', 'With lamp']);
  assert.deepEqual(bound.attributes.map((a) => a.id), ['210216587', '227522851']);
  assert.equal(attributes[0].id, undefined);
});

test('does not accept a joined cellular list or another model just because one number matches', () => {
  assert.equal(attributeOptionMatchScore('LTE, 5 G', '5G'), 0);
  assert.equal(attributeOptionMatchScore('LTE, CDMA2000', 'CDMA2000'), 0);
  assert.equal(attributeOptionMatchScore('Model A 12', 'Model B 12'), 0);
  assert.equal(attributeOptionMatchScore('5 G', '5G'), 100);
  const f = { ...field('200000573', '蜂窝网络'), values: ['LTE', '5 G'] };
  assert.equal(attributeFieldMatchesValue(f, 'LTE, 5 G'), true);
  assert.equal(attributeFieldMatchesValue({ ...f, values: ['5 G'] }, 'LTE, 5 G'), false);
  assert.equal(attributeFieldMatchesValue({ ...f, values: ['LTE', '5 G', '3 G'] }, 'LTE, 5 G'), false);
});

test('reconciles screen and battery measurements within ranges while preserving real contradictions and units', () => {
  const screen = [{ name: 'screen', value: '>7"' }, { name: 'Screen Size', value: '7.3 Inch HD Screen' }];
  const copy = structuredClone(screen);
  assert.equal(resolve(screen, '屏幕').value, '7.3 Inch');
  assert.deepEqual(screen, copy);
  assert.equal(resolve([{ name: 'screen', value: ['>7"', '7.3 Inch'] }], '屏幕').value, '7.3 Inch');
  assert.equal(resolve([{ name: 'battery capacity', value: '4000-4999mAh' }, { name: 'Battery capacity', value: '4000mAh' }], '电池容量').value, '4000mAh');
  assert.equal(resolve([{ name: 'battery capacity', value: '5000-5999mAh' }, { name: 'Battery', value: '5000Mah Lithium-ion Battery' }], '电池容量').value, '5000Mah');
  assert.equal(resolve([{ name: 'screen', value: '7"' }, { name: 'Screen Size', value: '7.3 inch' }], '屏幕').conflict, true);
  assert.equal(resolve([{ name: 'battery capacity', value: ['4000mAh', '5000mAh'] }], '电池容量').conflict, true);
  assert.equal(resolve([{ name: 'battery capacity', value: 'Above 8000mAh' }, { name: 'Battery', value: '8000mAh' }], '电池容量').conflict, true);
  assert.equal(measurementFits('7 cm', '>7 inch', 'inch'), false);
  assert.equal(measurementFits('7 inch', '>7 inch', 'inch'), false);
  assert.equal(measurementFits('7.3 inch', '>7 inch', 'inch'), true);
  assert.equal(attributeOptionMatchScore('7.3 inch', '>7"'), 70);
});

test('keeps CPU core count separate from model and preserves conflicting core counts', () => {
  const attributes = [{ name: 'cpu', value: 'Deca Core' }, { name: 'CPU', value: 'Snapdrtagon 8 Gen3' }];
  assert.equal(mergeSourceAttributes(attributes).length, 2);
  const f = field('200001044', '手机中央处理器');
  const bound = bindSourceAttributesToPostingSchema({ attributes }, [f]);
  assert.equal(sourceAttributeForField(bound, f).value, 'Deca Core');
  assert.equal(sourceAttributeForField({ attributes: [{ id: f.id, name: 'CPU', value: ['Deca Core', 'Snapdrtagon 8 Gen3'] }] }, f).value, 'Deca Core');
  assert.equal(resolve([...attributes, { name: 'CPU', value: 'Octa Core' }], f.label).conflict, true);
  assert.equal(resolve([...attributes, { name: 'CPU', value: 'Unidentified processor' }], f.label).conflict, true);
});

test('recognizes equivalent cellular sets without silently unioning inconsistent sources', () => {
  const attributes = [{ name: 'cellular', value: 'LTE, 5 G' }, { name: 'Cellular Network', value: ['5G', 'LTE'] }];
  assert.equal(resolve(attributes, '蜂窝网络').conflict, undefined);
  assert.equal(resolve([...attributes, { name: 'network', value: '3G' }], '蜂窝网络').conflict, true);
});

test('resolves a collected mainland province in the origin field and still reports an unknown region', async () => {
  assert.equal(originCountry('Mainland China'), 'China');
  assert.equal(originCountry('Fujian, Mainland China'), 'China');
  assert.equal(originCountry('Fujian'), 'China');
  const product = { categoryId: '100', attributes: [{ name: 'place of origin', value: 'Fujian' }] };
  const schema = categoryRequirementSchema('100', [field('origin', '产地')]);
  assert.deepEqual(categoryReadiness(product, schema).missing, []);
  product.attributes[0].value = 'Unrecognized region';
  assert.deepEqual(categoryReadiness(product, schema).missing, ['产地']);
  const error = await requiredAttributeFailure({ evaluate: async () => schema.fields }, product, ['产地']);
  assert.deepEqual(error.missingSourceFields, ['产地']);
  assert.deepEqual(error.unmatchedSourceFields, []);
});

test('preserves old charger and phone attributes through the full field-filling entry point', { skip: !findChromium(), timeout: 40000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-210216587"><label class="label required">输出功率</label>
      <select><option value="">请选择</option><option>35W</option><option>350W</option></select></div>
      <div class="sell-catProp-item" id="struct-p-227522851"><label class="label required">多功能一体化</label>
      <select><option value="">请选择</option><option>With lamp</option></select></div>
      <div class="sell-catProp-item" id="struct-p-200000573"><label class="label required">蜂窝网络</label>
      <div class="next-select"><div class="next-select-values"></div><input readonly role="combobox"></div></div>
      <div class="sell-catProp-item" id="struct-p-191294355"><label class="label required">屏幕</label>
      <select><option value="">请选择</option><option>&gt;7&quot;</option><option>6.8 inch</option></select></div>
      <div class="sell-catProp-item" id="struct-p-200001044"><label class="label required">手机中央处理器</label>
      <select><option value="">请选择</option><option>Octa Core</option><option>Deca Core</option></select></div>
      <div class="next-select-popup" hidden><div role="option">LTE</div><div role="option">5 G</div><div role="option">CDMA2000</div></div>
      <script>
      const input=document.querySelector('[role=combobox]'), menu=document.querySelector('.next-select-popup'), values=document.querySelector('.next-select-values');
      input.onclick=()=>{menu.hidden=false;input.setAttribute('aria-expanded','true')};
      menu.onclick=e=>{if(e.target.matches('[role=option]')){const label=e.target.textContent;setTimeout(()=>{const chip=document.createElement('em');chip.textContent=label;values.append(chip)},200)}};
      document.onkeydown=e=>{if(e.key==='Escape'){menu.hidden=true;input.setAttribute('aria-expanded','false')}};
      </script>`);
    const product = { attributes: [
      { name: 'output power', value: '35 W' }, { name: 'multi-function integrated', value: 'With lamp' },
      { name: 'cellular', value: ['LTE, 5 G', 'CDMA2000'] },
      { name: 'screen', value: '>7"' }, { name: 'Screen Size', value: '7.3 Inch' },
      { name: 'cpu', value: 'Deca Core' }, { name: 'CPU', value: 'Snapdrtagon 8 Gen3' },
    ] };
    const original = structuredClone(product);
    const bound = bindSourceAttributesToPostingSchema(product, await page.evaluate(readPostingAttributeSchema));
    await SellerPublisher.prototype.fillStableProductFields.call({}, page, bound);
    await requireCategoryAttributes(page, bound);
    assert.deepEqual((await page.evaluate(readPostingAttributeSchema)).map((f) => f.values), [['35W'], ['With lamp'], ['LTE', '5 G', 'CDMA2000'], ['>7"'], ['Deca Core']]);
    assert.deepEqual(product, original);
    await page.locator('.next-select-values em').first().evaluate((node) => node.remove());
    await assert.rejects(requireCategoryAttributes(page, bound), (error) => error.unmatchedSourceFields.includes('蜂窝网络'));
  } finally { await browser.close(); }
});
