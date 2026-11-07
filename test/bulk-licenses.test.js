import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bulkLicenseInput, eligibleBulkLicenses, bulkLicenseChange } from '../auth-server/bulk-licenses.js';

test('bulk day adjustments exclude every non-active state and reject invalid day values', () => {
  const now = Date.now(), future = new Date(now + 86400000).toISOString();
  const rows = [{ status: 'active', expires_at: future }, { status: 'active', expires_at: new Date(now).toISOString() },
    { status: 'paused', expires_at: future }, { status: 'revoked', expires_at: future }, { status: 'active', expires_at: future, deleted_at: future }];
  assert.equal(eligibleBulkLicenses(rows, now).length, 1);
  for (const days of [0, -1, 1.5, Infinity, 36501, '', null]) assert.throws(() => bulkLicenseInput({ action: 'extend', days }));
  assert.throws(() => bulkLicenseInput({ action: 'resume' }));
  assert.equal(new Date(bulkLicenseChange(rows[0], { action: 'reduce', days: 2 }, now).expires_at).getTime(), now - 86400000);
  for (const row of rows.slice(1)) assert.throws(() => bulkLicenseChange(row, { action: 'extend', days: 10 }, now));
});

test('bulk authorization applies across pages, detects stale previews and never double-applies a retry', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-bulk-'));
  const database = process.env.AUTH_TEST_DATABASE_URL;
  if (database && !/^\/auth_qa_[a-z0-9_]+$/.test(new URL(database).pathname)) throw new Error('Bulk tests require an isolated auth_qa_ database');
  const child = spawn(process.execPath, [database ? 'auth-server/index.js' : 'auth-server/dev.js'], { windowsHide: true,
    env: { ...process.env, PORT: '0', BIND_HOST: '127.0.0.1', AUTH_DEV_STATE_FILE: path.join(root, 'state.json'),
      ...(database ? { DATABASE_URL: database, PGSSL: 'disable', KUA_YIPU_AUTH_SECRET: 'isolated-auth-test-signing-secret-2026' } : {}),
      KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Auth test did not start')), 10000);
      child.once('error', reject);
      child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    let token = '';
    const api = async (route, body, method = 'POST', auth = token) => {
      const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const create = async account => (await api('/api/admin/licenses', { alibabaAccount: account, days: 10 })).data;
    const change = (id, body) => api(`/api/admin/licenses/${id}`, body, 'PATCH');
    const rows = async () => (await api('/api/admin/licenses?status=active,expired,paused,revoked,deleted&pageSize=100', null, 'GET')).data.items;
    const snapshot = values => values.map(({ id, status, expires_at, deleted_at, updated_at }) => ({ id, status, expires_at, deleted_at, updated_at })).sort((a, b) => a.id.localeCompare(b.id));
    token = (await api('/api/admin/login', { username: 'test', password: 'local-test-password' })).data.token;
    assert.ok(token);
    const active = [];
    for (let i = 0; i < 25; i++) active.push(await create(`bulk-active-${i}`));
    const client = (await api('/api/client/login', { username: active[1].alibaba_account, activationCode: active[1].activationCode, deviceId: 'bulk-device' })).data.token;
    assert.ok(client);
    const excludedIds = [];
    for (const state of ['expired', 'paused', 'revoked', 'deleted']) {
      const row = await create(`bulk-${state}`); excludedIds.push(row.id);
      if (state === 'deleted') await api(`/api/admin/licenses/${row.id}`, null, 'DELETE');
      else await change(row.id, { action: state === 'expired' ? 'reduce' : state === 'paused' ? 'pause' : 'revoke', days: 20 });
    }
    const excluded = snapshot((await rows()).filter(row => excludedIds.includes(row.id)));
    assert.equal(excluded.length, 4);
    assert.equal((await api('/api/admin/licenses/bulk-preview', { action: 'extend', days: 2 }, 'POST', '')).status, 401);
    assert.equal((await api('/api/admin/licenses/bulk', { token: 'invalid' }, 'POST', client)).status, 401);
    const preview = (await api('/api/admin/licenses/bulk-preview', { action: 'extend', days: 2 })).data;
    assert.equal(preview.count, 25);
    const results = await Promise.all([api('/api/admin/licenses/bulk', { token: preview.token }), api('/api/admin/licenses/bulk', { token: preview.token })]);
    assert.ok(results.every(result => result.status === 200 && result.data.changed === 25));
    assert.equal(results.filter(result => result.data.replayed).length, 1);
    let saved = await rows();
    assert.deepEqual(snapshot(saved.filter(row => excludedIds.includes(row.id))), excluded);
    for (const row of active) assert.equal(new Date(saved.find(item => item.id === row.id).expires_at) - new Date(row.expires_at), 2 * 86400000);
    const events = (await api(`/api/admin/licenses/${active[0].id}/history`, null, 'GET')).data;
    assert.equal(events.filter(event => event.action === 'bulk-extend').length, 1);
    assert.equal((await api('/api/client/heartbeat', {}, 'POST', client)).status, 200);
    const stale = (await api('/api/admin/licenses/bulk-preview', { action: 'reduce', days: 1 })).data;
    await change(active[0].id, { action: 'pause' });
    saved = snapshot(await rows());
    assert.equal((await api('/api/admin/licenses/bulk', { token: stale.token })).status, 409);
    assert.deepEqual(snapshot(await rows()), saved);
    const reduce = (await api('/api/admin/licenses/bulk-preview', { action: 'reduce', days: 20 })).data;
    assert.equal(reduce.count, 24); assert.equal(reduce.willExpire, 24);
    assert.equal((await api('/api/admin/licenses/bulk', { token: reduce.token })).data.changed, 24);
    assert.equal((await api('/api/client/heartbeat', {}, 'POST', client)).status, 403);
    assert.equal((await api('/api/admin/licenses/bulk-preview', { action: 'pause' })).data.count, 0);
    const extra = await create('bulk-pause-target');
    const loginBody = { username: extra.alibaba_account, activationCode: extra.activationCode, deviceId: 'pause-device' };
    const session = (await api('/api/client/login', loginBody)).data.token;
    assert.ok(session);
    const pause = (await api('/api/admin/licenses/bulk-preview', { action: 'pause' })).data;
    assert.equal(pause.count, 1);
    assert.equal((await api('/api/admin/licenses/bulk', { token: pause.token })).data.changed, 1);
    assert.equal((await api('/api/client/heartbeat', {}, 'POST', session)).status, 403);
    assert.equal((await api('/api/client/login', loginBody)).status, 403);
    assert.equal((await rows()).find(row => row.id === extra.id).status, 'paused');
    assert.deepEqual(snapshot((await rows()).filter(row => excludedIds.includes(row.id))), excluded);
    assert.equal((await api('/api/admin/licenses/bulk', { token: preview.token + 'bad' })).status, 409);
  } finally { child.kill(); await exited; fs.rmSync(root, { recursive: true, force: true }); }
});
