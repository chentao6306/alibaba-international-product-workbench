import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

if (process.versions.electron) {
  const { app, BrowserWindow, ipcMain } = await import('electron');
  app.setPath('userData', path.join(process.env.QA_DIAGNOSTIC_ROOT, 'profile'));
  app.whenReady().then(async () => {
  process.env.DATA_DIR = path.join(process.env.QA_DIAGNOSTIC_ROOT, 'data'); process.env.PORT = '0';
  delete process.env.KUA_YIPU_DESKTOP;
  const service = await import('../server/index.js');
  const { createDiagnosticController } = await import('../electron/diagnostics.js');
  const { buildDiagnosticReport } = await import('../server/diagnostic-report.js');
  const { createRuntimeDiagnostics } = await import('../server/runtime-diagnostics.js');
  const { createPublishDiagnosticStore } = await import('../server/publish-diagnostics.js');
  const evidence = createPublishDiagnosticStore(process.env.DATA_DIR, 'diagnostic-ui');
  evidence.write(JSON.parse(fs.readFileSync(path.join(process.env.QA_DIAGNOSTIC_ROOT, 'failure.json'), 'utf8')));
  const log = path.join(process.env.DATA_DIR, 'runtime-diagnostics.log');
  createRuntimeDiagnostics(log)('workbench-startup-failed', { code: 'ERR_STRING_TOO_LONG', stage: 'startup' });
  globalThis.__QA_DIAGNOSTIC_OFFLINE = false;
  const controller = createDiagnosticController({
    session: () => ({ username: 'diagnostic-ui', token: process.env.QA_DIAGNOSTIC_TOKEN }),
    buildReport: async (note, account) => buildDiagnosticReport({ account, version: '1.4.83', note, files: [log], dataDirectory: process.env.DATA_DIR, service: 'running', summary: service.diagnosticSummary() }),
    upload: async (report, token) => {
      if (globalThis.__QA_DIAGNOSTIC_OFFLINE) throw new Error('暂时无法连接授权服务器，请检查网络后重试');
      const response = await fetch(process.env.QA_DIAGNOSTIC_AUTH + '/api/client/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(report) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    },
    clear: async () => { evidence.clear(); fs.rmSync(log, { force: true }); },
  });
  ipcMain.handle('diagnostics:upload', (_event, id) => controller.upload(id));
  ipcMain.handle('diagnostics:clear', () => controller.clear());
  ipcMain.handle('auth:session', () => ({ username: 'diagnostic-ui', expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  ipcMain.handle('auth:connection', () => ({ state: 'connected' }));
  ipcMain.handle('auth:heartbeat', () => ({ authorized: true }));
  ipcMain.handle('credentials:load', () => null);
  ipcMain.handle('activation:status', () => false);
  ipcMain.handle('service:status', () => ({ status: 'running' }));
  ipcMain.handle('update:state', () => ({ status: 'current', currentVersion: '1.4.83' }));
  const listener = await service.serverReady;
  const window = new BrowserWindow({ show: false, width: 1360, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.resolve('electron/preload.cjs') } });
  await window.loadURL(`http://127.0.0.1:${listener.address().port}/`);
  app.on('window-all-closed', () => app.quit());
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { _electron, chromium } = await import('playwright-core');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-ui-'));
  const output = process.env.QA_OUTPUT_DIR || root; fs.mkdirSync(output, { recursive: true });
  const child = spawn(process.execPath, ['auth-server/dev.js'], { windowsHide: true, env: { ...process.env, PORT: '0', AUTH_DEV_STATE_FILE: path.join(root, 'auth.json'), KUA_YIPU_DIAGNOSTIC_DIR: path.join(root, 'reports'), KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let desktop; let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Auth startup timeout')), 10000);
      child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const api = async (route, body, token = '', method = 'POST') => {
      const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(response.ok, route + ': ' + response.status); return response.json();
    };
    const admin = (await api('/api/admin/login', { username: 'test', password: 'local-test-password' })).token;
    const license = await api('/api/admin/licenses', { alibabaAccount: 'diagnostic-ui', days: 10 }, admin);
    const client = (await api('/api/client/login', { username: 'diagnostic-ui', activationCode: license.activationCode, deviceId: 'diagnostic-ui-device' })).token;
    browser = await chromium.launch({ executablePath: path.resolve('vendor/chromium/chrome.exe'), headless: true });
    const publishing = await browser.newPage();
    await publishing.route('https://post.alibaba.com/product/publish.htm', route => route.fulfill({ contentType: 'text/html', body: '<html><body><main id="struct-content"><h1>Fixture publish page</h1><input id="productTitle" value="QA linen shirt"><textarea id="description">Linen with pockets</textarea><input type="password" value="SCREEN_SECRET"><div role="alert">Product images: upload rejected</div></main></body></html>' }));
    await publishing.goto('https://post.alibaba.com/product/publish.htm');
    const { capturePublishFailure } = await import('../server/publish-diagnostics.js');
    const product = { id: 'qa-linen', title: 'QA linen shirt', sourceUrl: 'https://www.alibaba.com/product-detail/linen_1600000000000.html', descriptionHtml: '<table><tr><td>Material</td><td>Linen</td></tr></table>', attributes: [{ name: 'Material', value: 'Linen' }], skus: [{ color: 'Blue', size: 'M', price: 9.5 }], source: { snapshot: { title: 'Original linen shirt', description: 'Original description' } }, cookies: 'SHOULD_NOT_BE_CAPTURED' };
    const failure = await capturePublishFailure({ page: publishing, product, error: Object.assign(new Error('Product images rejected; Cookie: PRIVATE_COOKIE'), { code: 'PUBLISH_IMAGE_UPLOAD_FAILED' }), stage: 'images', mode: 'draft', elapsedMs: 12500 });
    assert.equal(failure.screenshots.length, 2);
    fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify(failure));
    await publishing.close();
    desktop = await _electron.launch({ args: [fileURLToPath(import.meta.url)], env: { ...process.env, QA_DIAGNOSTIC_ROOT: root, QA_DIAGNOSTIC_TOKEN: client, QA_DIAGNOSTIC_AUTH: url, KUA_YIPU_AUTH_URL: 'http://127.0.0.1:1' } });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(20000); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
    const panel = page.locator('.diagnostic-upload');
    assert.equal(await panel.locator('pre').count(), 0);
    assert.equal(await panel.getByRole('button', { name: /预览|导出/ }).count(), 0);
    assert.doesNotMatch(await panel.innerText(), /Cookie|保留约|商品正文或图片|diagnostic-ui/);
    await panel.getByLabel('诊断问题描述').fill('连续图片失败\n密码: PRIVATE_PASSWORD\n<img src=x onerror=alert(1)>');
    await desktop.evaluate(() => { globalThis.__QA_DIAGNOSTIC_OFFLINE = true; });
    await panel.getByRole('button', { name: '上传日志', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: '检查网络' }).waitFor();
    assert.equal(await panel.getByRole('button', { name: '上传日志', exact: true }).isEnabled(), true);
    await desktop.evaluate(() => { globalThis.__QA_DIAGNOSTIC_OFFLINE = false; });
    await panel.getByRole('button', { name: '上传日志', exact: true }).click();
    await panel.getByText('上传成功，请将反馈编号发给客服。', { exact: true }).waitFor();
    const receipt = await panel.locator('strong').textContent(); assert.match(receipt, /^LOG-[A-F0-9]{24}$/);
    const uploaded = (await api('/api/admin/diagnostics/' + receipt, null, admin, 'GET')).report;
    assert.doesNotMatch(JSON.stringify(uploaded), /PRIVATE_PASSWORD|PRIVATE_COOKIE|SCREEN_SECRET|SHOULD_NOT_BE_CAPTURED/);
    assert.equal(uploaded.events[0].code, 'ERR_STRING_TOO_LONG');
    assert.equal(uploaded.failures[0].product.descriptionHtml, product.descriptionHtml);
    assert.deepEqual(uploaded.failures[0].product.skus, product.skus);
    assert.equal(uploaded.failures[0].source.description, 'Original description');
    assert.equal(uploaded.failures[0].screenshots.length, 2);
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'desktop-diagnostics.png') });
    await page.goto('file:///' + path.resolve('electron/login.html').replaceAll('\\', '/'));
    await page.locator('#diagnosticBox summary').click();
    assert.equal(await page.locator('#diagnosticPreview, #diagnosticExport').count(), 0);
    await page.locator('#diagnosticNote').fill('启动问题回归');
    await page.locator('#diagnosticUpload').click();
    await page.locator('#diagnosticStatus').filter({ hasText: '上传成功' }).waitFor();
    await page.screenshot({ path: path.join(output, 'login-diagnostics.png') });
    const dataDir = path.join(root, 'data');
    const businessBefore = fs.readdirSync(dataDir).filter(name => !/diagnostic|runtime/.test(name)).map(name => [name, fs.statSync(path.join(dataDir, name)).size]);
    await page.locator('#diagnosticClear').click();
    await page.locator('#diagnosticStatus').filter({ hasText: '本机日志已清理' }).waitFor();
    const { createPublishDiagnosticStore } = await import('../server/publish-diagnostics.js');
    assert.equal(createPublishDiagnosticStore(dataDir, 'diagnostic-ui').read().failures.length, 0);
    assert.deepEqual(fs.readdirSync(dataDir).filter(name => !/diagnostic|runtime/.test(name)).map(name => [name, fs.statSync(path.join(dataDir, name)).size]), businessBefore);
    const adminPage = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
    adminPage.on('pageerror', error => errors.push(error.message));
    await adminPage.goto(url + '/admin/'); await adminPage.locator('#adminUser').fill('test'); await adminPage.locator('#adminPass').fill('local-test-password');
    await adminPage.locator('#loginForm button').click(); await adminPage.locator('#diagnosticsTab').click();
    await adminPage.locator('#diagnosticSearch').fill(receipt); await adminPage.getByRole('button', { name: '查询日志' }).click();
    await adminPage.getByRole('button', { name: receipt, exact: true }).click();
    await adminPage.waitForFunction(() => document.querySelector('#diagnosticDetail').textContent.includes('ERR_STRING_TOO_LONG'));
    assert.equal(await adminPage.locator('#diagnosticList img').count(), 0);
    assert.equal(await adminPage.locator('#diagnosticScreenshots img').count(), 2);
    assert.ok(await adminPage.locator('#diagnosticScreenshots img').first().evaluate(img => img.complete && img.naturalWidth > 0));
    const download = adminPage.waitForEvent('download'); await adminPage.locator('#downloadDiagnostic').click();
    const file = await download; await file.saveAs(path.join(output, 'admin-download.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'admin-download.json'), 'utf8')).report, uploaded);
    await adminPage.screenshot({ path: path.join(output, 'admin-diagnostics.png') });
    await adminPage.locator('#logout').click(); await adminPage.locator('#loginBox').waitFor({ state: 'visible' });
    assert.equal(await adminPage.locator('#diagnosticDetail').textContent(), '');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, uploadAndReadback: true, offlineRetry: true, loginUpload: true, clearPreservesProducts: true, richEvidence: true, noClientExport: true, adminDownload: true, noScriptExecution: true, errors }, null, 2));
    console.log(JSON.stringify({ passed: true, output }));
  } finally { await desktop?.close(); await browser?.close(); child.kill(); await exited; }
}
