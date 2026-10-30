import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-bulk-ui-'));
const child = spawn(process.execPath, ['auth-server/dev.js'], { windowsHide: true, env: { ...process.env, PORT: '0', BIND_HOST: '127.0.0.1', AUTH_DEV_STATE_FILE: path.join(root, 'state.json'), KUA_YIPU_ADMIN_PATH: '/admin', KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password' }, stdio: ['ignore','pipe','pipe'] });
const exited = once(child, 'exit');
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  let token;
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.ok, true, route); return response.json();
  };
  token = (await api('/api/admin/login', { username: 'test', password: 'local-test-password' })).token;
  const created = [];
  for (let i = 0; i < 21; i++) created.push(await api('/api/admin/licenses', { alibabaAccount: `ui-account-${i}`, days: 20 }));
  const paused = await api('/api/admin/licenses', { alibabaAccount: 'ui-paused', days: 20 });
  await api(`/api/admin/licenses/${paused.id}`, { action: 'pause' }, 'PATCH');
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/admin/');
  await page.locator('#loginBox').getByLabel('管理员账号', { exact: true }).fill('test');
  await page.locator('#loginBox').getByLabel('管理员密码', { exact: true }).fill('local-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('#app').waitFor();
  await page.locator('#search').fill('ui-account-20');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.locator('#licenses tbody tr').first().waitFor();
  for (const [action, days] of [['extend',3], ['reduce',1], ['pause',0]]) {
    await page.locator('#bulkLicenseAction').selectOption(action);
    assert.equal(await page.locator('#bulkLicenseConfirm').isDisabled(), true);
    if (days) await page.locator('#bulkLicenseDays').fill(String(days));
    else assert.equal(await page.locator('#bulkLicenseDaysField').isVisible(), false);
    await page.getByRole('button', { name: '预览影响人数', exact: true }).click();
    await page.locator('#bulkLicensePreview').waitFor();
    assert.match(await page.locator('#bulkLicensePreview').innerText(), /所有 21 个/);
    if (action === 'extend') {
      await page.locator('#bulkLicenseDays').fill('4');
      assert.equal(await page.locator('#bulkLicenseConfirm').isDisabled(), true);
      await page.locator('#bulkLicenseDays').fill('3');
      await page.getByRole('button', { name: '预览影响人数', exact: true }).click();
      await page.locator('#bulkLicensePreview').waitFor();
      await page.screenshot({ path: path.join(root, 'bulk-preview.png'), fullPage: true });
    }
    await page.getByRole('button', { name: '确认批量执行', exact: true }).click();
    await page.locator('#msg').filter({ hasText: '批量操作完成' }).waitFor();
    assert.match(await page.locator('#msg').innerText(), /21 个账号/);
    await page.reload(); await page.locator('#app').waitFor();
  }
  const saved = await api('/api/admin/licenses?pageSize=100', null, 'GET');
  for (const row of created) {
    const value = saved.items.find(item => item.id === row.id);
    assert.equal(value.status, 'paused');
    assert.equal(new Date(value.expires_at) - new Date(row.expires_at), 2 * 86400000);
  }
  assert.equal(saved.items.find(item => item.id === paused.id).expires_at, paused.expires_at);
  await page.getByRole('button', { name: '预览影响人数', exact: true }).click();
  await page.locator('#bulkLicensePreview').waitFor();
  assert.match(await page.locator('#bulkLicensePreview').innerText(), /所有 0 个/);
  assert.equal(await page.locator('#bulkLicenseConfirm').isDisabled(), true);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, `bulk-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, checks: ['all-pages-filter-independent', 'preview-invalidation', 'extend', 'reduce', 'pause', 'excluded-unchanged', 'empty-disabled', 'reload', 'responsive'] }));
} finally { await browser?.close(); child.kill(); await exited; }
