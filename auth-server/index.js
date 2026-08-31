import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '64kb' }));
const port = Number(process.env.PORT || 8790);
const signingSecret = String(process.env.KUA_YIPU_AUTH_SECRET || '');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });

if (!process.env.DATABASE_URL || signingSecret.length < 32) {
  console.error('DATABASE_URL and KUA_YIPU_AUTH_SECRET (at least 32 chars) are required');
  process.exit(1);
}

const id = () => crypto.randomUUID();
const now = () => new Date();
const normalize = (value) => String(value || '').trim();
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
};
const verifyPassword = (password, encoded) => {
  const [, salt, expected] = String(encoded || '').split('$');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
};
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', signingSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
};
const verify = (token) => {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', signingSecret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try { const payload = JSON.parse(Buffer.from(body, 'base64url').toString()); return payload.exp > Date.now() ? payload : null; } catch { return null; }
};
const bearer = (request) => verify(request.headers.authorization?.replace(/^Bearer\s+/i, ''));
const requireAdmin = (request, response, next) => { const auth = bearer(request); if (!auth?.admin) return response.status(401).json({ error: '管理员登录已失效' }); request.admin = auth; next(); };

app.get('/health', (_request, response) => response.json({ ok: true, service: 'kua-yipu-auth' }));
app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'admin.html')));
app.post('/api/admin/login', async (request, response, next) => {
  try {
    const username = normalize(request.body?.username); const password = String(request.body?.password || '');
    const result = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
    if (!result.rows[0] || !verifyPassword(password, result.rows[0].password_hash)) return response.status(401).json({ error: '管理员账号或密码错误' });
    response.json({ token: sign({ admin: true, username, exp: Date.now() + 8 * 60 * 60 * 1000 }), username });
  } catch (error) { next(error); }
});

app.post('/api/client/login', async (request, response, next) => {
  try {
    const account = normalize(request.body?.username); const deviceId = normalize(request.body?.deviceId);
    if (!account || !deviceId) return response.status(400).json({ error: '缺少 Alibaba 账号或设备标识' });
    const result = await pool.query('SELECT * FROM licenses WHERE alibaba_account=$1', [account]);
    const license = result.rows[0]; const current = now();
    if (!license || license.status !== 'active' || new Date(license.expires_at) <= current) {
      return response.status(403).json({ authorized: false, reason: '该 Alibaba 账号没有有效的软件授权' });
    }
    await pool.query(`INSERT INTO client_logins (id,alibaba_account,device_id,device_name,app_version,ip_address,last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (alibaba_account,device_id) DO UPDATE SET device_name=EXCLUDED.device_name,app_version=EXCLUDED.app_version,ip_address=EXCLUDED.ip_address,last_seen_at=now()`,
      [id(), account, deviceId, normalize(request.body?.deviceName), normalize(request.body?.appVersion), request.ip]);
    await pool.query('INSERT INTO license_events (id,license_id,action,actor,metadata) VALUES ($1,$2,$3,$4,$5)', [id(), license.id, 'client-login', account, JSON.stringify({ deviceId })]);
    response.json({ authorized: true, token: sign({ account, licenseId: license.id, deviceId, exp: Math.min(new Date(license.expires_at).getTime(), Date.now() + 10 * 60 * 1000) }), expiresAt: license.expires_at });
  } catch (error) { next(error); }
});

app.post('/api/client/heartbeat', async (request, response, next) => {
  try {
    const auth = bearer(request); if (!auth?.account) return response.status(401).json({ authorized: false, reason: '授权会话已失效' });
    const result = await pool.query('SELECT status,expires_at FROM licenses WHERE id=$1 AND alibaba_account=$2', [auth.licenseId, auth.account]);
    const license = result.rows[0]; const authorized = Boolean(license && license.status === 'active' && new Date(license.expires_at) > now());
    if (!authorized) return response.status(403).json({ authorized: false, expiresAt: license?.expires_at || null, reason: '软件授权已暂停或过期' });
    response.json({ authorized: true, token: sign({ account: auth.account, licenseId: auth.licenseId, deviceId: auth.deviceId, exp: Math.min(new Date(license.expires_at).getTime(), Date.now() + 10 * 60 * 1000) }), expiresAt: license.expires_at });
  } catch (error) { next(error); }
});

app.get('/api/admin/licenses', requireAdmin, async (_request, response, next) => {
  try { const result = await pool.query(`SELECT l.*, COALESCE(c.login_count,0) AS login_count, c.last_seen_at FROM licenses l LEFT JOIN (SELECT alibaba_account,COUNT(*) login_count,MAX(last_seen_at) last_seen_at FROM client_logins GROUP BY alibaba_account) c ON c.alibaba_account=l.alibaba_account ORDER BY l.created_at DESC`); response.json(result.rows); } catch (error) { next(error); }
});

app.get('/api/admin/licenses/:id/history', requireAdmin, async (request, response, next) => {
  try { const result = await pool.query('SELECT * FROM license_events WHERE license_id=$1 ORDER BY created_at DESC', [request.params.id]); response.json(result.rows); } catch (error) { next(error); }
});

app.post('/api/admin/licenses', requireAdmin, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const account = normalize(request.body?.alibabaAccount); const days = Number(request.body?.days);
    if (!account || !Number.isFinite(days) || days <= 0 || days > 36500) return response.status(400).json({ error: '账号和有效天数无效' });
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM licenses WHERE alibaba_account=$1 FOR UPDATE', [account]);
    const starts = existing.rows[0]?.status === 'active' && new Date(existing.rows[0].expires_at) > now() ? new Date(existing.rows[0].expires_at) : now();
    const expires = new Date(starts.getTime() + days * 86400000); const licenseId = existing.rows[0]?.id || id();
    await client.query(`INSERT INTO licenses (id,alibaba_account,status,starts_at,expires_at,note) VALUES ($1,$2,'active',$3,$4,$5)
      ON CONFLICT (alibaba_account) DO UPDATE SET status='active',expires_at=EXCLUDED.expires_at,note=EXCLUDED.note,updated_at=now()`, [licenseId, account, starts, expires, normalize(request.body?.note)]);
    await client.query('INSERT INTO license_events (id,license_id,action,actor,metadata) VALUES ($1,$2,$3,$4,$5)', [id(), licenseId, existing.rows[0] ? 'extend' : 'activate', request.admin.username, JSON.stringify({ days })]);
    await client.query('COMMIT'); response.json({ id: licenseId, alibabaAccount: account, startsAt: starts, expiresAt: expires, status: 'active' });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client.release(); }
});

app.patch('/api/admin/licenses/:id', requireAdmin, async (request, response, next) => {
  try {
    const action = normalize(request.body?.action); const days = Number(request.body?.days);
    if (!['pause','resume','revoke','extend'].includes(action)) return response.status(400).json({ error: '不支持的授权操作' });
    const existing = (await pool.query('SELECT * FROM licenses WHERE id=$1', [request.params.id])).rows[0]; if (!existing) return response.status(404).json({ error: '授权账号不存在' });
    let query = ''; let values = [request.params.id];
    if (action === 'pause') query = `UPDATE licenses SET status='paused',updated_at=now() WHERE id=$1 RETURNING *`;
    if (action === 'resume') query = `UPDATE licenses SET status='active',updated_at=now() WHERE id=$1 AND expires_at>now() RETURNING *`;
    if (action === 'revoke') query = `UPDATE licenses SET status='revoked',updated_at=now() WHERE id=$1 RETURNING *`;
    if (action === 'extend') { if (!Number.isFinite(days) || days <= 0) return response.status(400).json({ error: '延长天数无效' }); query = `UPDATE licenses SET status='active',expires_at=GREATEST(expires_at,now()) + ($2 * interval '1 day'),updated_at=now() WHERE id=$1 RETURNING *`; values = [request.params.id, days]; }
    const updated = (await pool.query(query, values)).rows[0]; if (!updated) return response.status(409).json({ error: '授权已过期，无法恢复' });
    await pool.query('INSERT INTO license_events (id,license_id,action,actor,metadata) VALUES ($1,$2,$3,$4,$5)', [id(), existing.id, action, request.admin.username, JSON.stringify({ days: days || null })]);
    response.json(updated);
  } catch (error) { next(error); }
});

app.get('/api/admin/stats', requireAdmin, async (_request, response, next) => {
  try {
    const [paid, active24, active30, logins] = await Promise.all([
      pool.query("SELECT COUNT(*)::int count FROM licenses WHERE status='active' AND expires_at>now()"),
      pool.query("SELECT COUNT(DISTINCT alibaba_account)::int count FROM client_logins WHERE last_seen_at>now()-interval '24 hours'"),
      pool.query("SELECT COUNT(DISTINCT alibaba_account)::int count FROM client_logins WHERE last_seen_at>now()-interval '30 days'"),
      pool.query('SELECT COUNT(*)::int count FROM license_events WHERE action=\'client-login\'')
    ]);
    response.json({ paidUsers: paid.rows[0].count, activeUsers24h: active24.rows[0].count, activeUsers30d: active30.rows[0].count, loginCount: logins.rows[0].count });
  } catch (error) { next(error); }
});

app.use((error, _request, response, _next) => { console.error(error); response.status(500).json({ error: '授权服务内部错误' }); });
app.listen(port, '0.0.0.0', () => console.log(`Kua Yipu authorization service listening on ${port}`));
