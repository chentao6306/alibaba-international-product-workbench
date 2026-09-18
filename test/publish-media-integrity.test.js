import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher, buildLegacyDescriptionHtml, distinctAlibabaImageUrls, mainImageFormState, preparePublishProduct, validateProductData } from '../server/publisher.js';
import { mergeSourceDataForPublish } from '../server/product-model.js';
import { resolveReferencedSkuRows } from '../server/sku-reference.js';

test('uses later gallery images after early downloads fail and preserves source order and the upload limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gallery-'));
  const original = globalThis.fetch;
  try {
    const png = await sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
    const requested = [];
    globalThis.fetch = async (url) => {
      const index = Number(url.match(/gallery-(\d+)/)[1]);
      requested.push(index);
      return index < 3 ? new Response('', { status: 404 }) : new Response(png);
    };
    const publisher = new SellerPublisher(root);
    const files = await publisher.downloadImageSet({ sourceId: 'gallery' }, Array.from({ length: 12 }, (_, i) => `https://sc04.alicdn.com/kf/gallery-${i}.png`), 'main', 6);
    assert.equal(files.length, 6);
    assert.deepEqual(files.map((file) => Number(path.basename(file).match(/(\d)\.png$/)[1])), [3, 4, 5, 6, 7, 8]);
    assert.deepEqual(requested.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retains distinct images with shared filenames and removes only derivatives of the same Alibaba asset', () => {
  const urls = ['https://sc04.alicdn.com/kf/A.jpg', 'https://s.alicdn.com/@sc04/kf/A.jpg_960x960.jpg',
    'https://sc04.alicdn.com/kf/a.jpg', 'https://example.test/one/1.jpg', 'https://example.test/two/1.jpg'];
  assert.deepEqual(distinctAlibabaImageUrls(urls), [urls[0], ...urls.slice(2)]);
});

test('removes email addresses from plain descriptions, split rich text and attribute tables without changing the source', () => {
  const product = { title: 'Servo PDI-6225MG-300', description: '25KG torque. sales@example.com\n300 degree rotation.',
    descriptionHtml: '<p>Metal gear <b>sales</b>&#64;<span>example.com</span></p>',
    attributes: [{ name: 'Support', value: 'help@example.com' }, { name: 'Voltage', value: '12V' }],
    variantGroups: [{ name: 'Model', options: ['SAVOX-0236', 'parts@example.com'] }] };
  const original = structuredClone(product);
  const html = buildLegacyDescriptionHtml(product);
  assert.doesNotMatch(html, /@|&#64;|example\.com/);
  for (const retained of ['PDI-6225MG-300', '25KG', '300 degree', 'Metal gear', '12V', 'SAVOX-0236', '<table']) assert.ok(html.includes(retained), retained);
  assert.deepEqual(product, original);
});

test('recovers detail images from structured descriptions without substituting main images for missing detail material', () => {
  const product = { mainImages: ['https://sc04.alicdn.com/kf/main.jpg'],
    structuredDescription: { html: '<p>Detail</p><img data-src="//sc04.alicdn.com/kf/detail.jpg">' } };
  assert.deepEqual(preparePublishProduct(product).detailImages, ['https://sc04.alicdn.com/kf/detail.jpg']);
  const insufficient = preparePublishProduct({ ...product, structuredDescription: {} });
  assert.ok(validateProductData(insufficient).includes('缺少详情图片'));
  assert.ok(validateProductData(insufficient).includes('主图不足 4 张（当前 1 张）'));
});

test('automatic source enrichment preserves referenced taxonomy and SKUs as well as customer prices', () => {
  const target = { sourceId: 'same', title: 'Edited title', price: 90, stock: 0, categoryReference: { id: 'accepted' },
    categoryId: 'target', categoryPath: ['Target'], attributes: [{ name: 'Material', value: 'Metal' }],
    variantGroups: [{ name: 'Type', options: ['A'] }], skus: [{ attributes: { Type: 'A' }, stock: 0, code: 'MY-SKU' }],
    mainImages: ['https://sc04.alicdn.com/kf/selected.jpg'], detailImages: [] };
  const source = { ...target, title: 'Original title', price: 1, stock: 100, categoryId: 'source', categoryPath: ['Source'],
    attributes: [], variantGroups: [{ name: 'Color', options: ['Red'] }], skus: [],
    mainImages: [1, 2, 3, 4].map((i) => `https://sc04.alicdn.com/kf/${i}.jpg`), detailImages: ['https://sc04.alicdn.com/kf/detail.jpg'] };
  const before = structuredClone(target);
  const merged = mergeSourceDataForPublish(target, source);
  for (const field of ['title', 'price', 'stock', 'categoryReference', 'categoryId', 'categoryPath', 'attributes', 'variantGroups', 'skus']) assert.deepEqual(merged[field], target[field]);
  assert.equal(merged.mainImages[0], target.mainImages[0]);
  assert.equal(merged.mainImages.length, 5);
  assert.deepEqual(merged.detailImages, source.detailImages);
  assert.deepEqual(target, before);
  assert.throws(() => mergeSourceDataForPublish(target, { ...source, sourceId: 'different' }), /不同的来源商品/);
});

test('maps referenced SKU identities through actual selected values and flattened combinations without shifting quantities', () => {
  const skus = [
    { attributes: { Color: '黑色', Type: 'EU' }, code: 'BLACK-EU', stock: 11 },
    { attributes: { Color: 'Blue', Type: 'EU' }, code: 'BLUE-EU', stock: 22 },
  ];
  const normalizeValue = (value) => value === '黑色' ? 'Black' : value;
  const groups = [{ name: '颜色', options: ['Blue', 'Black'] }, { name: '类型', options: ['For E.U.'] }];
  const options = { normalizeValue, appliedGroups: [{ name: 'Type', appliedValues: { EU: 'For E.U.' } }] };
  assert.deepEqual(resolveReferencedSkuRows({ skus }, groups, options).map((row) => row.sku.code), ['BLUE-EU', 'BLACK-EU']);
  const flat = [{ name: 'Model', options: ['Blue / EU', 'Black / EU'] }];
  assert.deepEqual(resolveReferencedSkuRows({ skus }, flat, { normalizeValue, appliedGroups: [{ name: 'Model', sourceGroups: ['Color', 'Type'] }] }).map((row) => row.sku.stock), [22, 11]);
  assert.throws(() => resolveReferencedSkuRows({ skus: [...skus, skus[0]] }, groups, options), /重复规格组合/);
  assert.throws(() => resolveReferencedSkuRows({ skus }, [{ name: 'Color', options: ['Red'] }], { normalizeValue }), /规格组合不一致/);
});

test('detects stale main-image previews and reuploads before allowing submission', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="image-uploader"></div>');
    await page.evaluate(() => {
      window.files = [];
      window.render = (empty = false) => {
        const root = document.querySelector('.image-uploader');
        root.__reactFiber$test = { memoizedProps: { fileList: window.files, onRemove: () => {} } };
        root.innerHTML = Array.from({ length: 6 }, (_, i) => `<div class="image-upload-list-item">${!empty && i < 4 ? `<img width="80" height="80" src="https://example.test/${i}.jpg">` : '<span id="image-placeholder-span">上传图片</span>'}</div>`).join('') + '<button>删除图片</button>';
        root.querySelector('button').onclick = () => { window.files = []; window.render(true); };
      };
      window.render();
    });
    const before = await mainImageFormState(page);
    assert.equal(before.remotePreviews, 4);
    assert.equal(before.occupied, 0);
    assert.equal(before.modelKnown, true);
    const publisher = new SellerPublisher('.');
    let uploads = 0;
    publisher.uploadMainImages = async () => {
      uploads++;
      assert.equal((await mainImageFormState(page)).empty, 6);
      await page.evaluate(() => {
        window.files = Array.from({ length: 4 }, (_, i) => ({ status: 'done', fileURL: `https://example.test/${i}.jpg` }));
        window.render();
      });
    };
    await publisher.reconcileMainImages(page, {});
    assert.equal((await mainImageFormState(page)).occupied, 4);
    await publisher.reconcileMainImages(page, {});
    assert.equal(uploads, 1);
    await page.evaluate(() => { window.files[0].status = 'uploading'; window.render(); });
    const pending = await mainImageFormState(page);
    assert.equal(pending.occupied, 3);
    assert.equal(pending.uploading, 1);
  } finally { await browser.close(); }
});
