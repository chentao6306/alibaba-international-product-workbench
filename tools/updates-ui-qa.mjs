import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { registerUpdateRoutes } from '../auth-server/updates.js';
import { signArtifact } from '../auth-server/update-protocol.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-ui-qa-'));
process.env.DATA_DIR = directory; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js'); const listener = await server.serverReady;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
fs.mkdirSync('.data/update-qa', { recursive: true });
const keys = crypto.generateKeyPairSync('ed25519');
const admin = express(); admin.use(express.json());
registerUpdateRoutes(admin, { directory: path.join(directory, 'updates'), publicKey: keys.publicKey,
  requireAdmin: (request, response, next) => {
    if (request.headers.authorization !== 'Bearer fixture') return response.sendStatus(401);
    request.admin = { username: 'fixture' }; next();
  } });
admin.use(express.static('auth-server'));
admin.use((error, request, response, next) => response.status(error.status || 400).json({ error: error.message }));
const adminListener = await new Promise((resolve) => { const active = admin.listen(0, '127.0.0.1', () => resolve(active)); });
try {
  await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
  await page.addInitScript(() => {
    let state = { status: 'idle', currentVersion: '1.4.52', canInstall: true, error: '' };
    window.kuaYipu = {
      updateState: async () => state,
      checkUpdate: async () => { state = { ...state, status: 'available', checkedAt: Date.now(), release: { version: '1.4.53', title: '新增软件在线更新，优化属性填写', notes: '1. 支持下载断点续传\n2. 新增后台版本管理\n3. 优化多个 OE 代码填写', publishedAt: '2026-10-03T08:00:00Z', size: 268000000 } }; },
      downloadUpdate: async () => { state = { ...state, status: 'downloading', progress: 48, downloaded: 128640000, total: 268000000 }; },
      cancelUpdate: async () => { state = { ...state, status: 'available', error: '下载已暂停，点击下载可继续' }; },
    };
  });
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
  await page.getByRole('heading', { name: '软件更新', exact: true }).waitFor();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByText('发现新版本', { exact: true }).waitFor();
  assert.match(await page.locator('.update-notes').textContent(), /后台版本管理/);
  await page.screenshot({ path: '.data/update-qa/client-available.png', fullPage: false });
  await page.getByRole('button', { name: '下载更新', exact: true }).click();
  await page.getByLabel('更新下载进度').waitFor();
  assert.equal(await page.getByLabel('更新下载进度').getAttribute('value'), '48');
  await page.getByRole('button', { name: '暂停下载', exact: true }).click();
  await page.getByText('下载已暂停，点击下载可继续').waitFor();
  await page.screenshot({ path: '.data/update-qa/client-paused.png' });
  const adminPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  adminPage.on('pageerror', (error) => errors.push(error.message));
  await adminPage.addInitScript(() => sessionStorage.setItem('auth-admin-token', 'fixture'));
  await adminPage.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/updates')) return route.continue();
    await route.fulfill({ json: url.includes('/stats') ? {} : { items: [], total: 0, page: 1, pageSize: 20 } });
  });
  await adminPage.goto(`http://127.0.0.1:${adminListener.address().port}/admin.html`);
  await adminPage.getByRole('tab', { name: '系统更新' }).click();
  await adminPage.getByRole('heading', { name: '发布软件更新' }).waitFor();
  await adminPage.getByLabel('更新标题', { exact: true }).fill('新增软件在线更新，优化属性填写');
  await adminPage.getByLabel('本次更新说明').fill('1. 下载中途退出后可以续传\n2. 安装前保留程序恢复副本\n3. 支持后台上传安装包并正式发布');
  const bytes = Buffer.alloc(5 * 1024 * 1024, 65);
  const envelope = signArtifact({ schema: 1, product: 'com.kua-yipu.workbench', platform: 'win32', arch: 'x64', version: '1.4.53',
    filename: 'chaodekuai-1.4.53-setup.exe', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, keys.privateKey);
  await adminPage.locator('#updateInstaller').setInputFiles({ name: 'chaodekuai-1.4.53-setup.exe', mimeType: 'application/octet-stream', buffer: bytes });
  await adminPage.locator('#updateSignature').setInputFiles({ name: 'chaodekuai-1.4.53-setup.exe.update.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) });
  await adminPage.getByRole('button', { name: '上传并保存草稿' }).click();
  await adminPage.getByText('安装包校验通过，已保存草稿。确认更新说明后点击“正式发布”').waitFor();
  const latest = () => fetch(`http://127.0.0.1:${adminListener.address().port}/updates/chaodekuai/latest.json`).then((r) => r.json());
  assert.equal((await latest()).release, null);
  adminPage.on('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '正式发布', exact: true }).click();
  await adminPage.getByText('已保存软件更新', { exact: true }).waitFor();
  assert.match((await latest()).release.title, /在线更新/);
  await adminPage.screenshot({ path: '.data/update-qa/admin.png' });
  await adminPage.getByLabel('本次更新说明').fill('更新说明已修改');
  await adminPage.getByRole('button', { name: '保存说明', exact: true }).click();
  await adminPage.waitForFunction(() => !document.getElementById('saveUpdateNotes').disabled);
  assert.equal((await latest()).release.notes, '更新说明已修改');
  await adminPage.getByRole('button', { name: '撤回版本', exact: true }).click();
  await adminPage.waitForFunction(() => !document.getElementById('withdrawUpdate').disabled);
  assert.equal((await latest()).release, null);
  assert.deepEqual(errors, []);
  console.log('Client check/download/pause and real 5 MB chunk upload, draft, publish, edit, withdrawal UI passed without page errors.');
} finally {
  await browser.close(); await server.shutdownServer(); adminListener.closeAllConnections();
  await new Promise((r) => adminListener.close(r)); fs.rmSync(directory, { recursive: true, force: true });
}
