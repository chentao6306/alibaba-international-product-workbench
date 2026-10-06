import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientAllowed, licenseState, pagination, announcementInput, licenseFilters } from './policy.js';
import { configureHttpSecurity } from './http-security.js';
import { createActivationCredential, credentialResetRevokesSessions, validActivation, publicLicense, clientSessionAllowed, clientSession, tokenCodec, requireCredentialTransport, offlineGraceMinutes } from './security.js';
import { registerUpdateRoutes } from './updates.js';
import { registerAdminPages } from './admin-pages.js';
import { registerAnnouncementImages } from './announcement-images.js';
import { verifyAdminPassword, registerAdminAccountRoutes, postgresAccountChanger } from './admin-account.js';

const app = express();
configureHttpSecurity(app);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '128kb' }));
const port = Number(process.env.PORT || 8790);
const signingSecret = String(process.env.KUA_YIPU_AUTH_SECRET || '');
if (!process.env.DATABASE_URL || signingSecret.length < 32) throw new Error('DATABASE_URL and KUA_YIPU_AUTH_SECRET (at least 32 chars) are required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true } });
const id = () => crypto.randomUUID();
const normalize = (value) => String(value || '').trim();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
app.use('/api/admin', (request, _response, next) => { requireCredentialTransport(request, { credential_required: true }); next(); });
const daysValue = (value) => {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0 || days > 36500) throw fail('授权天数必须大于 0 且不超过 36500');
  return days;
};
const { sign, verify } = tokenCodec(signingSecret);
const passwordFingerprint = (hash) => crypto.createHmac('sha256', signingSecret).update(hash).digest('hex');
const bearer = (request) => verify(request.headers.authorization?.replace(/^Bearer\s+/i, ''));
const requireAdmin = async (request, response, next) => {
  const auth = bearer(request);
  if (!auth?.admin || auth.aud !== 'admin' || typeof auth.sid !== 'string' || !/^[a-f0-9-]{36}$/.test(auth.sid)) return response.status(401).json({ error: '管理员登录已失效' });
  const stored = (await pool.query('SELECT s.password_fingerprint,u.password_hash FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.id=$1 AND s.expires_at>now() AND u.username=$2', [auth.sid, auth.username])).rows[0];
  if (!stored || stored.password_fingerprint !== passwordFingerprint(stored.password_hash)) return response.status(401).json({ error: '管理员登录已失效' });
  request.admin = auth; next();
};
const session = (license, deviceId, version) => clientSession(license, deviceId, sign, version);
registerUpdateRoutes(app, { requireAdmin, directory: process.env.KUA_YIPU_UPDATE_DIR || path.join(__dirname, '.data', 'updates') });
const validateAnnouncementImages = registerAnnouncementImages(app, {
  requireAdmin,
  directory: process.env.KUA_YIPU_ANNOUNCEMENT_DIR || path.join(process.env.KUA_YIPU_UPDATE_DIR || path.join(__dirname, '.data', 'updates'), 'announcement-images'),
  isPublished: async src => Boolean((await pool.query("SELECT 1 FROM announcements WHERE status='published' AND blocks @> $1::jsonb LIMIT 1", [JSON.stringify([{ type: 'image', src }])])).rows.length),
});
async function transaction(work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
const event = (client, licenseId, action, actor, metadata = {}) => client.query('INSERT INTO license_events (id,license_id,action,actor,metadata) VALUES ($1,$2,$3,$4,$5)', [id(), licenseId, action, actor, JSON.stringify(metadata)]);

app.get('/health', (_request, response) => response.json({ ok: true, service: 'kua-yipu-auth', version: '1.4.53' }));
registerAdminPages(app, { directory: __dirname });
registerAdminAccountRoutes(app, { requireAdmin, changeAccount: postgresAccountChanger({ transaction, passwordFingerprint }) });
app.post('/api/admin/login', async (request, response) => {
  const username = normalize(request.body?.username);
  if (username.length > 200 || typeof request.body?.password !== 'string' || request.body.password.length > 1024) throw fail('管理员账号或密码格式不正确');
  const result = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
  const valid = await verifyAdminPassword(request.body.password, result.rows[0]?.password_hash);
  if (!valid) throw fail('管理员账号或密码错误', 401);
  const sid = id(); const exp = Date.now() + 8 * 60 * 60 * 1000;
  await transaction(async (client) => {
    await client.query('DELETE FROM admin_sessions WHERE expires_at<=now()');
    await client.query('INSERT INTO admin_sessions (id,admin_id,password_fingerprint,expires_at) VALUES ($1,$2,$3,$4)', [sid, result.rows[0].id, passwordFingerprint(result.rows[0].password_hash), new Date(exp)]);
  });
  response.json({ token: sign({ aud: 'admin', admin: true, username, sid, exp }), username });
});
app.post('/api/admin/logout', requireAdmin, async (request, response) => {
  await pool.query('DELETE FROM admin_sessions WHERE id=$1', [request.admin.sid]);
  response.json({ ok: true });
});

app.post('/api/client/login', async (request, response) => {
  const account = normalize(request.body?.username); const deviceId = normalize(request.body?.deviceId);
  if (!account || !deviceId || account.length > 200 || deviceId.length > 200) throw fail('缺少或无效的 Alibaba 账号或设备标识');
  const result = await transaction(async (client) => {
    const license = (await client.query('SELECT * FROM licenses WHERE alibaba_account=$1 AND deleted_at IS NULL FOR UPDATE', [account])).rows[0];
    if (!license || licenseState(license) !== 'active') throw fail('该 Alibaba 账号没有有效的软件授权', 403);
    requireCredentialTransport(request, license);
    if (!validActivation(license, request.body?.activationCode)) throw fail('软件授权码无效，请使用新版客户端并填写管理员提供的授权码', 403);
    if (!license.allow_multi_device) await client.query('UPDATE licenses SET active_device_id=$2 WHERE id=$1', [license.id, deviceId]);
    await client.query(`INSERT INTO client_logins (id,alibaba_account,device_id,device_name,app_version,ip_address,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (alibaba_account,device_id) DO UPDATE SET device_name=EXCLUDED.device_name,app_version=EXCLUDED.app_version,ip_address=EXCLUDED.ip_address,last_seen_at=now()`, [id(), account, deviceId, normalize(request.body?.deviceName).slice(0, 200), normalize(request.body?.appVersion).slice(0, 50), request.ip]);
    await event(client, license.id, 'client-login', account, { deviceId });
    return session(license, deviceId, request.body.connectionPolicyVersion);
  });
  response.json(result);
});

app.post('/api/client/heartbeat', async (request, response) => {
  const auth = bearer(request);
  if (!auth?.account) throw fail('授权会话已失效', 401);
  const result = await transaction(async (client) => {
    const license = (await client.query('SELECT * FROM licenses WHERE id=$1 AND alibaba_account=$2 FOR UPDATE', [auth.licenseId, auth.account])).rows[0];
    if (!license || licenseState(license) !== 'active') throw fail('软件授权已停用或过期', 403);
    requireCredentialTransport(request, license);
    if (!clientSessionAllowed(license, auth)) throw fail('软件授权凭证已更新，请重新登录', 403);
    if (!clientAllowed(license, auth.deviceId)) throw fail('此账号已设为单设备登录，当前会话已被另一台设备替换', 403);
    if (!license.allow_multi_device && !license.active_device_id) await client.query('UPDATE licenses SET active_device_id=$2 WHERE id=$1', [license.id, auth.deviceId]);
    await client.query('UPDATE client_logins SET last_seen_at=now() WHERE alibaba_account=$1 AND device_id=$2', [auth.account, auth.deviceId]);
    return session(license, auth.deviceId, auth.connectionPolicyVersion);
  });
  response.json(result);
});

app.get('/api/admin/licenses', requireAdmin, async (request, response) => {
  const { page, pageSize, offset } = pagination(request.query);
  const filters = licenseFilters(request.query);
  const stateSql = "CASE WHEN l.deleted_at IS NOT NULL THEN 'deleted' WHEN l.status='active' AND l.expires_at<=now() THEN 'expired' ELSE l.status END";
  const from = `FROM licenses l LEFT JOIN (SELECT alibaba_account,COUNT(*) device_count,MAX(last_seen_at) last_seen_at FROM client_logins GROUP BY alibaba_account) c ON c.alibaba_account=l.alibaba_account AND l.deleted_at IS NULL`;
  const where = `WHERE (CASE WHEN cardinality($1::text[])=0 THEN l.deleted_at IS NULL ELSE ${stateSql}=ANY($1::text[]) END)
    AND ($2='' OR strpos(lower(l.alibaba_account),lower($2))>0 OR strpos(lower(l.note),lower($2))>0)
    AND ($3='all' OR ($3='multiple' AND l.allow_multi_device) OR ($3='single' AND NOT l.allow_multi_device))
    AND ($4='all' OR ($4='never' AND c.last_seen_at IS NULL) OR ($4='24h' AND c.last_seen_at>now()-interval '24 hours') OR ($4='30d' AND c.last_seen_at>now()-interval '30 days'))`;
  const values = [filters.statuses, filters.search, filters.devices, filters.activity];
  const total = (await pool.query(`SELECT COUNT(*)::int count ${from} ${where}`, values)).rows[0].count;
  const result = await pool.query(`SELECT l.*, ${stateSql} AS display_status, COALESCE(c.device_count,0)::int AS device_count, c.last_seen_at ${from} ${where} ORDER BY l.created_at DESC,l.id LIMIT $5 OFFSET $6`, [...values, pageSize, offset]);
  response.json({ items: result.rows.map(publicLicense), total, page, pageSize });
});
app.get('/api/admin/licenses/:id/history', requireAdmin, async (request, response) => {
  const { pageSize, offset } = pagination(request.query);
  response.json((await pool.query('SELECT * FROM license_events WHERE license_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3', [request.params.id, pageSize, offset])).rows);
});
app.post('/api/admin/licenses', requireAdmin, async (request, response) => {
  const account = normalize(request.body?.alibabaAccount); const days = daysValue(request.body?.days);
  if (!account || account.length > 200) throw fail('账号无效');
  response.json(await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [account]);
    const existing = (await client.query('SELECT * FROM licenses WHERE alibaba_account=$1 AND deleted_at IS NULL FOR UPDATE', [account])).rows[0];
    const base = existing && licenseState(existing) === 'active' ? new Date(existing.expires_at).getTime() : Date.now();
    const expires = new Date(base + days * 86400000);
    const credential = existing ? null : createActivationCredential();
    const result = await client.query(`INSERT INTO licenses (id,alibaba_account,status,starts_at,expires_at,note,credential_required,credential_hash) VALUES ($1,$2,'active',now(),$3,$4,$5,$6) ON CONFLICT (alibaba_account) WHERE deleted_at IS NULL DO UPDATE SET status='active',expires_at=EXCLUDED.expires_at,note=EXCLUDED.note,updated_at=now() RETURNING *`, [existing?.id || id(), account, expires, normalize(request.body?.note).slice(0, 2000), !existing, credential?.credentialHash || null]);
    await event(client, result.rows[0].id, existing ? 'extend' : 'activate', request.admin.username, { days });
    return { ...publicLicense(result.rows[0]), ...(credential ? { activationCode: credential.activationCode } : {}) };
  }));
});
app.patch('/api/admin/licenses/:id', requireAdmin, async (request, response) => {
  const action = normalize(request.body?.action);
  if (!['pause', 'resume', 'revoke', 'extend', 'reduce', 'devices', 'credential', 'connection'].includes(action)) throw fail('不支持的授权操作');
  response.json(await transaction(async (client) => {
    const existing = (await client.query('SELECT * FROM licenses WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!existing) throw fail('授权账号不存在', 404);
    if (existing.deleted_at) throw fail('账号已删除，不能修改原授权', 409);
    const values = [existing.id]; let query; let credential; let sessionsRevoked;
    if (action === 'connection') {
      values.push(offlineGraceMinutes(request.body.offlineGraceMinutes));
      query = 'UPDATE licenses SET offline_grace_minutes=$2,updated_at=now() WHERE id=$1 RETURNING *';
    } else if (action === 'credential') {
      sessionsRevoked = credentialResetRevokesSessions(existing, request.body.revokeSessions);
      credential = createActivationCredential();
      values.push(credential.credentialHash, sessionsRevoked ? 1 : 0);
      query = 'UPDATE licenses SET credential_required=true,credential_hash=$2,credential_version=credential_version+$3,updated_at=now() WHERE id=$1 RETURNING *';
    } else if (action === 'devices') {
      if (typeof request.body.allowMultiDevice !== 'boolean') throw fail('多端登录开关无效');
      query = `UPDATE licenses SET allow_multi_device=$2,active_device_id=CASE WHEN $2 THEN NULL ELSE (SELECT device_id FROM client_logins WHERE alibaba_account=licenses.alibaba_account ORDER BY last_seen_at DESC,id LIMIT 1) END,updated_at=now() WHERE id=$1 RETURNING *`;
      values.push(request.body.allowMultiDevice);
    } else if (action === 'extend') {
      values.push(daysValue(request.body.days));
      query = `UPDATE licenses SET status='active',expires_at=GREATEST(expires_at,now())+($2*interval '1 day'),updated_at=now() WHERE id=$1 RETURNING *`;
    } else if (action === 'reduce') {
      values.push(daysValue(request.body.days));
      query = `UPDATE licenses SET expires_at=expires_at-($2*interval '1 day'),updated_at=now() WHERE id=$1 RETURNING *`;
    } else {
      if (action === 'resume' && new Date(existing.expires_at).getTime() <= Date.now()) throw fail('授权已到期，请先延长有效期', 409);
      query = "UPDATE licenses SET status=$2,credential_version=credential_version+CASE WHEN $2 IN ('paused','revoked') THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 RETURNING *";
      values.push({ pause: 'paused', resume: 'active', revoke: 'revoked' }[action]);
    }
    const updated = (await client.query(query, values)).rows[0];
    await event(client, existing.id, action, request.admin.username, { days: request.body.days || null, allowMultiDevice: updated.allow_multi_device, previousExpiresAt: existing.expires_at, expiresAt: updated.expires_at, previousOfflineGraceMinutes: existing.offline_grace_minutes, offlineGraceMinutes: updated.offline_grace_minutes, ...(credential ? { sessionsRevoked } : {}) });
    return { ...publicLicense(updated), ...(credential ? { activationCode: credential.activationCode, sessionsRevoked } : {}) };
  }));
});
app.delete('/api/admin/licenses/:id', requireAdmin, async (request, response) => {
  response.json(await transaction(async (client) => {
    const existing = (await client.query('SELECT * FROM licenses WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!existing) throw fail('授权账号不存在', 404);
    if (existing.deleted_at) return { ok: true };
    await client.query("UPDATE licenses SET status='revoked',deleted_at=now(),active_device_id=NULL,updated_at=now() WHERE id=$1", [existing.id]);
    await client.query('DELETE FROM client_logins WHERE alibaba_account=$1', [existing.alibaba_account]);
    await event(client, existing.id, 'delete', request.admin.username, { account: existing.alibaba_account });
    return { ok: true };
  }));
});
app.get('/api/admin/stats', requireAdmin, async (_request, response) => {
  const results = await Promise.all([
    pool.query("SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL)::int total,COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int deleted,COUNT(*) FILTER (WHERE deleted_at IS NULL AND status='active' AND expires_at>now())::int active,COUNT(*) FILTER (WHERE deleted_at IS NULL AND status='active' AND expires_at<=now())::int expired,COUNT(*) FILTER (WHERE deleted_at IS NULL AND status='paused')::int paused,COUNT(*) FILTER (WHERE deleted_at IS NULL AND status='revoked')::int revoked FROM licenses"),
    pool.query("SELECT COUNT(DISTINCT c.alibaba_account) FILTER (WHERE c.last_seen_at>now()-interval '24 hours')::int active24,COUNT(DISTINCT c.alibaba_account) FILTER (WHERE c.last_seen_at>now()-interval '30 days')::int active30 FROM client_logins c JOIN licenses l ON l.alibaba_account=c.alibaba_account AND l.deleted_at IS NULL"),
    pool.query("SELECT COUNT(*)::int count FROM license_events WHERE action='client-login'")
  ]);
  response.json({ ...results[0].rows[0], paidUsers: results[0].rows[0].active, activeUsers24h: results[1].rows[0].active24, activeUsers30d: results[1].rows[0].active30, loginCount: results[2].rows[0].count });
});

// Published announcements are public product notices; drafts remain admin-only.
app.get('/api/announcements', async (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json((await pool.query("SELECT id,title,content,blocks,kind,popup_policy,revision,published_at,updated_at FROM announcements WHERE status='published' ORDER BY published_at DESC,id")).rows);
});
app.get('/api/admin/announcements', requireAdmin, async (request, response) => {
  const { page, pageSize, offset } = pagination(request.query);
  const total = (await pool.query('SELECT COUNT(*)::int count FROM announcements')).rows[0].count;
  const items = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC,id LIMIT $1 OFFSET $2', [pageSize, offset])).rows;
  response.json({ items, total, page, pageSize });
});
app.post('/api/admin/announcements', requireAdmin, async (request, response) => {
  const data = announcementInput(request.body);
  await validateAnnouncementImages(data.blocks);
  const result = await pool.query(`INSERT INTO announcements (id,title,content,kind,status,author,blocks,popup_policy,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,CASE WHEN $5='published' THEN now() ELSE NULL END) RETURNING *`, [id(), data.title, data.content, data.kind, data.status, request.admin.username, JSON.stringify(data.blocks), data.popup_policy]);
  response.status(201).json(result.rows[0]);
});
app.patch('/api/admin/announcements/:id', requireAdmin, async (request, response) => {
  const data = announcementInput(request.body);
  await validateAnnouncementImages(data.blocks);
  const result = await pool.query(`UPDATE announcements SET title=$2,content=$3,kind=$4,status=$5,author=$6,blocks=$7::jsonb,popup_policy=$8,revision=revision+1,published_at=CASE WHEN $5='published' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1 RETURNING *`, [request.params.id, data.title, data.content, data.kind, data.status, request.admin.username, JSON.stringify(data.blocks), data.popup_policy]);
  if (!result.rows[0]) throw fail('公告不存在', 404);
  response.json(result.rows[0]);
});
app.delete('/api/admin/announcements/:id', requireAdmin, async (request, response) => {
  await pool.query('DELETE FROM announcements WHERE id=$1', [request.params.id]);
  response.json({ ok: true });
});
app.use((error, request, response, _next) => {
  const status = error.status || (error.code === '22P02' ? 400 : 500);
  if (status === 500) console.error('Authorization request failed:', error.code || error.name);
  const message = status === 500 ? '授权服务内部错误' : error.code === '22P02' ? '请求标识无效' : error.message;
  response.status(status).json({ error: message, ...(request.path.startsWith('/api/client/') ? { authorized: false, reason: message } : {}) });
});
const listener = app.listen(port, process.env.BIND_HOST || '0.0.0.0', () => console.log(`Kua Yipu authorization service: http://127.0.0.1:${listener.address().port}`));
process.on('SIGTERM', () => listener.close(() => pool.end().finally(() => process.exit(0))));
