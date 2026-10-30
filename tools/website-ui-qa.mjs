import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'website-ui-qa-'));
const app = express(); app.use('/website', express.static(path.resolve('dist-website')));
const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
let mode = 'ready';
const release = { envelope: { payload: Buffer.from(JSON.stringify({ schema: 1, product: 'com.kua-yipu.workbench', platform: 'win32', arch: 'x64',
  version: '1.4.71', filename: 'chaodekuai-1.4.71-setup.exe', size: 270000000 })).toString('base64') },
  url: '/updates/chaodekuai/files/12345678-abcd-abcd-abcd-123456789abc.exe', title: 'QA Release', notes: '<script>bad()</script>\nFixed upload' };
await page.route('**/updates/chaodekuai/latest.json', (route) => mode === 'error'
  ? route.fulfill({ status: 503, json: { error: 'QA temporary' } }) : route.fulfill({ json: { release: mode === 'empty' ? null : release } }));
await page.route('**/updates/chaodekuai/download', (route) => route.fulfill({ body: 'MZ-fixture', headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="qa-installer.exe"' } }));
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}/website/`);
  for (const id of ['collect', 'edit', 'publish']) {
    await page.locator(`#tab-${id}`).click(); assert.equal(await page.locator(`#tab-${id}`).getAttribute('aria-selected'), 'true');
  }
  await page.locator('#tab-publish').press('Home'); assert.equal(await page.locator('#tab-collect').getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '查看版本说明', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByText('QA Release', { exact: true }).waitFor();
  assert.match(await dialog.innerText(), /<script>bad\(\)<\/script>/); assert.equal(await dialog.locator('script').count(), 0);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '下载软件', exact: true }).click();
  await dialog.getByText('版本 1.4.71', { exact: true }).waitFor();
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '下载安装包', exact: true }).click();
  assert.equal((await download).suggestedFilename(), 'qa-installer.exe');
  await dialog.getByRole('button', { name: '关闭弹窗' }).click();
  mode = 'empty'; await page.getByRole('button', { name: '下载软件', exact: true }).click();
  await dialog.getByText('安装包暂未开放下载，请稍后再来。', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('link', { name: '下载安装包' }).count(), 0);
  mode = 'error'; await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await dialog.getByText('暂时无法获取安装包，请检查网络后重试。', { exact: true }).waitFor();
  mode = 'ready'; await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await dialog.getByText('版本 1.4.71', { exact: true }).waitFor(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '微信咨询', exact: true }).click();
  assert.equal(await dialog.getByRole('img', { name: /客服微信二维码/ }).evaluate((img) => img.complete && img.naturalWidth > 0), true);
  await dialog.getByRole('button', { name: '复制客服微信' }).click(); await dialog.getByRole('status').waitFor();
  await dialog.getByRole('button', { name: '先查看使用指南', exact: true }).click();
  await page.getByRole('dialog', { name: '抄得快入门指南' }).waitFor(); await page.keyboard.press('Escape');
  for (const summary of await page.locator('.faq-list summary').all()) {
    const wasOpen = await summary.evaluate((node) => node.parentElement.open); await summary.click();
    assert.equal(await summary.evaluate((node) => node.parentElement.open), !wasOpen);
  }
  await page.getByRole('button', { name: '隐私说明', exact: true }).click(); await page.getByRole('dialog', { name: '隐私说明' }).waitFor(); await page.keyboard.press('Escape');
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, `website-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航菜单' }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '产品功能' }).click();
  assert.equal(await page.getByRole('button', { name: '打开导航菜单' }).getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, checks: ['feature-tabs-keyboard', 'download', 'withdrawal', 'outage-retry', 'plain-text-notes', 'wechat', 'guide', 'faq', 'privacy', 'mobile-menu', 'responsive'] }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); throw error; }
finally { await browser.close(); await new Promise((resolve) => listener.close(resolve)); }
