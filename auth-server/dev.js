import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const stateFile = path.join(rootDir, '.data', 'auth-dev.json');
const port = Number(process.env.PORT || 8790);
const adminUsername = String(process.env.KUA_YIPU_ADMIN_USERNAME || 'admin');
const adminPassword = String(process.env.KUA_YIPU_ADMIN_PASSWORD || 'KuaYipu-Admin-2026');
const signingSecret = String(process.env.KUA_YIPU_AUTH_SECRET || 'kua-yipu-local-development-secret-2026');
const app = express();
app.use(express.json({ limit: '64kb' }));

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return { licenses: [], events: [], logins: [] }; }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, stateFile);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', signingSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', signingSecret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try { const payload = JSON.parse(Buffer.from(body, 'base64url')); return payload.exp > Date.now() ? payload : null; }
  catch { return null; }
}

const bearer = (request) => verify(request.headers.authorization?.replace(/^Bearer\s+/i, ''));
const requireAdmin = (request, response, next) => {
  const auth = bearer(request);
  if (!auth?.admin) return response.status(401).json({ error: '管理员登录已失效' });
  request.admin = auth;
  next();
};
const timestamp = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const addEvent = (state, licenseId, action, actor, metadata = {}) => state.events.unshift({ id: newId(), license_id: licenseId, action, actor, metadata, created_at: timestamp() });

app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'admin.html')));
app.get('/health', (_request, response) => response.json({ ok: true, service: 'kua-yipu-auth-dev' }));
app.post('/api/admin/login', (request, response) => {
  if (request.body?.username !== adminUsername || request.body?.password !== adminPassword) return response.status(401).json({ error: '管理员账号或密码错误' });
  response.json({ username: adminUsername, token: sign({ admin: true, username: adminUsername, exp: Date.now() + 8 * 60 * 60 * 1000 }) });
});

app.post('/api/client/login', (request, response) => {
  const account = String(request.body?.username || '').trim();
  const deviceId = String(request.body?.deviceId || '').trim();
  const state = readState();
  const license = state.licenses.find((item) => item.alibaba_account === account);
  if (!license || license.status !== 'active' || new Date(license.expires_at).getTime() <= Date.now()) return response.status(403).json({ authorized: false, reason: '该 Alibaba 账号没有有效的软件授权' });
  let login = state.logins.find((item) => item.alibaba_account === account && item.device_id === deviceId);
  if (!login) { login = { id: newId(), alibaba_account: account, device_id: deviceId, created_at: timestamp() }; state.logins.push(login); }
  Object.assign(login, { device_name: String(request.body?.deviceName || ''), app_version: String(request.body?.appVersion || ''), ip_address: request.ip, last_seen_at: timestamp() });
  addEvent(state, license.id, 'client-login', account, { deviceId });
  writeState(state);
  response.json({ authorized: true, expiresAt: license.expires_at, token: sign({ account, licenseId: license.id, deviceId, exp: Math.min(new Date(license.expires_at).getTime(), Date.now() + 10 * 60 * 1000) }) });
});

app.post('/api/client/heartbeat', (request, response) => {
  const auth = bearer(request);
  if (!auth?.account) return response.status(401).json({ authorized: false, reason: '授权会话已失效' });
  const state = readState();
  const license = state.licenses.find((item) => item.id === auth.licenseId && item.alibaba_account === auth.account);
  if (!license || license.status !== 'active' || new Date(license.expires_at).getTime() <= Date.now()) return response.status(403).json({ authorized: false, reason: '软件授权已暂停或过期' });
  response.json({ authorized: true, expiresAt: license.expires_at, token: sign({ account: auth.account, licenseId: license.id, deviceId: auth.deviceId, exp: Math.min(new Date(license.expires_at).getTime(), Date.now() + 10 * 60 * 1000) }) });
});

app.get('/api/admin/licenses', requireAdmin, (_request, response) => {
  const state = readState();
  response.json(state.licenses.map((license) => {
    const logins = state.logins.filter((item) => item.alibaba_account === license.alibaba_account);
    return { ...license, login_count: logins.length, last_seen_at: logins.map((item) => item.last_seen_at).sort().at(-1) || null };
  }));
});

app.get('/api/admin/licenses/:id/history', requireAdmin, (request, response) => response.json(readState().events.filter((item) => item.license_id === request.params.id)));
app.post('/api/admin/licenses', requireAdmin, (request, response) => {
  const account = String(request.body?.alibabaAccount || '').trim();
  const days = Number(request.body?.days);
  if (!account || !Number.isFinite(days) || days <= 0) return response.status(400).json({ error: '账号和有效天数无效' });
  const state = readState();
  let license = state.licenses.find((item) => item.alibaba_account === account);
  const isNew = !license;
  const base = license?.status === 'active' && new Date(license.expires_at).getTime() > Date.now() ? new Date(license.expires_at) : new Date();
  const expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  if (isNew) { license = { id: newId(), alibaba_account: account, created_at: timestamp(), starts_at: timestamp() }; state.licenses.unshift(license); }
  Object.assign(license, { status: 'active', expires_at: expiresAt, note: String(request.body?.note || ''), updated_at: timestamp() });
  addEvent(state, license.id, isNew ? 'activate' : 'extend', request.admin.username, { days });
  writeState(state);
  response.json(license);
});

app.patch('/api/admin/licenses/:id', requireAdmin, (request, response) => {
  const state = readState();
  const license = state.licenses.find((item) => item.id === request.params.id);
  if (!license) return response.status(404).json({ error: '授权账号不存在' });
  const action = String(request.body?.action || '');
  if (action === 'pause') license.status = 'paused';
  else if (action === 'resume') { if (new Date(license.expires_at).getTime() <= Date.now()) return response.status(409).json({ error: '授权已过期，请使用延长功能' }); license.status = 'active'; }
  else if (action === 'revoke') license.status = 'revoked';
  else if (action === 'extend') { const days = Number(request.body?.days); if (!Number.isFinite(days) || days <= 0) return response.status(400).json({ error: '延长天数无效' }); license.expires_at = new Date(Math.max(Date.now(), new Date(license.expires_at).getTime()) + days * 86400000).toISOString(); license.status = 'active'; }
  else return response.status(400).json({ error: '不支持的授权操作' });
  license.updated_at = timestamp(); addEvent(state, license.id, action, request.admin.username, { days: request.body?.days || null }); writeState(state); response.json(license);
});

app.get('/api/admin/stats', requireAdmin, (_request, response) => {
  const state = readState(); const now = Date.now();
  response.json({ paidUsers: state.licenses.filter((item) => item.status === 'active' && new Date(item.expires_at).getTime() > now).length, activeUsers24h: new Set(state.logins.filter((item) => new Date(item.last_seen_at).getTime() > now - 86400000).map((item) => item.alibaba_account)).size, activeUsers30d: new Set(state.logins.filter((item) => new Date(item.last_seen_at).getTime() > now - 30 * 86400000).map((item) => item.alibaba_account)).size, loginCount: state.events.filter((item) => item.action === 'client-login').length });
});

app.listen(port, '127.0.0.1', () => console.log(`Kua Yipu local authorization preview: http://127.0.0.1:${port}`));
