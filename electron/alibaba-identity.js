export function matchesAlibabaSession(cookies, username, url) {
  try {
    const page = new URL(url);
    if (page.protocol !== 'https:' || !/(^|\.)alibaba\.com$/i.test(page.hostname) || /login|passport|signin/i.test(page.hostname + page.pathname)) return false;
  } catch { return false; }
  const accounts = cookies.filter((cookie) => cookie.name === 'xman_us_t' && /(^|\.)alibaba\.com$/i.test(cookie.domain))
    .map((cookie) => new URLSearchParams(cookie.value)).filter((values) => values.get('sign') === 'y');
  return accounts.length > 0 && accounts.every((values) => values.get('x_lid')?.trim().toLowerCase() === String(username).trim().toLowerCase());
}

export function checkAlibabaLoginAccount(cookies, username, url) {
  if (matchesAlibabaSession(cookies, username, url)) return true;
  // Only reject a different account after Alibaba confirms it is signed in;
  // an anonymous page or a login redirect is still an unfinished login.
  const otherAccount = cookies.some((cookie) => {
    if (cookie.name !== 'xman_us_t' || !/(^|\.)alibaba\.com$/i.test(cookie.domain)) return false;
    const values = new URLSearchParams(cookie.value);
    const account = values.get('x_lid')?.trim().toLowerCase();
    return values.get('sign') === 'y' && account && account !== String(username).trim().toLowerCase();
  });
  if (otherAccount) throw new Error('Alibaba 实际登录账号与软件授权账号不一致，请返回软件登录页重新登录');
  return false;
}
