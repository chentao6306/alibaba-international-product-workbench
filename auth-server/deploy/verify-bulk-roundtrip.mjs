// Explicitly authorized production roundtrip. Reuses the deployed business
// adapter inside one transaction so customers never observe a test extension.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { postgresBulkLicenses, bulkLicenseFingerprint } from '../bulk-licenses.js';
import { licenseState } from '../policy.js';

assert.equal(process.env.QA_LIVE_BULK_ROUNDTRIP, 'authorized-extend-and-reduce-one-day');
const root = process.env.QA_BULK_REPORT_DIR;
assert.match(root || '', /^\/var\/backups\/kua-yipu-bulk-roundtrip-[0-9]+$/);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true } });
const client = await pool.connect();
const snapshot = rows => rows.map(row => ({ id: row.id, status: row.status, expires_at: row.expires_at.toISOString(), deleted_at: row.deleted_at?.toISOString() || null })).sort((a, b) => a.id.localeCompare(b.id));
let committed = false;
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='30s'");
  const before = (await client.query('SELECT * FROM licenses ORDER BY id FOR UPDATE')).rows;
  const baseline = snapshot(before);
  fs.writeFileSync(path.join(root, 'before.json'), JSON.stringify(baseline, null, 2), { mode: 0o600 });
  const adapter = postgresBulkLicenses({ pool: client, transaction: work => work(client), event: (db, licenseId, action, actor, metadata) => db.query('INSERT INTO license_events (id,license_id,action,actor,metadata) VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), licenseId, action, actor, JSON.stringify(metadata)]) });
  const eligible = await adapter.preview();
  const ids = new Set(eligible.map(row => row.id));
  const extend = await adapter.execute({ action: 'extend', days: 1, batchId: crypto.randomUUID(), fingerprint: bulkLicenseFingerprint(eligible) }, 'authorized-roundtrip-test');
  const afterExtend = (await client.query('SELECT * FROM licenses ORDER BY id')).rows;
  assert.equal(afterExtend.length, before.length);
  for (const row of afterExtend) {
    const original = before.find(value => value.id === row.id);
    assert.equal(row.status, original.status);
    assert.equal(+row.expires_at - +original.expires_at, ids.has(row.id) ? 86400000 : 0);
  }
  const reduction = await adapter.preview();
  assert.deepEqual(reduction.map(row => row.id).sort(), [...ids].sort(), 'Eligibility changed during test');
  const reduce = await adapter.execute({ action: 'reduce', days: 1, batchId: crypto.randomUUID(), fingerprint: bulkLicenseFingerprint(reduction) }, 'authorized-roundtrip-test');
  const after = (await client.query('SELECT * FROM licenses ORDER BY id')).rows;
  assert.deepEqual(snapshot(after), baseline, 'Expiration or account status did not return exactly to baseline');
  const events = (await client.query("SELECT action,count(*)::int AS count FROM license_events WHERE metadata->>'batchId'=ANY($1) GROUP BY action", [[extend.batchId, reduce.batchId]])).rows;
  assert.equal(events.find(row => row.action === 'bulk-extend')?.count || 0, ids.size);
  assert.equal(events.find(row => row.action === 'bulk-reduce')?.count || 0, ids.size);
  await client.query('COMMIT'); committed = true;
  const excluded = {};
  for (const row of before.filter(row => !ids.has(row.id))) {
    const state = licenseState(row); excluded[state] = (excluded[state] || 0) + 1;
  }
  const report = { ok: true, checkedAt: new Date().toISOString(), total: before.length, extended: extend.changed, reduced: reduce.changed, restoredExactly: ids.size, excluded, allOriginalExpirationsAndStatusesPreserved: true, auditEvents: events, transaction: 'committed', backup: root };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!committed) await client.query('ROLLBACK').catch(() => {});
  client.release(); await pool.end();
}
