// Authorized HTTPS ingestion probe using the current account's existing lease.
// No license, password or device registration is changed; only QA reports are removed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { clientSession, tokenCodec } from '../security.js';

assert.ok(process.env.QA_DIAGNOSTIC_ACCOUNT);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true } });
let receipt;
try {
  const license = (await pool.query('SELECT * FROM licenses WHERE alibaba_account=$1 AND deleted_at IS NULL', [process.env.QA_DIAGNOSTIC_ACCOUNT])).rows[0];
  assert.ok(license);
  const deviceId = license.active_device_id || (await pool.query('SELECT device_id FROM client_logins WHERE alibaba_account=$1 ORDER BY last_seen_at DESC LIMIT 1', [license.alibaba_account])).rows[0]?.device_id;
  assert.ok(deviceId);
  const { sign } = tokenCodec(process.env.KUA_YIPU_AUTH_SECRET);
  const { token } = clientSession(license, deviceId, sign, 2);
  const attemptId = crypto.randomUUID(), at = new Date().toISOString();
  const failure = { id: crypto.randomUUID(), attemptId, at, mode: 'draft', processingMode: 'rules', targetCategoryId: '201346401',
    product: { id: 'synthetic-diagnostic-fixture', title: 'QA fixture - not a sale product', description: 'QA product body. '.repeat(12000), sourceUrl: 'https://www.alibaba.com/product-detail/qa_1600000000000.html' },
    error: { code: 'PUBLISH_IMAGE_UPLOAD_FAILED', message: 'QA upload failure fixture', apiKey: 'PRIVATE_QA_SECRET' },
    timeline: { totalMs: 350, entries: [{ stage: 'images', startedMs: 0, durationMs: 350, outcome: 'failed' }], truncated: false } };
  const report = { schemaVersion: 1, reportId: crypto.randomUUID(), createdAt: at, appVersion: '1.4.103', note: 'Deployment QA fixture',
    events: [{ at, event: 'publish-stage-completed', attemptId, mode: 'draft', processingMode: 'rules', stage: 'images', stageMs: 350 }],
    failures: [failure], failureIndex: [{ ...failure, evidence: 'included' }], failureCoverage: { retainedSnapshots: 1 } };
  const body = JSON.stringify(report);
  assert.ok(Buffer.byteLength(body) > 128 * 1024);
  const response = await fetch('https://106.55.45.126/api/client/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body, signal: AbortSignal.timeout(60000) });
  if (response.status !== 201) throw new Error('Diagnostic HTTPS probe failed: ' + response.status + ' ' + (await response.text()).slice(0, 500));
  receipt = await response.json();
  assert.match(receipt.id, /^LOG-[A-F0-9]{24}$/);
  const record = JSON.parse(fs.readFileSync(path.join('/var/lib/kua-yipu/diagnostics', receipt.id + '.json'), 'utf8'));
  assert.equal(record.account, process.env.QA_DIAGNOSTIC_ACCOUNT);
  assert.equal(record.report.failures[0].product.title, report.failures[0].product.title);
  assert.ok(record.report.failures[0].product.description.length > 128 * 1024);
  assert.equal(record.report.events[0].event, 'publish-stage-completed');
  assert.equal(record.report.events[0].attemptId, attemptId);
  assert.equal(record.report.events[0].stageMs, 350);
  assert.equal(record.report.failures[0].timeline.entries[0].durationMs, 350);
  assert.equal(record.report.failureIndex[0].attemptId, attemptId);
  assert.equal(record.report.failureIndex[0].targetCategoryId, '201346401');
  assert.equal(record.report.failureIndex[0].processingMode, 'rules');
  assert.equal(record.report.failureCoverage.indexLimit, 60);
  assert.equal(JSON.stringify(record.report).includes('PRIVATE_QA_SECRET'), false);
  const retry = await fetch('https://106.55.45.126/api/client/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body, signal: AbortSignal.timeout(60000) });
  assert.equal(retry.status, 201); assert.deepEqual(await retry.json(), receipt);
  const denied = await fetch('https://106.55.45.126/api/admin/diagnostics/' + receipt.id, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
  assert.equal(denied.status, 401);
  console.log(JSON.stringify({ passed: true, httpsLargePayload: true, bytes: Buffer.byteLength(body), storedProductEvidence: true,
    attemptTimeline: true, failureIndex: true, newEventPreserved: true, credentialRedaction: true, retryIdempotency: true, clientCannotReadAdminReport: true }));
} finally {
  if (receipt && /^LOG-[A-F0-9]{24}$/.test(receipt.id)) for (const suffix of ['.json', '.meta.json']) fs.rmSync(path.join('/var/lib/kua-yipu/diagnostics', receipt.id + suffix), { force: true });
  await pool.end();
}
