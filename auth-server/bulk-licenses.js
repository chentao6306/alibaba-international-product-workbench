import crypto from 'node:crypto';
import { licenseState } from './policy.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function bulkLicenseInput(input = {}) {
  const action = input.action;
  if (!['extend', 'reduce', 'pause'].includes(action)) throw fail('不支持的批量授权操作');
  const days = action === 'pause' ? 0 : Number(input.days);
  if (action !== 'pause' && (!Number.isInteger(days) || days < 1 || days > 36500)) throw fail('调整天数必须是 1 至 36500 的整数');
  return { action, days };
}
export const eligibleBulkLicenses = (licenses, now = Date.now()) => licenses.filter(license => licenseState(license, now) === 'active');
export function bulkLicenseFingerprint(licenses) {
  const rows = licenses.map(row => [row.id, row.status, new Date(row.expires_at).toISOString(), row.updated_at ? new Date(row.updated_at).toISOString() : '']).sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export function bulkLicenseChange(license, input, now) {
  if (licenseState(license, now) !== 'active') throw fail('账号已过期或停用，请重新预览', 409);
  return input.action === 'pause' ? { status: 'paused', updated_at: new Date(now).toISOString() }
    : { expires_at: new Date(new Date(license.expires_at).getTime() + (input.action === 'reduce' ? -1 : 1) * input.days * 86400000).toISOString(), updated_at: new Date(now).toISOString() };
}
export function requireBulkSnapshot(licenses, expected) {
  if (bulkLicenseFingerprint(licenses) !== expected) throw fail('授权状态或人数已变化，请重新预览后确认', 409);
}

export function registerBulkLicenseRoutes(app, { requireAdmin, sign, verify, preview, execute }) {
  app.post('/api/admin/licenses/bulk-preview', requireAdmin, async (request, response) => {
    const input = bulkLicenseInput(request.body);
    const licenses = await preview();
    const now = Date.now();
    const token = sign({ aud: 'license-bulk', sid: request.admin.sid, username: request.admin.username,
      batchId: crypto.randomUUID(), ...input, fingerprint: bulkLicenseFingerprint(licenses), exp: now + 5 * 60000 });
    const willExpire = input.action === 'reduce' ? licenses.filter(row => new Date(row.expires_at).getTime() - input.days * 86400000 <= now).length : 0;
    response.json({ count: licenses.length, willExpire, action: input.action, days: input.days, token });
  });
  app.post('/api/admin/licenses/bulk', requireAdmin, async (request, response) => {
    const plan = verify(request.body?.token);
    if (!plan || plan.aud !== 'license-bulk' || plan.sid !== request.admin.sid || plan.username !== request.admin.username) throw fail('批量操作预览已失效，请重新预览', 409);
    response.json(await execute({ ...plan, ...bulkLicenseInput(plan) }, request.admin.username));
  });
}

export function postgresBulkLicenses({ transaction, pool, event }) {
  const eligible = "deleted_at IS NULL AND status='active' AND expires_at>clock_timestamp()";
  return {
    preview: async () => (await pool.query(`SELECT * FROM licenses WHERE ${eligible} ORDER BY id`)).rows,
    execute: (plan, actor) => transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bulk-license:${plan.batchId}`]);
      const previous = (await client.query("SELECT metadata FROM license_events WHERE action=$1 AND metadata->>'batchId'=$2 LIMIT 1", [`bulk-${plan.action}`, plan.batchId])).rows[0];
      if (previous) return { ...previous.metadata.summary, replayed: true };
      const licenses = (await client.query(`SELECT * FROM licenses WHERE ${eligible} ORDER BY id FOR UPDATE`)).rows;
      const now = Date.now();
      // Recheck after acquiring locks; an account can expire while waiting.
      const current = eligibleBulkLicenses(licenses, now);
      requireBulkSnapshot(current, plan.fingerprint);
      const summary = { ok: true, batchId: plan.batchId, action: plan.action, days: plan.days, changed: current.length };
      for (const license of current) {
        const patch = bulkLicenseChange(license, plan, now);
        await client.query('UPDATE licenses SET status=$2,expires_at=$3,updated_at=$4 WHERE id=$1', [license.id, patch.status || license.status, patch.expires_at || license.expires_at, patch.updated_at]);
        await event(client, license.id, `bulk-${plan.action}`, actor, { batchId: plan.batchId, days: plan.days,
          before: { status: license.status, expires_at: license.expires_at }, after: { status: patch.status || license.status, expires_at: patch.expires_at || license.expires_at }, summary });
      }
      return summary;
    }),
  };
}

export function localBulkLicenses({ readState, writeState, addEvent }) {
  return {
    preview: async () => eligibleBulkLicenses(readState().licenses),
    execute: async (plan, actor) => {
      const state = readState(), now = Date.now();
      const previous = state.events.find(event => event.action === `bulk-${plan.action}` && event.metadata?.batchId === plan.batchId);
      if (previous) return { ...previous.metadata.summary, replayed: true };
      const licenses = eligibleBulkLicenses(state.licenses, now);
      requireBulkSnapshot(licenses, plan.fingerprint);
      const summary = { ok: true, batchId: plan.batchId, action: plan.action, days: plan.days, changed: licenses.length };
      for (const license of licenses) {
        const before = { status: license.status, expires_at: license.expires_at };
        Object.assign(license, bulkLicenseChange(license, plan, now));
        addEvent(state, license.id, `bulk-${plan.action}`, actor, { batchId: plan.batchId, days: plan.days, before,
          after: { status: license.status, expires_at: license.expires_at }, summary });
      }
      writeState(state);
      return summary;
    },
  };
}
