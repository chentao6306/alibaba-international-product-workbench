import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { navigateSourceWindow } from '../electron/source-navigation.js';

const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'source-window-qa-')));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  const failures = [];
  session.defaultSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.pathname.includes('slow-image')) return new Promise(() => {});
    if (url.pathname.includes('first')) return new Response('<img src="https://www.alibaba.com/slow-image"><script>setTimeout(()=>location.replace("https://www.alibaba.com/product-detail/final_123.html"),30)</script>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname.includes('fail')) return Response.error();
    return new Response('<h1>QA source product detail</h1>', { headers: { 'content-type': 'text/html' } });
  });
  const window = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('did-fail-load', (_event, code) => failures.push(code));
  const load = window.loadURL.bind(window);
  window.loadURL = async (...args) => {
    try { return await load(...args); }
    catch (error) { if (/ERR_ABORTED/.test(error.message)) failures.push(-3); throw error; }
  };
  try {
    const opened = await navigateSourceWindow(window, 'https://www.alibaba.com/product-detail/first_123.html', { timeoutMs: 10000 });
    assert.equal(opened.visible, true);
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("h1")?.textContent'), 'QA source product detail');
    assert.match(window.webContents.getURL(), /final_123/);
    assert.ok(failures.includes(-3), 'Actual redirect must reproduce Electron ERR_ABORTED');
    await assert.rejects(navigateSourceWindow(window, 'https://www.alibaba.com/product-detail/fail_123.html', { timeoutMs: 10000 }), /加载失败/);
    assert.equal(window.isVisible(), true);
    const result = { ok: true, reproducedAborted: true, verified: ['immediate-visible-window', 'redirect-recovery', 'real-failure-preserved'], output };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { window.destroy(); }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
