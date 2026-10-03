import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { registerUpdateRoutes } from '../auth-server/updates.js';
import { compareVersions, signArtifact, verifyArtifact } from '../auth-server/update-protocol.js';
import { Updater } from '../electron/updater.js';
import { launchInstaller } from '../electron/update-install.js';
import { createUpdateGuard } from '../server/update-guard.js';

const keys = crypto.generateKeyPairSync('ed25519');
const payload = Buffer.from('MZ' + 'installer fixture'.repeat(10000));
const artifact = (version = '1.4.53', bytes = payload) => ({ schema: 1, product: 'com.kua-yipu.workbench', platform: 'win32', arch: 'x64', version,
  filename: `chaodekuai-${version}-setup.exe`, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
const envelope = (version = '1.4.53', bytes = payload) => signArtifact(artifact(version, bytes), keys.privateKey);
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaodekuai-update-test-'));
  const app = express(); app.use(express.json());
  const requireAdmin = (req, res, next) => { if (req.headers.authorization !== 'Bearer test') return res.sendStatus(401); req.admin = { username: 'test' }; next(); };
  registerUpdateRoutes(app, { requireAdmin, directory: path.join(directory, 'server'), publicKey: keys.publicKey });
  app.use((error, req, res, next) => res.status(error.status || 400).json({ error: error.message }));
  const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  t.after(async () => { listener.closeAllConnections(); await new Promise((r) => listener.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  async function api(route, body, method = 'POST', raw = false) {
    const response = await fetch(base + '/api/admin/updates' + route, { method,
      headers: { authorization: 'Bearer test', 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      ...(method !== 'GET' ? { body: raw ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function publish(version = '1.4.53') {
    const item = (await api('', { envelope: envelope(version), title: '更新说明', notes: '1. 修复\n2. 新增' })).data;
    await api(`/${item.id}/file?offset=0`, payload, 'PUT', true);
    assert.equal((await api(`/${item.id}/complete`, {})).status, 200);
    assert.equal((await api(`/${item.id}`, { title: '更新说明', notes: '1. 修复\n2. 新增', status: 'published' }, 'PATCH')).status, 200);
    return item;
  }
  const updater = (version = '1.4.52', extra = {}) => new Updater({ directory: path.join(directory, 'client'), version,
    config: { server: base, publicKey: keys.publicKey }, allowLocalTests: true, ...extra });
  return { api, base, directory, publish, updater };
}

test('signed updates reject tampering, wrong products, platform and downgrade ordering', () => {
  assert.equal(verifyArtifact(envelope(), keys.publicKey).version, '1.4.53');
  const changed = { ...envelope(), payload: Buffer.from(JSON.stringify(artifact('9.0.0'))).toString('base64') };
  assert.throws(() => verifyArtifact(changed, keys.publicKey), /签名/);
  for (const change of [{ product: 'other' }, { platform: 'linux' }, { filename: '../bad.exe' }, { size: -1 }]) {
    assert.throws(() => verifyArtifact(signArtifact({ ...artifact(), ...change }, keys.privateKey), keys.publicKey));
  }
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('1.4.53', '1.4.53-beta.1'), 1);
});

test('administrator upload resumes and remains invisible until verified and explicitly published', async (t) => {
  const { api, base } = await fixture(t);
  assert.equal((await fetch(base + '/api/admin/updates')).status, 401);
  const item = (await api('', { envelope: envelope(), title: '功能更新', notes: '修复发布' })).data;
  assert.equal((await fetch(base + '/updates/chaodekuai/latest.json').then((r) => r.json())).release, null);
  assert.equal((await api(`/${item.id}`, { title: 'x', notes: '', status: 'published' }, 'PATCH')).status, 400);
  const split = 23000;
  assert.equal((await api(`/${item.id}/file?offset=0`, payload.subarray(0, split), 'PUT', true)).data.uploaded, split);
  assert.equal((await api('', { envelope: envelope(), title: '功能更新', notes: '' })).data.uploaded, split);
  assert.equal((await api(`/${item.id}/file?offset=0`, payload, 'PUT', true)).status, 409);
  await api(`/${item.id}/file?offset=${split}`, payload.subarray(split), 'PUT', true);
  assert.equal((await api(`/${item.id}/complete`, {})).status, 200);
  assert.equal((await fetch(base + `/updates/chaodekuai/files/${item.id}.exe`)).status, 404);
  await api(`/${item.id}`, { title: '标题', notes: '<script>literal text</script>', status: 'published' }, 'PATCH');
  const latest = await fetch(base + '/updates/chaodekuai/latest.json').then((r) => r.json());
  assert.equal(latest.release.notes, '<script>literal text</script>');
  const range = await fetch(base + latest.release.url, { headers: { Range: 'bytes=100-' } });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), payload.subarray(100));
});

test('invalid uploaded bytes cannot become a published release and can be reuploaded', async (t) => {
  const { api } = await fixture(t);
  const item = (await api('', { envelope: envelope(), title: 'x', notes: '' })).data;
  await api(`/${item.id}/file?offset=0`, Buffer.alloc(payload.length), 'PUT', true);
  assert.equal((await api(`/${item.id}/complete`, {})).status, 400);
  assert.equal((await api('', { envelope: envelope(), title: 'x', notes: '' })).data.uploaded, 0);
  assert.equal((await api(`/${item.id}`, { title: 'x', notes: '', status: 'published' }, 'PATCH')).status, 400);
});

test('administrators can download verified drafts and withdrawn packages without exposing them publicly', async (t) => {
  const { api, base } = await fixture(t);
  const item = (await api('/', { envelope: envelope(), title: '草稿标题', notes: '初始说明' })).data;
  const url = `${base}/api/admin/updates/${item.id}/file`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer test' } })).status, 409);
  await api(`/${item.id}/file?offset=0`, payload, 'PUT', true);
  await api(`/${item.id}/complete`, {});
  const download = await fetch(url, { headers: { authorization: 'Bearer test', Range: 'bytes=10-99' } });
  assert.equal(download.status, 206);
  assert.match(download.headers.get('content-disposition'), /chaodekuai-1.4.53-setup.exe/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload.subarray(10, 100));
  assert.equal((await fetch(`${base}/updates/chaodekuai/files/${item.id}.exe`)).status, 404);
  const resumed = await api('/', { envelope: envelope(), title: '更新标题', notes: '续传时更新说明' });
  assert.equal(resumed.data.notes, '续传时更新说明');
  await api(`/${item.id}`, { title: '更新标题', notes: '说明', status: 'withdrawn' }, 'PATCH');
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer test' } })).status, 200);
  assert.equal((await fetch(`${base}/updates/chaodekuai/files/${item.id}.exe`)).status, 404);
});

test('older published descriptions remain editable without republishing a withdrawn old release', async (t) => {
  const { publish, api } = await fixture(t);
  const older = await publish('1.4.53');
  await publish('1.4.54');
  const edited = await api(`/${older.id}`, { title: '修正旧版说明', notes: '保留新版分发', status: 'published' }, 'PATCH');
  assert.equal(edited.status, 200);
  assert.equal(edited.data.notes, '保留新版分发');
  assert.equal((await api('/', { envelope: envelope('1.4.53'), title: '重复上传', notes: '' })).status, 409);
  await api(`/${older.id}`, { title: '停止分发', notes: '', status: 'withdrawn' }, 'PATCH');
  assert.equal((await api(`/${older.id}`, { title: '重新发布', notes: '', status: 'published' }, 'PATCH')).status, 400);
});

test('client preserves partial download across exit, resumes by Range, and verifies bytes again before install', async (t) => {
  const { updater, publish, directory } = await fixture(t); await publish();
  const first = updater(); await first.check();
  const partial = first.file() + '.part'; fs.writeFileSync(partial, payload.subarray(0, 12345)); first.close();
  const calls = [];
  const next = updater('1.4.52', { fetchImpl: (url, options) => { calls.push(options.headers?.Range); return fetch(url, options); } });
  assert.equal((await next.check()).status, 'available');
  assert.equal((await next.download()).status, 'ready'); assert.ok(calls.includes('bytes=12345-'));
  assert.equal(await next.prepare(), next.file());
  fs.writeFileSync(next.file(), 'tampered');
  await assert.rejects(next.prepare(), /安装文件已变化/);
  assert.equal((await next.download()).status, 'ready');
  fs.writeFileSync(path.join(directory, 'client', 'customer-data.txt'), 'preserved'); next.close();
  const upgraded = updater('1.4.53');
  assert.equal((await upgraded.check()).status, 'current');
  assert.equal(fs.readFileSync(path.join(directory, 'client', 'customer-data.txt'), 'utf8'), 'preserved'); upgraded.close();
});

test('cancel during streaming keeps partial data and the next instance resumes instead of reinstalling blindly', async (t) => {
  const { updater, publish } = await fixture(t); await publish();
  let first;
  first = updater('1.4.52', { onChange: (state) => { if (state.status === 'downloading' && state.downloaded > 0) first.cancel(); } });
  await first.check();
  assert.equal((await first.download()).status, 'available');
  assert.ok(fs.existsSync(first.file() + '.part')); first.close();
  const second = updater(); await second.check(); assert.equal((await second.download()).status, 'ready'); second.close();
});

test('withdrawal blocks already downloaded installers and previous versions cannot be republished', async (t) => {
  const { updater, publish, api, base } = await fixture(t); const item = await publish();
  const client = updater(); await client.check(); await client.download();
  await api(`/${item.id}`, { title: '撤回', notes: '', status: 'withdrawn' }, 'PATCH');
  await assert.rejects(client.prepare(), /停止分发/);
  assert.equal((await fetch(base + `/updates/chaodekuai/files/${item.id}.exe`)).status, 404);
  await publish('1.4.54');
  assert.equal((await api(`/${item.id}`, { title: '旧版', notes: '', status: 'published' }, 'PATCH')).status, 400); client.close();
});

test('unreachable update service reports retryable error instead of claiming current version', async (t) => {
  const { updater } = await fixture(t);
  const client = updater('1.4.52', { fetchImpl: async () => { throw new Error('fetch failed'); } });
  const state = await client.check(); assert.equal(state.status, 'error'); assert.match(state.error, /无法连接/); client.close();
});

test('update guard refuses active jobs and pending writes, then freezes new writes until cancelled', () => {
  let working = true; const guard = createUpdateGuard(() => working);
  assert.throws(() => guard.acquire(), /任务/); working = false;
  const response = new EventEmitter();
  guard.middleware({ method: 'POST' }, response, () => {});
  assert.throws(() => guard.acquire(), /保存/); response.emit('finish'); response.emit('close');
  assert.equal(guard.acquire(), true);
  let status;
  guard.middleware({ method: 'POST' }, { status(code) { status = code; return this; }, json() {} }, () => assert.fail());
  assert.equal(status, 409); guard.release(); assert.equal(guard.acquire(), true);
});

test('installer handoff confirms readiness before quitting and fails without closing the app', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaodekuai-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = new EventEmitter(); child.unref = () => {}; child.kill = () => {};
  await launchInstaller({ file: 'fixture.exe', directory: dir, target: 'C:\\Program Files\\抄得快', spawnImpl: (file, args, options) => {
    assert.equal(options.windowsHide, true); assert.equal(args.at(-1), '/D=C:\\Program Files\\抄得快');
    fs.writeFileSync(args.find((arg) => arg.startsWith('/update-ready=')).slice(14), 'ready'); return child;
  } });
  await assert.rejects(launchInstaller({ file: 'fixture.exe', directory: dir, target: 'x', timeout: 5, spawnImpl: () => child }), /超时/);
});
