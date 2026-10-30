import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher, fillProductKeywords, fillProductSubtitle } from '../server/publisher.js';
import { findChromium } from '../server/browser-runtime.js';
import { collectedTextPatch, alibabaKeywordText } from '../server/product-keywords.js';
import { syncProductModel, recordProductMutation, createPublishSnapshot, verifySourceIntegrity } from '../server/product-model.js';
import { structuredHighlightText } from '../server/structured-description.js';

test('independent collection text rules preserve source facts, manual edits and explicit clearing across categories', () => {
  for (const [title, name, value] of [
    ['Senior Flip Mobile Phone', 'Display', '2.4 inch'], ['Cotton Shirt', 'Weave', 'Twill'],
    ['Illustrated Animal Book', 'Binding', 'Hardcover'], ['Engine Water Pump', 'Part number', '4G63'],
  ]) for (const autoGenerateSubtitle of [false, true]) for (const autoGenerateKeywords of [false, true]) {
    const source = { title, attributes: [{ name, value }], subtitle: '', keywords: [] };
    const settings = { autoGenerateSubtitle, autoGenerateKeywords };
    const product = syncProductModel({ ...source, ...collectedTextPatch(source, settings) }, { captureSource: true, sourceSnapshot: source });
    assert.equal(product.subtitle, autoGenerateSubtitle ? value : '');
    assert.deepEqual(product.keywords, autoGenerateKeywords ? [title] : []);
    assert.equal(alibabaKeywordText(product), autoGenerateKeywords ? title : '');
    assert.equal(structuredHighlightText(product), [autoGenerateSubtitle ? value : '', autoGenerateKeywords ? title : ''].filter(Boolean).join('\n'));
    assert.equal(product.source.snapshot.subtitle, ''); assert.deepEqual(product.source.snapshot.keywords, []);
    const hash = product.source.snapshotHash;
    recordProductMutation(product, { subtitle: 'User subtitle', keywords: ['User keyword'] });
    const refreshed = collectedTextPatch({ ...source, title: 'Changed source title' }, settings, product);
    assert.equal(refreshed.subtitle, 'User subtitle'); assert.deepEqual(refreshed.keywords, ['User keyword']);
    assert.equal(product.source.snapshotHash, hash); assert.equal(verifySourceIntegrity(product).valid, true);
    recordProductMutation(product, { subtitle: '', keywords: [] });
    assert.equal(alibabaKeywordText(product), '', 'Explicit user clearing must not be regenerated at publication');
    const cleared = collectedTextPatch(source, { autoGenerateSubtitle: true, autoGenerateKeywords: true }, product);
    assert.equal(cleared.subtitle, ''); assert.deepEqual(cleared.keywords, []);
    assert.equal(createPublishSnapshot(product).data.textGeneration.fields.keywords.source, 'manual');
    const supplied = { ...source, subtitle: 'Source subtitle', keywords: ['Source keyword'] };
    const kept = collectedTextPatch(supplied, settings);
    assert.equal(kept.subtitle, supplied.subtitle); assert.deepEqual(kept.keywords, supplied.keywords);
  }
  assert.equal(collectedTextPatch({ title: '' }, { autoGenerateSubtitle: true, autoGenerateKeywords: true }).subtitle, '');
  assert.deepEqual(collectedTextPatch({ title: 'Failed capture', collectWarning: 'Transport failed' }, { autoGenerateKeywords: true }).keywords, []);
});

test('settings persist and flow through link, image, shop, recollection, editor and publish inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-product-text-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'QA' }];
    state.groups = [{ id: 'group', shopId: 'shop', url: 'https://example.en.alibaba.com/productlist.html', name: 'QA' }];
    state.settings.priceMarkup = 7;
  });
  let serial = 0;
  const sample = () => ({ sourceId: String(1600000000000 + ++serial), sourceUrl: `https://www.alibaba.com/product-detail/Phone_${1600000000000 + serial}.html`,
    sourcePlatform: 'alibaba.com', title: 'Senior Flip Phone', categoryId: '201905202', attributes: [{ name: 'Display', value: '2.4 inch' }],
    subtitle: '', keywords: [], mainImages: ['https://example.test/phone.jpg'], price: '10' });
  const originals = Object.fromEntries(['collectLinks', 'collectSearch', 'collectGroup', 'enrichProducts'].map(key => [key, ShopCollector.prototype[key]]));
  const collect = async (_input, progress, options) => {
    const raw = sample();
    const product = options.prepareProduct ? await options.prepareProduct(raw) : raw;
    progress({ product, stage: 'detail', current: 1, total: 1, key: raw.sourceId }); return [product];
  };
  for (const key of ['collectLinks', 'collectSearch', 'collectGroup']) ShopCollector.prototype[key] = collect;
  ShopCollector.prototype.enrichProducts = async ([product]) => {
    const raw = { ...sample(), sourceId: product.sourceId, sourceUrl: product.sourceUrl };
    return [{ ...raw, _collectedSnapshot: structuredClone(raw) }];
  };
  const publishOriginal = SellerPublisher.prototype.publishProduct;
  const inputs = [];
  SellerPublisher.prototype.publishProduct = async product => {
    inputs.push(structuredClone(product)); return { status: 'drafted', message: 'Fixture draft' };
  };
  const server = await import('../server/index.js'), listener = await server.serverReady;
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method,
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const complete = async response => {
    assert.equal(response.status, 202);
    const deadline = Date.now() + 6000;
    let job;
    do { job = store.read().jobs.find(row => row.id === response.data.id); if (job?.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
    assert.equal(job.status, 'completed', job.message);
  };
  try {
    for (const key of ['autoGenerateSubtitle', 'autoGenerateKeywords']) {
      assert.equal(store.read().settings[key], false);
      for (const value of ['true', 1, null]) assert.equal((await api('/api/settings', { [key]: value }, 'PATCH')).status, 400);
    }
    await complete(await api('/api/collect/links', { collectionFolderId: 'folder', urls: 'https://www.alibaba.com/product-detail/Phone_1600000000001.html' }));
    let product = store.read().products[0];
    assert.equal(product.subtitle, ''); assert.deepEqual(product.keywords, []);
    assert.equal((await api('/api/settings', { autoGenerateSubtitle: true }, 'PATCH')).status, 200);
    assert.equal((await api(`/api/products/${product.id}/refresh-detail`, {})).status, 200);
    product = store.read().products[0];
    assert.equal(product.subtitle, '2.4 inch'); assert.deepEqual(product.keywords, []);
    assert.equal((await api('/api/settings', { autoGenerateKeywords: true }, 'PATCH')).status, 200);
    await complete(await api('/api/groups/group/collect', { collectionFolderId: 'folder', startPage: 1, endPage: 1 }));
    product = store.read().products[0];
    assert.equal(product.subtitle, '2.4 inch'); assert.deepEqual(product.keywords, ['Senior Flip Phone']);
    assert.equal(product.source.snapshot.subtitle, ''); assert.deepEqual(product.source.snapshot.keywords, []);
    assert.equal((await api('/api/settings', { autoGenerateSubtitle: false }, 'PATCH')).status, 200);
    await complete(await api('/api/collect/links', { collectionFolderId: 'folder', method: 'image-search', urls: 'https://www.alibaba.com/search/page?SearchScene=imageTextSearch&imagePath=sample.jpg' }));
    const imageProduct = store.read().products[0];
    assert.equal(imageProduct.subtitle, ''); assert.deepEqual(imageProduct.keywords, ['Senior Flip Phone']);
    const persisted = new JsonStore(store.filePath).read();
    assert.equal(persisted.settings.autoGenerateSubtitle, false); assert.equal(persisted.settings.autoGenerateKeywords, true);
    assert.equal(persisted.settings.priceMarkup, 7); assert.equal(persisted.settings.uploadProductVideos, true);
    assert.equal((await api(`/api/products/${product.id}`, { subtitle: 'Edited subtitle', keywords: ['Edited keyword'] }, 'PATCH')).status, 200);
    assert.equal((await api(`/api/products/${product.id}/refresh-detail`, {})).status, 200);
    const reopened = (await api(`/api/products/${product.id}`, undefined, 'GET')).data;
    assert.equal(reopened.subtitle, 'Edited subtitle'); assert.deepEqual(reopened.keywords, ['Edited keyword']);
    await complete(await api('/api/publish', { ids: [product.id], collectionFolderId: 'folder', mode: 'draft' }));
    assert.equal(inputs[0].subtitle, 'Edited subtitle'); assert.deepEqual(inputs[0].keywords, ['Edited keyword']);
    assert.equal(inputs[0].source.snapshot.subtitle, ''); assert.deepEqual(inputs[0].source.snapshot.keywords, []);
  } finally {
    await server.shutdownServer(); Object.assign(ShopCollector.prototype, originals); SellerPublisher.prototype.publishProduct = publishOriginal;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatic text switches recover from save failure and generated text fills native publishing controls', { skip: !findChromium() }, async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import AutomaticProductTextSetting from './src/AutomaticProductTextSetting.jsx';
    window.requests=[]; window.fail=false; window.saved={};
    function App(){const [settings,setSettings]=React.useState(window.saved);return <AutomaticProductTextSetting settings={settings}
      request={async(_route,options)=>{const patch=JSON.parse(options.body);window.requests.push(patch);await new Promise(r=>setTimeout(r,50));if(window.fail)throw Error('保存失败');return window.saved={...window.saved,...patch}}}
      refresh={async()=>setSettings({...window.saved})} notify={message=>document.querySelector('#notice').textContent=message}/>}
    createRoot(document.querySelector('#root')).render(<App/>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div><p id="notice"></p>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const subtitle = page.getByRole('switch', { name: '自动生成副标题', exact: true });
    const keywords = page.getByRole('switch', { name: '自动生成商品关键词', exact: true });
    await subtitle.click(); await page.waitForFunction(() => window.saved.autoGenerateSubtitle === true);
    await page.waitForFunction(() => !document.querySelector('input').disabled);
    assert.equal(await keywords.isChecked(), false);
    await page.evaluate(() => { window.fail = true; });
    await keywords.click(); await page.waitForFunction(() => document.querySelector('#notice').textContent === '保存失败');
    assert.equal(await keywords.isChecked(), false); assert.equal(await subtitle.isChecked(), true);
    await page.evaluate(() => { window.fail = false; });
    await keywords.click(); await page.waitForFunction(() => window.saved.autoGenerateKeywords === true);
    assert.deepEqual(await page.evaluate(() => window.requests), [{ autoGenerateSubtitle: true }, { autoGenerateKeywords: true }, { autoGenerateKeywords: true }]);
    await page.setContent('<input name="subTitle"><div class="posting-field-keywords"><textarea></textarea></div>');
    const raw = { title: 'Cotton Shirt', attributes: [{ name: 'Weave', value: 'Twill' }] };
    const product = { ...raw, ...collectedTextPatch(raw, { autoGenerateSubtitle: true, autoGenerateKeywords: true }) };
    assert.equal(await fillProductSubtitle(page, product), true); assert.equal(await fillProductKeywords(page, product), true);
    assert.equal(await page.locator('input').inputValue(), 'Twill'); assert.equal(await page.locator('textarea').inputValue(), 'Cotton Shirt');
    const disabled = { ...raw, ...collectedTextPatch(raw, {}) };
    const noBrowser = new Proxy({}, { get() { assert.fail('Disabled automatic text must not access the browser'); } });
    assert.equal(await fillProductSubtitle(noBrowser, disabled), false); assert.equal(await fillProductKeywords(noBrowser, disabled), false);
  } finally { await browser.close(); }
});
