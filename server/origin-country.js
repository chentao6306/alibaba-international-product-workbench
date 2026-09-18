const CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const english = new Intl.DisplayNames(['en'], { type: 'region' });
const chinese = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
// Match the posting form's option labels, including its legacy country names.
const names = {
  CN: 'China', HK: 'Hong Kong S.A.R.', MO: 'Macao S.A.R.', TW: 'Taiwan, China', KR: 'South Korea', KP: 'North Korea', RU: 'Russian Federation', VN: 'Vietnam', TR: 'Turkey', CZ: 'Czech Republic',
  AX: 'Aland Islands', BL: 'Saint Barthelemy', BN: 'Brunei Darussalam', CD: 'Congo, The Democratic Republic Of The', CG: 'Congo, The Republic of Congo', CI: "Cote D'Ivoire", CW: 'Curacao',
  FK: 'Falkland Islands (Malvinas)', GS: 'South Georgia and the South Sandwich Islands', HM: 'Heard and Mc Donald Islands', HR: 'Croatia (local name: Hrvatska)', IR: 'Iran (Islamic Republic of)',
  KN: 'Saint Kitts and Nevis', LA: "Lao People's Democratic Republic", LC: 'Saint Lucia', MF: 'Saint Martin', MK: 'Macedonia', MM: 'Myanmar', PN: 'Pitcairn', PS: 'Palestine',
  RE: 'Reunion', SJ: 'Svalbard and Jan Mayen Islands', SK: 'Slovakia (Slovak Republic)', ST: 'Sao Tome and Principe', SY: 'Syrian Arab Republic', SZ: 'Swaziland',
  UM: 'United States Minor Outlying Islands', VA: 'Vatican City State (Holy See)', VC: 'Saint Vincent and the Grenadines', VG: 'Virgin Islands (British)', VI: 'Virgin Islands (U.S.)', WF: 'Wallis And Futuna Islands',
};
const extraOptions = [
  ['AN', 'Netherlands Antilles', '荷属安的列斯'], ['AC', 'Ascension Island', '阿森松岛'], ['EAZ', 'Zanzibar', '桑给巴尔'], ['FX', 'France Metropolitan', '法国本土'],
  ['GBA', 'Alderney', '奥尔德尼岛'], ['XK', 'Kosovo', '科索沃'], ['SCT', 'Scotland', '苏格兰'], ['TP', 'East Timor', '东帝汶'], ['YU', 'Yugoslavia', '南斯拉夫'],
].map(([code, name, label]) => ({ code, name, label }));
export const ORIGIN_COUNTRIES = [...CODES.filter((code) => !['BQ', 'PR'].includes(code)).map((code) => ({ code, name: names[code] || english.of(code).replace(/&/g, 'and'), label: chinese.of(code) })), ...extraOptions];
const normalized = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ');
const aliases = new Map();
for (const country of ORIGIN_COUNTRIES) {
  for (const value of [country.code, country.name, country.label, ...(CODES.includes(country.code) ? [english.of(country.code)] : [])]) aliases.set(normalized(value), country.name);
  for (const value of [`${country.name} (${country.label})`, `${country.name}(${country.label})`, `${country.label} (${country.name})`, `${country.name} ${country.label}`]) aliases.set(normalized(value), country.name);
}
for (const [alias, code] of [['中国大陆', 'CN'], ['中国', 'CN'], ['中国香港', 'HK'], ['香港', 'HK'], ['中国澳门', 'MO'], ['澳门', 'MO'], ['中国台湾', 'TW'], ['台湾', 'TW'], ['USA', 'US'], ['UK', 'GB'], ['Korea', 'KR']]) {
  aliases.set(normalized(alias), ORIGIN_COUNTRIES.find((country) => country.code === code).name);
}

export function originCountry(value) {
  const text = normalized(value);
  if (aliases.has(text)) return aliases.get(text);
  // Retain the country from older source records such as "Guangdong, China".
  const parts = text.split(/[,，;；>\n]/).map((part) => part.trim()).filter(Boolean);
  const matches = [...new Set(parts.filter((part) => aliases.has(part)).map((part) => aliases.get(part)))];
  if (matches.length === 1) return matches[0];
  if (/^中国(?:广东|浙江|江苏|福建|上海|北京|山东|深圳|广州)/.test(text)) return 'China';
  return '';
}

export function isOriginRegionAttribute(name) {
  return /^(?:省|省份|省市|城市|province|state|city|province\s*\/\s*state|state\s*\/\s*province)$/i.test(String(name || '').trim());
}

export function isOriginAttribute(name) {
  return /^(?:原产地|产地|原产国|原产国家|place of origin|country of origin|origin|country\/region of manufacture)$/.test(
    normalized(name).replace(/^[*＊]\s*|\s*[:：]$/g, '')
  );
}

export function productOrigin(product = {}) {
  if (String(product.origin ?? '').trim()) return originCountry(product.origin);
  const values = [...(product.attributes || []), ...(product.customAttributes || [])]
    .filter((item) => isOriginAttribute(item.name)).map((item) => originCountry(item.value)).filter(Boolean);
  const countries = [...new Set(values)];
  return countries.length === 1 ? countries[0] : '';
}

// An edit to either representation updates both working fields. The immutable
// source snapshot is deliberately not part of this patch.
export function synchronizeProductOrigin(product, patch) {
  const explicit = Object.hasOwn(patch, 'origin');
  const changed = [];
  for (const field of ['attributes', 'customAttributes']) {
    if (!Array.isArray(patch[field])) continue;
    for (const row of patch[field].filter((item) => isOriginAttribute(item.name))) {
      const old = (product[field] || []).find((item) => isOriginAttribute(item.name) && normalized(item.name) === normalized(row.name));
      if (!old || String(old.value ?? '') !== String(row.value ?? '')) changed.push(row.value);
    }
  }
  if (!explicit && !changed.length) return patch;
  const raw = explicit && String(patch.origin ?? '') !== String(product.origin ?? '')
    ? patch.origin : changed.at(-1) ?? patch.origin;
  const country = originCountry(raw) || String(raw ?? '').trim();
  const next = { ...patch, origin: country };
  for (const field of ['attributes', 'customAttributes']) {
    const rows = patch[field] || product[field] || [];
    if (field === 'customAttributes' && !rows.some((row) => isOriginAttribute(row.name))) continue;
    next[field] = rows.map((row) => {
      if (!isOriginAttribute(row.name)) return { ...row };
      const updated = { ...row, value: country };
      if (String(row.value ?? '') !== country || Object.keys(row.valueIds || {}).some((value) => originCountry(value) !== country)) delete updated.valueIds;
      return updated;
    });
  }
  if (!next.attributes.some((row) => isOriginAttribute(row.name)) && country) next.attributes.push({ name: '原产地', value: country });
  return next;
}
