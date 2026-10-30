// Read-only live acceptance. No administrator credentials or customer writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tls from 'node:tls';
import { DEFAULT_SERVICE_ORIGIN } from '../server/auth-endpoint.js';
import { UPDATE_CONFIG } from '../electron/update-config.js';
import { verifyArtifact } from '../auth-server/update-protocol.js';

const origin = DEFAULT_SERVICE_ORIGIN;
assert.equal(origin, 'https://106.55.45.126');
assert.equal(UPDATE_CONFIG.server, origin);
const results = {};
const request = (route, options = {}) => fetch(new URL(route, origin), { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
const home = await request('/');
assert.equal(home.status, 302); assert.equal(home.headers.get('location'), '/website/');
const website = await request('/website/');
assert.equal(website.status, 200);
const html = await website.text();
assert.match(html, /抄得快/); assert.doesNotMatch(html, /copyfast\.com\.cn/);
for (const match of html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)) {
  const asset = new URL(match[1], origin + '/website/');
  assert.equal(asset.origin, origin);
  assert.equal((await request(asset.href)).status, 200);
}
results.website = true;
const health = await request('/health');
assert.equal(health.status, 200);
const service = await health.json();
assert.equal(service.ok, true); assert.equal(service.service, 'kua-yipu-auth');
results.serviceVersion = service.version;
for (const route of ['/api/admin/licenses', '/api/admin/stats', '/api/admin/announcements', '/api/admin/account']) {
  assert.equal((await request(route)).status, 401, route);
}
for (const route of ['/admin/', '/admin.js', '/.env', '/.git/config', '/schema.sql']) assert.equal((await request(route)).status, 404, route);
results.adminIsolation = true;
const notices = await request('/api/announcements');
assert.equal(notices.status, 200);
await notices.json(); results.announcements = true;
const latest = await request('/updates/chaodekuai/latest.json');
assert.equal(latest.status, 200); assert.match(latest.headers.get('cache-control'), /no-store/);
const feed = await latest.json();
assert.ok(feed.release);
const artifact = verifyArtifact(feed.release.envelope, UPDATE_CONFIG.publicKey);
const downloadUrl = new URL(feed.release.url, origin);
assert.equal(downloadUrl.origin, origin);
for (const route of [downloadUrl.href, '/updates/chaodekuai/download']) {
  const response = await request(route, { headers: { range: 'bytes=0-1' } });
  assert.equal(response.status, 206, route);
  assert.equal(response.headers.get('content-range'), `bytes 0-1/${artifact.size}`);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'MZ');
}
results.release = { version: artifact.version, size: artifact.size, verifiedSignature: true, rangedDownload: true };
results.tls = await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: '106.55.45.126', port: 443, rejectUnauthorized: true }, () => {
    const certificate = socket.getPeerCertificate();
    resolve({ authorized: socket.authorized, protocol: socket.getProtocol(), san: certificate.subjectaltname, expires: certificate.valid_to });
    socket.end();
  });
  socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('TLS timed out')); });
  socket.once('error', reject);
});
assert.match(results.tls.san, /IP Address:106\.55\.45\.126/);
const report = { ok: true, checkedAt: new Date().toISOString(), origin, results };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
