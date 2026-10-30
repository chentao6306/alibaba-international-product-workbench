// Shared by the editor and publisher: generated text is an explicit fallback,
// never presented as the source seller's private search-keyword configuration.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const clipWords = (value, limit) => value.length <= limit ? value : value.slice(0, limit + 1).replace(/\s+\S*$/, '').slice(0, limit).trim();

export const AUTO_TEXT_SETTINGS = {
  autoGenerateSubtitle: '自动生成副标题',
  autoGenerateKeywords: '自动生成商品关键词',
};

// Apply after collection/translation and before saving the working copy. The
// caller captures the unmodified source separately; generated text is not a
// claim about the source seller's private keywords or subtitle.
export function collectedTextPatch(product, settings = {}, previous = null) {
  const patch = { textGeneration: {
    autoGenerateSubtitle: settings.autoGenerateSubtitle === true,
    autoGenerateKeywords: settings.autoGenerateKeywords === true,
    fields: {},
  } };
  const valueOf = (item, field) => field === 'keywords'
    ? (Array.isArray(item?.keywords) ? item.keywords.map(clean).filter(Boolean) : []) : clean(item?.subtitle);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [field, setting, generate] of [
    ['subtitle', 'autoGenerateSubtitle', generateProductSubtitle],
    ['keywords', 'autoGenerateKeywords', generateProductKeywords],
  ]) {
    let value = valueOf(product, field), source = 'collected';
    if (previous) {
      const old = valueOf(previous, field);
      const generated = previous.textGeneration?.fields?.[field];
      const edited = (previous.auditTrail || []).some(entry => entry.actor !== 'system'
        && entry.fields?.includes(field) && !same(valueOf(entry.before, field), valueOf(entry.after, field))
        && same(old, valueOf(entry.after, field)));
      const manual = !(generated?.source === 'generated' && same(old, generated.value))
        && (edited || (old.length > 0 && !same(old, valueOf(previous.source?.snapshot, field))));
      if (manual) { value = old; source = 'manual'; }
    }
    if (!value.length && source !== 'manual' && settings[setting] === true && !product.collectWarning) {
      value = generate(product);
      source = value.length ? 'generated' : 'unavailable';
    }
    patch[field] = value;
    patch.textGeneration.fields[field] = { source, value: structuredClone(value) };
  }
  return patch;
}

export function generateProductKeywords(product = {}) {
  const title = clean(product.title).replace(/\b(\d+(?:\.\d+)?)\s*:\s*(?=\d)/g, '$1 to ')
    .replace(/[,:;|]/g, ' ').replace(/\s+/g, ' ');
  if (!title) return [];
  if (title.length <= 64) return [title];
  // Use contiguous phrases from the actual product title. Do not introduce
  // unverified features, brands, certifications or a hard-coded category.
  const words = title.split(' '), phrases = [];
  let start = 0;
  while (start < words.length && phrases.length < 3) {
    let end = start + 1;
    while (end < words.length && words.slice(start, end + 1).join(' ').length <= 64) end++;
    phrases.push(clipWords(words.slice(start, end).join(' '), 128));
    start = end;
  }
  return [...new Set(phrases.filter(Boolean))];
}

export function generateProductSubtitle(product = {}) {
  const title = clean(product.title);
  const facts = [...(product.attributes || []), ...(product.customAttributes || [])]
    .filter(item => !/^description-/.test(item.source || '') && !/brand|origin|certificate|certification|品牌|产地|证书|认证/i.test(item.name || ''))
    .map(item => [item.value].flat().map(clean).filter(Boolean).join(', '))
    .filter(value => value && value.length <= 60 && !/^(?:yes|no|other|oem|odm|none|无|其他)$/i.test(value)
      && !title.toLowerCase().includes(value.toLowerCase()));
  const unique = [...new Set(facts)].slice(0, 3);
  return clipWords(unique.length ? unique.join(' | ') : title, 128);
}

export function alibabaKeywordText(product) {
  const supplied = (product.keywords || []).map(value => String(value).trim()).filter(Boolean);
  if (!supplied.length && (product.textGeneration?.autoGenerateKeywords === false
    || product.textGeneration?.fields?.keywords?.source === 'manual')) return '';
  const keywords = supplied.length ? supplied.slice(0, 10).join('\n') : generateProductKeywords(product).join('\n');
  const normalized = keywords.replace(/\b(\d+(?:\.\d+)?)\s*:\s*(?=\d)/g, '$1 to ')
    .replace(/[,:]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return normalized.length <= 384 ? normalized : normalized.slice(0, 384).replace(/\s+\S*$/, '').trim();
}
