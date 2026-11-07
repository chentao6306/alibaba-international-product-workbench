import { app, BrowserWindow, session, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAccountCookies } from '../electron/seller-session.js';
import { readPrivateSession } from '../server/private-session-storage.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seller-session-qa-'));
app.setPath('userData', root);
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Session QA timed out'); app.exit(1); }, 30000);
async function main() {
  await app.whenReady();
  globalThis.__KUA_YIPU_SECURE_STORAGE = {
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  };
  const account = 'session-qa';
  const partition = `persist:kua-yipu-${account}`;
  const window = new BrowserWindow({ show: false, webPreferences: { partition } });
  await window.webContents.session.cookies.set({ url: 'https://www.alibaba.com', name: 'fixture', value: 'fresh-login' });
  await window.webContents.session.cookies.flushStore();
  window.destroy();
  assert.equal(window.isDestroyed(), true);
  const file = path.join(root, 'cookies.json');
  assert.equal(await saveAccountCookies('', session, file), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await saveAccountCookies(account, session, file), true);
  assert.equal(readPrivateSession(file).find((cookie) => cookie.name === 'fixture').value, 'fresh-login');
  assert.equal(await saveAccountCookies('different-account', session, file), true);
  assert.equal(readPrivateSession(file).some((cookie) => cookie.name === 'fixture'), false);
  console.log(JSON.stringify({ ok: true, closedWindowSession: true, accountIsolation: true }));
  clearTimeout(watchdog);
  app.exit(0);
}
main().catch((error) => { console.error(error); app.exit(1); });
