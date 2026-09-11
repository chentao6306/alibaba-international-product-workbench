import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientAllowed, licenseState, pagination, announcementInput, licenseFilters, matchesLicenseFilters } from './policy.js';
import { configureHttpSecurity } from './http-security.js';
import { createActivationCredential, validActivation, publicLicense, clientSessionAllowed, clientClaims, tokenCodec, requireCredentialTransport } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const stateFile = process.env.AUTH_DEV_STATE_FILE || path.join(rootDir, '.data', 'auth-dev.json');
const port = Number(process.env.PORT || 8790);
const adminUsername = String(process.env.KUA_YIPU_ADMIN_USERNAME || 'admin');
const adminPassword = String(process.env.KUA_YIPU_ADMIN_PASSWORD || 'KuaYipu-Admin-2026');
const signingSecret = String(process.env.KUA_YIPU_AUTH_SECRET || 'kua-yipu-local-development-secret-2026');
const app = express();
configureHttpSecurity(app);
app.use(express.json({ limit: '128kb' }));
app.use('/api/admin', (request, _response, next) => { requireCredentialTransport(request, { credential_required: true }); next(); });

function readState() {
  try { return { announcements: [], ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; }
  catch { return { licenses: [], events: [], logins: [], announcements: [] }; }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, stateFile);
}

const { sign, verify } = tokenCodec(signingSecret);
const adminSessions = new Map();
const session = (license, deviceId) => ({ authorized: true, serverTime: new Date().toISOString(), expiresAt: license.expires_at, token: sign(clientClaims(license, deviceId)) });

const bearer = (request) => verify(request.headers.authorization?.replace(/^Bearer\s+/i, ''));
const requireAdmin = (request, response, next) => {
  const auth = bearer(request);
  if (!auth?.admin || auth.aud !== 'admin' || adminSessions.get(auth.sid) !== auth.exp) return response.status(401).json({ error: '管理员登录已失效' });
  request.admin = auth;
  next();
};
const timestamp = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const addEvent = (state, licenseId, action, actor, metadata = {}) => state.events.unshift({ id: newId(), license_id: licenseId, action, actor, metadata, created_at: timestamp() });

app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'admin.html')));
for (const file of ['admin.js', 'admin.css']) app.get(`/${file}`, (_request, response) => response.sendFile(path.join(__dirname, file)));
app.get('/health', (_request, response) => response.json({ ok: true, service: 'kua-yipu-auth-dev' }));
app.post('/api/admin/login', (request, response) => {
  if (request.body?.username !== adminUsername || request.body?.password !== adminPassword) return response.status(401).json({ error: '管理员账号或密码错误' });
  const sid = newId(); const exp = Date.now() + 8 * 60 * 60 * 1000;
  for (const [key, expiry] of adminSessions) if (expiry <= Date.now()) adminSessions.delete(key);
  adminSessions.set(sid, exp);
  response.json({ username: adminUsername, token: sign({ aud: 'admin', admin: true, username: adminUsername, sid, exp }) });
});
app.post('/api/admin/logout', requireAdmin, (request, response) => { adminSessions.delete(request.admin.sid); response.json({ ok: true }); });

app.post('/api/client/login', (request, response) => {
  const account = String(request.body?.username || '').trim();
  const deviceId = String(request.body?.deviceId || '').trim();
  if (!account || !deviceId || account.length > 200 || deviceId.length > 200) return response.status(400).json({ error: '账号或设备标识无效' });
  const state = readState();
  const license = state.licenses.find((item) => item.alibaba_account === account && !item.deleted_at);
  if (!license || licenseState(license) !== 'active') return response.status(403).json({ authorized: false, reason: '该 Alibaba 账号没有有效的软件授权' });
  requireCredentialTransport(request, license);
  if (!validActivation(license, request.body?.activationCode)) return response.status(403).json({ authorized: false, reason: '软件授权码无效，请使用新版客户端并填写管理员提供的授权码' });
  if (license.allow_multi_device === false) license.active_device_id = deviceId;
  let login = state.logins.find((item) => item.alibaba_account === account && item.device_id === deviceId);
  if (!login) { login = { id: newId(), alibaba_account: account, device_id: deviceId, created_at: timestamp() }; state.logins.push(login); }
  Object.assign(login, { device_name: String(request.body?.deviceName || ''), app_version: String(request.body?.appVersion || ''), ip_address: request.ip, last_seen_at: timestamp() });
  addEvent(state, license.id, 'client-login', account, { deviceId });
  writeState(state);
  response.json(session(license, deviceId));
});

app.post('/api/client/heartbeat', (request, response) => {
  const auth = bearer(request);
  if (!auth?.account) return response.status(401).json({ authorized: false, reason: '授权会话已失效' });
  const state = readState();
  const license = state.licenses.find((item) => item.id === auth.licenseId && item.alibaba_account === auth.account);
  if (!license || licenseState(license) !== 'active') return response.status(403).json({ authorized: false, reason: '软件授权已停用、删除或过期' });
  requireCredentialTransport(request, license);
  if (!clientSessionAllowed(license, auth)) return response.status(403).json({ authorized: false, reason: '软件授权凭证已更新，请重新登录' });
  if (!clientAllowed(license, auth.deviceId)) return response.status(403).json({ authorized: false, reason: '此账号已设为单设备登录，当前会话已被另一台设备替换' });
  if (license.allow_multi_device === false && !license.active_device_id) license.active_device_id = auth.deviceId;
  const login = state.logins.find((item) => item.alibaba_account === auth.account && item.device_id === auth.deviceId);
  if (login) login.last_seen_at = timestamp();
  writeState(state);
  response.json(session(license, auth.deviceId));
});

app.get('/api/admin/licenses', requireAdmin, (request, response) => {
  const state = readState();
  const { page, pageSize, offset } = pagination(request.query);
  const filters = licenseFilters(request.query);
  const items = state.licenses.map((license) => {
    const logins = state.logins.filter((item) => !license.deleted_at && item.alibaba_account === license.alibaba_account);
    return { ...license, allow_multi_device: license.allow_multi_device !== false, display_status: licenseState(license), device_count: logins.length, last_seen_at: logins.map((item) => item.last_seen_at).sort().at(-1) || null };
  }).filter((license) => matchesLicenseFilters(license, filters));
  response.json({ items: items.slice(offset, offset + pageSize).map(publicLicense), total: items.length, page, pageSize });
});

app.get('/api/admin/licenses/:id/history', requireAdmin, (request, response) => response.json(readState().events.filter((item) => item.license_id === request.params.id)));
app.post('/api/admin/licenses', requireAdmin, (request, response) => {
  const account = String(request.body?.alibabaAccount || '').trim();
  const days = Number(request.body?.days);
  if (!account || account.length > 200 || !Number.isFinite(days) || days <= 0 || days > 36500) return response.status(400).json({ error: '账号和有效天数无效' });
  const state = readState();
  let license = state.licenses.find((item) => item.alibaba_account === account && !item.deleted_at);
  const isNew = !license;
  const base = license?.status === 'active' && new Date(license.expires_at).getTime() > Date.now() ? new Date(license.expires_at) : new Date();
  const expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  const credential = isNew ? createActivationCredential() : null;
  if (isNew) { license = { id: newId(), alibaba_account: account, created_at: timestamp(), starts_at: timestamp(), allow_multi_device: true, credential_required: true, credential_hash: credential.credentialHash, credential_version: 0 }; state.licenses.unshift(license); }
  Object.assign(license, { status: 'active', expires_at: expiresAt, note: String(request.body?.note || ''), updated_at: timestamp() });
  addEvent(state, license.id, isNew ? 'activate' : 'extend', request.admin.username, { days });
  writeState(state);
  response.json({ ...publicLicense(license), ...(credential ? { activationCode: credential.activationCode } : {}) });
});

app.patch('/api/admin/licenses/:id', requireAdmin, (request, response) => {
  const state = readState();
  const license = state.licenses.find((item) => item.id === request.params.id);
  if (!license) return response.status(404).json({ error: '授权账号不存在' });
  if (license.deleted_at) return response.status(409).json({ error: '账号已删除，不能修改原授权' });
  const action = String(request.body?.action || '');
  const previousExpiresAt = license.expires_at;
  let credential;
  if (action === 'credential') { credential = createActivationCredential(); license.credential_required = true; license.credential_hash = credential.credentialHash; }
  else if (action === 'pause') license.status = 'paused';
  else if (action === 'resume') { if (new Date(license.expires_at).getTime() <= Date.now()) return response.status(409).json({ error: '授权已过期，请使用延长功能' }); license.status = 'active'; }
  else if (action === 'revoke') license.status = 'revoked';
  else if (action === 'extend') { const days = Number(request.body?.days); if (!Number.isFinite(days) || days <= 0 || days > 36500) return response.status(400).json({ error: '延长天数无效' }); license.expires_at = new Date(Math.max(Date.now(), new Date(license.expires_at).getTime()) + days * 86400000).toISOString(); license.status = 'active'; }
  else if (action === 'reduce') { const days = Number(request.body?.days); if (!Number.isFinite(days) || days <= 0 || days > 36500) return response.status(400).json({ error: '减少天数无效' }); license.expires_at = new Date(new Date(license.expires_at).getTime() - days * 86400000).toISOString(); }
  else if (action === 'devices') {
    if (typeof request.body.allowMultiDevice !== 'boolean') return response.status(400).json({ error: '多端登录开关无效' });
    license.allow_multi_device = request.body.allowMultiDevice;
    license.active_device_id = license.allow_multi_device ? null : state.logins.filter((item) => item.alibaba_account === license.alibaba_account).sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))[0]?.device_id || null;
  }
  else return response.status(400).json({ error: '不支持的授权操作' });
  if (['credential', 'pause', 'revoke'].includes(action)) license.credential_version = Number(license.credential_version || 0) + 1;
  license.updated_at = timestamp(); addEvent(state, license.id, action, request.admin.username, { days: request.body?.days || null, previousExpiresAt, expiresAt: license.expires_at }); writeState(state); response.json({ ...publicLicense(license), ...(credential ? { activationCode: credential.activationCode } : {}) });
});

app.delete('/api/admin/licenses/:id', requireAdmin, (request, response) => {
  const state = readState();
  const license = state.licenses.find((item) => item.id === request.params.id);
  if (!license) return response.status(404).json({ error: '授权账号不存在' });
  if (!license.deleted_at) {
    Object.assign(license, { status: 'revoked', deleted_at: timestamp(), updated_at: timestamp(), active_device_id: null });
    state.logins = state.logins.filter((item) => item.alibaba_account !== license.alibaba_account);
    addEvent(state, license.id, 'delete', request.admin.username, { account: license.alibaba_account });
    writeState(state);
  }
  response.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, (_request, response) => {
  const state = readState(); const now = Date.now();
  state.logins = state.logins.filter((login) => state.licenses.some((license) => !license.deleted_at && license.alibaba_account === login.alibaba_account));
  const counts = Object.fromEntries(['active', 'expired', 'paused', 'revoked', 'deleted'].map((status) => [status, state.licenses.filter((item) => licenseState(item, now) === status).length]));
  response.json({ ...counts, total: state.licenses.length - counts.deleted, paidUsers: counts.active, activeUsers24h: new Set(state.logins.filter((item) => new Date(item.last_seen_at).getTime() > now - 86400000).map((item) => item.alibaba_account)).size, activeUsers30d: new Set(state.logins.filter((item) => new Date(item.last_seen_at).getTime() > now - 30 * 86400000).map((item) => item.alibaba_account)).size, loginCount: state.events.filter((item) => item.action === 'client-login').length });
});

app.get('/api/announcements', (_request, response) => response.set('Cache-Control', 'no-store').json(readState().announcements.filter((item) => item.status === 'published')));
app.get('/api/admin/announcements', requireAdmin, (request, response) => {
  const { page, pageSize, offset } = pagination(request.query);
  const items = readState().announcements;
  response.json({ items: items.slice(offset, offset + pageSize), total: items.length, page, pageSize });
});
app.post('/api/admin/announcements', requireAdmin, (request, response) => {
  const data = announcementInput(request.body); const state = readState();
  const item = { ...data, id: newId(), revision: 1, author: request.admin.username, created_at: timestamp(), updated_at: timestamp(), published_at: data.status === 'published' ? timestamp() : null };
  state.announcements.unshift(item); writeState(state); response.status(201).json(item);
});
app.patch('/api/admin/announcements/:id', requireAdmin, (request, response) => {
  const data = announcementInput(request.body); const state = readState();
  const item = state.announcements.find((entry) => entry.id === request.params.id);
  if (!item) return response.status(404).json({ error: '公告不存在' });
  Object.assign(item, data, { revision: item.revision + 1, author: request.admin.username, updated_at: timestamp(), published_at: data.status === 'published' ? timestamp() : item.published_at });
  writeState(state); response.json(item);
});
app.delete('/api/admin/announcements/:id', requireAdmin, (request, response) => {
  const state = readState();
  state.announcements = state.announcements.filter((item) => item.id !== request.params.id);
  writeState(state); response.json({ ok: true });
});
app.use((error, _request, response, _next) => response.status(error.status || 500).json({ error: error.status ? error.message : '授权服务内部错误' }));

const listener = app.listen(port, '127.0.0.1', () => console.log(`Kua Yipu local authorization preview: http://127.0.0.1:${listener.address().port}`));
