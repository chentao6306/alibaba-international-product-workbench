import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LicenseManager } from '../server/auth.js';

const original = {
  secret: process.env.CROSS_EASYSHOP_BRIDGE_SECRET,
  user: process.env.CROSS_EASYSHOP_ADMIN_USER,
  password: process.env.CROSS_EASYSHOP_ADMIN_PASSWORD
};
let dataDir;
let manager;

before(() => {
  process.env.CROSS_EASYSHOP_BRIDGE_SECRET = 'test-bridge-secret';
  process.env.CROSS_EASYSHOP_ADMIN_USER = 'test-admin';
  process.env.CROSS_EASYSHOP_ADMIN_PASSWORD = 'test-password';
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-easyshop-auth-'));
  manager = new LicenseManager(dataDir);
});

after(() => {
  for (const [key, value] of Object.entries({
    CROSS_EASYSHOP_BRIDGE_SECRET: original.secret,
    CROSS_EASYSHOP_ADMIN_USER: original.user,
    CROSS_EASYSHOP_ADMIN_PASSWORD: original.password
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function bridgeToken(account, deviceId, stamp = Date.now()) {
  const payload = `${String(account).trim().toLowerCase()}|${stamp}|${deviceId}`;
  const signature = crypto.createHmac('sha256', 'test-bridge-secret').update(payload).digest('hex');
  return `${stamp}.${signature}`;
}

test('active license accepts a valid desktop bridge and records login', () => {
  const license = manager.upsert({ account: 'Seller-001', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(license.status, 'active');
  const deviceId = 'device-a';
  const result = manager.establish({ account: 'seller-001', deviceId, bridgeToken: bridgeToken('seller-001', deviceId) });
  assert.equal(result.ok, true);
  assert.equal(result.license.account, 'Seller-001');
  assert.equal(manager.stats().recentLogins.length, 1);
});

test('invalid bridge and inactive licenses are rejected', () => {
  const invalid = manager.establish({ account: 'seller-001', deviceId: 'device-a', bridgeToken: 'bad-token' });
  assert.equal(invalid.ok, false);
  manager.upsert({ account: 'paused-seller', expiresAt: new Date(Date.now() + 86400000).toISOString(), status: 'paused' });
  const paused = manager.establish({ account: 'paused-seller', deviceId: 'device-b', bridgeToken: bridgeToken('paused-seller', 'device-b') });
  assert.equal(paused.ok, false);
  manager.upsert({ account: 'expired-seller', expiresAt: new Date(Date.now() - 1000).toISOString() });
  const expired = manager.establish({ account: 'expired-seller', deviceId: 'device-c', bridgeToken: bridgeToken('expired-seller', 'device-c') });
  assert.equal(expired.ok, false);
});

test('admin login and license lifecycle are isolated and auditable', () => {
  assert.equal(manager.adminLogin('test-admin', 'wrong'), null);
  const adminSession = manager.adminLogin('test-admin', 'test-password');
  assert.ok(adminSession);
  const changed = manager.update('paused-seller', { status: 'active', action: 'activate' }, 'test-admin');
  assert.equal(changed.status, 'active');
  const list = manager.list();
  assert.equal(list.length, 3);
  assert.ok(manager.history().some((item) => item.action === 'activate'));
  assert.equal(manager.stats().totalLicenses, 3);
});
