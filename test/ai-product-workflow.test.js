import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { ShopCollector } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';
import { verifySourceIntegrity } from '../server/product-model.js';
import { DEFAULT_AI_PRODUCT_SETTINGS } from '../server/ai-product-settings.js';
import { createPublishDiagnosticStore } from '../server/publish-diagnostics.js';

test('AI settings, link/shop recollection, source persistence and publishing mapping share the saved configuration', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workflow-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  globalThis.__KUA_YIPU_SECURE_STORAGE = { encrypt: text => Buffer.from(text).map(byte => byte ^ 127), decrypt: bytes => Buffer.from(bytes).map(byte => byte ^ 127).toString() };
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => { state.collectionFolders = [{ id: 'folder', name: 'QA' }]; state.groups = [{ id: 'group', shopId: 'shop', url: 'https://example.en.alibaba.com/productlist.html', name: 'QA' }]; });
  let serial = 0, calls = 0, failAfterMapping = false;
  const sample = () => ({ sourceId: String(1600000000000 + ++serial), sourceUrl: `https://www.alibaba.com/product-detail/Bottle_${1600000000000 + serial}.html`, sourcePlatform: 'alibaba.com',
    title: 'Oil bottle', categoryId: '201268985', sourceCategoryId: '201268985', price: 10, mainImages: ['https://example.test/bottle.jpg'],
    description: 'Material: PET. Use: Essential Oil.', attributes: [{ id: '19421', name: 'Industrial Use', value: 'Cosmetic' }] });
  const originals = Object.fromEntries(['collectLinks', 'collectGroup', 'enrichProducts'].map(key => [key, ShopCollector.prototype[key]]));
  for (const method of ['collectLinks', 'collectGroup']) ShopCollector.prototype[method] = async (_input, progress, options) => {
    let product = sample(); const prepare = options.prepareProduct || options.prepareDetailProduct;
    if (prepare) product = await prepare(product);
    progress({ product, stage: 'detail', current: 1, total: 1, key: product.sourceId }); return [product];
  };
  ShopCollector.prototype.enrichProducts = async ([product]) => [{ ...sample(), sourceId: product.sourceId, sourceUrl: product.sourceUrl }];
  const publish = SellerPublisher.prototype.publishProduct;
  SellerPublisher.prototype.publishProduct = async (product, _url, _mode, _category, _job, _stage, options) => {
    const mapped = await options.resolveAttributeMappings(product, [{ id: '19421-19427', label: 'Use', required: true, multiple: true, controlType: 'combobox', options: [{ value: 'oil', label: 'Essential Oil' }] }],
      { feedback: { code: 'PUBLISH_REQUIRED_DATA_MISSING', fields: ['Use'] } });
    assert.deepEqual(mapped.product.attributes.at(-1).value, ['Essential Oil']);
    await options.onAiMapping([mapped.audit]);
    if (failAfterMapping) throw Object.assign(new Error('Fixture platform rejected later field'), { code: 'PUBLISH_REQUIRED_DATA_MISSING' });
    return { status: 'drafted', message: 'Fixture draft', aiMapping: [mapped.audit] };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url !== 'https://api.deepseek.com/chat/completions') return originalFetch(url, options);
    calls++; assert.equal(options.headers.authorization, 'Bearer ai-secret-fixture');
    const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (payload.task === 'mapping') assert.deepEqual(payload.feedback, { code: 'PUBLISH_REQUIRED_DATA_MISSING', fields: ['Use'] });
    const description = payload.evidence.find(row => row.kind === 'description');
    const result = payload.task === 'collection' ? { attributes: [{ name: 'Material', value: 'PET', evidenceId: description.evidenceId, quote: 'Material: PET' }] }
      : { mappings: [{ fieldId: '19421-19427', values: ['Essential Oil'], evidenceId: description.evidenceId, quote: 'Use: Essential Oil.', confidence: 0.99 }] };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  };
  const server = await import('../server/index.js'); const listener = await server.serverReady;
  const api = async (route, body, method = 'POST') => {
    const res = await originalFetch(`http://127.0.0.1:${listener.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  const complete = async result => {
    assert.equal(result.status, 202, JSON.stringify(result));
    const deadline = Date.now() + 10000;
    let job;
    do { job = store.read().jobs.find(item => item.id === result.data.id); if (job.status === 'completed') return; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
    assert.fail(job.message);
  };
  try {
    assert.equal((await api('/api/settings/ai-products', undefined, 'GET')).data.mode, 'rules');
    const saved = await api('/api/settings/ai-products', { ...DEFAULT_AI_PRODUCT_SETTINGS, mode: 'assisted', apiKey: 'ai-secret-fixture' }, 'PATCH');
    assert.equal(saved.status, 200); assert.equal(saved.data.apiKeyConfigured, true);
    assert.doesNotMatch(JSON.stringify(saved), /ai-secret-fixture/); assert.doesNotMatch(fs.readFileSync(store.filePath, 'utf8'), /ai-secret-fixture/);
    await complete(await api('/api/collect/links', { collectionFolderId: 'folder', urls: 'https://www.alibaba.com/product-detail/Bottle_1600000000001.html' }));
    let product = store.read().products[0];
    assert.equal(product.attributes.find(a => a.name === 'Material').value, 'PET'); assert.equal(verifySourceIntegrity(product).valid, true);
    assert.equal(product.source.snapshot.attributes.some(a => a.source === 'ai-extraction'), false);
    await complete(await api('/api/groups/group/collect', { collectionFolderId: 'folder', startPage: 1, endPage: 1 }));
    product = store.read().products[0]; assert.equal(product.aiCollection.accepted.length, 1);
    const refreshed = await api(`/api/products/${product.id}/refresh-detail`, {});
    assert.equal(refreshed.status, 200); assert.equal(refreshed.data.aiCollection.accepted.length, 1);
    await complete(await api('/api/publish', { ids: [product.id], collectionFolderId: 'folder', mode: 'draft' }));
    product = store.read().products.find(p => p.id === product.id);
    assert.equal(product.status, 'drafted'); assert.equal(product.aiMapping[0].accepted.length, 1);
    assert.equal(verifySourceIntegrity(product).valid, true);
    failAfterMapping = true;
    await complete(await api('/api/publish', { ids: [product.id], collectionFolderId: 'folder', mode: 'draft' }));
    assert.equal(store.read().products.find(p => p.id === product.id).status, 'publish_failed');
    const failures = createPublishDiagnosticStore(root, process.env.KUA_YIPU_ACCOUNT).read().failures;
    assert.equal(failures[0].error.diagnostics.aiMapping[0].provider, 'deepseek');
    assert.deepEqual(failures[0].error.diagnostics.aiMapping[0].feedback, { code: 'PUBLISH_REQUIRED_DATA_MISSING', fields: ['Use'] });
    assert.deepEqual(failures[0].error.diagnostics.aiMapping[0].accepted[0].value, ['Essential Oil']);
    assert.doesNotMatch(JSON.stringify(failures), /ai-secret-fixture/);
    const before = calls;
    await api('/api/settings/ai-products', { mode: 'rules' }, 'PATCH');
    await complete(await api('/api/collect/links', { collectionFolderId: 'folder', urls: 'https://www.alibaba.com/product-detail/Bottle_1600000000099.html' }));
    assert.equal(calls, before);
  } finally {
    await server.shutdownServer(); globalThis.fetch = originalFetch; delete globalThis.__KUA_YIPU_SECURE_STORAGE;
    Object.assign(ShopCollector.prototype, originals); SellerPublisher.prototype.publishProduct = publish;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI settings UI saves switches and provider without revealing the saved key or testing unsaved changes', { skip: !findChromium(), timeout: 60000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import AiProductSetting from './src/AiProductSetting.jsx';
    window.saved=${JSON.stringify({ ...DEFAULT_AI_PRODUCT_SETTINGS, apiKeyConfigured: true })};window.requests=[];
    createRoot(document.querySelector('#root')).render(<AiProductSetting request={async(route,options)=>{window.requests.push({route,options});if(options?.method==='PATCH'){const {apiKey,...values}=JSON.parse(options.body);window.saved={...values,apiKeyConfigured:true};}return window.saved;}} refresh={async()=>{}} notify={text=>document.querySelector('#notice').textContent=text}/>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage(); await page.setContent('<div id="root"></div><p id="notice"></p>'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByLabel('商品处理方式', { exact: true }).selectOption('assisted');
    assert.equal(await page.getByRole('button', { name: '测试已保存的 AI 连接' }).isDisabled(), true);
    await page.getByLabel('AI 商品 API 密钥').fill('fixture-key');
    await page.getByRole('button', { name: '保存 AI 设置' }).click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已保存'));
    assert.equal(await page.getByLabel('AI 商品 API 密钥').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: '测试已保存的 AI 连接' }).isEnabled(), true);
    await page.getByLabel('AI 服务', { exact: true }).selectOption('openai');
    assert.equal(await page.getByRole('button', { name: '测试已保存的 AI 连接' }).isDisabled(), true);
    assert.equal(await page.getByLabel('AI 商品模型').inputValue(), DEFAULT_AI_PRODUCT_SETTINGS.openaiModel);
    const saved = await page.evaluate(() => window.saved); assert.equal(saved.mode, 'assisted'); assert.equal(saved.provider, 'deepseek');
    assert.equal(await page.locator('body').innerText().then(text => text.includes('fixture-key')), false);
  } finally { await browser.close(); }
});
