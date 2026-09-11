import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AuthorizationLease } from '../electron/auth-lease.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { SecureSettings } from '../server/secure-settings.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { fixedWindowLimiter } from '../auth-server/http-security.js';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillChoice } from '../server/publisher.js';
import { authorizationEndpoint } from '../server/auth-endpoint.js';
import { tokenCodec, clientSessionAllowed } from '../auth-server/security.js';

test('authorization transport rejects HTTP and credential-bearing or redirected endpoints', () => {
  assert.equal(authorizationEndpoint(), 'https://106.55.45.126:80');
  for (const url of ['http://106.55.45.126', 'https://user:secret@106.55.45.126', 'https://106.55.45.126/path', 'https://106.55.45.126?url=http://other', 'file:///local']) assert.throws(() => authorizationEndpoint(url));
  assert.throws(() => authorizationEndpoint('http://127.0.0.1:8790'));
  assert.equal(authorizationEndpoint('http://127.0.0.1:8790', { development: true }), 'http://127.0.0.1:8790');
});

test('signed tokens reject tampering, expired timestamps, type confusion and revoked credential versions', () => {
  const codec = tokenCodec('test-only-signing-secret-at-least-32-characters');
  const valid = { aud: 'client', deviceId: 'device', credentialVersion: 1, credentialVerified: true, exp: Date.now() + 10000 };
  const token = codec.sign(valid);
  assert.deepEqual(codec.verify(token), valid);
  assert.equal(codec.verify(token + '.extra'), null);
  assert.equal(codec.verify(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')), null);
  assert.equal(codec.verify(codec.sign({ exp: '999999999999999' })), null);
  assert.equal(codec.verify(codec.sign({ exp: 0 })), null);
  const license = { credential_required: true, credential_version: 1 };
  assert.equal(clientSessionAllowed(license, valid), true);
  for (const auth of [{ ...valid, credentialVersion: 0 }, { ...valid, aud: 'admin' }, { ...valid, admin: true }, { ...valid, credentialVerified: false }]) assert.equal(clientSessionAllowed(license, auth), false);
});

test('login requires a signed-in Alibaba session for the licensed account on the real domain', () => {
  const cookies = [{ domain: '.alibaba.com', name: 'xman_us_t', value: 'sign=y&x_lid=licensed-user' }];
  assert.equal(matchesAlibabaSession(cookies, 'licensed-user', 'https://www.alibaba.com/'), true);
  assert.equal(matchesAlibabaSession(cookies, 'other-user', 'https://www.alibaba.com/'), false);
  assert.equal(matchesAlibabaSession([], 'licensed-user', 'https://www.alibaba.com/'), false);
  assert.equal(matchesAlibabaSession(cookies, 'licensed-user', 'https://evilalibaba.com/'), false);
  assert.equal(matchesAlibabaSession(cookies, 'licensed-user', 'https://login.alibaba.com/'), false);
  assert.equal(matchesAlibabaSession([{ ...cookies[0], value: 'sign=n&x_lid=licensed-user' }], 'licensed-user', 'https://www.alibaba.com/'), false);
});

test('authorization expires on monotonic elapsed time regardless of client clock rollback', () => {
  let elapsed = 100;
  const lease = new AuthorizationLease({ now: () => elapsed });
  const response = { authorized: true, serverTime: '2026-09-21T00:00:00Z', expiresAt: '2026-09-22T00:00:00Z' };
  lease.renew(response); assert.equal(lease.valid(), true);
  const originalDate = Date.now;
  try { Date.now = () => 0; elapsed += 70001; assert.equal(lease.valid(), false); }
  finally { Date.now = originalDate; }
  elapsed = 100;
  lease.renew({ ...response, expiresAt: '2026-09-21T00:00:03Z' });
  elapsed += 3001; assert.equal(lease.valid(), false);
  assert.throws(() => lease.renew({ ...response, serverTime: null }));
  assert.throws(() => lease.renew({ ...response, authorized: false }));
  assert.equal(lease.valid(), false);
});

test('stores integration secrets encrypted and fails closed without the platform encryption provider', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-settings-'));
  const key = crypto.randomBytes(32); const iv = crypto.randomBytes(12);
  const provider = {
    encrypt: (text) => { const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([cipher.getAuthTag(), data]); },
    decrypt: (data) => { const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(data.subarray(0, 16)); return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString(); },
  };
  try {
    const first = new SecureSettings(directory, provider); first.saveKey('sk-test-private');
    assert.equal(fs.readFileSync(first.file).includes('sk-test-private'), false);
    assert.equal(new SecureSettings(directory, provider).key(), 'sk-test-private');
    const sessionFile = path.join(directory, 'session.json');
    const session = [{ name: 'test-session', value: 'private-session-fixture' }];
    fs.writeFileSync(sessionFile, JSON.stringify(session));
    assert.deepEqual(readPrivateSession(sessionFile), session);
    writePrivateSession(sessionFile, session, provider);
    assert.equal(fs.readFileSync(sessionFile).includes('private-session-fixture'), false);
    assert.deepEqual(readPrivateSession(sessionFile, provider), session);
    assert.throws(() => readPrivateSession(sessionFile, null), /桌面客户端/);
    assert.throws(() => writePrivateSession(sessionFile, session, null), /安全保存/);
    assert.throws(() => new SecureSettings(directory, null).read(), /桌面客户端/);
    first.saveKey(''); assert.equal(first.configured(), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('limits repeated login requests per address and recovers after the window', () => {
  let now = 0; let allowed = 0; let blocked = 0;
  const limiter = fixedWindowLimiter({ limit: 2, windowMs: 1000, now: () => now });
  const response = { setHeader: () => {}, status: (code) => { assert.equal(code, 429); blocked++; return { json: () => {} }; } };
  for (let i = 0; i < 3; i++) limiter({ ip: 'client-a' }, response, () => allowed++);
  limiter({ ip: 'client-b' }, response, () => allowed++);
  assert.equal(allowed, 3); assert.equal(blocked, 1);
  now = 1001; limiter({ ip: 'client-a' }, response, () => allowed++); assert.equal(allowed, 4);
});

test('a disappearing category dropdown does not abort a product or wait for the default locator timeout', async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.setContent('<div id="struct-p-191284141"><input role="combobox" onclick="this.remove()"></div>');
    const start = performance.now();
    assert.equal(await fillChoice(page, page.locator('#struct-p-191284141 input'), '6.8 inch'), false);
    assert.ok(performance.now() - start < 3000);
  } finally { await browser.close(); }
});
