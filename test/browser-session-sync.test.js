import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncAlibabaCookies } from '../server/browser-runtime.js';

test('preserves verification completed in the collector while importing changed desktop login cookies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-test-'));
  const previous = process.env.KUA_YIPU_ALIBABA_COOKIES_FILE;
  const file = path.join(root, 'cookies.json');
  process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = file;
  const values = new Map();
  let imports = 0;
  let scripts = 0;
  const context = { addCookies: async (cookies) => { imports++; for (const cookie of cookies) values.set(cookie.name, cookie.value); }, addInitScript: async () => { scripts++; } };
  const save = (login) => fs.writeFileSync(file, JSON.stringify([
    { name: 'qa-login', value: login, domain: '.alibaba.com', path: '/' },
    { name: 'qa-verification', value: 'initial', domain: '.alibaba.com', path: '/' },
  ]));
  try {
    save('first');
    fs.writeFileSync(path.join(root, 'alibaba-storage.json'), JSON.stringify({ 'https://www.alibaba.com': { language: 'en' } }));
    await syncAlibabaCookies(context);
    values.set('qa-verification', 'user-completed');
    save('first');
    await syncAlibabaCookies(context);
    assert.equal(values.get('qa-verification'), 'user-completed');
    assert.equal(imports, 1);
    assert.equal(scripts, 1);
    save('new-login');
    await syncAlibabaCookies(context);
    assert.equal(values.get('qa-login'), 'new-login');
    assert.equal(values.get('qa-verification'), 'user-completed');
    assert.equal(imports, 2);
    assert.equal(scripts, 1);
    values.set('qa-login', 'expired-in-publisher');
    await syncAlibabaCookies(context, { force: true });
    assert.equal(values.get('qa-login'), 'new-login', 'A login redirect must allow reimporting the desktop session');
    values.set('qa-verification', 'verified-after-login');
    await syncAlibabaCookies(context);
    assert.equal(values.get('qa-verification'), 'verified-after-login');
    assert.equal(imports, 3);
  } finally {
    if (previous == null) delete process.env.KUA_YIPU_ALIBABA_COOKIES_FILE;
    else process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
