import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('local admin preview supports pagination, device policy and announcement lifecycle', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-dev-test-'));
  const child = spawn(process.execPath, ['auth-server/dev.js'], { windowsHide: true, env: { ...process.env, PORT: '0', AUTH_DEV_STATE_FILE: path.join(root, 'state.json'), KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let token = '';
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview did not start')), 10000);
      child.once('error', reject);
      child.stdout.on('data', (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const api = async (route, body, method = 'POST', credential = token) => {
      const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    token = (await api('/api/admin/login', { username: 'test', password: 'local-test-password' })).data.token;
    assert.ok(token);
    assert.equal((await fetch(url + '/admin.js')).status, 200);
    const license = (await api('/api/admin/licenses', { alibabaAccount: 'test-account', days: 1 })).data;
    const a = (await api('/api/client/login', { username: 'test-account', deviceId: 'A' })).data.token;
    const b = (await api('/api/client/login', { username: 'test-account', deviceId: 'B' })).data.token;
    assert.equal((await api('/api/client/heartbeat', {}, 'POST', a)).status, 200);
    assert.equal((await api('/api/client/heartbeat', {}, 'POST', b)).status, 200);
    await api(`/api/admin/licenses/${license.id}`, { action: 'devices', allowMultiDevice: false }, 'PATCH');
    const c = (await api('/api/client/login', { username: 'test-account', deviceId: 'C' })).data.token;
    assert.equal((await api('/api/client/heartbeat', {}, 'POST', a)).status, 403);
    assert.equal((await api('/api/client/heartbeat', {}, 'POST', c)).status, 200);
    const page = (await api('/api/admin/licenses?page=1&pageSize=10&status=active&search=test', null, 'GET')).data;
    assert.equal(page.total, 1); assert.equal(page.items[0].display_status, 'active');
    const draft = (await api('/api/admin/announcements', { title: 'Title', content: 'Body', kind: 'popup', status: 'draft' })).data;
    assert.deepEqual((await api('/api/announcements', null, 'GET')).data, []);
    await api(`/api/admin/announcements/${draft.id}`, { ...draft, status: 'published' }, 'PATCH');
    assert.equal((await api('/api/announcements', null, 'GET')).data[0].revision, 2);
    await api(`/api/admin/announcements/${draft.id}`, { ...draft, status: 'withdrawn' }, 'PATCH');
    assert.deepEqual((await api('/api/announcements', null, 'GET')).data, []);
  } finally { child.kill(); await exited; fs.rmSync(root, { recursive: true, force: true }); }
});
