import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-auth-qa-'));
let authorized = true;
let heartbeats = 0;
let codeLogins = 0;
let unavailable = false;
const testCode = 'CDK-' + 'q'.repeat(43);
const authServer = http.createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (unavailable && request.url.includes('heartbeat')) { response.writeHead(503); response.end('{"error":"QA temporary outage"}'); return; }
  if (request.url.includes('/login')) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.activationCode !== testCode) { response.writeHead(403); response.end('{"error":"QA activation code missing"}'); return; }
    codeLogins++;
  }
  if (!authorized) { response.writeHead(403); response.end('{"error":"QA authorization revoked"}'); return; }
  if (request.url.includes('heartbeat')) heartbeats++;
  response.end(JSON.stringify({ authorized: true, token: 'qa-session', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), offlineGraceSeconds: 60 }));
});
await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
const free = net.createServer();
await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve));
const port = free.address().port;
await new Promise((resolve) => free.close(resolve));
let app;
try {
  app = await _electron.launch({ args: ['electron/main.js', `--user-data-dir=${path.join(root, 'profile')}`], env: { ...process.env, APPDATA: root, LOCALAPPDATA: root, KUA_YIPU_PORT: String(port), KUA_YIPU_AUTH_URL: `http://127.0.0.1:${authServer.address().port}` } });
  const login = await app.firstWindow();
  await app.evaluate(async ({ session }) => {
    const seller = session.fromPartition('persist:kua-yipu-qa-account');
    await seller.cookies.set({ url: 'https://www.alibaba.com/', domain: '.alibaba.com', name: 'xman_us_t', value: 'sign=y&x_lid=qa-account', secure: true });
    seller.protocol.handle('https', (request) => new Response(new URL(request.url).hostname === 'login.alibaba.com'
      ? '<script>location.href="https://www.alibaba.com/"</script>'
      : '<html><body><h1>QA Alibaba Seller Account</h1><p>Authenticated account fixture</p><div>Product administration</div></body></html>', { headers: { 'content-type': 'text/html' } }));
  });
  await login.locator('#username').fill('qa-account');
  await login.locator('#password').fill('not-a-real-password');
  await login.locator('#activationCode').fill(testCode);
  await login.locator('#login').click();
  await login.getByRole('button', { name: '进入系统', exact: true }).waitFor({ timeout: 20000 });
  assert.ok(heartbeats > 0);
  const session = await login.evaluate(() => window.kuaYipu.session());
  assert.equal(session.username, 'qa-account');
  assert.equal(session.token, undefined);
  const mainReady = app.waitForEvent('window', { timeout: 20000 });
  // A slow placeholder must not display a transient startup error.
  await app.evaluate(({ BrowserWindow }) => {
    const original = BrowserWindow.prototype.loadURL;
    globalThis.qaWorkbenchLoads = [];
    BrowserWindow.prototype.loadURL = async function (url, ...args) {
      globalThis.qaWorkbenchLoads.push(url.startsWith('data:') ? 'data' : url);
      if (url.startsWith('data:')) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return original.call(this, url, ...args);
    };
  });
  await login.locator('#login').click();
  const main = await mainReady;
  await main.locator('.sidebar').waitFor({ timeout: 20000 });
  const loads = await app.evaluate(() => globalThis.qaWorkbenchLoads);
  assert.equal(loads.filter(url => url === `http://127.0.0.1:${port}/`).length, 1, 'Startup must load the workbench once');
  assert.equal(await main.evaluate(async () => (await fetch('/api/state')).status), 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(fs.readFileSync(path.join(userData, 'alibaba-cookies.json')).includes('qa-account'), false);
  assert.equal(fs.readFileSync(path.join(userData, 'activation-credentials.bin')).includes(testCode), false);
  unavailable = true;
  await main.evaluate(() => window.kuaYipu.heartbeat());
  assert.equal(main.isClosed(), false);
  assert.equal((await main.evaluate(() => window.kuaYipu.connection())).state, 'retrying');
  assert.equal(await main.evaluate(async () => (await fetch('/api/state')).status), 200);
  await main.locator('.authorization-connection.retrying').waitFor();
  await main.screenshot({ path: path.join(root, 'retrying.png') });
  unavailable = false;
  await main.evaluate(() => window.kuaYipu.heartbeat());
  assert.equal((await main.evaluate(() => window.kuaYipu.connection())).state, 'connected');
  unavailable = true;
  await app.evaluate(() => {
    const monotonic = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { configurable: true, value: () => monotonic() + 65000 });
  });
  await main.evaluate(() => window.kuaYipu.heartbeat());
  assert.equal(main.isClosed(), false);
  assert.equal((await main.evaluate(() => window.kuaYipu.connection())).state, 'paused');
  assert.equal(await main.evaluate(async () => (await fetch('/api/state')).status), 200);
  assert.equal(await main.evaluate(async () => (await fetch('/api/collection-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"blocked"}' })).status), 401);
  await main.locator('.authorization-connection.paused').waitFor();
  assert.ok((await main.locator('.authorization-connection.paused').boundingBox()).y >= 0);
  await main.screenshot({ path: path.join(root, 'paused.png') });
  await main.setViewportSize({ width: 430, height: 932 });
  await main.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  assert.equal(await main.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await main.screenshot({ path: path.join(root, 'paused-mobile.png') });
  await main.setViewportSize({ width: 1440, height: 1000 });
  unavailable = false;
  await main.evaluate(() => window.kuaYipu.heartbeat());
  assert.equal((await main.evaluate(() => window.kuaYipu.connection())).state, 'connected');
  assert.equal(await main.evaluate(async () => (await fetch('/api/collection-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"restored"}' })).status), 201);
  authorized = false;
  await main.evaluate(() => window.kuaYipu.heartbeat()).catch(() => {});
  assert.equal(main.isClosed(), false);
  assert.equal((await main.evaluate(() => window.kuaYipu.connection())).state, 'revoked');
  assert.equal(await main.evaluate(async () => (await fetch('/api/state')).status), 200);
  assert.equal(await main.evaluate(async () => (await fetch('/api/collection-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"revoked"}' })).status), 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  assert.equal(codeLogins, 1);
  // A crashed Playwright Page remains marked crashed. Check recovery through
  // Electron's native webContents and the actual rendered retry button.
  const recovery = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL()));
    if (!window) throw Error('Missing QA workbench');
    const loaded = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Recovery page did not load')), 20000);
      window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    });
    let loading = loaded();
    window.webContents.forcefullyCrashRenderer();
    await loading;
    const message = await window.webContents.executeJavaScript('document.body.textContent');
    loading = loaded();
    await window.webContents.executeJavaScript('document.querySelector("button").click()');
    await loading;
    const firstRecoveryUrl = window.webContents.getURL();
    loading = loaded();
    window.webContents.forcefullyCrashRenderer();
    await loading;
    const secondMessage = await window.webContents.executeJavaScript('document.body.textContent');
    loading = loaded();
    await window.webContents.executeJavaScript('document.querySelector("button").click()');
    await loading;
    return { message, secondMessage, firstRecoveryUrl, url: window.webContents.getURL(), status: await window.webContents.executeJavaScript('fetch("/api/state").then(response => response.status)') };
  });
  assert.match(recovery.message, /工作台暂时未能打开/);
  assert.match(recovery.secondMessage, /工作台暂时未能打开/);
  assert.doesNotMatch(recovery.message + recovery.secondMessage, /data:text|%3C|ERR_ABORTED/);
  assert.equal(recovery.url, `http://127.0.0.1:${port}/`);
  assert.equal(recovery.status, 200);
  assert.match(fs.readFileSync(path.join(userData, '.data', 'runtime-diagnostics.log'), 'utf8'), /renderer-stopped/);
  console.log(JSON.stringify({ ok: true, screenshots: root, verified: ['signed-in-identity', 'heartbeat-before-entry', 'renderer-api-gate', 'encrypted-session-export', 'encrypted-activation-code', 'renderer-crash-visible-and-reloadable', 'temporary-outage-keeps-workbench', 'grace-expiry-preserves-workbench-and-blocks-writes', 'reconnection-without-login', 'revocation-preserves-workbench-and-blocks-writes'] }));
} finally {
  if (app) { try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  authServer.closeAllConnections();
  await new Promise((resolve) => authServer.close(resolve));
}
