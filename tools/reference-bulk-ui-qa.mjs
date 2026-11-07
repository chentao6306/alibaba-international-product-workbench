import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

// Synthetic component harness: no customer data, seller session or live API.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-bulk-ui-qa-'));
const bundle = await build({
  stdin: { contents: `
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import ReferenceDialog from './src/ReferenceDialog.jsx';
    function Harness() {
      const [tick, setTick] = useState(0);
      useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), 100); return () => clearInterval(timer); }, []);
      window.qaRerender = () => setTick(value => value + 1);
      return <><output id="polls">{tick}</output><ReferenceDialog
        products={Array.from({ length: window.qaCount || 1886 }, (_, i) => ({ id: 'target-' + i, title: 'Synthetic ' + i }))}
        notify={(message, type) => { window.qaNotices.push({ message, type }); }}
        onClose={() => { window.qaClosed = true; }}
        onSaved={result => { window.qaSaved = result; }}
        editorDraft={window.qaEditor ? { title: 'Unsaved draft title' } : undefined}
        onApplyDraft={window.qaEditor ? result => { window.qaAppliedDraft = result; } : undefined}
      /></>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
});
const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const listener = http.createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
  res.setHeader('Content-Type', 'text/html');
  res.end('<link rel="stylesheet" href="/style.css"><div id="root"></div><script>window.qaNotices=[];</script><script src="/app.js"></script>');
}).listen(0, '127.0.0.1');
await new Promise(resolve => listener.once('listening', resolve));
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
let mode = 'success', previewCalls = 0, saveCalls = 0, lastSave;
const template = { categoryId: 'category', categoryPath: ['Synthetic category'], attributes: [{ name: 'Material', value: 'ABS' }], skus: [] };
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/references') return route.fulfill({ json: { references: [{ id: 'reference', title: 'Synthetic published template', template }] } });
  const body = route.request().postDataJSON();
  if (url.pathname === '/api/products/reference/preview') {
    previewCalls++;
    await new Promise(resolve => setTimeout(resolve, 300));
    if (mode === 'error') return route.fulfill({ status: 500, json: { error: 'Synthetic preview failure: no changes saved' } });
    assert.ok([1886, 1].includes(body.ids.length));
    assert.equal(body.pageSize, 30, 'The real API must page results, not only hide a large full response');
    const start = (body.page - 1) * body.pageSize;
    return route.fulfill({ json: { referenceId: 'reference', token: mode === 'changed-page' ? 'changed-token' : 'preview-token',
      total: body.ids.length, totalChanged: mode === 'skipped' ? 0 : mode === 'first-page-skipped' ? body.ids.length - 30 : body.ids.length,
      page: body.page, pageSize: body.pageSize,
      items: body.ids.slice(start, start + body.pageSize).map((id, index) => ({ id, title: 'Synthetic ' + (start + index),
        skipped: mode === 'skipped' || (mode === 'first-page-skipped' && start + index < 30) ? '没有需要修改的字段' : '',
        patch: { material: 'ABS' }, changes: [{ field: 'attributes', before: [{ name: 'Material', value: 'Metal' }], after: template.attributes }] })) } });
  }
  if (url.pathname === '/api/products/reference') {
    saveCalls++; lastSave = body;
    if (mode === 'stale') return route.fulfill({ status: 409, json: { error: '商品或引用内容已变化，请重新预览后保存' } });
    return route.fulfill({ json: { changed: body.ids.map(id => ({ id })) } });
  }
  return route.fulfill({ status: 404, json: { error: 'Unexpected synthetic endpoint' } });
});
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('选择引用商品', { exact: true }).selectOption('reference');
  const preview = page.getByRole('button', { name: '预览修改', exact: true });
  const save = page.getByRole('button', { name: '引用并保存', exact: true });
  await preview.click();
  await page.getByRole('status').filter({ hasText: '正在核对 1886 件商品' }).waitFor();
  await page.getByRole('heading', { name: '修改预览 · 1886 件将更新' }).waitFor();
  const rows = page.locator('.reference-preview details');
  assert.ok(await rows.count() <= 50, 'Large previews must not mount every product row');
  assert.equal(await page.locator('.reference-diff').count(), 0, 'Collapsed rows must not create all diff JSON nodes');
  await rows.first().locator('summary').click();
  await page.locator('.reference-diff').waitFor();
  assert.equal(await page.locator('.reference-diff').count(), 1);
  const polls = Number(await page.locator('#polls').innerText());
  await page.waitForFunction(value => Number(document.querySelector('#polls').textContent) > value + 3, polls);
  assert.equal(await save.isEnabled(), true, 'New but equal product objects from polling must preserve preview');
  await page.getByRole('button', { name: '下一页预览', exact: true }).click();
  await rows.first().filter({ hasText: 'Synthetic 30' }).waitFor();
  await page.getByRole('button', { name: '上一页预览', exact: true }).click();
  await rows.first().filter({ hasText: 'Synthetic 0' }).waitFor();
  await save.click();
  await page.waitForFunction(() => window.qaSaved?.changed.length === 1886);
  assert.equal(lastSave.ids.length, 1886);
  assert.equal(lastSave.previewToken, 'preview-token');
  assert.equal(lastSave.page, undefined, 'Saving applies the reviewed batch, not only the visible page');
  assert.equal(saveCalls, 1);
  mode = 'error';
  await preview.click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic preview failure' }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await page.waitForTimeout(4300);
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Synthetic preview failure' }).isVisible(), true, 'Errors remain in the dialog after global notices expire');
  assert.equal(saveCalls, 1);
  mode = 'success';
  await preview.click(); await page.getByRole('heading', { name: '修改预览 · 1886 件将更新' }).waitFor();
  mode = 'stale'; await save.click();
  await page.getByRole('alert').filter({ hasText: '重新预览' }).waitFor();
  assert.equal(await save.isDisabled(), true);
  mode = 'skipped'; await preview.click();
  await page.getByRole('heading', { name: '修改预览 · 0 件将更新' }).waitFor();
  assert.equal(await save.isDisabled(), true);
  mode = 'first-page-skipped'; await preview.click();
  await page.getByRole('heading', { name: '修改预览 · 1856 件将更新' }).waitFor();
  assert.equal(await save.isEnabled(), true, 'A skipped first page must not disable the changes on later pages');
  mode = 'changed-page'; await page.getByRole('button', { name: '下一页预览', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '重新预览' }).waitFor();
  assert.equal(await save.isDisabled(), true, 'A changed token cannot combine old and new preview pages');
  mode = 'success'; await preview.click();
  await page.getByRole('heading', { name: '修改预览 · 1886 件将更新' }).waitFor();
  await preview.click();
  await page.getByRole('status').filter({ hasText: '正在核对' }).waitFor();
  await page.evaluate(() => { window.qaCount = 1; window.qaRerender(); });
  await page.getByRole('alert').filter({ hasText: '所选商品或引用选项已变化' }).waitFor();
  assert.equal(await save.isDisabled(), true, 'A response for the previous selection must not enable saving');
  await page.evaluate(() => { window.qaEditor = true; window.qaRerender(); });
  await preview.click();
  await page.getByRole('heading', { name: '修改预览 · 1 件将更新' }).waitFor();
  await page.locator('.reference-diff').waitFor();
  const previousSaveCalls = saveCalls;
  await page.getByRole('button', { name: '应用到编辑窗口', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.qaAppliedDraft));
  assert.equal(saveCalls, previousSaveCalls, 'Applying an editor preview does not save the product immediately');
  assert.deepEqual(await page.evaluate(() => window.qaAppliedDraft), { patch: { material: 'ABS' }, review: {
    ids: ['target-0'], referenceId: 'reference', options: { scope: 'full', preserveSkuStock: true, includeLogistics: false },
    editorDraft: { title: 'Unsaved draft title' }, previewToken: 'preview-token',
  } });
  await page.evaluate(() => { window.qaEditor = false; window.qaCount = 1886; window.qaRerender(); });
  await preview.click();
  await page.getByRole('heading', { name: '修改预览 · 1886 件将更新' }).waitFor();
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.locator('.reference-drawer').evaluate(node => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(root, `reference-bulk-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, products: 1886, previewCalls, saveCalls, screenshots: root,
    verified: ['server-paged-bounded-diff-render', 'polling-preserves-preview', 'full-selection-save-token', 'persistent-error', 'stale-token-blocks-save', 'all-skipped-blocks-save', 'skipped-page-with-other-changes', 'changed-page-token-blocks-save', 'late-selection-response-rejected', 'unsaved-editor-draft', 'desktop-mobile'] }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png') });
  console.error(JSON.stringify({ root, errors, previewCalls, saveCalls }));
  throw error;
} finally { await browser.close(); await new Promise(resolve => listener.close(resolve)); }
