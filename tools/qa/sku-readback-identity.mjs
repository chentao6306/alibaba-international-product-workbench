import { attributeId } from '../../server/category-attributes.js';

const label = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const mismatch = (reason, details) => Object.assign(new Error('保存后的 SKU 表头无法通过当前规格字段编号唯一关联来源规格'), {
  code: 'QA_SKU_READBACK_IDENTITY_MISMATCH', diagnostics: { reason, ...details },
});

// QA only: recover the same field identity that the publishing writer observed.
// A translated header is usable only when its unique live sales-property ID
// equals a unique source dimension ID. Option spelling and SKU matching stay
// with the existing strict resolver; no language aliases or value guesses.
export function bindReadbackSkuGroups(product, headers, fields) {
  const appliedGroups = [], usedIds = new Set();
  const groups = headers.map(header => {
    const candidates = fields.filter(field => field.saleSpecification && !field.disabled
      && [field.label, ...(field.labels || [])].some(value => label(value) === label(header.name)));
    if (candidates.length !== 1) throw mismatch('target-field-not-unique', { targetName: header.name, matches: candidates.length });
    const field = candidates[0], id = attributeId(field);
    if (!id || header.id && attributeId(header) !== id) throw mismatch('target-field-id-conflict', { targetName: header.name, id, headerId: header.id });
    if (usedIds.has(id)) throw mismatch('duplicate-target-field', { targetName: header.name, id });
    const sourceGroups = (product.variantGroups || []).filter(group => attributeId(group) === id);
    if (sourceGroups.length !== 1 || !label(sourceGroups[0].name)) throw mismatch('source-field-not-unique', { targetName: header.name, id, matches: sourceGroups.length });
    // The header must represent the selected values of that live field. Read
    // order from the virtual table header, not from the attribute input tags.
    const options = [...header.options].map(String).sort();
    const values = Array.isArray(field.values) ? field.values.map(String).sort() : [];
    if (JSON.stringify(options) !== JSON.stringify(values)) throw mismatch('header-values-differ-from-field', { targetName: header.name, id });
    usedIds.add(id);
    appliedGroups.push({ id, name: sourceGroups[0].name, targetName: header.name });
    return { ...header, id };
  });
  return { groups, appliedGroups };
}
