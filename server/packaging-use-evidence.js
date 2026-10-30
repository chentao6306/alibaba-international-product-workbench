import { load } from 'cheerio';
import { attributeId, sourceAttributeForField } from './category-attributes.js';
import { currentDescriptionStructure } from './description-structure.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = value => clean(value).toLowerCase();
const useName = name => /^(?:use|specific use|具体用途|用途)$/i.test(clean(name));
const purposeName = name => /^(?:industrial use|use|specific use|usage|application|purpose|行业应用|具体用途|用途|应用)$/i.test(clean(name));
const negative = /\b(?:not|no|without|except|avoid|unsuitable|incompatible|cannot|never|unsupported|isn't|aren't|can't|free of|free from)\b|不适用|不支持|不能|不含|禁止|不可/iu;
const useContext = /\b(?:suitable|ideal|designed|used|use|uses|usage|applications?|dispensing|packaging|filling|storing|storage|containers?)\b|适用|用于|用途|应用|包装|盛装/iu;
const unrelated = /\b(?:company|factory|supplier|faq|other products?|our range|we offer|we specialize)\b|公司介绍|供应商介绍|其他产品|工厂介绍/iu;

function currentPurposeRows(product) {
  const explicit = new Set((product.customAttributes || []).map(row => key(row.name)));
  return [...(product.attributes || []).filter(row => (attributeId(row) && !row.isCustom) || !explicit.has(key(row.name))),
    ...(product.customAttributes || []).map(row => ({ ...row, isCustom: true }))];
}

function choiceMatches(text, label) {
  const escaped = key(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plural = /[a-z]y$/.test(escaped) ? `(?:${escaped}|${escaped.slice(0, -1)}ies)` : `${escaped}s?`;
  return [...key(text).matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${plural}(?![\\p{L}\\p{N}])`, 'gu'))]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function purposeEvidence(product, parentValues) {
  const evidence = [];
  for (const row of currentPurposeRows(product)) {
    // Keep the custom field itself. Its explicit contents can additionally
    // support a child option, but never replace the native parent industry.
    if (!purposeName(row?.name) || (attributeId(row) && !row.isCustom) || row.conflict) continue;
    for (const value of [row.value].flat()) if (typeof value === 'string' && value.length <= 2000) {
      // Old captures repeat the standard industry in ID-less DOM rows.
      // Gift & Craft is not independent evidence for the child choice Craft.
      if (parentValues.some(parent => key(parent) === key(value))) continue;
      evidence.push({ kind: 'attribute', name: row.name, quote: clean(value) });
    }
  }
  const html = String(product.descriptionHtml || '');
  if (html.length > 300000 || product.descriptionTemplate) return evidence;
  const structure = currentDescriptionStructure(product);
  if (structure) {
    for (const module of structure.modules || []) if (module.type === 'highlights') {
      for (const item of module.items || []) if (typeof item === 'string' && item.length <= 2000) {
        evidence.push({ kind: 'product-highlight', quote: clean(item) });
      }
    }
  } else {
    // Legacy pages have no module identity. Keep only product-use sentences;
    // stop before company/FAQ sections and exclude recommendation containers.
    const $ = load(html);
    $('script,style,iframe,form,input,button,[class*="recommend" i],[class*="related" i],[data-module-name*="company" i],[data-module-name*="faq" i]').remove();
    $('p,li,tr,div,h1,h2,h3,br').each((_, node) => $(node).append('\n'));
    const text = (html ? $.text() : String(product.description || '')).slice(0,30000)
      .split(/about (?:this|the|our) supplier|company (?:overview|introduction|profile)|FAQs?\b|供应商介绍|公司介绍|常见问题/i)[0];
    for (const quote of text.split(/[\r\n]+|[.!?。！？]+\s*/).map(clean)) {
      if (quote && quote.length <= 2000) evidence.push({ kind: 'product-description', quote });
    }
  }
  return evidence.filter(item => item.quote && !unrelated.test(item.quote)
    && (item.kind === 'attribute' || useContext.test(item.quote)));
}

export function packagingParentConflict(product, schema) {
  const parent = schema.find(field => field.id === '19421');
  if (!parent) return null;
  const source = sourceAttributeForField(product, parent);
  if (!source || source.conflict) return null;
  const known = new Set((parent.options || []).flatMap(option => [key(option.label), key(option.label).replace(/s$/, '')]));
  // The source sometimes says Pharmaceutical while the native option says
  // Pharmaceuticals. Compare only whole parent labels, not multi-use prose.
  const chosen = [source.value].flat().map(value => key(value).replace(/s$/, ''));
  const alternatives = currentPurposeRows(product)
    .filter(row => row.isCustom && /^(?:industrial use|行业应用)$/i.test(clean(row.name)))
    .flatMap(row => [row.value].flat()).filter(value => known.has(key(value)) || known.has(key(value).replace(/s$/, ''))
      // Confirmed public/seller wording for this property. Read-only parent
      // controls may omit their choices; still report this known conflict.
      || /^pharmaceuticals?$/i.test(clean(value)))
    .filter(value => !chosen.includes(key(value).replace(/s$/, '')));
  return alternatives.length ? { parentId: parent.id, sourceValues: [source.value].flat(), conflictingValues: [...new Set(alternatives)] } : null;
}

// Deterministic fallback for this verified dependent property family only.
// No model, title inference, static option catalogue, source mutation or parent
// substitution. Every proposed option needs current choices and literal proof.
export function packagingUseFromEvidence(product, field, schema) {
  if (!/^19421-\d+$/.test(field.id || '') || !field.required || field.disabled || field.saleSpecification) return null;
  const rows = [...(product.attributes || []), ...(product.customAttributes || [])];
  if (rows.some(row => attributeId(row) === field.id || attributeId(row) === field.id.split('-').at(-1)
    || (!attributeId(row) && useName(row.name)))) return null;
  const parent = schema.find(item => item.id === '19421');
  const parentSource = parent && sourceAttributeForField(product, parent);
  if (!parent?.hasValue || !parentSource || parentSource.conflict || packagingParentConflict(product, schema)) return null;
  const expected = [parentSource.value].flat().map(key).sort();
  if (JSON.stringify([...new Set((parent.values || []).map(key))].sort()) !== JSON.stringify([...new Set(expected)])) return null;
  const evidence = purposeEvidence(product, [parentSource.value].flat());
  const accepted = [];
  const options = (field.options || []).slice(0,400).filter(option => !option.disabled && option.value && clean(option.label)
    && !/^(?:other\b|others\b|其他|其它)/i.test(clean(option.label)));
  const proofs = evidence.map(item => ({ item, choices: options.map(option => ({ option, hits: choiceMatches(item.quote, option.label) })) }));
  for (const option of options) {
    const matches = proofs.filter(proof => proof.choices.find(choice => choice.option === option).hits.some(hit => !proof.choices.some(longer =>
      key(longer.option.label).length > key(option.label).length && longer.hits.some(span => span.start <= hit.start && span.end >= hit.end))))
      .map(proof => proof.item);
    if (!matches.length || matches.some(item => negative.test(item.quote))) continue;
    if (accepted.some(item => key(item.value) === key(option.label))) continue;
    accepted.push({ value: option.label, optionId: String(option.value), ...matches[0] });
  }
  if (!accepted.length || (field.multiple !== true && accepted.length > 1)) return null;
  return { id: field.id, name: field.label, value: field.multiple === true ? accepted.map(item => item.value) : accepted[0].value,
    valueIds: Object.fromEntries(accepted.map(item => [item.value, item.optionId])), matchedById: true,
    source: 'rule-description-evidence', ruleEvidence: { parentId: parent.id, parentValues: parent.values, entries: accepted } };
}

export function postingAttributeSource(product, field, schema) {
  return sourceAttributeForField(product, field) || packagingUseFromEvidence(product, field, schema);
}
