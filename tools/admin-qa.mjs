import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-admin-qa-'));
const child = spawn(process.execPath, ['auth-server/dev.js'], { windowsHide: true, env: { ...process.env, PORT: '0', AUTH_DEV_STATE_FILE: path.join(root, 'state.json'), KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit');
let browser;
let client; let clientExited;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Admin preview did not start')), 10000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  let token;
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token || ''}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${method} ${route}: ${response.status}`);
    return response.json();
  };
  token = (await api('/api/admin/login', { username: 'test', password: 'local-test-password' })).token;
  for (let i = 0; i < 24; i += 1) {
    const item = await api('/api/admin/licenses', { alibabaAccount: `qa-account-${String(i).padStart(2, '0')}`, days: 30, note: i === 0 ? 'Long account note '.repeat(30) : 'QA account' });
    if (i % 6 === 1) await api(`/api/admin/licenses/${item.id}`, { action: 'pause' }, 'PATCH');
    if (i % 6 === 2) await api(`/api/admin/licenses/${item.id}`, { action: 'reduce', days: 31 }, 'PATCH');
    if (i % 6 === 3) await api(`/api/admin/licenses/${item.id}`, null, 'DELETE');
    if (i % 6 === 4) await api('/api/client/login', { username: item.alibaba_account, deviceId: 'QA' });
  }
  browser = await chromium.launch({ executablePath: path.resolve('vendor/chromium/chrome.exe'), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('#adminUser').fill('test'); await page.locator('#adminPass').fill('local-test-password');
  await page.locator('#loginForm button').click();
  await page.locator('#licenses tbody tr').first().waitFor();
  async function filtered(action) {
    await Promise.all([page.waitForResponse((response) => response.url().includes('/api/admin/licenses?') && response.status() === 200), action()]);
  }
  await filtered(() => page.locator('[data-filter="expired"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#licenses tbody tr').length === 4);
  assert.deepEqual(await page.locator('#licenses .badge').allTextContents(), Array(4).fill('已到期'));
  await filtered(() => page.locator('#statusFilters input[value="paused"]').check());
  await page.waitForFunction(() => document.querySelectorAll('#licenses tbody tr').length === 8);
  await filtered(() => page.locator('#activity').selectOption('never'));
  await filtered(() => page.locator('#resetFilters').click());
  await filtered(() => page.locator('#pageSize').selectOption('10'));
  await page.locator('#licensePages button[aria-label="下一页"]').click();
  await page.waitForFunction(() => document.querySelector('#licensePages').textContent.includes('2 / 2'));
  await filtered(() => page.locator('[data-filter="active"]').click());
  const row = page.locator('#licenses tbody tr').first();
  await row.locator('[data-action="reduce"]').click();
  await page.locator('#extendDays').fill('40');
  assert.match(await page.locator('#expiryPreview').textContent(), /立即到期/);
  await page.screenshot({ path: path.join(root, 'reduce-dialog.png') });
  await page.locator('#cancelAction').click();
  await row.locator('[data-action="delete"]').click();
  await page.locator('#confirmAction').click();
  await page.locator('#actionDialog').waitFor({ state: 'hidden' });
  await filtered(() => page.locator('[data-filter="deleted"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#licenses tbody tr').length === 5);
  assert.equal(await page.locator('#licenses [data-action]').count(), 0);
  await page.screenshot({ path: path.join(root, 'accounts-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.screenshot({ path: path.join(root, 'accounts-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#announcementsTab').click();
  await page.locator('#createNotice').click();
  await page.locator('#noticeTitle').fill('QA announcement'); await page.locator('#noticeContent').fill('QA text');
  await page.locator('#noticeKind').selectOption('popup'); await page.locator('#noticeStatus').selectOption('published');
  await page.locator('#saveNotice').click();
  await page.locator('#noticeDialog').waitFor({ state: 'hidden' });
  await page.locator('[data-delete-notice]').click();
  await page.screenshot({ path: path.join(root, 'delete-notice-dialog.png') });
  await page.locator('#confirmAction').click();
  await page.locator('#actionDialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#announcements').textContent.includes('暂无公告'));
  assert.deepEqual(await api('/api/announcements', null, 'GET'), []);
  const popup = await api('/api/admin/announcements', { title: 'Client popup QA', content: 'Client popup body', kind: 'popup', status: 'published' });
  const notice = await api('/api/admin/announcements', { title: 'Client notice QA', content: 'Client notice body', kind: 'notice', status: 'published' });
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  client = spawn(process.execPath, ['server/index.js'], { windowsHide: true, env: { ...process.env, PORT: String(port), DATA_DIR: path.join(root, 'client'), KUA_YIPU_AUTH_URL: url, KUA_YIPU_ACCOUNT: 'qa' }, stdio: ['ignore', 'pipe', 'pipe'] });
  clientExited = once(client, 'exit');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Client did not start')), 10000);
    client.once('error', reject);
    client.stdout.on('data', (chunk) => { if (String(chunk).includes('workbench API:')) { clearTimeout(timer); resolve(); } });
  });
  const workbench = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  workbench.on('pageerror', (error) => errors.push(error.message));
  await workbench.goto(`http://127.0.0.1:${port}`);
  await workbench.getByRole('dialog', { name: '公告', exact: true }).waitFor();
  await workbench.screenshot({ path: path.join(root, 'client-popup.png') });
  await api(`/api/admin/announcements/${popup.id}`, null, 'DELETE');
  await workbench.evaluate(() => window.dispatchEvent(new Event('focus')));
  await workbench.getByRole('dialog', { name: '公告', exact: true }).waitFor({ state: 'hidden' });
  await workbench.locator('.sidebar nav button').filter({ hasText: /^公告$/ }).click();
  await workbench.getByText('Client notice QA', { exact: true }).waitFor();
  await api(`/api/admin/announcements/${notice.id}`, null, 'DELETE');
  await workbench.getByTitle('刷新公告', { exact: true }).click();
  await workbench.getByText('暂无公告', { exact: true }).waitFor();
  assert.equal(await workbench.locator('.sidebar .unread-dot').count(), 0);
  await workbench.reload();
  await workbench.locator('.sidebar nav button').filter({ hasText: /^公告$/ }).click();
  await workbench.getByText('暂无公告', { exact: true }).waitFor();
  await workbench.screenshot({ path: path.join(root, 'client-deleted-announcements.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: root }));
} finally {
  await browser?.close();
  if (client) { client.kill(); await clientExited; }
  child.kill(); await exited;
}
