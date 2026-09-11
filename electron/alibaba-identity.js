export function matchesAlibabaSession(cookies, username, url) {
  try {
    const page = new URL(url);
    if (page.protocol !== 'https:' || !/(^|\.)alibaba\.com$/i.test(page.hostname) || /login|passport|signin/i.test(page.hostname + page.pathname)) return false;
  } catch { return false; }
  return cookies.some((cookie) => {
    if (cookie.name !== 'xman_us_t' || !/(^|\.)alibaba\.com$/i.test(cookie.domain)) return false;
    const values = new URLSearchParams(cookie.value);
    return values.get('sign') === 'y' && values.get('x_lid')?.trim().toLowerCase() === String(username).trim().toLowerCase();
  });
}
