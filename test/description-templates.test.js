import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { load } from 'cheerio';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity, mergeSourceDataForPublish } from '../server/product-model.js';
import { sanitizeTemplateHtml, renderDescriptionTemplate, templatePublishHtml, registerDescriptionTemplateApi } from '../server/description-templates.js';
import { buildLegacyDescriptionHtml, preparePublishProduct, validateProductData } from '../server/publisher.js';
import { imageListPatch } from '../server/product-image-api.js';
import { cleanupWorkspace } from '../server/storage-cleanup.js';

const p = () => syncProductModel({ id: 'a', title: 'Product A & <safe>', brand: 'My Brand', price: 12, stock: 50,
  description: 'Old company', descriptionHtml: '<p>Old company</p><img src="https://example.com/product.jpg">',
  detailImages: ['https://example.com/product.jpg'], mainImages: ['https://example.com/main.jpg'] });
const template = { id: 'company-a', name: '公司通用版', version: 1, html: '<h2>{{title}}</h2><p>{{productImages}}</p><h3>Company Information</h3><table><tr><td>Our company</td></tr></table><img src="https://example.com/company.png">' };

test('company templates remove executable HTML and expand escaped product text only', () => {
  const clean = sanitizeTemplateHtml('<script>alert(1)</script><svg onload="x()"></svg><img src="javascript:alert(1)" onerror="x()"><p style="color:red;background:url(evil)">Safe</p><a href="javascript:x()">Link</a>');
  assert.doesNotMatch(clean, /script|svg|onerror|onload|javascript|url\(/i);
  assert.match(clean, /color:red/);
  const result = renderDescriptionTemplate(p(), { ...template, html: '<h2>{{title}}</h2><p>{{brand}}</p><a href="https://example.com/{{title}}">link</a>' }, 'replace');
  assert.match(result.descriptionHtml, /Product A &amp; &lt;safe&gt;/);
  assert.match(result.descriptionHtml, /https:\/\/example.com\/\{\{title\}\}/);
  assert.doesNotMatch(result.descriptionHtml, /Old company/);
  assert.deepEqual(result.detailImages, []);
  assert.throws(() => renderDescriptionTemplate(p(), template, 'invalid'));
});

test('template replacement preserves product photos, company layout and immutable collected source', () => {
  const product = p(), original = structuredClone(product.source);
  const result = { ...product, ...renderDescriptionTemplate(product, template, 'replace') };
  assert.deepEqual(result.mainImages, product.mainImages);
  assert.deepEqual(result.detailImages, ['https://example.com/product.jpg', 'https://example.com/company.png']);
  assert.match(result.descriptionHtml, /<table>/);
  assert.doesNotMatch(result.descriptionHtml, /Old company/);
  const prepared = preparePublishProduct(result);
  assert.match(prepared.descriptionHtml, /Company Information/);
  const publish = buildLegacyDescriptionHtml(prepared);
  assert.match(publish, /Company Information/); assert.match(publish, /<table>/);
  assert.doesNotMatch(publish, /<img/); assert.match(publish, /data-workbench-image-slot="1"/);
  assert.equal(templatePublishHtml(prepared), publish);
  const textOnly = { ...product, ...renderDescriptionTemplate(product, { ...template, html: '<p>My company only</p>' }, 'replace') };
  assert.equal(validateProductData(textOnly).includes('缺少详情图片'), false);
  assert.deepEqual(mergeSourceDataForPublish(textOnly, product).detailImages, []);
  assert.deepEqual(product.source, original); assert.equal(verifySourceIntegrity(product).valid, true);
});

test('reapplying and switching templates updates the company block without retaining old company images', () => {
  for (const mode of ['append', 'prepend', 'replace']) {
    let product = p();
    product = { ...product, ...renderDescriptionTemplate(product, template, mode) };
    const next = { ...template, id: 'company-b', version: 2, html: '<h2>New company</h2><p>{{productImages}}</p><img src="https://example.com/new-company.png">' };
    for (let i = 0; i < 3; i++) product = { ...product, ...renderDescriptionTemplate(product, next, mode) };
    const $ = load(product.descriptionHtml);
    assert.equal($('[data-workbench-template]').length, 1);
    assert.doesNotMatch(product.descriptionHtml, /Our company|example.com\/company.png/);
    assert.equal(product.detailImages.length, 2);
    assert.ok(product.detailImages.includes('https://example.com/product.jpg'));
    if (mode !== 'replace') assert.match(product.descriptionHtml, /Old company/);
    const patched = { ...product, ...imageListPatch(product, { mainImages: product.mainImages, detailImages: [] }) };
    assert.deepEqual(renderDescriptionTemplate(patched, next, mode).detailImages, ['https://example.com/new-company.png']);
  }
});

test('company templates persist independently, preview without saving, and apply atomically after revision checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-api-test-'));
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const app = express(); app.use(express.json()); registerDescriptionTemplateApi(app, { store, mediaDir: path.join(root, 'media') });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const request = async (url, body, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:' + listener.address().port + '/api/description-templates' + url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    store.update((s) => { s.products = [p(), { ...p(), id: 'b', title: 'Product B' }]; });
    const original = structuredClone(store.read().products);
    const first = (await request('', { name: template.name, html: template.html })).data;
    const copy = (await request('', { name: '服装版', html: '<p>Garment company</p>' })).data;
    assert.notEqual(first.id, copy.id);
    assert.equal((await request('', null, 'GET')).data.length, 2);
    assert.equal(new JsonStore(path.join(root, 'workspace.json')).read().descriptionTemplates.length, 2);
    const body = { ids: ['a', 'b'], templateId: first.id, version: first.version, mode: 'replace' };
    const preview = (await request('/preview', body)).data;
    assert.match(preview.items[1].patch.descriptionHtml, /Product B/);
    assert.deepEqual(store.read().products, original, 'preview never mutates products');
    const revisions = Object.fromEntries(preview.items.map((item) => [item.id, item.revision]));
    assert.equal((await request('/apply', { ...body, revisions: { ...revisions, b: 'stale' } })).status, 409);
    assert.deepEqual(store.read().products, original, 'partial batch cannot be committed');
    store.update((s) => { s.jobs.push({ id: 'active', type: 'publish', status: 'running', metadata: { productIds: ['a'] } }); });
    assert.equal((await request('/apply', { ...body, revisions })).status, 409);
    store.update((s) => { s.jobs = []; });
    const applied = await request('/apply', { ...body, revisions });
    assert.deepEqual(applied, { status: 200, data: { updated: 2 } });
    for (const product of store.read().products) { assert.match(product.descriptionHtml, /Our company/); assert.equal(verifySourceIntegrity(product).valid, true); }
    const savedProducts = structuredClone(store.read().products);
    const edited = (await request('', { ...first, name: '新名称', html: '<p>Updated company</p>' })).data;
    assert.equal(edited.version, 2);
    assert.equal((await request('', first)).status, 409);
    assert.equal((await request('/preview', body)).status, 409);
    assert.deepEqual(store.read().products, savedProducts, 'editing the reusable template does not silently rewrite products');
    assert.equal((await request('/' + first.id, { version: 1 }, 'DELETE')).status, 409);
    assert.equal((await request('/' + first.id, { version: 2 }, 'DELETE')).status, 200);
    assert.deepEqual(store.read().products, savedProducts, 'deleting a template keeps already applied details');
    assert.equal((await request('', { name: 'invalid', html: '<script>alert(1)</script>' })).status, 400);
    assert.equal((await request('', { name: 'missing image', html: '<img src="/media/missing.png">' })).status, 400);
  } finally { await new Promise((resolve) => listener.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('storage cleanup preserves company images referenced by saved templates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-cleanup-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    await fs.mkdir(path.join(root, 'media'));
    store.update((s) => { s.descriptionTemplates = [{ html: '<img src="/media/company.png">' }]; });
    assert.throws(() => cleanupWorkspace(store, root, { scopes: ['products', 'media'], confirm: true }), /详情模板/);
    assert.equal(store.read().descriptionTemplates.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
