import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('rejects account impersonation, token forgery, privilege escalation and replay after revocation', { timeout: 40000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-security-test-'));
  const database = process.env.AUTH_TEST_DATABASE_URL;
  if (database && !/^\/auth_qa_[a-z0-9_]+$/.test(new URL(database).pathname)) throw new Error('Security tests require an isolated auth_qa_ database');
  const child = spawn(process.execPath, [database ? 'auth-server/index.js' : 'auth-server/dev.js'], { windowsHide: true,
    env: { ...process.env, PORT: '0', BIND_HOST: '127.0.0.1', ...(database ? { DATABASE_URL: database, PGSSL: 'disable', KUA_YIPU_AUTH_SECRET: 'isolated-security-test-secret-2026' } : {}), AUTH_DEV_STATE_FILE: path.join(root, 'state.json'), KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Security test server did not start')), 10000);
      child.once('error', reject);
      child.stdout.on('data', (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const api = async (route, body, token = '', method = 'POST', extraHeaders = {}) => {
      const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extraHeaders }, ...(body === null ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await api('/api/admin/login', { username: "' OR 1=1 --", password: 'invalid-password' })).status, 401);
    const admin = (await api('/api/admin/login', { username: 'test', password: 'local-test-password' })).data.token;
    assert.ok(admin);
    const license = (await api('/api/admin/licenses', { alibabaAccount: 'security-test-account', days: 2 }, admin)).data;
    assert.equal(license.credential_required, true); assert.ok(license.activationCode); assert.equal(license.credential_hash, undefined);
    const login = { username: license.alibaba_account, deviceId: 'security-A' };
    assert.equal((await api('/api/client/login', login)).status, 403);
    assert.equal((await api('/api/client/login', { ...login, activationCode: 'CDK-' + 'a'.repeat(43) })).status, 403);
    assert.equal((await api('/api/client/login', { ...login, username: "' OR 1=1 --" })).status, 403);
    const session = (await api('/api/client/login', { ...login, activationCode: license.activationCode })).data.token;
    assert.ok(session);
    assert.equal((await api('/api/client/login', { ...login, activationCode: license.activationCode }, '', 'POST', { 'x-forwarded-proto': 'http' })).status, 426);
    assert.equal((await api('/api/client/heartbeat', {}, session)).status, 200);
    assert.equal((await api('/api/admin/licenses', null, session, 'GET')).status, 401);
    assert.equal((await api('/api/client/heartbeat', {}, admin)).status, 401);
    const [claims, signature] = session.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(claims, 'base64url')), admin: true, aud: 'admin' })).toString('base64url') + '.' + signature;
    assert.equal((await api('/api/admin/licenses', null, forged, 'GET')).status, 401);
    assert.equal((await api('/api/client/heartbeat', {}, session + '.extra')).status, 401);
    assert.equal((await api('/api/admin/licenses/' + license.id, { action: 'credential' }, session, 'PATCH')).status, 401);
    for (const revokeSessions of ['false', 0, null]) {
      assert.equal((await api('/api/admin/licenses/' + license.id, { action: 'credential', revokeSessions }, admin, 'PATCH')).status, 400);
      assert.equal((await api('/api/client/heartbeat', {}, session)).status, 200);
    }
    const preserved = (await api('/api/admin/licenses/' + license.id, { action: 'credential', revokeSessions: false }, admin, 'PATCH')).data;
    assert.equal(preserved.sessionsRevoked, false);
    assert.equal(preserved.credential_version, license.credential_version);
    assert.notEqual(preserved.activationCode, license.activationCode);
    assert.equal((await api('/api/client/login', { ...login, activationCode: license.activationCode })).status, 403);
    const secondDevice = (await api('/api/client/login', { ...login, deviceId: 'security-B', activationCode: preserved.activationCode })).data.token;
    assert.ok(secondDevice);
    for (const deviceToken of [session, secondDevice]) {
      const heartbeat = await api('/api/client/heartbeat', {}, deviceToken);
      assert.equal(heartbeat.status, 200);
      assert.equal((await api('/api/client/heartbeat', {}, heartbeat.data.token)).status, 200);
    }
    const preservedAgain = (await api('/api/admin/licenses/' + license.id, { action: 'credential', revokeSessions: false }, admin, 'PATCH')).data;
    assert.equal(preservedAgain.sessionsRevoked, false);
    assert.equal((await api('/api/client/login', { ...login, activationCode: preserved.activationCode })).status, 403);
    assert.equal((await api('/api/client/heartbeat', {}, session)).status, 200);
    assert.equal((await api('/api/client/heartbeat', {}, secondDevice)).status, 200);
    const resetHistory = (await api('/api/admin/licenses/' + license.id + '/history', null, admin, 'GET')).data;
    assert.ok(resetHistory.some((entry) => entry.action === 'credential' && entry.metadata.sessionsRevoked === false));
    assert.equal(JSON.stringify(resetHistory).includes(preservedAgain.activationCode), false);
    const revoked = (await api('/api/admin/licenses/' + license.id, { action: 'credential', revokeSessions: true }, admin, 'PATCH')).data;
    assert.equal(revoked.sessionsRevoked, true);
    for (const deviceToken of [session, secondDevice]) assert.equal((await api('/api/client/heartbeat', {}, deviceToken)).status, 403);
    const beforeDefaultReset = (await api('/api/client/login', { ...login, activationCode: revoked.activationCode })).data.token;
    assert.ok(beforeDefaultReset);
    const rotated = (await api('/api/admin/licenses/' + license.id, { action: 'credential' }, admin, 'PATCH')).data;
    assert.notEqual(rotated.activationCode, license.activationCode); assert.equal(rotated.credential_hash, undefined);
    assert.equal(rotated.sessionsRevoked, true);
    assert.equal((await api('/api/client/heartbeat', {}, beforeDefaultReset)).status, 403);
    assert.equal((await api('/api/client/heartbeat', {}, session)).status, 403);
    assert.equal((await api('/api/client/login', { ...login, activationCode: license.activationCode })).status, 403);
    const next = (await api('/api/client/login', { ...login, activationCode: rotated.activationCode })).data.token;
    assert.ok(next);
    await api('/api/admin/licenses/' + license.id, { action: 'devices', allowMultiDevice: false }, admin, 'PATCH');
    const singleReset = (await api('/api/admin/licenses/' + license.id, { action: 'credential', revokeSessions: false }, admin, 'PATCH')).data;
    assert.equal((await api('/api/client/heartbeat', {}, next)).status, 200);
    const singleReplacement = (await api('/api/client/login', { ...login, deviceId: 'security-C', activationCode: singleReset.activationCode })).data.token;
    assert.ok(singleReplacement);
    assert.equal((await api('/api/client/heartbeat', {}, next)).status, 403);
    assert.equal((await api('/api/client/heartbeat', {}, singleReplacement)).status, 200);
    await api('/api/admin/licenses/' + license.id, { action: 'pause' }, admin, 'PATCH');
    await api('/api/admin/licenses/' + license.id, { action: 'resume' }, admin, 'PATCH');
    assert.equal((await api('/api/client/heartbeat', {}, next)).status, 403);
    assert.equal((await api('/api/client/heartbeat', {}, singleReplacement)).status, 403);
    const listing = (await api('/api/admin/licenses', null, admin, 'GET')).data;
    assert.equal(JSON.stringify(listing).includes('credential_hash'), false);
    assert.equal(JSON.stringify(listing).includes(rotated.activationCode), false);
    const history = (await api('/api/admin/licenses/' + license.id + '/history', null, admin, 'GET')).data;
    assert.equal(JSON.stringify(history).includes(rotated.activationCode), false);
    for (const route of ['/api/admin/licenses', '/api/admin/stats', '/api/admin/announcements']) assert.equal((await api(route, null, '', 'GET')).status, 401);
    for (const route of ['/.env', '/.git/config', '/schema.sql', '/security.js', '/%2e%2e%2f.env']) assert.equal((await fetch(url + route)).status, 404);
    assert.equal((await api('/api/admin/logout', {}, admin)).status, 200);
    assert.equal((await api('/api/admin/licenses', null, admin, 'GET')).status, 401);
    for (let i = 0; i < 61; i++) await api('/api/client/login', login);
    assert.equal((await api('/api/client/login', login)).status, 429);
  } finally { child.kill(); await exited; fs.rmSync(root, { recursive: true, force: true }); }
});
