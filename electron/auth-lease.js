// Use server time for expiry and a monotonic clock for elapsed time. Never use
// the user's wall clock to extend a license or an offline grace period.
export class AuthorizationLease {
  constructor({ now = () => performance.now(), maxAge = 70000 } = {}) {
    this.now = now;
    this.maxAge = maxAge;
    this.deadline = 0;
  }

  renew(response, requestStarted = this.now()) {
    const serverTime = Date.parse(response.serverTime);
    const expires = Date.parse(response.expiresAt);
    const duration = Math.min(this.maxAge, expires - serverTime);
    if (!response.authorized || !Number.isFinite(duration) || duration <= 0) {
      this.clear();
      throw new Error('授权已到期或服务器校验结果无效，请重新登录');
    }
    this.deadline = requestStarted + duration;
    if (!this.valid()) throw new Error('授权校验超时，请重新登录');
  }

  valid() { return this.deadline > this.now(); }
  clear() { this.deadline = 0; }
}
