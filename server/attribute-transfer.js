import { attributeId, isDescriptionAttribute, isSourceInterfaceAttribute, sourceAttributeForField } from './category-attributes.js';
import { supplierCustomAttributes } from './custom-attributes.js';
import { isOriginAttribute, isCountryOnlyOrigin, originCountry, sourceOriginRegion } from './origin-country.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = value => clean(value).toLowerCase();
const valueKey = value => [value].flat().map(key).sort().join('\n');

function nativeProvincePreservesOrigin(item, schema) {
  const province = sourceOriginRegion({ attributes: [item] }, 'Province');
  if (!province || originCountry(item.value) !== 'China') return false;
  // A province and country cannot account for any additional city/address.
  // Those details still need an explicit public custom attribute.
  const remainder = key(item.value).replace(key(province), '')
    .replace(/\bchina\b|中国|\bprovince\b|省|[,，;；>\s]/gi, '');
  if (remainder) return false;
  return schema.some(field => /^(?:省|省份|province)$/i.test(clean(field.label))
    && !field.disabled && field.hasValue && (field.values || []).some(value => key(value) === key(province)));
}

// These rows have their own native trading/logistics controls. Description
// tables retain their original position; they are not missing public properties.
export function isPublicProductAttribute(item) {
  return Boolean(clean(item?.name) && clean(item?.value)) && !isDescriptionAttribute(item) && !isSourceInterfaceAttribute(item)
    && !/packaging|delivery|shipping|logistics|lead[\s_-]*time|supply[\s_-]*(?:ability|capacity)|包装|物流|发货|交货|供货|供应能力/i.test(item.section || '')
    && !/^(?:selling units?|single package size|single gross weight|lead time(?:\s*\([^)]*\))?|quantity\s*\([^)]*\)|销售单位|单个包装尺寸|单个产品毛重|交货时间|数量\s*[（(].*[）)])$/i.test(clean(item.name));
}

const transferFailure = (name, reason) => Object.assign(new Error(`来源属性“${name}”${reason}；请核对当前类目和属性，原始资料已保留`), {
  code: 'PUBLISH_ATTRIBUTE_TRANSFER_FAILED', requiredFields: [name], fieldName: name,
});

export function planPublicAttributeTransfer(product, schema) {
  let custom = supplierCustomAttributes(product);
  const explicitNames = new Set((product.customAttributes || []).map(row => key(row.name)));
  const seen = new Set();
  const standard = [];
  const fallback = [];
  const publicAttributes = (product.attributes || []).filter(isPublicProductAttribute);
  for (const item of publicAttributes) {
    if (item.isCustom) continue;
    // Structured and DOM captures can expose the same custom row twice.
    // Explicit editor changes, including clearing a value, own that row.
    if (!attributeId(item) && (explicitNames.has(key(item.name))
      || custom.some(row => key(row.name) === key(item.name) && valueKey(row.value) === valueKey(item.value)))) continue;
    // A DOM copy has no property ID and may no longer match the translated
    // posting label. Account for it through its unique identified source row,
    // whose native value is still checked below. A different custom value or
    // two distinct property IDs must never be merged by name alone.
    let identifiedFields = [];
    if (!attributeId(item)) {
      const identified = publicAttributes.filter(other => !other.isCustom && attributeId(other)
        && key(other.name) === key(item.name) && valueKey(other.value) === valueKey(item.value));
      if (new Set(identified.map(attributeId)).size === 1) {
        identifiedFields = schema.filter(field => sourceAttributeForField({ attributes: identified }, field));
      }
    }
    const identity = `${attributeId(item)}\n${key(item.name)}\n${valueKey(item.value)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const fields = identifiedFields.length ? identifiedFields
      : schema.filter(field => sourceAttributeForField({ attributes: [item] }, field));
    if (fields.length) {
      const duplicateCustom = custom.find(row => key(row.name) === key(item.name));
      if (duplicateCustom && valueKey(duplicateCustom.value) !== valueKey(item.value)) {
        const generated = duplicateCustom.transferSource === 'public-attribute'
          || (duplicateCustom.source === 'dom' && Boolean(attributeId(item)));
        if (generated) custom = custom.filter(row => row !== duplicateCustom);
      } else if (duplicateCustom) {
        // The native field is authoritative; a same-value custom copy would
        // consume a slot and can make the platform reject the form as a
        // duplicate. Keep only the native receipt.
        custom = custom.filter(row => row !== duplicateCustom);
      }
      // A present but rejecting/disabled native field must not be bypassed by
      // duplicating its value in custom properties or the description.
      standard.push({ source: item, fields });
      // Country alone cannot preserve a compound origin. A verified native
      // province can, without consuming one of the supplier's custom slots.
      if (!isOriginAttribute(item.name) || !originCountry(item.value) || isCountryOnlyOrigin(item.value)) continue;
      // Some categories accept the complete region/country as native text.
      // Only committed, enabled values count; a country-only value still needs
      // its province or a public custom row to preserve the source precision.
      if (fields.some(field => !field.disabled && field.hasValue
        && valueKey(field.values || []) === valueKey(item.value))) continue;
      if (nativeProvincePreservesOrigin(item, schema)) continue;
    }
    const existing = [...custom, ...fallback].find(row => key(row.name) === key(item.name));
    if (existing && valueKey(existing.value) !== valueKey(item.value)) {
      // A prior publish attempt may have materialized a source property as a
      // custom fallback. Once the structured source row is available again,
      // that generated fallback is stale and must not block the retry. Keep a
      // real user edit strict: only rows explicitly marked as a generated
      // source fallback, or an anonymous DOM copy, may be replaced.
      const generated = (existing.transferSource === 'public-attribute'
        && (!attributeId(existing) || !attributeId(item) || attributeId(existing) === attributeId(item)))
        || (existing.source === 'dom' && Boolean(attributeId(item)));
      if (!generated) throw transferFailure(item.name, '存在同名不同值，不能覆盖自定义属性');
      custom = custom.filter(row => row !== existing);
      const fallbackIndex = fallback.indexOf(existing);
      if (fallbackIndex >= 0) fallback.splice(fallbackIndex, 1);
    }
    if (!existing) fallback.push({ ...item, isCustom: true, transferSource: 'public-attribute' });
  }
  return { standard, fallback, custom: [...custom, ...fallback],
    product: { ...product, customAttributes: [...custom, ...fallback] } };
}

export function requirePublicAttributeValues(plan, matches) {
  const verified = [];
  for (const { source, fields } of plan.standard) {
    const accepted = fields.find(field => field.hasValue && matches(field, source));
    if (!accepted) throw transferFailure(source.name, `未被原生属性栏完整接收（${fields.map(field => field.label).join('、')}）`);
    verified.push({ name: source.name, value: source.value, source: source.source || 'product',
      propertyId: attributeId(source), targetId: accepted.id, targetLabel: accepted.label,
      destination: accepted.saleSpecification ? 'specification' : 'standard-attribute', committedValues: accepted.values });
    if (source.aiNormalization && source.aiOriginal) Object.assign(verified.at(-1), {
      originalValue: source.aiOriginal.value, normalization: source.aiNormalization,
    });
  }
  return [...verified, ...plan.custom.map(item => ({ name: item.name, value: item.value, source: item.source || 'product',
    propertyId: attributeId(item), destination: 'custom-attribute', ...(item.transferSource ? { transferSource: item.transferSource } : {}) }))];
}
