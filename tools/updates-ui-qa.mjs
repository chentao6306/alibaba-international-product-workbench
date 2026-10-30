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
let redirectedCollectionRequests = 0;
// Reproduce the production proxy's slash redirect. Upload must use the
// canonical collection URL and remain POST, including when it resumes.
admin.use((request, response, next) => {
  if (request.path === '/api/admin/updates') { redirectedCollectionRequests++; return response.redirect(301, '/api/admin/updates/'); }
  next();
});
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
  const malformed = async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ json: [] });
    else await route.continue();
  };
  await adminPage.route('**/api/admin/updates/', malformed);
  await adminPage.getByRole('button', { name: '上传并保存草稿' }).click();
  await adminPage.getByText('更新服务返回的版本信息不完整，请刷新管理页面后重试').waitFor();
  assert.equal(await adminPage.locator('#updateMessage').textContent().then((text) => text.includes('Cannot read properties')), false);
  await adminPage.unroute('**/api/admin/updates/', malformed);
  let releaseChunk;
  let chunkWaiting;
  const heldChunk = new Promise((resolve) => { chunkWaiting = resolve; });
  const hold = async (route) => {
    chunkWaiting();
    await new Promise((resolve) => { releaseChunk = resolve; });
    await route.abort().catch(() => {});
  };
  await adminPage.route('**/api/admin/updates/*/file?offset=4194304', hold);
  await adminPage.getByRole('button', { name: '上传并保存草稿' }).click();
  await heldChunk;
  await adminPage.getByRole('button', { name: '暂停上传', exact: true }).click();
  releaseChunk();
  await adminPage.getByText('上传已暂停，重新选择相同文件可继续上传').waitFor();
  await adminPage.unroute('**/api/admin/updates/*/file?offset=4194304', hold);
  await adminPage.getByRole('button', { name: '继续上传', exact: true }).waitFor();
  assert.equal(await adminPage.getByRole('button', { name: '正式发布', exact: true }).count(), 0);
  await adminPage.getByRole('button', { name: '上传并保存草稿' }).click();
  await adminPage.getByText('安装包校验通过，已保存草稿。请在下方版本记录中点击“正式发布”').waitFor();
  assert.equal(redirectedCollectionRequests, 0, 'A POST may not be redirected into a GET');
  assert.equal(await adminPage.locator('#updateVersionCount').textContent(), '1');
  const record = adminPage.locator('#updateVersions tbody tr').first();
  const draftDownload = adminPage.waitForEvent('download');
  await record.getByRole('button', { name: '下载安装包', exact: true }).click();
  assert.equal((await draftDownload).suggestedFilename(), 'chaodekuai-1.4.53-setup.exe');
  const latest = () => fetch(`http://127.0.0.1:${adminListener.address().port}/updates/chaodekuai/latest.json`).then((r) => r.json());
  assert.equal((await latest()).release, null);
  adminPage.on('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '正式发布', exact: true }).click();
  await adminPage.getByText('版本已正式发布，客户现在可以检查更新', { exact: true }).waitFor();
  assert.match((await latest()).release.title, /在线更新/);
  await adminPage.evaluate(() => window.scrollTo(0, 0));
  await adminPage.screenshot({ path: '.data/update-qa/admin.png', fullPage: true });
  await record.getByRole('button', { name: '编辑说明', exact: true }).click();
  await adminPage.getByLabel('本次更新说明').fill('更新说明已修改');
  await adminPage.getByRole('button', { name: '保存说明', exact: true }).click();
  await adminPage.waitForFunction(() => !document.getElementById('saveUpdateNotes').disabled);
  assert.equal((await latest()).release.notes, '更新说明已修改');
  await record.getByRole('button', { name: '停止分发', exact: true }).click();
  await adminPage.getByText('版本已停止分发', { exact: true }).waitFor();
  assert.equal((await latest()).release, null);
  await adminPage.setViewportSize({ width: 390, height: 844 });
  await adminPage.locator('#cancelUpdateEdit').click();
  await adminPage.evaluate(() => window.scrollTo(0, 0));
  await adminPage.screenshot({ path: '.data/update-qa/admin-mobile.png', fullPage: true });
  assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('Client check/download/pause and real 5 MB chunk upload, draft, publish, edit, withdrawal UI passed without page errors.');
} finally {
  await browser.close(); await server.shutdownServer(); adminListener.closeAllConnections();
  await new Promise((r) => adminListener.close(r)); fs.rmSync(directory, { recursive: true, force: true });
}
