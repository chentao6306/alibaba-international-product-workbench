export const SOURCE_LANGUAGE_HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' };

const COUNTRY_CODES = {
  'United States': 'US', 'United Kingdom': 'GB', Germany: 'DE', Canada: 'CA',
  Australia: 'AU', 'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE'
};

export async function withSourceLocale(context, callback, options = {}) {
  const original = await context.cookies('https://www.alibaba.com');
  const changed = original.map((cookie) => {
    let value = cookie.value;
    if (cookie.name === '_lang') value = 'en_US:GB18030';
    if (cookie.name === 'intl_locale') value = 'en_US';
    if (cookie.name === 'sc_g_cfg_f') value = value.replace(/sc_b_locale=[^&]*/i, 'sc_b_locale=en_US');
    if (cookie.name === 'xman_us_f') value = value.replace(/x_locale=[^&]*/i, 'x_locale=en_US');
    if (cookie.name === 'buyer_ship_to_info' && COUNTRY_CODES[options.destinationCountry]) {
      value = value.replace(/local_country=[^&]*/i, `local_country=${COUNTRY_CODES[options.destinationCountry]}`);
    }
    return value === cookie.value ? null : { ...cookie, value };
  }).filter(Boolean);
  try {
    if (changed.length) await context.addCookies(changed);
    return await callback();
  } finally {
    if (changed.length) {
      const keys = new Set(changed.map((cookie) => `${cookie.name}|${cookie.domain}|${cookie.path}`));
      await context.addCookies(original.filter((cookie) => keys.has(`${cookie.name}|${cookie.domain}|${cookie.path}`)));
    }
  }
}
