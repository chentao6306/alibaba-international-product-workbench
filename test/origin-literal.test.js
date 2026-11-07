import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { productOrigin, productOriginText, originValueForField } from '../server/origin-country.js';
import { categoryReadiness, categoryRequirementSchema } from '../server/category-readiness.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { fillCategoryAttributes, requireCategoryAttributes, preparePublishProduct, fillOriginCountry, requirePublicAttributeTransfer } from '../server/publisher.js';

test('preserves literal None origin for free text categories without assigning it a country or bypassing country selectors', () => {
  const product = { categoryId:'clothing', attributes:[{id:'1',name:'Place of Origin',value:'None',source:'detailData.attributes'}] };
  assert.equal(productOrigin(product),''); assert.equal(productOriginText(product),'None');
  const prepared=preparePublishProduct(product);
  assert.equal(prepared.origin,'None'); assert.deepEqual(product.attributes,prepared.attributes);
  for (const controlType of ['text','textarea','combobox','select']) {
    const field={id:'1',label:'原产地',labels:['原产地'],controlType,required:true};
    const schema=categoryRequirementSchema('clothing',[field]);
    assert.equal(categoryReadiness(product,schema).status,['text','textarea'].includes(controlType)?'covered':'incomplete');
  }
  assert.equal(originValueForField(product,{controlType:'text',autocomplete:'list'}),'');
  assert.equal(originValueForField(product,{controlType:'text',options:[{value:'CN',label:'China'}]}),'');
  assert.equal(originValueForField(product,{controlType:'select',options:[{value:'none',label:'None'}]}),'None');
  assert.equal(originValueForField(product,{controlType:'select',options:[{value:'none',label:'None',disabled:true}]}),'');
  assert.equal(productOriginText({attributes:[{name:'产地',value:'None'},{name:'Place of Origin',value:'Japan'}]}),'');
  assert.equal(productOriginText(preparePublishProduct({attributes:[{name:'Place of Origin',value:'Guangdong, China'}]})),'Guangdong, China');
});

test('accepts literal origin with country suggestions only after the native property model commits it', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const product = preparePublishProduct({ categoryId: 'clothing', attributes: [{ id: '1', name: 'Place of Origin', value: 'None' }] });
    for (const accept of [true, false]) {
      await page.setContent(`<div class="sell-catProp-item" id="struct-p-1"><label class="required">原产地</label>
        <span class="next-select"><input required></span></div><div role="listbox" hidden><div role="option">China</div></div>`);
      await page.evaluate(accept => {
        const row = document.querySelector('.sell-catProp-item'), input = row.querySelector('input');
        const dataSource = [{ value: 'CN', label: 'China' }, { value: 'US', label: 'United States' }];
        const owner = { memoizedProps: { id: 'icbuCatProp', name: 'p-1', value: '', dataSource } };
        row.__reactFiber$fixture = { return: owner };
        input.__reactFiber$fixture = { memoizedProps: { dataSource } };
        input.onclick = () => document.querySelector('[role=listbox]').hidden = false;
        input.onblur = () => {
          document.querySelector('[role=listbox]').hidden = true;
          if (accept) setTimeout(() => owner.memoizedProps.value = { text: input.value, value: input.value }, 180);
        };
      }, accept);
      const [field] = await page.evaluate(readPostingAttributeSchema);
      assert.equal(field.options.length, 2);
      assert.equal(field.allowsCustomValue, true);
      assert.equal(categoryReadiness(product, categoryRequirementSchema('clothing', [field])).status, 'covered');
      assert.equal(await fillOriginCountry(page, 'None'), accept);
      assert.equal(await page.locator('input').inputValue(), 'None');
      const [committed] = await page.evaluate(readPostingAttributeSchema);
      assert.equal(committed.hasValue, accept);
      if (accept) {
        await requireCategoryAttributes(page, product);
        assert.equal((await requirePublicAttributeTransfer(page, product))[0].destination, 'standard-attribute');
      } else {
        await assert.rejects(requireCategoryAttributes(page, product));
        await assert.rejects(requirePublicAttributeTransfer(page, product));
      }
    }
  } finally { await browser.close(); }
});

test('writes and rereads None in the native origin textbox while country selection still rejects it', {skip:!findChromium()}, async()=>{
  const browser=await chromium.launch({executablePath:findChromium(),headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<div class="sell-catProp-item" id="struct-p-1"><div class="label required">原产地</div><input required></div>');
    const product=preparePublishProduct({attributes:[{id:'1',name:'Place of Origin',value:'None'}]});
    await fillCategoryAttributes(page,product);
    assert.equal(await page.locator('input').inputValue(),'None');
    await requireCategoryAttributes(page,product);
    assert.equal((await requirePublicAttributeTransfer(page,product))[0].destination,'standard-attribute');
    await page.locator('input').fill('');
    assert.equal(await fillOriginCountry(page,'None'),true);
    await page.setContent('<div class="sell-catProp-item" id="struct-p-1"><div class="label required">原产地</div><select required><option value=""></option><option value="CN">China</option></select></div>');
    assert.equal(await fillOriginCountry(page,'None'),false);
    await fillCategoryAttributes(page,product);
    await assert.rejects(requireCategoryAttributes(page,product),{code:'PUBLISH_REQUIRED_DATA_MISSING'});
    assert.equal(await page.locator('select').inputValue(),'');
    await page.locator('select').selectOption('CN');
    await assert.rejects(requireCategoryAttributes(page,product));
    await page.locator('select').evaluate(select => select.add(new Option('None', 'none')));
    await fillCategoryAttributes(page,product);
    await requireCategoryAttributes(page,product);
    assert.equal(await page.locator('select').inputValue(),'none');
    await page.locator('select').selectOption('CN');
    assert.equal(await fillOriginCountry(page,'None'),true);
    assert.equal(await page.locator('select').inputValue(),'none');
    await page.setContent('<div class="sell-catProp-item" id="struct-p-1"><div class="label required">原产地</div><input required onblur="setTimeout(()=>this.value=\'\',200)"></div>');
    assert.equal(await fillOriginCountry(page,'None'),false);
    await assert.rejects(requireCategoryAttributes(page,product));
  } finally {await browser.close();}
});
