export const DEFAULT_SERVICE_ORIGIN = 'https://106.55.45.126';

export function authorizationEndpoint(value = DEFAULT_SERVICE_ORIGIN, { development = false } = {}) {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:'))) {
    throw new Error('授权服务器必须使用 HTTPS 安全连接');
  }
  return url.origin;
}
