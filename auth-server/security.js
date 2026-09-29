import crypto from 'node:crypto';

export function offlineGraceMinutes(value = 1440) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 21600) {
    throw Object.assign(new Error('断线宽限时间必须为 1 至 21600 分钟（15 天）的整数'), { status: 400 });
  }
  return value;
}

export function createActivationCredential() {
  const activationCode = `CDK-${crypto.randomBytes(32).toString('base64url')}`;
  return { activationCode, credentialHash: crypto.createHash('sha256').update(activationCode).digest('hex') };
}

export function credentialResetRevokesSessions(license, revokeSessions = true) {
  if (typeof revokeSessions !== 'boolean') {
    throw Object.assign(new Error('退出已登录设备选项必须为布尔值'), { status: 400 });
  }
  // Keep the previous API default for older admin pages. Enabling credentials
  // must always revoke sessions that never verified an activation code.
  return !license.credential_required || revokeSessions;
}

export function validActivation(license, value) {
  if (!license?.credential_required) return true;
  if (typeof value !== 'string' || !/^CDK-[A-Za-z0-9_-]{43}$/.test(value.trim())) return false;
  if (!/^[a-f0-9]{64}$/.test(license.credential_hash || '')) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(value.trim()).digest(), Buffer.from(license.credential_hash, 'hex'));
}

export function publicLicense(license) {
  const { credential_hash, ...visible } = license;
  return visible;
}

export function requireCredentialTransport(request, license) {
  if (!license.credential_required) return;
  const directLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) && !request.headers['x-forwarded-proto'];
  if (!request.secure && !directLocal) throw Object.assign(new Error('软件授权码必须通过 HTTPS 安全连接验证，请更新客户端'), { status: 426 });
}

export function clientSessionAllowed(license, auth) {
  return Boolean(auth && !auth.admin && (!auth.aud || auth.aud === 'client') && typeof auth.deviceId === 'string' && auth.deviceId
    && Number(auth.credentialVersion || 0) === Number(license.credential_version || 0)
    && (!license.credential_required || auth.aud === 'client' && auth.credentialVerified === true));
}

export function clientClaims(license, deviceId, connectionPolicyVersion = 1) {
  return { aud: 'client', account: license.alibaba_account, licenseId: license.id, deviceId,
    connectionPolicyVersion: connectionPolicyVersion === 2 ? 2 : 1,
    credentialVersion: Number(license.credential_version || 0), credentialVerified: Boolean(license.credential_required),
    exp: Math.min(new Date(license.expires_at).getTime(), Date.now() + Math.max(10, offlineGraceMinutes(license.offline_grace_minutes) + 2) * 60000) };
}

export function clientSession(license, deviceId, sign, connectionPolicyVersion = 1) {
  const claims = clientClaims(license, deviceId, connectionPolicyVersion);
  return { authorized: true, serverTime: new Date().toISOString(), expiresAt: license.expires_at,
    offlineGraceSeconds: Math.min(offlineGraceMinutes(license.offline_grace_minutes) * 60, claims.connectionPolicyVersion === 2 ? 1296000 : 3600),
    token: sign(claims) };
}

export function tokenCodec(secret) {
  const sign = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  const verify = (token) => {
    if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [body, mac] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url'));
      return payload && Number.isFinite(payload.exp) && payload.exp > Date.now() ? payload : null;
    } catch { return null; }
  };
  return { sign, verify };
}
