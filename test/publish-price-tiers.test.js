import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher } from '../server/publisher.js';

const tiers = [{ minQuantity: 1, price: 90 }, { minQuantity: 10, price: 88 }, { minQuantity: 50, price: 85 }, { minQuantity: 100, price: 80 }];

function priceForm({ label = '+ 新增价格区间', delay = 0, requireFilled = false, rows = 1, blocked = false, resetEarlier = false } = {}) {
  return `<input id="unrelated" placeholder="price" value="Keep"><input id="other-quantity" role="input-quantity" value="7"><div class="posting-field-ladder"><table><tbody></tbody></table>
    <button role="btn-add">${label}</button></div><div hidden><button>+ 新增价格区间</button><input role="input-price"><input role="input-quantity"></div>
    <script>(()=>{
    const settings=${JSON.stringify({ delay, requireFilled, rows, blocked, resetEarlier })};
    let values=Array.from({length:settings.rows},()=>({quantity:'',price:''}));window.additions=0;window.removals=0;
    const button=document.querySelector('button');
    function render(){
      document.querySelector('tbody').innerHTML=values.map((row,i)=>'<tr role="row"><td><input role="input-quantity" value="'+row.quantity+'"></td><td><input role="input-price" value="'+row.price+'"></td><td><button role="remove" data-index="'+i+'">Delete</button></td></tr>').join('');
      document.querySelectorAll('tbody tr').forEach((row,i)=>{
        for(const key of ['quantity','price'])row.querySelector('[role=input-'+key+']').onchange=e=>{values[i][key]=e.target.value;render();};
        row.querySelector('button').onclick=()=>{window.removals++;setTimeout(()=>{values.splice(i,1);render();},settings.delay);};
      });
      button.disabled=settings.blocked||(settings.requireFilled&&values.some(row=>!row.quantity||!row.price));
    }
    button.onclick=()=>{window.additions++;button.disabled=true;setTimeout(()=>{
      if(settings.resetEarlier&&values.length===1)values[0].price='';
      values.push({quantity:'',price:''});render();
    },settings.delay);};render();})();
    </script>`;
}

test('adds delayed price tiers after committing each row and preserves all values across form rebuilds', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.setContent(priceForm({ delay: 900, requireFilled: true, resetEarlier: true }));
    const publisher = new SellerPublisher('unused-pricing-fixture');
    const product = { priceTiers: structuredClone(tiers) };
    await publisher.fillPriceFields(page, product, { timeoutMs: 3000 });
    assert.deepEqual(await page.locator('.posting-field-ladder [role=input-quantity]:visible').evaluateAll(nodes => nodes.map(node => Number(node.value))), tiers.map(tier => tier.minQuantity));
    assert.deepEqual(await page.locator('[role=input-price]:visible').evaluateAll(nodes => nodes.map(node => Number(node.value))), tiers.map(tier => tier.price));
    assert.equal(await page.locator('#unrelated').inputValue(), 'Keep');
    assert.equal(await page.locator('#other-quantity').inputValue(), '7');
    assert.deepEqual(product.priceTiers, tiers);
    await publisher.fillPriceFields(page, product, { timeoutMs: 3000 });
    assert.equal(await page.evaluate(() => window.additions), 3);
  } finally { await browser.close(); }
});

test('Chinese and English price ladders preserve three and four tiers and remove extra rows', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const publisher = new SellerPublisher('unused-pricing-fixture');
    for (const label of ['+ 新增价格区间', '+ Add price range']) {
      for (const count of [3, 4]) {
        await page.setContent(priceForm({ label, delay: 100, requireFilled: true }));
        await publisher.fillPriceFields(page, { priceMode: 'fob-tier', fobPrice: { tiers: tiers.slice(0, count) } }, { timeoutMs: 2000 });
        assert.equal(await page.locator('[role=input-price]:visible').count(), count);
        assert.deepEqual(await page.locator('[role=input-price]:visible').evaluateAll(nodes => nodes.map(node => Number(node.value))), tiers.slice(0, count).map(tier => tier.price));
        await publisher.fillPriceFields(page, { priceTiers: tiers.slice(0, 1) }, { timeoutMs: 2000 });
        assert.equal(await page.locator('[role=input-price]:visible').count(), 1);
        assert.equal(await page.locator('[role=input-price]:visible').inputValue(), '90');
        assert.equal(await page.evaluate(() => window.removals), count - 1);
      }
    }
  } finally { await browser.close(); }
});

test('unavailable ladder controls pause instead of discarding tiers or silently using a single price', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    const publisher = new SellerPublisher('unused-pricing-fixture');
    await page.setContent(priceForm({ blocked: true }));
    await assert.rejects(publisher.fillPriceFields(page, { priceTiers: tiers }, { timeoutMs: 300 }), { code: 'PUBLISH_FIELD_NOT_READY' });
    assert.equal(await page.evaluate(() => window.additions), 0);
    await page.setContent('<input placeholder="price"><input placeholder="quantity">');
    await assert.rejects(publisher.fillPriceFields(page, { priceTiers: tiers }, { timeoutMs: 300 }), { code: 'PUBLISH_FIELD_NOT_READY' });
    assert.equal(await page.locator('input').first().inputValue(), '');
    await publisher.fillPriceFields(page, { price: 90, minOrder: 2 }, { timeoutMs: 300 });
    assert.equal(await page.locator('input').first().inputValue(), '90');
    assert.equal(await page.locator('input').last().inputValue(), '2');
  } finally { await browser.close(); }
});
