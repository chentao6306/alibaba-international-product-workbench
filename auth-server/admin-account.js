import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fixedWindowLimiter } from './http-security.js';

const scrypt = promisify(crypto.scrypt);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export async function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scrypt(password, salt, 64)).toString('hex')}`;
}

export async function verifyAdminPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [scheme, salt, expected] = String(hash || '').split('$');
  const computed = await scrypt(password, salt || 'invalid-admin-account', 64);
  return Boolean(scheme === 'scrypt' && salt && /^[a-f0-9]{128}$/i.test(expected || '') && crypto.timingSafeEqual(computed, Buffer.from(expected, 'hex')));
}

export function accountChangeInput(body = {}) {
  if (!body || typeof body !== 'object') throw fail('账号信息格式不正确');
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!/^[\p{L}\p{N}_.@+-]{1,80}$/u.test(username)) throw fail('账号须为 1–80 位文字、数字或 _ . @ + -，不能包含空格');
  if (typeof body.currentPassword !== 'string' || !body.currentPassword || body.currentPassword.length > 1024) throw fail('请填写当前密码');
  const newPassword = body.newPassword ?? '';
  const confirmPassword = body.confirmPassword ?? '';
  if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string') throw fail('新密码格式不正确');
  if (newPassword && (newPassword.length < 12 || newPassword.length > 128 || !newPassword.trim())) throw fail('新密码须为 12–128 位');
  if (newPassword !== confirmPassword) throw fail('两次输入的新密码不一致');
  return { username, currentPassword: body.currentPassword, newPassword };
}

export async function changedAccount(current, input) {
  if (!await verifyAdminPassword(input.currentPassword, current.password_hash)) throw fail('当前密码不正确', 403);
  if (!input.newPassword && input.username === current.username) throw fail('请修改账号或填写新密码');
  return { username: input.username, password_hash: input.newPassword ? await hashAdminPassword(input.newPassword) : current.password_hash };
}

export function postgresAccountChanger({ transaction, passwordFingerprint }) {
  return async (auth, input) => {
    try {
      return await transaction(async (client) => {
        // Lock the user and recheck the session inside the transaction: two
        // simultaneous changes must not restore a revoked credential/session.
        const current = (await client.query('SELECT u.*,s.password_fingerprint FROM admin_users u JOIN admin_sessions s ON s.admin_id=u.id WHERE s.id=$1 AND s.expires_at>now() AND u.username=$2 FOR UPDATE OF u', [auth.sid, auth.username])).rows[0];
        if (!current || current.password_fingerprint !== passwordFingerprint(current.password_hash)) throw fail('管理员登录已失效', 401);
        const updated = await changedAccount(current, input);
        await client.query('UPDATE admin_users SET username=$2,password_hash=$3 WHERE id=$1', [current.id, updated.username, updated.password_hash]);
        await client.query('DELETE FROM admin_sessions WHERE admin_id=$1', [current.id]);
        return { username: updated.username };
      });
    } catch (error) {
      if (error.code === '23505') throw fail('该管理员账号已被使用，请更换账号', 409);
      throw error;
    }
  };
}

export function registerAdminAccountRoutes(app, { requireAdmin, changeAccount }) {
  app.get('/api/admin/account', requireAdmin, (request, response) => response.json({ username: request.admin.username }));
  app.patch('/api/admin/account', requireAdmin, fixedWindowLimiter({ limit: 12, windowMs: 15 * 60000 }), async (request, response) => {
    const result = await changeAccount(request.admin, accountChangeInput(request.body));
    response.json({ ok: true, username: result.username, loginRequired: true });
  });
}
