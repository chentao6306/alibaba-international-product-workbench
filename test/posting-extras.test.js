import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { regionalPriceRows, fillRegionalPrices, fillOptionalServices, linkProductCertificates } from '../server/posting-extras.js';
import { fillAndVerify } from '../server/publisher.js';
import { customizationGroups, customizationProblems } from '../server/product-services.js';

test('regional prices keep zero adjustments and reject duplicate, empty and invalid country pricing', () => {
  assert.deepEqual(regionalPriceRows({}), []);
  assert.equal(regionalPriceRows({ regionalPricing: { mode: 'amount', rows: [{ country: '美国', value: 0 }] } })[0].value, 0);
  assert.equal(regionalPriceRows({ regionalPricing: { country: 'US', price: 8 } })[0].code, 'US');
  for (const settings of [
    { rows: [{ country: 'unknown', value: 8 }] }, { rows: [{ country: 'US', value: '' }] },
    { rows: [{ country: 'US', value: 0 }] }, { rows: [{ country: 'US', value: 'bad' }] },
    { mode: 'percent', rows: [{ country: 'US', value: -100 }] },
    { rows: [{ country: 'US', value: 8 }, { country: 'United States', value: 9 }] },
  ]) assert.throws(() => regionalPriceRows({ regionalPricing: settings }), { code: 'PUBLISH_FIELD_NOT_READY' });
});

test('requires explicit customization terms and never invents supplier promises, surcharges or hotspots', () => {
  assert.deepEqual(customizationGroups({ customizations: [{ name: 'Packaging', moq: 3000 }] }), []);
  const services = { deepCustomization: ['chipset'], customizationDetails: { 'deepCustomization:chipset': { value: 'JL', moq: 3000 } } };
  const before = structuredClone(services);
  assert.deepEqual(customizationProblems(customizationGroups(services)[0]), []);
  assert.deepEqual(services, before);
  const packaging = { kind: 'lightCustomization', name: 'Packaging', rows: [{ value: 'Box', moq: 3000, surcharge: 0.5 }] };
  assert.match(customizationProblems(packaging).join(), /示例图/);
  assert.deepEqual(customizationProblems({ ...packaging, rows: [{ ...packaging.rows[0], image: 'https://example.test/box.jpg' }] }), []);
  const logo = { kind: 'lightCustomization', name: 'Logo/graphic design', rows: [{ value: 'Print', moq: 3000, surcharge: 1 }], baseImage: 'https://example.test/product.jpg', hotspot: { x: 10, y: 20, width: 30, height: 40 } };
  assert.deepEqual(customizationProblems(logo), []);
  assert.match(customizationProblems({ ...logo, hotspot: { ...logo.hotspot, width: 95 } }).join(), /定制区域/);
  assert.match(customizationProblems({ ...packaging, rows: [{ value: '', surcharge: -1, moq: 0 }] }).join(), /定制值.*起订量.*加价/);
});

test('regional publishing binds country columns instead of selection order and detects later lost values', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-icbuCountryRegion"><label>US<input type="checkbox" value="US"></label><label>CA<input type="checkbox" value="CA"></label></div>
      <div id="struct-countryLadderPrice"><label><input type="radio" checked>直接设置价格</label><table><thead><tr>
      <th><div class="next-table-cell-wrapper" data-next-table-col="1">加拿大售价</div></th>
      <th><div class="next-table-cell-wrapper" data-next-table-col="2">美国售价</div></th></tr></thead><tbody>
      ${[0, 1].map((row) => `<tr><td data-next-table-col="1"><input value="5"></td><td data-next-table-col="2"><input value="6"></td></tr>`).join('')}
      </tbody></table></div>`);
    const product = { regionalPricing: { rows: [{ country: 'US', value: 8 }, { country: 'CA', value: 9 }] } };
    await fillRegionalPrices(page, product, fillAndVerify);
    assert.deepEqual(await page.locator('tbody input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['9', '8', '9', '8']);
    await page.locator('tbody input').last().evaluate((node) => node.addEventListener('change', () => document.querySelector('tbody input').value = '0'));
    // Reverse country application so the reset happens after Canada was written.
    product.regionalPricing.rows.reverse();
    product.regionalPricing.rows[1].value = 7;
    await assert.rejects(fillRegionalPrices(page, product, fillAndVerify), /重绘丢失/);
    await assert.rejects(fillRegionalPrices(page, { regionalPricing: { rows: [{ country: 'Japan', value: 5 }] } }, fillAndVerify), /日本/);
  } finally { await browser.close(); }
});

test('explicit services and manual certificates never silently disappear during publication', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="sell-o-addon"><label class="sell-o-addon-label">售后服务</label><label><input type="radio" name="service">支持</label><label><input type="radio" name="service">不支持</label></div>');
    await fillOptionalServices(page, { services: { afterSales: false } });
    assert.equal(await page.getByLabel('不支持', { exact: true }).isChecked(), true);
    await fillOptionalServices(page, { services: { afterSales: true } });
    assert.equal(await page.getByLabel('支持', { exact: true }).isChecked(), true);
    for (const product of [{ services: { sample: false } }, { services: { lightCustomization: ['Packaging'] } }, { certificates: [{ source: 'manual', number: 'CERT-1' }] }]) {
      await assert.rejects(fillOptionalServices(page, product), /已停止提交/);
    }
    assert.equal((await fillOptionalServices(page, { certificates: [{ name: 'CE' }] })).length, 1);
  } finally { await browser.close(); }
});

test('certificate linking accepts only the exact selectable seller certificate and verifies the resulting association', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-certificate"><a>去关联</a><table><tbody id="linked"></tbody></table></div>
      <div class="posting-field-certificate-dialog" style="display:none"><input role="searchbox"><button class="next-search-btn">搜索</button>
      <table><tbody id="choices"><tr><td><label><input type="checkbox"></label></td><td>CERT-17</td><td>Test certificate</td></tr></tbody></table>
      <button role="btn-ok">确认</button><button role="btn-cancel">取消</button></div>
      <script>const dialog=document.querySelector('.posting-field-certificate-dialog');window.links=0;
      document.querySelector('a').onclick=()=>dialog.style.display='block';
      document.querySelector('[role=btn-cancel]').onclick=()=>dialog.style.display='none';
      document.querySelector('[role=btn-ok]').onclick=()=>{window.links++;document.querySelector('#linked').innerHTML='<tr><td>CERT-17</td><td>Test certificate</td></tr>';dialog.style.display='none';};</script>`);
    const cert = { source: 'manual', number: 'CERT-17', name: 'Test certificate' };
    await linkProductCertificates(page, [cert]);
    await linkProductCertificates(page, [cert]);
    assert.equal(await page.evaluate(() => window.links), 1);
    await assert.rejects(linkProductCertificates(page, [{ ...cert, number: 'CERT-1' }]), /未找到唯一/);
    assert.equal(await page.locator('.posting-field-certificate-dialog').isVisible(), false);
    await page.locator('#linked').evaluate((node) => node.innerHTML = '');
    await page.locator('#choices input').evaluate((node) => node.disabled = true);
    await assert.rejects(linkProductCertificates(page, [cert]), /不可选/);
    assert.equal(await page.evaluate(() => window.links), 1);
  } finally { await browser.close(); }
});

test('regional country picker searches all areas and commits only requested additional countries', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="struct-icbuCountryRegion"><span class="editBtn">添加国家/地区</span></div>
      <div class="icbu-dialog-selector" style="display:none"><iframe></iframe></div>
      <div id="struct-countryLadderPrice"><label><input type="radio" checked>直接设置价格</label><table><thead><tr><th><div class="next-table-cell-wrapper" data-next-table-col="1">日本售价</div></th></tr></thead><tbody><tr><td data-next-table-col="1"><input></td></tr></tbody></table></div>`);
    const frame = await page.locator('iframe').elementHandle().then(node => node.contentFrame());
    await frame.setContent(`<div role="tablist"><button role="tab">Popular</button><button role="tab">Asia</button></div><label><input type="checkbox" value="US">United States</label><label id="japan" hidden><input type="checkbox" value="JP">Japan</label><button id="done">Determine</button>
      <script>document.querySelectorAll('[role=tab]')[1].onclick=()=>document.querySelector('#japan').hidden=false;
      document.querySelector('#done').onclick=()=>{if(document.querySelector('[value=JP]').checked){parent.document.querySelector('#struct-icbuCountryRegion').insertAdjacentHTML('beforeend','<label><input type="checkbox" value="JP">Japan</label>');parent.document.querySelector('.icbu-dialog-selector').style.display='none';}};</script>`);
    await page.locator('.editBtn').evaluate(node => node.onclick = () => document.querySelector('.icbu-dialog-selector').style.display = 'block');
    await fillRegionalPrices(page, { regionalPricing: { rows: [{ country: 'Japan', value: 9 }] } }, fillAndVerify);
    assert.equal(await page.locator('#struct-icbuCountryRegion input[value=JP]').isChecked(), true);
    assert.equal(await page.locator('tbody input').inputValue(), '9');
    assert.equal(await frame.locator('input[value=US]').isChecked(), false);
  } finally { await browser.close(); }
});
