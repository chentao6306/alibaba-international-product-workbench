import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMadeInChinaShop, extractMadeInChinaGroups } from '../server/made-in-china-shop.js';
import { parseCollectionUrl } from '../server/source-platform.js';

const origin = 'https://supplier.en.made-in-china.com';
const groupUrl = `${origin}/product-group/Parent123/Bolts-catalog-1.html`;
test('reads supplier groups with children, stable IDs and counts while excluding other shops', () => {
  const child = '/product-group/Child123/Hex-Bolts-1.html';
  const html = `<div class="title-txt"><a>Example Hardware</a></div><div class="prod-result-list">Total 3,237 Products</div>
    <div class="sr-nav-sub-li"><a href="${groupUrl}">Bolts (130)</a><div class="sr-nav-ssub-list"><a href="${child}">Hex Bolts</a></div></div>
    <a href="${child.replace('-1.html', '-2.html')}">Hex Bolts (45)</a><a href="${groupUrl.replace('supplier.en', 'other.en')}">Wrong seller</a>`;
  const result = extractMadeInChinaGroups(html, `${origin}/product-list-1.html`);
  assert.equal(result.shopName, 'Example Hardware');
  assert.equal(result.readable, true);
  assert.equal(result.groups.length, 3);
  assert.equal(result.groups[0].productCount, 3237);
  assert.deepEqual(result.groups[2], { externalId: 'Child123', name: 'Hex Bolts', url: origin + child, productCount: 45, parentExternalId: 'Parent123', parentName: 'Bolts' });
  assert.equal(extractMadeInChinaGroups('<h1>Verify</h1>', groupUrl).readable, false);
});

test('supports all pages and explicit page ranges without a hidden 100 page or product cutoff', async () => {
  const link = parseCollectionUrl(groupUrl, 'shop-products');
  const read = [];
  const dependencies = {
    readListing: async url => {
      const number = Number(url.match(/-(\d+)\.html$/)[1]); read.push(number);
      return { readable: true, products: [{ sourceId: `Product${number}`, url: `${origin}/product/Product${number}/China-Bolt.html` }], nextUrl: number < 105 ? groupUrl.replace('-1.html', `-${number + 1}.html`) : '' };
    },
    collectLinks: async links => links,
  };
  const all = await collectMadeInChinaShop(link, () => {}, { allPages: true, maxProducts: null }, dependencies);
  assert.equal(all.length, 105); assert.equal(read.at(-1), 105);
  read.length = 0;
  const range = await collectMadeInChinaShop(link, () => {}, { startPage: 101, endPage: 104, maxProducts: null }, dependencies);
  assert.deepEqual(read, [101, 102, 103, 104]); assert.equal(range.length, 4);
  read.length = 0;
  const limited = await collectMadeInChinaShop(link, () => {}, { allPages: true, maxProducts: 2 }, dependencies);
  assert.deepEqual(read, [1, 2]); assert.equal(limited.length, 2);
});
