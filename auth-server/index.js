import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientAllowed, licenseState, pagination, announcementInput } from './policy.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '128kb' }));
const port = Number(process.env.PORT || 8790);
const signingSecret = String(process.env.KUA_YIPU_AUTH_SECRET || '');
if (!process.env.DATABASE_URL || signingSecret.length < 32) throw new Error('DATABASE_URL and KUA_YIPU_AUTH_SECRET (at least 32 chars) are required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
const id = () => crypto.randomUUID();
const normalize = (value) => String(value || '').trim();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const daysValue = (value) => {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0 || days > 36500) throw fail('授权天数必须大于 0 且不超过 36500');
  return days;
};
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', signingSecret).update(body).digest('base64url')}`;
};
const verify = (token) => {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', signingSecret).update(body).digest('base64url');
  if (Buffer.byteLength(mac) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try { const payload = JSON.parse(Buffer.from(body, 'base64url')); return payload.exp > Date.now() ? payload : null; } catch { return null; }
};
const bearer = (request) => verify(request.headers.authorization?.replace(/^Bearer\s+/i, ''));
const requireAdmin = (request, response, next) => {
  const auth = bearer(request);
  if (!auth?.admin) return response.status(401).json({ error: '管理员登录已失效' });
  request.admin = auth; next();
};
const session = (license, deviceId) => ({ authorized: true, expiresAt: license.expires_at, token: sign({ account: license.alibaba_account, licenseId: license.id, deviceId, exp: Math.min(new Date(license.expires_at).getTime(), Date.now() + 10 * 60 * 1000) }) });
async function transaction(work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
const event = (client, licenseId, action, actor, metadata = {}) => client.query('INSERT INTO license_events (id,license_id,action,actor,metadata) VALUES ($1,$2,$3,$4,$5)', [id(), licenseId, action, actor, JSON.stringify(metadata)]);

app.get('/health', (_request, response) => response.json({ ok: true, service: 'kua-yipu-auth', version: '1.4.0' }));
app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'admin.html')));
for (const file of ['admin.js', 'admin.css']) app.get(`/${file}`, (_request, response) => response.sendFile(path.join(__dirname, file)));
app.post('/api/admin/login', async (request, response) => {
  const username = normalize(request.body?.username);
  const result = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
  const [, salt, expected] = String(result.rows[0]?.password_hash || '').split('$');
  const valid = salt && /^[a-f0-9]{128}$/i.test(expected || '') && crypto.timingSafeEqual(crypto.scryptSync(String(request.body?.password || ''), salt, 64), Buffer.from(expected, 'hex'));
  if (!valid) throw fail('管理员账号或密码错误', 401);
  response.json({ token: sign({ admin: true, username, exp: Date.now() + 8 * 60 * 60 * 1000 }), username });
});

app.post('/api/client/login', async (request, response) => {
  const account = normalize(request.body?.username); const deviceId = normalize(request.body?.deviceId);
  if (!account || !deviceId || account.length > 200 || deviceId.length > 200) throw fail('缺少或无效的 Alibaba 账号或设备标识');
  const result = await transaction(async (client) => {
    const license = (await client.query('SELECT * FROM licenses WHERE alibaba_account=$1 FOR UPDATE', [account])).rows[0];
    if (!license || licenseState(license) !== 'active') throw fail('该 Alibaba 账号没有有效的软件授权', 403);
    if (!license.allow_multi_device) await client.query('UPDATE licenses SET active_device_id=$2 WHERE id=$1', [license.id, deviceId]);
    await client.query(`INSERT INTO client_logins (id,alibaba_account,device_id,device_name,app_version,ip_address,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (alibaba_account,device_id) DO UPDATE SET device_name=EXCLUDED.device_name,app_version=EXCLUDED.app_version,ip_address=EXCLUDED.ip_address,last_seen_at=now()`, [id(), account, deviceId, normalize(request.body?.deviceName).slice(0, 200), normalize(request.body?.appVersion).slice(0, 50), request.ip]);
    await event(client, license.id, 'client-login', account, { deviceId });
    return session(license, deviceId);
  });
  response.json(result);
});

app.post('/api/client/heartbeat', async (request, response) => {
  const auth = bearer(request);
  if (!auth?.account) throw fail('授权会话已失效', 401);
  const result = await transaction(async (client) => {
    const license = (await client.query('SELECT * FROM licenses WHERE id=$1 AND alibaba_account=$2 FOR UPDATE', [auth.licenseId, auth.account])).rows[0];
    if (!license || licenseState(license) !== 'active') throw fail('软件授权已停用或过期', 403);
    if (!clientAllowed(license, auth.deviceId)) throw fail('此账号已设为单设备登录，当前会话已被另一台设备替换', 403);
    if (!license.allow_multi_device && !license.active_device_id) await client.query('UPDATE licenses SET active_device_id=$2 WHERE id=$1', [license.id, auth.deviceId]);
    await client.query('UPDATE client_logins SET last_seen_at=now() WHERE alibaba_account=$1 AND device_id=$2', [auth.account, auth.deviceId]);
    return session(license, auth.deviceId);
  });
  response.json(result);
});

app.get('/api/admin/licenses', requireAdmin, async (request, response) => {
  const { page, pageSize, offset } = pagination(request.query);
  const status = String(request.query.status || 'all');
  const search = String(request.query.search || '').trim().slice(0, 160);
  const stateSql = "CASE WHEN l.status='active' AND l.expires_at<=now() THEN 'expired' ELSE l.status END";
  const where = `WHERE ($1='all' OR ${stateSql}=$1) AND ($2='' OR strpos(lower(l.alibaba_account),lower($2))>0 OR strpos(lower(l.note),lower($2))>0)`;
  const total = (await pool.query(`SELECT COUNT(*)::int count FROM licenses l ${where}`, [status, search])).rows[0].count;
  const result = await pool.query(`SELECT l.*, ${stateSql} AS display_status, COALESCE(c.device_count,0)::int AS device_count, c.last_seen_at FROM licenses l LEFT JOIN (SELECT alibaba_account,COUNT(*) device_count,MAX(last_seen_at) last_seen_at FROM client_logins GROUP BY alibaba_account) c ON c.alibaba_account=l.alibaba_account ${where} ORDER BY l.created_at DESC,l.id LIMIT $3 OFFSET $4`, [status, search, pageSize, offset]);
  response.json({ items: result.rows, total, page, pageSize });
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
    const existing = (await client.query('SELECT * FROM licenses WHERE alibaba_account=$1 FOR UPDATE', [account])).rows[0];
    const base = existing && licenseState(existing) === 'active' ? new Date(existing.expires_at).getTime() : Date.now();
    const expires = new Date(base + days * 86400000);
    const result = await client.query(`INSERT INTO licenses (id,alibaba_account,status,starts_at,expires_at,note) VALUES ($1,$2,'active',now(),$3,$4) ON CONFLICT (alibaba_account) DO UPDATE SET status='active',expires_at=EXCLUDED.expires_at,note=EXCLUDED.note,updated_at=now() RETURNING *`, [existing?.id || id(), account, expires, normalize(request.body?.note).slice(0, 2000)]);
    await event(client, result.rows[0].id, existing ? 'extend' : 'activate', request.admin.username, { days });
    return result.rows[0];
  }));
});
app.patch('/api/admin/licenses/:id', requireAdmin, async (request, response) => {
  const action = normalize(request.body?.action);
  if (!['pause', 'resume', 'revoke', 'extend', 'devices'].includes(action)) throw fail('不支持的授权操作');
  response.json(await transaction(async (client) => {
    const existing = (await client.query('SELECT * FROM licenses WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!existing) throw fail('授权账号不存在', 404);
    const values = [existing.id]; let query;
    if (action === 'devices') {
      if (typeof request.body.allowMultiDevice !== 'boolean') throw fail('多端登录开关无效');
      query = `UPDATE licenses SET allow_multi_device=$2,active_device_id=CASE WHEN $2 THEN NULL ELSE (SELECT device_id FROM client_logins WHERE alibaba_account=licenses.alibaba_account ORDER BY last_seen_at DESC,id LIMIT 1) END,updated_at=now() WHERE id=$1 RETURNING *`;
      values.push(request.body.allowMultiDevice);
    } else if (action === 'extend') {
      values.push(daysValue(request.body.days));
      query = `UPDATE licenses SET status='active',expires_at=GREATEST(expires_at,now())+($2*interval '1 day'),updated_at=now() WHERE id=$1 RETURNING *`;
    } else {
      if (action === 'resume' && new Date(existing.expires_at).getTime() <= Date.now()) throw fail('授权已到期，请先延长有效期', 409);
      query = 'UPDATE licenses SET status=$2,updated_at=now() WHERE id=$1 RETURNING *';
      values.push({ pause: 'paused', resume: 'active', revoke: 'revoked' }[action]);
    }
    const updated = (await client.query(query, values)).rows[0];
    await event(client, existing.id, action, request.admin.username, { days: request.body.days || null, allowMultiDevice: updated.allow_multi_device });
    return updated;
  }));
});
app.get('/api/admin/stats', requireAdmin, async (_request, response) => {
  const results = await Promise.all([
    pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE status='active' AND expires_at>now())::int active,COUNT(*) FILTER (WHERE status='active' AND expires_at<=now())::int expired,COUNT(*) FILTER (WHERE status='paused')::int paused,COUNT(*) FILTER (WHERE status='revoked')::int revoked FROM licenses"),
    pool.query("SELECT COUNT(DISTINCT alibaba_account) FILTER (WHERE last_seen_at>now()-interval '24 hours')::int active24,COUNT(DISTINCT alibaba_account) FILTER (WHERE last_seen_at>now()-interval '30 days')::int active30 FROM client_logins"),
    pool.query("SELECT COUNT(*)::int count FROM license_events WHERE action='client-login'")
  ]);
  response.json({ ...results[0].rows[0], paidUsers: results[0].rows[0].active, activeUsers24h: results[1].rows[0].active24, activeUsers30d: results[1].rows[0].active30, loginCount: results[2].rows[0].count });
});

// Published announcements are public product notices; drafts remain admin-only.
app.get('/api/announcements', async (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json((await pool.query("SELECT id,title,content,kind,revision,published_at,updated_at FROM announcements WHERE status='published' ORDER BY published_at DESC,id")).rows);
});
app.get('/api/admin/announcements', requireAdmin, async (request, response) => {
  const { page, pageSize, offset } = pagination(request.query);
  const total = (await pool.query('SELECT COUNT(*)::int count FROM announcements')).rows[0].count;
  const items = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC,id LIMIT $1 OFFSET $2', [pageSize, offset])).rows;
  response.json({ items, total, page, pageSize });
});
app.post('/api/admin/announcements', requireAdmin, async (request, response) => {
  const data = announcementInput(request.body);
  const result = await pool.query(`INSERT INTO announcements (id,title,content,kind,status,author,published_at) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $5='published' THEN now() ELSE NULL END) RETURNING *`, [id(), data.title, data.content, data.kind, data.status, request.admin.username]);
  response.status(201).json(result.rows[0]);
});
app.patch('/api/admin/announcements/:id', requireAdmin, async (request, response) => {
  const data = announcementInput(request.body);
  const result = await pool.query(`UPDATE announcements SET title=$2,content=$3,kind=$4,status=$5,author=$6,revision=revision+1,published_at=CASE WHEN $5='published' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1 RETURNING *`, [request.params.id, data.title, data.content, data.kind, data.status, request.admin.username]);
  if (!result.rows[0]) throw fail('公告不存在', 404);
  response.json(result.rows[0]);
});
app.use((error, request, response, _next) => {
  const status = error.status || (error.code === '22P02' ? 400 : 500);
  if (status === 500) console.error('Authorization request failed:', error.code || error.name);
  const message = status === 500 ? '授权服务内部错误' : error.code === '22P02' ? '请求标识无效' : error.message;
  response.status(status).json({ error: message, ...(request.path.startsWith('/api/client/') ? { authorized: false, reason: message } : {}) });
});
const listener = app.listen(port, process.env.BIND_HOST || '0.0.0.0', () => console.log(`Kua Yipu authorization service listening on ${port}`));
process.on('SIGTERM', () => listener.close(() => pool.end().finally(() => process.exit(0))));
