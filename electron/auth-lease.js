// Use server time for expiry and a monotonic clock for elapsed time. Never use
// the user's wall clock to extend a license or an offline grace period.
export class AuthorizationLease {
  constructor({ now = () => performance.now(), maxAge = 70000 } = {}) {
    this.now = now;
    this.maxAge = maxAge;
    this.deadline = 0;
    this.licenseDeadline = 0;
  }

  renew(response, requestStarted = this.now()) {
    const serverTime = Date.parse(response.serverTime);
    const expires = Date.parse(response.expiresAt);
    const configured = response.offlineGraceSeconds;
    if (configured !== undefined && (!Number.isInteger(configured) || configured < 60 || configured > 3600)) {
      this.clear();
      throw new Error('服务器断线策略无效，请联系管理员');
    }
    const duration = Math.min(configured === undefined ? this.maxAge : configured * 1000, expires - serverTime);
    if (!response.authorized || !Number.isFinite(duration) || duration <= 0) {
      this.clear();
      throw new Error('授权已到期或服务器校验结果无效，请重新登录');
    }
    this.deadline = requestStarted + duration;
    this.licenseDeadline = requestStarted + expires - serverTime;
    if (!this.valid()) throw new Error('授权校验超时，请重新登录');
  }

  valid() { return this.deadline > this.now(); }
  expired() { return this.licenseDeadline > 0 && this.licenseDeadline <= this.now(); }
  remainingSeconds() { return Math.max(0, Math.ceil((this.deadline - this.now()) / 1000)); }
  clear() { this.deadline = 0; this.licenseDeadline = 0; }
}

export function isRetryableAuthorizationError(error) {
  return error?.retryable === true || [408, 429, 500, 502, 503, 504].includes(error?.status);
}
