import { sourceAttributeForField } from './category-attributes.js';
import { requiredAttributeKey } from './publish-reference.js';
import { originValueForField } from './origin-country.js';

const hasValue = (value) => value != null && (Array.isArray(value) ? value.some(hasValue) : String(value).trim() !== '');
const categoryId = (product) => String(product.categoryId || product.sourceCategoryId || '');
export const CATEGORY_SCHEMA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function postingSchemaWithKnownLabels(product, fields, now = Date.now()) {
  const saved = product.postingRequirements;
  const age = now - Date.parse(saved?.capturedAt);
  if (!saved || saved.categoryId !== categoryId(product) || !Number.isFinite(age) || age < 0 || age > CATEGORY_SCHEMA_MAX_AGE_MS) return fields;
  return fields.map((field) => {
    const previous = field.id && saved.fields?.find((item) => item.id === field.id);
    if (!previous) return field;
    // Only reuse names tied to the same observed property ID. Current controls,
    // options and required flags always come from the live form.
    return { ...field, labels: [...new Set([...(field.labels || [field.label]), ...(previous.labels || [previous.label])].filter(Boolean))] };
  });
}

// Store descriptors, never current option selections or another product's
// values. Only baseline fields can be reused across products in the same leaf.
export function categoryRequirementSchema(id, fields, capturedAt = new Date().toISOString()) {
  return { categoryId: String(id || ''), capturedAt, source: 'posting-form', fields: fields
    .filter((field) => !field.saleSpecification && !field.disabled)
    .map((field) => ({ id: String(field.id || ''), label: field.label, labels: field.labels || [field.label],
      required: Boolean(field.required), controlType: field.controlType,
      ...(field.autocomplete ? { autocomplete: field.autocomplete } : {}),
      ...(field.allowsCustomValue === true ? { allowsCustomValue: true } : {}),
      ...(field.options?.length ? { options: field.options.map(option => ({ ...option })) } : {}),
      ...(field.maxLength ? { maxLength: field.maxLength } : {}),
      ...(typeof field.multiple === 'boolean' ? { multiple: field.multiple } : {}) })) };
}

export function categoryReadiness(product, schema = product.postingRequirements, now = Date.now()) {
  const id = categoryId(product);
  if (!schema || !id || schema.categoryId !== id || !schema.fields?.length) {
    return { status: 'unchecked', categoryId: id, missing: [], conflicts: [], checked: 0 };
  }
  const age = now - Date.parse(schema.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > CATEGORY_SCHEMA_MAX_AGE_MS) {
    return { status: 'stale', categoryId: id, missing: [], conflicts: [], checked: 0 };
  }
  const missing = [], conflicts = [], mappings = [];
  const properties = { 原产地: 'origin', 产地: 'origin', 品牌名称: 'brand', 型号: 'model', 材质: 'material', 颜色: 'color', 省份: 'province' };
  for (const field of schema.fields.filter((field) => field.required)) {
    const source = sourceAttributeForField(product, field);
    const keys = (field.labels || [field.label]).map(requiredAttributeKey);
    const direct = keys.map((key) => properties[key]).filter(Boolean).map((key) => product[key]).find(hasValue);
    const value = keys.includes('产地') ? originValueForField(product, field) : source?.value ?? direct;
    if (source?.conflict) conflicts.push(field.label);
    else if (!hasValue(value)) missing.push(field.label);
    mappings.push({ id: field.id, label: field.label, source: source?.name || '',
      status: source?.conflict ? 'conflict' : hasValue(value) ? 'available' : 'missing' });
  }
  return { status: missing.length || conflicts.length ? 'incomplete' : 'covered', categoryId: id,
    capturedAt: schema.capturedAt, missing, conflicts, checked: mappings.length, mappings };
}

export function rememberCategoryRequirements(state, schema) {
  if (!schema?.categoryId || !schema.fields?.length) return;
  state.postingSchemas ||= {};
  state.postingSchemas[schema.categoryId] = schema;
  const newest = Object.entries(state.postingSchemas).sort((a, b) => Date.parse(b[1].capturedAt) - Date.parse(a[1].capturedAt)).slice(0, 300);
  state.postingSchemas = Object.fromEntries(newest);
  for (const product of state.products) {
    if (categoryId(product) === schema.categoryId && !product.postingRequirements?.productSpecific) product.postingRequirements = schema;
  }
}

export function attachCategoryRequirements(product, schemas = {}) {
  const schema = schemas[categoryId(product)];
  if (schema) product.postingRequirements = schema;
  else if (product.postingRequirements?.categoryId !== categoryId(product)) delete product.postingRequirements;
  return product;
}
