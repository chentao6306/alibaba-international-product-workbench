const normalize = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[＜]/g, '<').replace(/[＞]/g, '>')
  .replace(/[–—～~]/g, '-')
  .replace(/\b(?:years? old|years?|yrs?)\b|岁/g, 'year')
  .replace(/(\d)\s*y\b/g, '$1year')
  .replace(/\b(?:months?|mos?)\b|个月/g, 'month')
  .replace(/\s+to\s+/g, '-')
  .replace(/英寸|inch(?:es)?|["“”]/g, 'inch')
  .replace(/毫安时/g, 'mah')
  .replace(/[\s'‘’（）()]/g, '');

export const attributeValueKey = (value) => normalize(value);

export function attributeTextValue(value) {
  return (Array.isArray(value) ? value.map((item) => String(item ?? '').trim()).filter(Boolean).join(', ') : String(value ?? '')).trim();
}

// Some source pages join multiple choices with spaces (for example SBC AAC).
// Split only when live options explain the entire value in exactly one way.
// A full option, an unknown word or two possible partitions stays intact.
function splitJoinedOptions(text, options, valueIds) {
  if (valueIds[text] != null || options.some((option) => attributeOptionMatchScore(text, option.label ?? option) >= 90)) return [text];
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 24 || !options.length) return [text];
  const keys = new Set(options.filter((option) => !option.disabled).map((option) => normalize(option.label ?? option)));
  const memo = new Map();
  const partitions = (start) => {
    if (start === words.length) return [[]];
    if (memo.has(start)) return memo.get(start);
    const found = [];
    for (let end = start + 1; end <= words.length; end++) {
      const part = words.slice(start, end).join(' ');
      if (!keys.has(normalize(part))) continue;
      for (const tail of partitions(end)) {
        found.push([part, ...tail]);
        if (found.length > 1) { memo.set(start, found); return found; }
      }
    }
    memo.set(start, found);
    return found;
  };
  const matches = partitions(0);
  return matches.length === 1 && matches[0].length > 1 ? matches[0] : [text];
}

// Detail pages join selections with commas. Punctuation inside one option,
// parentheses or a thousands separator must survive that round trip.
export function attributeValueList(value, { multiple = true, options = [], valueIds = {} } = {}) {
  return [...new Set([value].flat().flatMap((item) => {
    const text = String(item ?? '').trim();
    if (!text) return [];
    if (!multiple || valueIds[text] != null || options.some((option) => attributeOptionMatchScore(text, option.label ?? option) >= 90)) return [text];
    const result = [];
    let start = 0, depth = 0;
    for (let index = 0; index < text.length; index++) {
      if ('(（[【'.includes(text[index])) depth++;
      if (')）]】'.includes(text[index])) depth = Math.max(0, depth - 1);
      if (depth || !',;，；'.includes(text[index])) continue;
      if (text[index] === ',' && /\d/.test(text[index - 1] || '') && /^\d{3}(?=\D|$)/.test(text.slice(index + 1))) continue;
      result.push(text.slice(start, index).trim()); start = index + 1;
    }
    result.push(text.slice(start).trim());
    return result.filter(Boolean).flatMap((part) => splitJoinedOptions(part, options, valueIds));
  }))];
}

function measurement(value, defaultUnit = '') {
  const alternate = String(value ?? '').match(/^([^()（）]+)\s*[(（]([^()（）]+)[)）]\s*$/);
  if (alternate) {
    const primary = measurement(alternate[1], defaultUnit), secondary = measurement(alternate[2]);
    const scale = { inch: 25.4, cm: 10, mm: 1, m: 1000 };
    if (!primary || !secondary || !scale[primary.unit] || !scale[secondary.unit]
      || primary.min !== primary.max || secondary.min !== secondary.max) return null;
    return Math.abs(primary.min * scale[primary.unit] - secondary.min * scale[secondary.unit]) < 0.000001 ? primary : null;
  }
  const text = normalize(value).replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1').replace(/^(?:above|over|morethan)/, '>')
    .replace(/^(?:below|under|lessthan)/, '<').replace(/^atleast/, '>=')
    .replace(/^atmost/, '<=').replace(/^≥/, '>=').replace(/^≤/, '<=');
  const match = text.match(/^(<=|>=|<|>)?(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?(inch|year|month|mm|cm|km|m|kg|mg|g|mah|ah|ml|l|kw|w|kv|v|hz|khz|mhz|ghz)?(\+)?$/);
  if (!match || (match[1] && (match[3] || match[5])) || (match[3] && match[5])) return null;
  const [, operator, first, last, unit, plus] = match;
  const number = Number(first);
  if (last && Number(last) < number) return null;
  return {
    min: operator?.startsWith('<') ? -Infinity : number,
    max: operator?.startsWith('>') || plus ? Infinity : Number(last || first),
    minInclusive: operator !== '>', maxInclusive: operator !== '<',
    unit: unit || defaultUnit,
  };
}

function containedBy(value, range) {
  if (!value || !range || (value.unit && range.unit && value.unit !== range.unit)) return false;
  // A missing month unit must not turn an age or an unrelated number into months.
  if ((value.unit === 'month' || range.unit === 'month') && value.unit !== range.unit) return false;
  return (value.min > range.min || (value.min === range.min && (!value.minInclusive || range.minInclusive)))
    && (value.max < range.max || (value.max === range.max && (!value.maxInclusive || range.maxInclusive)));
}

export function measurementFits(value, range, defaultUnit = '') {
  return containedBy(measurement(value, defaultUnit), measurement(range, defaultUnit));
}

export function hasMeasurementUnit(value) {
  return Boolean(measurement(value)?.unit);
}

export function measurementValue(value, defaultUnit) {
  let text = String(value ?? '').trim();
  if (defaultUnit === 'mah') text = text.replace(/\s*(?:(?:lithium[ -]?ion|li[ -]?ion)\s+)?battery$/i, '').trim();
  if (defaultUnit === 'inch') text = text.replace(/\s+(?:capacitive|resistive)\s+touch(?:\s+screen)?$/i, '')
    .replace(/\s*(?:(?:hd|fhd|lcd|oled|amoled)\s+)?(?:screen|display)$/i, '').trim();
  return measurement(text, defaultUnit) ? text : null;
}

export function attributeOptionMatchScore(source, option) {
  const wanted = normalize(source), offered = normalize(option);
  if (!wanted || !offered) return 0;
  if (wanted === offered) return 100;
  if ([['yes', 'true', '是'], ['no', 'false', '否'], ['unisex', '男女通用', '男女皆宜'], ['boys', 'boy', '男孩'], ['girls', 'girl', '女孩']]
    .some((values) => values.includes(wanted) && values.includes(offered))) return 100;
  if (/\d/.test(wanted) || /\d/.test(offered)) {
    const value = measurement(source), range = measurement(option);
    if (!containedBy(value, range)) return 0;
    return containedBy(range, value) ? 90 : 70;
  }
  if (/^others?$/.test(wanted) && /^(?:others?|其他)$/.test(offered)) return 90;
  return offered.includes(wanted) || wanted.includes(offered) ? 50 : 0;
}

export function cpuValueKind(value) {
  const text = normalize(value);
  if (/^(?:single|dual|quad|hexa|octa|deca|[1-9]\d?)[-]?cores?$/.test(text) || /^(?:单|双|四|六|八|十|[1-9]\d?)核$/.test(text)) return 'cores';
  if (/^(?:snapdragon|snapdrtagon|qualcomm|mediatek|dimensity|exynos|kirin|unisoc|mtk|helio)/.test(text)) return 'model';
  return '';
}
