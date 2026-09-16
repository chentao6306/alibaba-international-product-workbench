import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { enterPostingForm, preparePublishProduct } from '../server/publisher.js';
import { findPostingTitle, waitForPostingTitle } from '../server/posting-readiness.js';
import { extractAlibabaCategoryId, readAlibabaCategoryDocument } from '../server/alibaba-source-data.js';
import { canRefreshSourceCategory, refreshedSourceCategoryPatch } from '../server/category-routing.js';

test('category extraction ignores recommendations and reads the leaf of trusted breadcrumbs', () => {
  const data = { nodeMap: { recommendedProducts: [{ categoryId: 777777 }], breadcrumb: { items: [
    { categoryId: 111111 }, { categoryId: 222222 }, { categoryId: 333333 }
  ] } } };
  assert.equal(extractAlibabaCategoryId(data), '333333');
  assert.equal(extractAlibabaCategoryId({ nodeMap: { recommendedProducts: [{ categoryId: 777777 }] } }), '');
  assert.equal(extractAlibabaCategoryId({ ...data, globalData: { product: { leafCategoryId: 444444 } } }), '444444');
});

test('only untouched source categories can be repaired from the same fresh source path', () => {
  const product = { sourcePlatform: 'alibaba.com', sourceUrl: 'https://www.alibaba.com/product-detail/fixture_123.html',
    categoryId: '111111', sourceCategoryId: '111111', categoryPath: ['A', 'B'], sourceCategoryPath: ['A', 'B'] };
  const fresh = { sourceCategoryId: '222222', sourceCategoryPath: ['A', 'B'] };
  assert.equal(refreshedSourceCategoryPatch(product, fresh).categoryId, '222222');
  assert.equal(refreshedSourceCategoryPatch(product, { ...fresh, sourceCategoryPath: ['A', 'C'] }), null);
  for (const patch of [{ categoryReference: { categoryId: '111111' } }, { targetCategoryId: '111111' },
    { auditTrail: [{ actor: 'user', fields: ['categoryId'] }] }, { categoryId: '333333' }, { sourcePlatform: '1688', sourceUrl: 'https://detail.1688.com/offer/123.html' }]) {
    assert.equal(canRefreshSourceCategory({ ...product, ...patch }), false);
    assert.equal(refreshedSourceCategoryPatch({ ...product, ...patch }, fresh), null);
  }
});

test('preserves uploaded media and recovers only actual images from the current product description', () => {
  const image = 'https://sc04.alicdn.com/kf/source-product.jpg';
  const main = ['https://sc04.alicdn.com/kf/main.jpg', '/media/uploaded.png'];
  const product = { mainImages: main, detailImages: [], descriptionHtml: `<p>Product</p><img data-src="${image}"><img src="/media/detail.png"><img src="javascript:bad">` };
  const prepared = preparePublishProduct(product);
  assert.deepEqual(prepared.mainImages, main);
  assert.deepEqual(prepared.detailImages, [image, '/media/detail.png']);
  assert.deepEqual(product.detailImages, []);
  assert.deepEqual(preparePublishProduct({ mainImages: main, detailImages: [], description: 'No detail pictures' }).detailImages, []);
  assert.deepEqual(preparePublishProduct({ ...product, detailImages: ['/media/chosen-detail.png'] }).detailImages, ['/media/chosen-detail.png']);
});

test('English category entry selects the exact ID and recognizes product-name fields without selecting subtitles', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://post.alibaba.com/**', (route) => route.fulfill({ contentType: 'text/html', body: `<select>
      <option value="12013464010">Wrong category containing ID</option><option value="201346401">Exact category</option></select>
      <button id="next">Next</button><script>document.querySelector('#next').onclick=()=>{
        window.selected=document.querySelector('select').value;
        history.pushState({}, '', '/product/publish.htm?catId='+window.selected);
        document.body.innerHTML='<input name="subTitle" value="Subtitle"><textarea name="productName"></textarea>';
      };</script>` }));
    await page.goto('https://post.alibaba.com/product/category.htm');
    assert.equal(await enterPostingForm(page, 'https://post.alibaba.com/product/publish.htm?catId=201346401', '201346401'), true);
    assert.equal(await page.evaluate(() => window.selected), '201346401');
    const title = await waitForPostingTitle(page, { timeoutMs: 1000 });
    await title.fill('Correct title');
    assert.equal(await page.locator('[name=subTitle]').inputValue(), 'Subtitle');
    assert.equal(await page.locator('[name=productName]').inputValue(), 'Correct title');
    await page.setContent('<input name="subTitle"><input placeholder="Enter image title"><textarea name="description"></textarea>');
    assert.equal(await findPostingTitle(page), null);
    await assert.rejects(waitForPostingTitle(page, { timeoutMs: 100 }), { code: 'PUBLISH_FORM_NOT_READY' });
    await page.setContent('<label for="name">Product name:</label><input id="name">');
    assert.ok(await findPostingTitle(page));
    await page.setContent('The category does not exist or has become invalid.');
    await assert.rejects(waitForPostingTitle(page), (error) => error.code === 'PUBLISH_CATEGORY_INVALID' && error.categoryId === '201346401');
  } finally { await browser.close(); }
});

test('DOM category extraction uses breadcrumb leaf and excludes navigation, advertisements and arbitrary numbers', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<nav><a href="https://www.alibaba.com/category?categoryId=888888">Other navigation</a></nav>
      <div class="detail-breadcrumb"><a href="https://www.alibaba.com/cat_cid111111.html">Parent</a>
      <a href="https://www.alibaba.com/cat_cid222222.html">Leaf</a></div>
      <a href="https://www.alibaba.com/category?catId=999999">Recommended</a><script>window.ad={categoryId:777777};</script>`);
    assert.deepEqual(await page.evaluate(readAlibabaCategoryDocument), { path: ['Parent', 'Leaf'], id: '222222' });
    await page.setContent('<nav><a href="https://www.alibaba.com/product_160123456789.html">Product</a></nav>');
    assert.deepEqual(await page.evaluate(readAlibabaCategoryDocument), { path: [], id: '' });
  } finally { await browser.close(); }
});
