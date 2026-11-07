import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'category-picker-qa-'));
// Isolated fixture data, not a production taxonomy or live publication.
const nodes = [
  { id: '1', parentId: '0', name: 'Agriculture', nameZh: '农业', leaf: false },
  { id: '135', parentId: '1', name: 'Other Agriculture Products', nameZh: '其他农业产品', leaf: true },
  { id: '44', parentId: '0', name: 'Consumer Electronics', nameZh: '消费电子', leaf: false },
  { id: '509', parentId: '44', name: 'Accessories', nameZh: '配件', leaf: false },
  { id: '201346401', parentId: '509', name: 'Drones Accessories', nameZh: '无人机配件', leaf: true },
];
await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
  import CategorySelect from './src/CategorySelect.jsx'; import './src/ProductEditor.css';
  function App(){const [value,setValue]=useState({id:'201896803',path:'Original category'});return <div className="pe-window" style={{height:'auto',width:'100%'}}><form onSubmit={e=>{e.preventDefault();document.body.dataset.submitted='true'}}><CategorySelect categoryId={value.id} path={value.path} onChange={setValue} onCancel={()=>{document.body.dataset.cancelled='true'}}/><output>{JSON.stringify(value)}</output></form></div>}
  createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, jsx: 'automatic', outfile: path.join(output, 'app.js'), logLevel: 'warning' });
let failCatalog = true;
const app = http.createServer(async (req, res) => {
  if (req.url === '/api/categories/catalog') {
    res.writeHead(failCatalog ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failCatalog ? { error: '测试网络不可用' } : { nodes, updatedAt: '2026-09-23' })); return;
  }
  if (req.url === '/api/categories/from-product') {
    await new Promise((resolve) => setTimeout(resolve, 600));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: '135', path: 'Agriculture >> Other Agriculture Products' })); return;
  }
  if (req.url === '/app.js' || req.url === '/app.css') {
    res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : 'application/javascript' });
    res.end(await fs.readFile(path.join(output, req.url.slice(1)))); return;
  }
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{box-sizing:border-box}body{margin:12px}output{display:block;margin:12px}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${app.address().port}`);
  await page.getByText('测试网络不可用').waitFor();
  assert.equal(await page.getByRole('button', { name: '确认选择' }).isDisabled(), true);
  failCatalog = false;
  await page.getByRole('button', { name: '重新加载' }).click();
  await page.getByRole('listbox', { name: '第 1 级类目' }).waitFor();
  await page.getByRole('option', { name: 'Consumer Electronics', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '确认选择' }).isDisabled(), true);
  await page.getByRole('option', { name: 'Accessories', exact: true }).click();
  await page.getByRole('option', { name: 'Drones Accessories', exact: true }).click();
  assert.equal(JSON.parse(await page.locator('output').innerText()).id, '201896803', 'browsing does not edit the product');
  await page.screenshot({ path: path.join(output, 'browse-desktop.png') });
  await page.getByRole('button', { name: '确认选择' }).click();
  assert.equal(JSON.parse(await page.locator('output').innerText()).id, '201346401');
  await page.getByRole('tab', { name: '最近使用' }).click();
  assert.equal(await page.getByRole('listbox', { name: '最近使用类目' }).getByRole('option').count(), 1);
  await page.getByRole('tab', { name: '搜索类目' }).click();
  await page.getByLabel('搜索类目名称或 ID').fill('农业');
  await page.getByLabel('搜索类目名称或 ID').press('Enter');
  assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
  await page.getByRole('listbox', { name: '类目搜索结果' }).getByRole('option').click();
  await page.getByRole('button', { name: '取消选择' }).click();
  assert.equal(JSON.parse(await page.locator('output').innerText()).id, '201346401', 'cancel does not apply pending leaf');
  await page.getByRole('tab', { name: '读取同类商品' }).click();
  await page.getByLabel('同类国际站商品链接').fill('https://www.alibaba.com/product-detail/fixture_123456789.html');
  await page.getByRole('button', { name: '读取商品类目', exact: true }).click();
  await page.getByRole('tab', { name: '浏览类目' }).click();
  await page.getByRole('option', { name: 'Consumer Electronics', exact: true }).click();
  await page.waitForTimeout(800);
  assert.equal(await page.getByRole('button', { name: '确认选择' }).isDisabled(), true, 'late reference result must not replace a newer selection');
  await page.getByLabel('类目显示语言').selectOption('zh');
  await page.getByRole('option', { name: '农业', exact: true }).click();
  await page.getByRole('option', { name: '其他农业产品', exact: true }).click();
  await page.setViewportSize({ width: 430, height: 850 });
  assert.equal(await page.locator('.category-picker').evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: path.join(output, 'browse-small.png') });
  await page.getByRole('button', { name: '确认选择' }).click();
  assert.equal(JSON.parse(await page.locator('output').innerText()).path, 'Agriculture >> Other Agriculture Products', 'display language does not alter canonical category path');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, output, checks: ['load error and retry', 'leaf-only confirmation', 'cancel preserves product', 'search and Enter', 'recent categories', 'stale reference ignored', 'language preserves ID', 'small viewport'] }));
} finally {
  await browser.close(); await new Promise((resolve) => app.close(resolve));
}
