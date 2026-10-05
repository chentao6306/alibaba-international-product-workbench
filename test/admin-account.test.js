import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { hashAdminPassword, verifyAdminPassword, accountChangeInput } from '../auth-server/admin-account.js';
import { tokenCodec } from '../auth-server/security.js';

test('administrator password hashing and change input reject invalid credentials', async () => {
  const hash = await hashAdminPassword(' test-password-123 ');
  assert.equal(await verifyAdminPassword(' test-password-123 ', hash), true);
  assert.equal(await verifyAdminPassword('test-password-123', hash), false);
  assert.equal(await verifyAdminPassword(' test-password-123 ', hash.replace('scrypt$', 'unknown$')), false);
  for (const body of [null, {}, { username: '../other', currentPassword: 'x' }, { username: 'abc', currentPassword: 'x', newPassword: 'short', confirmPassword: 'short' }, { username: 'abc', currentPassword: 'x', newPassword: 'a-long-password', confirmPassword: 'different' }]) {
    assert.throws(() => accountChangeInput(body), { status: 400 });
  }
});

test('administrators can change their own credentials, revoke all old sessions and retain changes after restart', { timeout: 40000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-account-test-'));
  const database = process.env.AUTH_TEST_DATABASE_URL;
  if (database && !/^\/auth_qa_[a-z0-9_]+$/.test(new URL(database).pathname)) throw new Error('Only an isolated auth_qa_ database can be tested');
  const secret = 'isolated-admin-account-test-secret-2026';
  const password = 'old-test-password-123';
  const newPassword = 'new-test-password-456';
  const oldUsername = `account-test-${crypto.randomBytes(5).toString('hex')}`;
  const newUsername = `${oldUsername}-new`;
  const stateFile = path.join(root, 'state.json');
  const pool = database ? new pg.Pool({ connectionString: database, ssl: false }) : null;
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  let child; let exited; let url; let token;
  async function start() {
    child = spawn(process.execPath, [database ? 'auth-server/index.js' : 'auth-server/dev.js'], { windowsHide: true, env: { ...process.env, PORT: '0', BIND_HOST: '127.0.0.1', KUA_YIPU_ADMIN_PATH: '/isolated-entry-qa', KUA_YIPU_AUTH_SECRET: secret, AUTH_DEV_STATE_FILE: stateFile, KUA_YIPU_UPDATE_DIR: path.join(root, 'updates'), KUA_YIPU_ADMIN_USERNAME: oldUsername, KUA_YIPU_ADMIN_PASSWORD: password, ...(database ? { DATABASE_URL: database, PGSSL: 'disable' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Auth service startup timeout')), 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
  }
  async function stop() { if (child?.exitCode === null) child.kill(); if (exited) await exited; }
  async function api(route, body, method = 'POST', credential = token) {
    const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential || ''}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const login = (username, value) => api('/api/admin/login', { username, password: value });
  const change = (body, credential = token) => api('/api/admin/account', body, 'PATCH', credential);
  try {
    if (pool) {
      for (let i = 0; i < ids.length; i++) await pool.query('INSERT INTO admin_users (id,username,password_hash) VALUES ($1,$2,$3)', [ids[i], i ? `${oldUsername}-occupied` : oldUsername, await hashAdminPassword(password)]);
    }
    await start();
    const home = await fetch(url + '/', { redirect: 'manual' });
    assert.equal(home.status, 302); assert.equal(home.headers.get('location'), '/website/');
    const canonical = await fetch(url + '/isolated-entry-qa', { redirect: 'manual' });
    assert.equal(canonical.status, 308);
    const page = await fetch(url + '/isolated-entry-qa/');
    assert.equal(page.status, 200); assert.match(page.headers.get('x-robots-tag'), /noindex/);
    assert.match(await page.text(), /src="\.\/admin.js"/);
    for (const asset of ['admin.js', 'admin.css', 'admin-updates.js']) assert.equal((await fetch(url + '/isolated-entry-qa/' + asset)).status, 200);
    for (const route of ['/admin', '/admin/', '/admin.html', '/admin.js', '/admin.css', '/admin-updates.js', '/isolated-entry-qa/index.js', '/isolated-entry-qa/.env']) assert.equal((await fetch(url + route)).status, 404);
    assert.equal((await api('/api/admin/account', null, 'GET', '')).status, 401);
    const clientToken = tokenCodec(secret).sign({ aud: 'client', account: 'client', exp: Date.now() + 60000 });
    assert.equal((await change({ username: newUsername, currentPassword: password }, clientToken)).status, 401);
    token = (await login(oldUsername, password)).data.token; assert.ok(token);
    const secondToken = (await login(oldUsername, password)).data.token;
    assert.deepEqual((await api('/api/admin/account', null, 'GET')).data, { username: oldUsername });
    assert.equal((await change({ username: newUsername, currentPassword: 'wrong-password' })).status, 403);
    assert.equal((await change({ username: oldUsername, currentPassword: password })).status, 400);
    assert.equal((await change({ username: newUsername, currentPassword: password, newPassword, confirmPassword: 'wrong-confirmation' })).status, 400);
    if (pool) assert.equal((await change({ username: `${oldUsername}-occupied`, currentPassword: password })).status, 409);
    assert.equal((await change({ username: newUsername, currentPassword: password, newPassword, confirmPassword: newPassword, adminId: ids[1] })).status, 200);
    for (const oldToken of [token, secondToken]) assert.equal((await api('/api/admin/account', null, 'GET', oldToken)).status, 401);
    assert.equal((await login(oldUsername, password)).status, 401);
    assert.equal((await login(newUsername, password)).status, 401);
    token = (await login(newUsername, newPassword)).data.token; assert.ok(token);
    if (pool) {
      assert.equal((await pool.query('SELECT username FROM admin_users WHERE id=$1', [ids[1]])).rows[0].username, `${oldUsername}-occupied`);
    } else {
      const stored = fs.readFileSync(stateFile, 'utf8');
      assert.equal(stored.includes(newPassword), false); assert.match(JSON.parse(stored).adminAccount.password_hash, /^scrypt\$/);
    }
    // Username-only changes preserve the password but still revoke sessions.
    assert.equal((await change({ username: newUsername + '-renamed', currentPassword: newPassword })).status, 200);
    assert.equal((await api('/api/admin/account', null, 'GET')).status, 401);
    token = (await login(newUsername + '-renamed', newPassword)).data.token; assert.ok(token);
    assert.equal((await change({ username: newUsername + '-renamed', currentPassword: newPassword, newPassword: 'final-password-789', confirmPassword: 'final-password-789' })).status, 200);
    await stop(); await start();
    assert.equal((await login(newUsername + '-renamed', newPassword)).status, 401);
    token = (await login(newUsername + '-renamed', 'final-password-789')).data.token; assert.ok(token);
  } finally {
    await stop();
    if (pool) { await pool.query('DELETE FROM admin_users WHERE id=ANY($1::uuid[])', [ids]); await pool.end(); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
