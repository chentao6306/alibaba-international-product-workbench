import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { captureSellerReferenceWithExecutor, readSellerReference } from '../server/seller-reference.js';

test('captures seller properties and complete virtual SKU rows without changing input values', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://post.alibaba.com/**', (route) => route.fulfill({ body: '<html></html>' }));
    await page.goto('https://post.alibaba.com/product/publish.htm?itemId=1601003950128&catId=201776003');
    await page.setContent(`<p>当前类目：玩具 &gt;&gt; 早教书</p><div class="sell-catProp-item" id="p-123"><label class="label">Type</label><select><option value="audio" selected>Audio Books</option></select></div>
      <div id="struct-specification"><div id="p-456"><label class="label">Color</label><label><input type="checkbox" checked value="Yellow">Yellow</label><label><input type="checkbox" checked value="Green">Green</label></div></div>
      <div id="sku"><table class="sku-header"><tr><th><div class="th-saleProps-label"><span>Color</span></div><div class="checkSelectBabel"><span class="labelText">Yellow</span><span class="labelText">Green</span></div></th></tr></table>
      <div class="virtualized-table-scroll-wrapper" style="height:100px;overflow:auto"><div style="height:500px"><table id="body"></table></div></div></div>
      <script>window.rows=[{code:'A',stock:0,enabled:false},{code:'B',stock:12,enabled:true}];
      const render=(i)=>document.getElementById('body').innerHTML='<tr><td data-name="skuOuterId" data-row="'+i+'"><input value="'+rows[i].code+'"></td><td data-name="skuStock"><input value="'+rows[i].stock+'"></td><td data-name="operate"><button role="switch" aria-checked="'+rows[i].enabled+'"></button></td></tr>';
      document.querySelector('.virtualized-table-scroll-wrapper').onscroll=e=>render(e.target.scrollTop>0?1:0);render(0);</script>`);
    const options = { title: 'Book', categoryId: '201776003', productId: '1601003950128' };
    const reference = await readSellerReference(page, options);
    assert.equal(reference.referenceTemplate.attributes[0].id, '123');
    assert.equal(reference.referenceTemplate.attributes[0].value, 'Audio Books');
    assert.equal(reference.referenceTemplate.variantGroups[0].id, '456');
    assert.deepEqual(reference.referenceTemplate.skus, [
      { code: 'A', stock: 0, enabled: false, attributes: { Color: 'Yellow' } },
      { code: 'B', stock: 12, enabled: true, attributes: { Color: 'Green' } },
    ]);
    assert.deepEqual(reference.referenceTemplate.categoryPath, ['玩具', '早教书']);
    assert.equal(await page.locator('select').inputValue(), 'audio');
    assert.equal(await page.locator('.virtualized-table-scroll-wrapper').evaluate((node) => node.scrollTop), 0);
    await page.evaluate(() => { const title = document.createElement('input'); title.name = 'productTitle'; title.value = 'Book'; document.body.prepend(title); });
    const bridged = await captureSellerReferenceWithExecutor((script) => page.evaluate(script));
    assert.deepEqual(bridged.referenceTemplate, reference.referenceTemplate);
    await page.evaluate(() => { document.querySelector('.virtualized-table-scroll-wrapper').onscroll = null; });
    await assert.rejects(readSellerReference(page, options), /只读取到 1\/2/);
    await assert.rejects(readSellerReference(page, { ...options, productId: '' }), /已有商品/);
  } finally { await browser.close(); }
});
