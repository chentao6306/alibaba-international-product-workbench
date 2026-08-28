import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_COOKIE = 'cross_easy_session';
const ADMIN_COOKIE = 'cross_easy_admin';
const DAY = 24 * 60 * 60 * 1000;

function accountKey(value) {
  return String(value || '').trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, digest };
}

function checkPassword(password, record) {
  if (!record?.salt || !record?.digest) return false;
  const actual = crypto.scryptSync(String(password), record.salt, 32).toString('hex');
  const expected = Buffer.from(String(record.digest));
  const candidate = Buffer.from(actual);
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter((item) => item.length));
}

function setCookie(response, name, value, maxAge = 60 * 60 * 12) {
  response.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Path=/`);
}

function clearCookie(response, name) {
  response.setHeader('Set-Cookie', `${name}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/`);
}

function chinaTime(iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
}

export class LicenseManager {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'licenses.json');
    this.sessions = new Map();
    this.adminSessions = new Map();
    this.bridgeSecret = process.env.CROSS_EASYSHOP_BRIDGE_SECRET || '';
    this.adminUser = process.env.CROSS_EASYSHOP_ADMIN_USER || 'admin';
    this.adminPassword = process.env.CROSS_EASYSHOP_ADMIN_PASSWORD || 'change-me-now';
    if (!fs.existsSync(this.file)) {
      this.write({ version: 1, licenses: [], history: [] });
      if (process.env.NODE_ENV === 'production') console.warn('[auth] CROSS_EASYSHOP_ADMIN_PASSWORD is not configured; set it before deployment');
    }
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { version: 1, licenses: [], history: [] }; }
  }

  write(value) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, this.file);
  }

  find(account) {
    const key = accountKey(account);
    return this.read().licenses.find((item) => item.accountKey === key) || null;
  }

  isActive(record, now = Date.now()) {
    return Boolean(record && record.status === 'active' && new Date(record.startsAt).getTime() <= now && new Date(record.expiresAt).getTime() > now);
  }

  publicLicense(record) {
    if (!record) return null;
    return { account: record.account, status: record.status, startsAt: record.startsAt, expiresAt: record.expiresAt, expiresAtChina: chinaTime(record.expiresAt), lastLoginAt: record.lastLoginAt || null, lastLoginAtChina: chinaTime(record.lastLoginAt), lastDeviceId: record.lastDeviceId || null };
  }

  verifyBridge(account, deviceId, token) {
    if (!this.bridgeSecret || !token) return false;
    const [stamp, signature] = String(token).split('.');
    if (!stamp || !signature || Math.abs(Date.now() - Number(stamp)) > 5 * 60 * 1000) return false;
    const payload = `${accountKey(account)}|${stamp}|${String(deviceId || '')}`;
    const expected = crypto.createHmac('sha256', this.bridgeSecret).update(payload).digest('hex');
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    return expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  }

  establish({ account, deviceId, bridgeToken }) {
    const record = this.find(account);
    if (!record || !this.isActive(record)) return { ok: false, error: '账号未授权或授权已过期，请联系管理员开通' };
    if (!this.verifyBridge(account, deviceId, bridgeToken)) return { ok: false, error: '登录验证无效，请重新登录阿里巴巴国际站' };
    const now = new Date().toISOString();
    const data = this.read();
    const target = data.licenses.find((item) => item.accountKey === accountKey(account));
    target.lastLoginAt = now;
    target.lastDeviceId = String(deviceId || '');
    target.updatedAt = now;
    data.history.push({ action: 'login', account: target.account, at: now, deviceId: target.lastDeviceId });
    this.write(data);
    const sessionId = crypto.randomBytes(32).toString('hex');
    this.sessions.set(sessionId, { accountKey: target.accountKey, account: target.account, deviceId: target.lastDeviceId, createdAt: Date.now() });
    return { ok: true, sessionId, license: this.publicLicense(target) };
  }

  session(request) {
    const id = parseCookies(request)[SESSION_COOKIE];
    const session = id ? this.sessions.get(id) : null;
    const record = session ? this.find(session.accountKey) : null;
    if (!session || !record || !this.isActive(record)) return null;
    return { ...session, license: this.publicLicense(record) };
  }

  adminSession(request) {
    const id = parseCookies(request)[ADMIN_COOKIE];
    return id ? this.adminSessions.get(id) : null;
  }

  adminLogin(user, password) {
    if (String(user || '') !== this.adminUser || String(password || '') !== this.adminPassword) return null;
    const id = crypto.randomBytes(32).toString('hex');
    this.adminSessions.set(id, { user: this.adminUser, createdAt: Date.now() });
    return id;
  }

  upsert(input, actor = 'admin') {
    const account = String(input.account || '').trim();
    if (!account) throw new Error('国际站账号不能为空');
    const now = new Date().toISOString();
    const data = this.read();
    let target = data.licenses.find((item) => item.accountKey === accountKey(account));
    if (!target) {
      target = { account, accountKey: accountKey(account), status: 'active', createdAt: now, history: [] };
      data.licenses.push(target);
    }
    if (input.startsAt) target.startsAt = new Date(input.startsAt).toISOString();
    if (input.expiresAt) target.expiresAt = new Date(input.expiresAt).toISOString();
    if (!target.startsAt) target.startsAt = now;
    if (!target.expiresAt) target.expiresAt = new Date(Date.now() + DAY).toISOString();
    target.status = input.status || target.status || 'active';
    target.updatedAt = now;
    const action = input.action || 'upsert';
    data.history.push({ action, account, at: now, actor, startsAt: target.startsAt, expiresAt: target.expiresAt });
    this.write(data);
    return this.publicLicense(target);
  }

  update(account, patch, actor = 'admin') {
    const data = this.read();
    const target = data.licenses.find((item) => item.accountKey === accountKey(account));
    if (!target) throw Object.assign(new Error('授权账号不存在'), { status: 404 });
    Object.assign(target, patch);
    if (patch.expiresAt) target.expiresAt = new Date(patch.expiresAt).toISOString();
    if (patch.startsAt) target.startsAt = new Date(patch.startsAt).toISOString();
    target.updatedAt = new Date().toISOString();
    data.history.push({ action: patch.action || 'update', account: target.account, at: target.updatedAt, actor, status: target.status, expiresAt: target.expiresAt });
    this.write(data);
    return this.publicLicense(target);
  }

  list() { return this.read().licenses.map((item) => this.publicLicense(item)); }
  history() { return this.read().history.slice().reverse(); }
  stats() {
    const licenses = this.read().licenses;
    const active = licenses.filter((item) => this.isActive(item)).length;
    return { totalLicenses: licenses.length, activeLicenses: active, pausedLicenses: licenses.filter((item) => item.status === 'paused').length, revokedLicenses: licenses.filter((item) => item.status === 'revoked').length, recentLogins: licenses.filter((item) => item.lastLoginAt).sort((a, b) => new Date(b.lastLoginAt) - new Date(a.lastLoginAt)).slice(0, 20).map((item) => this.publicLicense(item)) };
  }
}

export { ADMIN_COOKIE, SESSION_COOKIE, clearCookie, parseCookies, setCookie, chinaTime, accountKey, checkPassword, hashPassword };
