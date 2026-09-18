import { requiredAttributeKey } from './publish-reference.js';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const attributeId = (item) => clean(item?.attributeId ?? item?.propertyId ?? item?.attrId ?? item?.propId ?? item?.id).replace(/^(?:struct-)?p-/, '');
export const SOURCE_ATTRIBUTE_SCHEMA_VERSION = 3;

export function needsSourceAttributeRefresh(product) {
  if (product.categoryReference || Number(product.sourceAttributeSchemaVersion) >= SOURCE_ATTRIBUTE_SCHEMA_VERSION) return false;
  return /必填属性或规格未填写|来源缺少必填资料|已采集但发布页未接受|缺少包装重量|重量未填写|体积未填写|物流属性未填写/.test(String(product.publishResult?.message || ''));
}

export function mergeSourceAttributes(...sources) {
  const result = [];
  for (const item of sources.flat()) {
    if (!item?.name || item.value == null || !clean(item.value)) continue;
    const id = attributeId(item);
    const key = requiredAttributeKey(item.name);
    const existing = result.find((row) => (id && attributeId(row) ? id === attributeId(row) : key === requiredAttributeKey(row.name)));
    if (!existing) { result.push(structuredClone(item)); continue; }
    if (id && !attributeId(existing)) existing.id = id;
    if (item.valueIds) existing.valueIds = { ...item.valueIds, ...existing.valueIds };
    // DOM text may be a translation or a comma-joined rendering of the same
    // structured values. Keep the structured representation and its IDs.
    if (existing.source === 'detailData.attributes' && item.source === 'dom') continue;
    const values = [...new Set([...[existing.value].flat(), ...[item.value].flat()].map(clean).filter(Boolean))];
    existing.value = values.length === 1 ? values[0] : values;
  }
  return result;
}

export function extractAlibabaAttributes(detailData) {
  const result = [];
  const seen = new Set();
  let visited = 0;
  const walk = (node, section = '') => {
    if (!node || typeof node !== 'object' || seen.has(node) || ++visited > 15000) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((item) => walk(item, section)); return; }
    if (/packaging|packinfo/i.test(section)) {
      for (const [key, label] of [['singleGrossWeight', 'Single gross weight'], ['singlePackageSize', 'Single package size']]) {
        const value = node[key];
        if (typeof value === 'string' || typeof value === 'number') result.push({ name: label,
          value: `${value}${node[`${key}Unit`] ? ` ${node[`${key}Unit`]}` : ''}`, section, source: 'detailData.attributes' });
      }
    }
    const name = clean(node.attributeName ?? node.attrName ?? node.propertyName ?? node.propName ?? node.name ?? node.key);
    const raw = node.attributeValue ?? node.attrValue ?? node.propertyValue ?? node.propValue ?? node.value ?? node.values
      ?? node.attributeValues ?? node.propertyValues ?? node.valueList;
    const entries = [raw].flat().filter((value) => value != null).map((value) => typeof value === 'object'
      ? { value: clean(value.valueName ?? value.attributeValueName ?? value.propertyValueName ?? value.name ?? value.label ?? value.text ?? value.value), id: clean(value.valueId ?? value.attributeValueId ?? value.propertyValueId ?? value.id) }
      : { value: clean(value), id: '' }).filter((value) => value.value);
    if (name && entries.length && name.length <= 100 && entries.every((value) => value.value.length <= 2000 && value.value !== '[object Object]')) {
      const id = attributeId(node);
      const ids = entries.map((entry) => entry.id || clean(node.valueId ?? node.attributeValueId));
      result.push({ name, value: entries.length === 1 ? entries[0].value : entries.map((entry) => entry.value),
        ...(id ? { id } : {}), ...(ids.every(Boolean) ? { valueIds: Object.fromEntries(entries.map((entry, i) => [entry.value, ids[i]])) } : {}),
        section, source: 'detailData.attributes' });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (/recommend|related|similar|advert|sku|price|image|video/i.test(key)) continue;
      walk(value, clean(node.title || node.groupName || section));
    }
  };
  for (const [name, module] of Object.entries(detailData?.nodeMap || {})) {
    if (/attribute|specification|packaging|productPropert|productPackInfo/i.test(name) && !/recommend|related|similar|sku/i.test(name)) walk(module?.privateData || module, name);
  }
  const product = detailData?.globalData?.product || {};
  for (const field of ['attributes', 'attributeList', 'productAttributes', 'properties', 'propertyList']) walk(product[field], 'Product Attributes');
  walk(product.packaging, 'Packaging');
  return mergeSourceAttributes(result);
}

// Serialized into the collection page. Read each supported layout, even when
// another layout has already yielded attributes. Never inspect recommendations.
export function readAlibabaAttributeRows() {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const excluded = '[data-module-name*="recommend" i], [data-module-name*="related" i], [data-module-name*="similar" i], [class*="recommend" i], [data-testid*="recommend" i]';
  const scopes = '[data-testid="module-attribute-group"], [data-module-name*="attribute" i], [data-module-name*="specification" i], [data-module-name*="packaging" i], [class*="product-attribute" i]';
  const result = [];
  const readRow = (row) => {
    if (row.closest(excluded)) return;
    let name = '', value = '';
    const keyNode = row.querySelector('[data-testid="module-attribute-name"], [class*="attribute-name"], [class*="property-name"]');
    const valueNode = row.querySelector('[data-testid="module-attribute-value"], [class*="attribute-value"], [class*="property-value"]');
    if (row.tagName === 'DT') {
      name = clean(row.textContent);
      const values = [];
      for (let sibling = row.nextElementSibling; sibling?.tagName === 'DD'; sibling = sibling.nextElementSibling) values.push(clean(sibling.textContent));
      value = values.join(', ');
    } else if (keyNode && valueNode) {
      name = clean(keyNode.getAttribute('title') || keyNode.textContent);
      value = clean(valueNode.getAttribute('title') || valueNode.textContent);
    } else {
      const cells = [...row.querySelectorAll(':scope > th, :scope > td, :scope > dt, :scope > dd')];
      if (cells.length >= 2) { name = clean(cells[0].textContent); value = cells.slice(1).map((cell) => clean(cell.textContent)).join(', '); }
      else if (row.closest(scopes)) {
        const children = [...row.children].filter((node) => clean(node.textContent));
        if (children.length === 2 && children.every((node) => !node.querySelector('table,dl,[data-testid="module-attribute-row"]'))
          && !children[0].querySelector('div > div')) {
          name = clean(children[0].textContent); value = clean(children[1].textContent);
        }
      }
    }
    if (!name || !value || name.length > 100 || value.length > 2000 || /[\r\n]/.test(name)
      || /^(?:key attributes|other attributes|product attributes|关键属性|其他属性|商品属性)$/i.test(name)) return;
    const id = row.getAttribute('data-attribute-id') || row.getAttribute('data-property-id') || '';
    result.push({ name, value, ...(id ? { id } : {}), source: 'dom',
      section: clean(row.closest('[data-testid="module-attribute-group"]')?.querySelector('[data-testid="module-attribute-group-title"]')?.textContent) || 'Product Attributes' });
  };
  const rows = new Set(document.querySelectorAll('[data-testid="module-attribute-row"], table tr, dl > dt'));
  for (const scope of document.querySelectorAll(scopes)) {
    if (scope.closest(excluded)) continue;
    for (const row of scope.querySelectorAll('li, [class*="row"], [class*="item"], div')) rows.add(row);
  }
  rows.forEach(readRow);
  return result;
}

export function packagingFromAttributes(attributes = []) {
  const find = (pattern) => {
    const item = attributes.find((item) => pattern.test(clean(item.name).replace(/\s*[(（][^()（）]+[)）]\s*$/, '')));
    return { value: clean(item?.value), unit: clean(item?.name).match(/[(（]([^()（）]+)[)）]\s*$/)?.[1]?.trim() || '' };
  };
  const result = {};
  const weight = find(/^(?:single gross weight|gross weight|package weight|packaging weight|单个产品毛重|单件毛重|包装重量|毛重)$/i);
  const weightPattern = /^(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|g|grams?|lb|lbs|pounds?|公斤|千克|克)?\s*$/i;
  const match = (/^\d+(?:\.\d+)?$/.test(weight.value) && weight.unit ? `${weight.value} ${weight.unit}` : weight.value).match(weightPattern);
  if (match && Number(match[1]) > 0) {
    const unit = (match[2] || 'kg').toLowerCase();
    result.weight = String(Number((Number(match[1]) * (/^(?:g|grams?|克)$/.test(unit) ? 0.001 : /^(?:lb|lbs|pounds?)$/.test(unit) ? 0.45359237 : 1)).toFixed(6)));
  }
  const lengthPattern = /^(\d+(?:\.\d+)?)\s*(cm|mm|m|inch(?:es)?|in|厘米|毫米|米)?\s*$/i;
  const toCm = (match, fallback) => {
    if (!match || Number(match[1]) <= 0) return null;
    const unit = (match[2] || fallback || 'cm').toLowerCase();
    if (!/^(cm|mm|m|inch(?:es)?|in|厘米|毫米|米)$/.test(unit)) return null;
    const scale = /^(mm|毫米)$/.test(unit) ? 0.1 : /^(m|米)$/.test(unit) ? 100 : /^(in|inch|inches)$/.test(unit) ? 2.54 : 1;
    return String(Number((Number(match[1]) * scale).toFixed(6)));
  };
  const size = find(/^(?:single package size|package size|packaging size|单个包装尺寸|单件包装尺寸|包装尺寸)$/i);
  const parts = size.value.split(/\s*[x×*]\s*/i).map((part) => part.match(lengthPattern));
  if (parts.length === 3 && parts.every(Boolean)) {
    const values = parts.map((part) => toCm(part, parts[2][2] || size.unit));
    if (values.every(Boolean)) ['length', 'width', 'height'].forEach((name, i) => { result[name] = values[i]; });
  }
  for (const [key, pattern] of [
    ['length', /^(?:package length|packaging length|包装长|包装长度)$/i],
    ['width', /^(?:package width|packaging width|包装宽|包装宽度)$/i],
    ['height', /^(?:package height|packaging height|包装高|包装高度)$/i],
  ]) {
    const item = find(pattern);
    const value = toCm(item.value.match(lengthPattern), item.unit);
    if (!result[key] && value) result[key] = value;
  }
  return result;
}

// Serialized into the seller page. Read actual rendered category fields and
// stable property IDs; a new category does not need its own filling routine.
export function readPostingAttributeSchema() {
  const rows = [...document.querySelectorAll('.sell-catProp-item, #struct-specification [id^="p-"], [data-attribute-id], [data-property-id]')]
    .filter((row) => !row.parentElement?.closest('.sell-catProp-item, #struct-specification [id^="p-"], [data-attribute-id], [data-property-id]'));
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').replace(/^[*＊]\s*/, '').replace(/[:：]\s*$/, '').trim();
  const selector = 'input:not([type="hidden"]):not([type="file"]):not([type="button"]):not([type="submit"]), textarea, select';
  return rows.flatMap((row, index) => {
    if (!row.getClientRects().length || row.closest('#saleAttributesItems, [class*="customizedServices"]')) return [];
    const heading = row.querySelector('.label, .next-form-item-label, label:not(:has(input)), legend');
    const label = clean(heading?.textContent || row.getAttribute('data-attribute-name') || row.getAttribute('aria-label'));
    const controls = [...row.querySelectorAll(selector)];
    const field = controls.find((node) => !node.disabled && node.getClientRects().length);
    if (!label) return [];
    let id = row.dataset.attributeId || row.dataset.propertyId
      || row.id.match(/^(?:struct-)?p-(\d+)$/)?.[1] || field?.name?.match(/^p-(\d+)$/)?.[1] || '';
    const labels = [label, row.dataset.enName, row.dataset.attributeName].filter(Boolean);
    const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey && row[fiberKey];
    for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props) continue;
      const candidateId = String(props.attributeId ?? props.propertyId ?? props.id ?? '').replace(/^(?:struct-)?p-/, '');
      if (!/^\d+$/.test(candidateId) || (id && candidateId !== id)) continue;
      id ||= candidateId;
      for (const value of [props.label, props.attributeName, props.propertyName, props.enName]) if (typeof value === 'string' && clean(value)) labels.push(clean(value));
      break;
    }
    const enabled = controls.filter((node) => !node.disabled && node.getClientRects().length);
    const hasValue = enabled.some((node) => ['checkbox', 'radio'].includes(node.type) ? node.checked
      : node.tagName === 'SELECT' ? [...node.selectedOptions].some((option) => option.value)
        : (node.getAttribute('role') !== 'combobox' || node.readOnly) && Boolean(clean(node.value)))
      || [...row.querySelectorAll('.next-select-values em, .next-tag-body, [class*="selected-value"]')].some((node) => clean(node.textContent));
    const values = enabled.flatMap((node) => ['checkbox', 'radio'].includes(node.type)
      ? (node.checked ? [clean(node.closest('label')?.textContent || node.value)] : [])
      : node.tagName === 'SELECT' ? [...node.selectedOptions].filter((option) => option.value).map((option) => clean(option.textContent))
        : (node.getAttribute('role') !== 'combobox' || node.readOnly) && clean(node.value) ? [clean(node.value)] : []);
    values.push(...[...row.querySelectorAll('.next-select-values em, .next-tag-body, [class*="selected-value"]')].map((node) => clean(node.textContent)).filter(Boolean));
    const controlType = field?.tagName === 'SELECT' ? (field.multiple ? 'multiSelect' : 'select') : field?.type || '';
    row.setAttribute('data-posting-attribute-row', String(index));
    return [{ id, label, labels: [...new Set(labels)], rowId: row.id, rowIndex: index, inputIndex: controls.indexOf(field), controlType,
      disabled: controls.length > 0 && enabled.length === 0, values: [...new Set(values)],
      saleSpecification: Boolean(row.closest('#struct-specification')),
      required: row.getAttribute('aria-required') === 'true' || row.getAttribute('data-required') === 'true'
        || Boolean(row.querySelector('label.required, .label.required, .next-form-item-label.required, [aria-required="true"], [required]')), hasValue }];
  });
}

export function sourceAttributeForField(product, field) {
  const items = [...(product.attributes || []), ...(product.customAttributes || [])].filter((item) => item?.name && item.value != null && clean(item.value));
  if (field.id) {
    const exact = items.find((item) => attributeId(item) === field.id);
    if (exact) return { ...exact, matchedById: true };
  }
  const names = new Set((field.labels || [field.label]).map(requiredAttributeKey));
  const item = items.find((item) => names.has(requiredAttributeKey(item.name)));
  return item ? { ...item, matchedById: false } : null;
}
