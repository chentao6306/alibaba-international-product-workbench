import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';

const base = 'https://106.55.45.126';
const request = (route, options = {}) => fetch(base + route, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
const results = {};
const health = await request('/health');
assert.equal(health.status, 200);
assert.equal((await health.json()).version, '1.4.7');
assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);
results.healthAndHeaders = true;
for (const route of ['/api/admin/licenses', '/api/admin/stats', '/api/admin/announcements']) {
  assert.equal((await request(route)).status, 401);
  assert.equal((await request(route, { headers: { authorization: 'Bearer forged-session.invalid-signature' } })).status, 401);
}
results.unauthenticatedAndForgedAdmin = true;
for (const route of ['/.env', '/.git/config', '/schema.sql', '/security.js']) assert.equal((await request(route)).status, 404);
assert.ok([400, 404].includes((await request('/%2e%2e%2f.env')).status));
results.privateFiles = true;
const login = await request('/api/client/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '__security_probe_unlicensed__', deviceId: 'read-only-probe' }) });
assert.equal(login.status, 403);
const injection = await request('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: "' OR 1=1 --", password: 'invalid-security-probe' }) });
assert.equal(injection.status, 401);
results.invalidIdentityAndSqlInjection = true;
const legacy = await fetch('http://106.55.45.126/', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(legacy.status, 308); assert.equal(legacy.headers.get('location'), base + '/');
results.adminHttpsRedirect = true;
results.tls = await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: '106.55.45.126', port: 443, rejectUnauthorized: true }, () => {
    const certificate = socket.getPeerCertificate();
    resolve({ authorized: socket.authorized, protocol: socket.getProtocol(), expires: certificate.valid_to }); socket.end();
  });
  socket.setTimeout(10000, () => { socket.destroy(); reject(Error('TLS probe timed out')); });
  socket.once('error', reject);
});
for (const port of [5432, 8790]) {
  const exposed = await new Promise((resolve) => {
    const socket = net.connect({ host: '106.55.45.126', port });
    socket.setTimeout(4000); socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  assert.equal(exposed, false, `Internal service port ${port} is public`);
}
results.internalPortsNotReachable = true;
console.log(JSON.stringify({ ok: true, target: base, results }));
