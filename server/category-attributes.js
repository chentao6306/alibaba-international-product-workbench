import { requiredAttributeKey } from './publish-reference.js';
import { attributeValueKey, attributeValueList, cpuValueKind, hasMeasurementUnit, measurementFits, measurementValue } from './attribute-values.js';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const attributeNameKey = (name) => clean(name).normalize('NFKC').toLowerCase();
export const attributeId = (item) => clean(item?.attributeId ?? item?.propertyId ?? item?.attrId ?? item?.propId ?? item?.id).replace(/^(?:struct-)?p-/, '');
export const SOURCE_ATTRIBUTE_SCHEMA_VERSION = 8;
export const isDescriptionAttribute = (item) => /^description-(?:dom|iframe)$/.test(item?.source || '');

// This is a buyer-side analysis tool, not a supplier property. Older DOM
// captures included its heading/action as a two-column attribute row.
export function isSourceInterfaceAttribute(item) {
  return !attributeId(item) && /^(?:dom|detailData\.attributes)$/.test(item?.source || '')
    && /^Further analysis\s*&\s*research about this product$/i.test(clean(item.name))
    && /^Calculate the cost and margin$/i.test(clean(item.value));
}

// Dependent properties use a path on the posting form (19421-19427), while
// public attributes may expose just the terminal property ID (19427).
export function attributeMatchesFieldId(item, field) {
  const id = attributeId(item);
  return Boolean(id && field.id && (id === field.id
    || (/^\d+(?:-\d+)+$/.test(field.id) && /^\d+$/.test(id) && field.id.endsWith(`-${id}`)
      && !field.id.split('-').slice(0, -1).includes(id))));
}

const isPackagingUseField = field => /^19421-\d+$/.test(field.id || '');
const matchesFieldAlias = (item, field, names) => names.has(requiredAttributeKey(item.name))
  // Application/Usage often describe general packaging, alongside the real
  // Use property. They cannot supply a fixed, industry-dependent Use choice.
  && (!isPackagingUseField(field) || /^(?:use|specific use|具体用途|用途)$/i.test(clean(item.name)));

export function needsSourceAttributeRefresh(product) {
  if (product.categoryReference || Number(product.sourceAttributeSchemaVersion) >= SOURCE_ATTRIBUTE_SCHEMA_VERSION) return false;
  return /必填属性或规格未填写|来源缺少必填资料|已采集但发布页未接受|缺少包装重量|重量未填写|体积未填写|物流属性未填写/.test(String(product.publishResult?.message || ''));
}

export function mergeSourceAttributes(...sources) {
  const rows = sources.flat().filter(row => !isSourceInterfaceAttribute(row));
  const idsByName = new Map();
  for (const row of rows) {
    if (!row?.name || !attributeId(row)) continue;
    const key = requiredAttributeKey(row.name);
    if (!idsByName.has(key)) idsByName.set(key, new Set());
    idsByName.get(key).add(attributeId(row));
  }
  const result = [];
  for (const item of rows) {
    if (!item?.name || item.value == null || !clean(item.value)) continue;
    const id = attributeId(item);
    const key = requiredAttributeKey(item.name);
    const candidates = result.filter((row) => {
      if (Boolean(row.isCustom) !== Boolean(item.isCustom) && (row.source === 'detailData.attributes' || item.source === 'detailData.attributes')) return false;
      if (isDescriptionAttribute(row) !== isDescriptionAttribute(item)) return false;
      if (id && attributeId(row)) return id === attributeId(row);
      // Supplier-defined names are identities, even when a broad native-field
      // alias and the values happen to be equal (Application and Usage).
      if ((row.isCustom || item.isCustom) && attributeNameKey(row.name) !== attributeNameKey(item.name)) return false;
      if (key !== requiredAttributeKey(row.name)) return false;
      // CPU core count and processor model are often both labelled "CPU".
      if (key === '手机中央处理器') {
        const kinds = new Set([row.value, item.value].flat().map(cpuValueKind).filter(Boolean));
        if (kinds.size > 1) return false;
      }
      return true;
    });
    const exactId = id && candidates.find((row) => attributeId(row) === id);
    // An unlabelled DOM row cannot identify which of two same-name properties
    // it describes. Keep it separate instead of attaching it to the first ID.
    const candidateIds = new Set(candidates.map(attributeId).filter(Boolean));
    const existing = exactId || ((idsByName.get(key)?.size || 0) <= 1 && candidateIds.size <= 1 && candidates.length === 1 ? candidates[0] : null);
    if (!existing) { result.push(structuredClone(item)); continue; }
    const differentNames = clean(existing.name).toLowerCase() !== clean(item.name).toLowerCase();
    const differentSections = existing.section && item.section && existing.section !== item.section;
    const sameValues = JSON.stringify([existing.value].flat().map(attributeValueKey).sort()) === JSON.stringify([item.value].flat().map(attributeValueKey).sort());
    if (!exactId && (differentNames || differentSections) && !sameValues
      && !(existing.source === 'detailData.attributes' && item.source === 'dom')) {
      result.push(structuredClone(item)); continue;
    }
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
    const name = clean(node.attributeName ?? node.attrName ?? node.propertyName ?? node.propName ?? node.attribute ?? node.name ?? node.key);
    const raw = node.attributeValue ?? node.attrValue ?? node.propertyValue ?? node.propValue ?? node.value ?? node.values
      ?? node.attributeValues ?? node.propertyValues ?? node.valueList;
    const entries = [raw].flat().filter((value) => value != null).map((value) => typeof value === 'object'
      ? { value: clean(value.valueName ?? value.attributeValueName ?? value.propertyValueName ?? value.name ?? value.label ?? value.text ?? value.value), id: clean(value.valueId ?? value.attributeValueId ?? value.propertyValueId ?? value.id) }
      : { value: clean(value), id: '' }).filter((value) => value.value);
    if (name && entries.length && name.length <= 100 && entries.every((value) => value.value.length <= 2000 && value.value !== '[object Object]')) {
      const id = attributeId(node);
      const ids = entries.map((entry) => entry.id || (entries.length === 1 ? clean(node.valueId ?? node.attributeValueId) : ''));
      const unit = clean(node.unitName ?? node.unit ?? node.valueUnit);
      const values = entries.map((entry) => unit && /^-?\d+(?:\.\d+)?$/.test(entry.value) ? `${entry.value} ${unit}` : entry.value);
      const valueIds = Object.fromEntries(values.flatMap((value, i) => ids[i] ? [[value, ids[i]]] : []));
      result.push({ name, value: values.length === 1 ? values[0] : values,
        ...(Object.hasOwn(node, 'attribute') && !id ? { isCustom: true } : {}),
        ...(unit ? { unit, rawValue: entries.length === 1 ? entries[0].value : entries.map((entry) => entry.value) } : {}),
        ...(id ? { id } : {}), ...(Object.keys(valueIds).length ? { valueIds } : {}),
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
  for (const field of ['attributes', 'attributeList', 'productAttributes', 'properties', 'propertyList', 'productKeyIndustryProperties', 'productOtherProperties']) walk(product[field], 'Product Attributes');
  walk(product.packaging, 'Packaging');
  return mergeSourceAttributes(result);
}

// Serialized into the collection page. Read each supported layout, even when
// another layout has already yielded attributes. Never inspect recommendations.
export function readAlibabaAttributeRows({ description = false } = {}) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const excluded = '[data-module-name*="recommend" i], [data-module-name*="related" i], [data-module-name*="similar" i], [class*="recommend" i], [data-testid*="recommend" i]';
  const scopes = '[data-testid="module-attribute-group"], [data-module-name*="attribute" i], [data-module-name*="specification" i], [data-module-name*="packaging" i], [data-module-name*="productPackInfo" i], [class*="product-attribute" i]';
  const descriptions = '[data-module-name="module_description"], [data-testid="module-description"], [data-module-name="module_structure_description"], [data-testid="module-details-structure-description"], #detail_decorate_root';
  const valueNodes = '[data-testid="module-attribute-value"], [class*="attribute-value"], [class*="property-value"]';
  const readText = (node) => {
    const copy = node?.cloneNode(true);
    copy?.querySelectorAll('button, [role="button"]').forEach((control) => control.remove());
    return clean(copy?.textContent);
  };
  const result = [];
  const readRow = (row) => {
    if (row.closest(excluded) || row.closest(valueNodes)) return;
    let name = '', value = '';
    const keyNode = row.querySelector('[data-testid="module-attribute-name"], [class*="attribute-name"], [class*="property-name"]');
    const valueNode = row.querySelector(valueNodes);
    if (row.tagName === 'DT') {
      name = clean(row.textContent);
      const values = [];
      for (let sibling = row.nextElementSibling; sibling?.tagName === 'DD'; sibling = sibling.nextElementSibling) values.push(clean(sibling.textContent));
      value = values.join(', ');
    } else if (keyNode && valueNode) {
      name = clean(keyNode.getAttribute('title') || keyNode.textContent);
      value = clean(valueNode.getAttribute('title') || readText(valueNode));
    } else {
      const cells = [...row.querySelectorAll(':scope > th, :scope > td, :scope > dt, :scope > dd')];
      if (cells.length >= 2) {
        name = clean(cells[0].textContent);
        const values = cells.slice(1).map((cell) => clean(cell.textContent));
        // A description table can span one property across several rows.
        // Alibaba also inserts empty rowspan=0 placeholders in continuation
        // rows. Read the whole group, stopping at a new property or section.
        const span = Math.min(Number(cells[0].getAttribute('rowspan')) || 1, 100);
        let sibling = row.nextElementSibling;
        for (let remaining = span - 1; remaining > 0 && sibling?.tagName === 'TR'; remaining--, sibling = sibling.nextElementSibling) {
          const next = [...sibling.querySelectorAll(':scope > th, :scope > td')];
          if (next.length === cells.length && !clean(next[0]?.textContent)) next.shift();
          if (next.length !== cells.length - 1) break;
          values.push(...next.map(cell => clean(cell.textContent)).filter(Boolean));
        }
        value = values.join(', ');
      }
      else if (row.closest(scopes)) {
        const children = [...row.children].filter((node) => clean(node.textContent));
        if (children.length === 2 && children.every((node) => !node.querySelector('table,dl,[data-testid="module-attribute-row"]'))
          && !children[0].querySelector('div > div')) {
          name = clean(children[0].textContent); value = clean(children[1].textContent);
        }
      }
    }
    if (!name || !value || name.length > 100 || value.length > 2000 || /[\r\n]/.test(name)
      || /^(?:show (?:more|less|all)|view more|see more|展开|收起|查看更多)$/i.test(value)
      || /^(?:key attributes|other attributes|product attributes|关键属性|其他属性|商品属性)$/i.test(name)) return;
    const id = row.getAttribute('data-attribute-id') || row.getAttribute('data-property-id') || '';
    const valueSelector = '[data-value-id], [data-attribute-value-id], [data-property-value-id]';
    const values = valueNode ? [...(valueNode.matches(valueSelector) ? [valueNode] : []), ...valueNode.querySelectorAll(valueSelector)] : [];
    const valueIds = Object.fromEntries(values.map((node) => [clean(node.getAttribute('title') || node.textContent),
      node.getAttribute('data-value-id') || node.getAttribute('data-attribute-value-id') || node.getAttribute('data-property-value-id')]).filter(([label, id]) => label && id));
    result.push({ name, value: values.length ? values.map((node) => clean(node.getAttribute('title') || node.textContent)).filter(Boolean) : value,
      ...(Object.keys(valueIds).length ? { valueIds } : {}), ...(id ? { id } : {}),
      source: description ? 'description-iframe' : row.closest(descriptions) ? 'description-dom' : 'dom',
      section: description || row.closest(descriptions) ? 'Product Description'
        : clean(row.closest('[data-testid="module-attribute-group"]')?.querySelector('[data-testid="module-attribute-group-title"]')?.textContent) || 'Product Attributes' });
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
    const labelNode = heading?.cloneNode(true);
    labelNode?.querySelectorAll('.upload-image-switch, .next-icon, button').forEach((node) => node.remove());
    const label = clean(labelNode?.textContent || row.getAttribute('data-attribute-name') || row.getAttribute('aria-label'))
      .replace(/(?:添加规格图|Add Specification).*$/i, '').trim();
    const controls = [...row.querySelectorAll(selector)];
    const field = controls.find((node) => !node.disabled && node.getClientRects().length);
    if (!label) return [];
    let id = row.dataset.attributeId || row.dataset.propertyId
      || row.id.match(/^(?:struct-)?p-(\d+(?:-\d+)*)$/)?.[1] || field?.name?.match(/^p-(\d+(?:-\d+)*)$/)?.[1] || '';
    // Verified seller property IDs disambiguate labels translated differently
    // on the public detail page (Theme) and the Chinese posting page (场景).
    const propertyLabels = { '200515261': ['Theme'], '210194576': ['Age'], '210240146': ['Age Range'],
      '191288357': ['use'], '139': ['Application'], '191288006': ['Usage'] };
    const labels = [label, row.dataset.enName, row.dataset.attributeName, ...(propertyLabels[id] || []),
      ...(/^19421-\d+$/.test(id) ? ['Use', '具体用途'] : [])].filter(Boolean);
    const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey && row[fiberKey];
    for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props) continue;
      const candidateId = [props.attributeId, props.propertyId, props.name, props.id]
        .map((value) => String(value ?? '').replace(/^(?:struct-)?p-/, '')).find((value) => /^\d+(?:-\d+)*$/.test(value)) || '';
      if (!candidateId || (id && candidateId !== id)) continue;
      id ||= candidateId;
      for (const value of [props.label, props.attributeName, props.propertyName, props.enName]) if (typeof value === 'string' && clean(value)) labels.push(clean(value));
    }
    const enabled = controls.filter((node) => !node.disabled && node.getClientRects().length);
    const committedControls = enabled.filter((node) => node.type !== 'search');
    const customComboCommitted = row.getAttribute('data-kua-yipu-custom-committed') === 'true';
    let hasValue = committedControls.some((node) => ['checkbox', 'radio'].includes(node.type) ? node.checked
      : node.tagName === 'SELECT' ? [...node.selectedOptions].some((option) => option.value)
        : (node.getAttribute('role') !== 'combobox' || node.readOnly || customComboCommitted) && Boolean(clean(node.value)))
      || [...row.querySelectorAll('.next-select-values em, .next-tag-body, [class*="selected-value"]')].some((node) => clean(node.textContent));
    const values = committedControls.flatMap((node) => ['checkbox', 'radio'].includes(node.type)
      ? (node.checked ? [clean(node.closest('label')?.textContent || node.value)] : [])
      : node.tagName === 'SELECT' ? [...node.selectedOptions].filter((option) => option.value).map((option) => clean(option.textContent))
        : (node.getAttribute('role') !== 'combobox' || node.readOnly || customComboCommitted) && clean(node.value) ? [clean(node.value)] : []);
    values.push(...[...row.querySelectorAll('.next-select-values em, .next-tag-body, [class*="selected-value"]')].map((node) => clean(node.textContent)).filter(Boolean));
    const customValues = committedControls.filter((node) => ['INPUT', 'TEXTAREA'].includes(node.tagName) && !['checkbox', 'radio'].includes(node.type)
      && !node.readOnly && node.getAttribute('role') !== 'combobox').map((node) => clean(node.value)).filter(Boolean);
    // Remove an Other selector only when custom text replaces it. Other can
    // itself be the literal brand in a plain input (including phone forms).
    // Never discard a value that the editable input actually contains.
    let committedValues = customValues.length ? values.filter((value) => customValues.includes(value)
      || !/^(?:other|others|其他|其它|自定义)$/i.test(value)) : values;
    const repeatableText = Boolean(row.querySelector('.posting-field-multi-text'))
      && !enabled.some((node) => node.tagName === 'SELECT' || node.getAttribute('role') === 'combobox' || ['checkbox', 'radio'].includes(node.type));
    const controlType = repeatableText ? 'multiText' : field?.tagName === 'SELECT' ? (field.multiple ? 'multiSelect' : 'select')
      : field?.getAttribute('role') === 'combobox' || field?.readOnly ? 'combobox' : field?.type || '';
    const selectRoot = field?.closest('.next-select') || field?.closest('[role="combobox"]');
    // AutoComplete suggestions do not make a text field a closed selector.
    // Origin's property model is authoritative: an input search buffer alone
    // must never satisfy the required field or public-attribute transfer check.
    let allowsCustomValue = Boolean(selectRoot?.classList.contains('next-select-auto-complete'));
    if (id === '1' && field && !field.readOnly && ['text', 'textarea'].includes(controlType)) {
      const propertyName = row.id.replace(/^struct-/, '');
      let owner = fiberKey && row[fiberKey];
      let root = owner;
      while (root?.return) root = root.return;
      if (root?.stateNode?.current && root.stateNode.current !== root && owner?.alternate) owner = owner.alternate;
      for (let depth = 0; owner && depth < 12; depth++, owner = owner.return) {
        const props = owner.memoizedProps;
        if (props?.id !== 'icbuCatProp' || !propertyName || props.name !== propertyName) continue;
        const selected = props.value;
        const option = props.dataSource?.find?.(item => String(item.value) === String(selected?.value));
        committedValues = (typeof selected === 'string' ? [selected] : selected && !Array.isArray(selected)
          ? [selected.text, option?.text || option?.label] : []).map(clean).filter(Boolean);
        hasValue = committedValues.length > 0;
        // This editable native property can be probed with the exact source
        // text. Acceptance still requires the property model to commit it.
        allowsCustomValue = true;
        break;
      }
    }
    const multiFlag = field?.getAttribute('aria-multiselectable') ?? selectRoot?.getAttribute('aria-multiselectable');
    const multiple = ['multiSelect', 'checkbox', 'multiText'].includes(controlType) ? true
      : ['select', 'radio', 'number'].includes(controlType) ? false
        : multiFlag != null ? multiFlag === 'true'
          : selectRoot?.classList.contains('next-select-multiple') ? true
            : selectRoot?.classList.contains('next-select-single') ? false : undefined;
    let options = field?.tagName === 'SELECT' ? [...field.options].filter((option) => option.value)
      .map((option) => ({ value: option.value, label: clean(option.textContent), disabled: option.disabled || Boolean(option.parentElement?.disabled) }))
      : ['checkbox', 'radio'].includes(controlType) ? enabled.filter((node) => node.type === controlType)
        .map((node) => ({ value: node.value, label: clean(node.closest('label')?.textContent || node.value), disabled: node.disabled })) : [];
    // Cascading Next Select controls keep their choices on the mounted React
    // component even while the popup is closed. Read only this field's chain;
    // never borrow another attribute's option list from a shared ancestor.
    if (!options.length && selectRoot && field) {
      const reactKey = Object.getOwnPropertyNames(field).find(key => key.startsWith('__reactFiber'));
      let owner = reactKey && field[reactKey];
      for (let depth = 0; owner && depth < 14; depth++, owner = owner.return) {
        if (owner.stateNode?.nodeType === 1 && !row.contains(owner.stateNode)) break;
        const props = owner.memoizedProps;
        const choices = props?.dataSource || props?.options;
        if (!Array.isArray(choices) || !choices.length) continue;
        const readOptions = entries => entries.flatMap(option => {
          if (!option || typeof option !== 'object') return [];
          if (Array.isArray(option.children)) return readOptions(option.children);
          const label = option.label ?? option.text ?? option.name;
          return ['string', 'number'].includes(typeof label) && ['string', 'number'].includes(typeof option.value)
            ? [{ value: String(option.value), label: clean(label), disabled: option.disabled === true }] : [];
        });
        options = readOptions(choices).slice(0, 500);
        if (options.length) break;
      }
    }
    row.setAttribute('data-posting-attribute-row', String(index));
    return [{ id, label, labels: [...new Set(labels)], rowId: row.id, rowIndex: index, inputIndex: controls.indexOf(field), controlType,
      ...(field?.getAttribute('aria-autocomplete') ? { autocomplete: field.getAttribute('aria-autocomplete') } : {}),
      ...(allowsCustomValue ? { allowsCustomValue: true } : {}),
      ...(multiple !== undefined ? { multiple } : {}), ...(options.length ? { options } : {}),
      ...(field?.maxLength > 0 ? { maxLength: field.maxLength } : {}),
      disabled: controls.length > 0 && enabled.length === 0, values: [...new Set(committedValues)],
      saleSpecification: Boolean(row.closest('#struct-specification')),
      required: row.getAttribute('aria-required') === 'true' || row.getAttribute('data-required') === 'true'
        || Boolean(row.querySelector('label.required, .label.required, .next-form-item-label.required, [aria-required="true"], [required]')), hasValue }];
  });
}

export function sourceSpecificationForField(product, field) {
  if (!field.saleSpecification) return null;
  const groups = (product.variantGroups || []).filter((group) => group.options?.length);
  const byId = field.id && groups.filter((group) => attributeId(group) === field.id);
  if (byId?.length) return byId.length === 1 ? byId[0] : null;
  const names = new Set((field.labels || [field.label]).map(requiredAttributeKey));
  // Sales dimensions can receive a different ID after a category change.
  // Match the same complete aliases as the specification writer, only when
  // there is no exact-ID group and the name identifies one source dimension.
  const matches = groups.filter((group) => names.has(requiredAttributeKey(group.name)));
  return matches.length === 1 ? matches[0] : null;
}

export function sourceAttributeForField(product, field) {
  const items = [...(product.attributes || []), ...(product.customAttributes || [])].filter((item) => item?.name && item.value != null && clean(item.value));
  const exactNames = new Set((field.labels || [field.label]).map(attributeNameKey));
  const names = new Set((field.labels || [field.label]).map(requiredAttributeKey));
  // Resolve category properties before supplier detail text, including when
  // only the latter has an exact translated label or a previously bound ID.
  for (const candidates of [items.filter((item) => !isDescriptionAttribute(item) && !item.isCustom), items.filter(item => item.isCustom && !isDescriptionAttribute(item)), items.filter(isDescriptionAttribute)]) {
    if (field.id) {
      const exact = candidates.filter((item) => attributeMatchesFieldId(item, field));
      if (exact.length) return consistentAttribute(exact, true, field);
    }
    const compatible = candidates.filter((item) => !field.id || !attributeId(item) || attributeMatchesFieldId(item, field));
    const exact = compatible.filter((item) => exactNames.has(attributeNameKey(item.name)));
    // The OE field is sometimes regenerated when the same category is shown
    // in another language or on another seller account. Its canonical alias
    // is stronger than that stale ID, so allow only OE to bridge the mismatch
    // after the exact-ID pass has failed.
    const allowsCrossIdAlias = names.has('OE代码');
    // Some suppliers use "Battery" for a measured capacity. That shorthand
    // is valid only with an explicit capacity unit, never for Yes/No presence.
    const measuredBattery = (item) => names.has('电池容量') && requiredAttributeKey(item.name) === '电池'
      && [item.value].flat().every(value => /\b(?:mAh|Ah)\b/i.test(String(value).replace(/(\d)([a-z])/gi, '$1 $2'))
        && measurementValue(value, 'mah') != null);
    // "Frequency" is also used for AC power and machinery. Only treat it as
    // a mobile band when the source explicitly identifies a cellular system.
    const cellularFrequency = (item) => names.has('蜂窝频段') && /^(?:frequency|frequencies|频率)$/i.test(clean(item.name))
      && [item.value].flat().every(value => /\b(?:[2-5]G|GSM|WCDMA|LTE|FDD|TDD|NR)\b/i.test(String(value)))
      && !/\b(?:50|60)\s*Hz\b/i.test(String(item.value));
    const matched = exact.length ? exact : candidates.filter((item) => (matchesFieldAlias(item, field, names) || measuredBattery(item) || cellularFrequency(item))
      && (allowsCrossIdAlias || !field.id || !attributeId(item) || attributeMatchesFieldId(item, field)));
    if (matched.length) return consistentAttribute(matched, false, field);
  }
  return null;
}

function consistentAttribute(items, matchedById, field) {
  if (!items.length) return null;
  const key = requiredAttributeKey(field.label);
  if (key === '手机中央处理器' && (field.id === '200001044' || (field.labels || [field.label]).includes('手机中央处理器'))) {
    const entries = items.flatMap((item) => [item.value].flat().map((value) => ({ ...item, value })));
    if (entries.every((item) => cpuValueKind(item.value)) && entries.some((item) => cpuValueKind(item.value) === 'cores')) {
      items = entries.filter((item) => cpuValueKind(item.value) === 'cores');
    }
  }
  const unit = { 屏幕: 'inch', 电池容量: 'mah' }[key] || '';
  const multiple = field.multiple ?? ['multiSelect', 'checkbox'].includes(field.controlType);
  const values = items.flatMap((item) => [item.value].flat());
  const numeric = values.every((value) => hasMeasurementUnit(value) || (field.controlType === 'number' && measurementValue(value) != null));
  if (!multiple && (unit || numeric)) {
    const entries = items.flatMap((item) => [item.value].flat().map((rawValue) => {
      const value = measurementValue(rawValue, unit) ?? rawValue;
      return { ...item, value, ...(item.valueIds?.[rawValue] ? { valueIds: { [value]: item.valueIds[rawValue] } } : {}) };
    }));
    // Prefer a source measurement contained by every source range. Overlap
    // alone is insufficient: we never manufacture an intersection value.
    const specific = entries.find((item) => entries.every((other) => measurementFits(item.value, other.value, unit)));
    if (specific) return { ...specific, matchedById };
    items = entries;
  }
  const valueKey = (item) => JSON.stringify([...new Set(attributeValueList(item.value, {
    multiple: field.multiple !== false && (multiple || field.controlType === 'combobox' || key === '蜂窝网络'),
    options: field.options, valueIds: item.valueIds,
  }).map(attributeValueKey))].sort());
  const singleWithManyValues = field.multiple === false || ['select', 'radio'].includes(field.controlType);
  if (new Set(items.map(valueKey)).size > 1 || (singleWithManyValues && items.some((item) => new Set([item.value].flat().map(attributeValueKey)).size > 1))) {
    return { name: items[0].name, value: null, conflict: true, candidates: items.map((item) => ({ name: item.name, value: item.value, id: attributeId(item) })) };
  }
  return { ...items[0], matchedById };
}

// Keep the relationship between the seller's initial language and the Chinese
// form using stable property IDs, including categories absent from our aliases.
export function bindSourceAttributesToPostingSchema(product, schema) {
  let changed = false;
  const all = [...(product.attributes || []), ...(product.customAttributes || [])]
    .filter((item) => item?.name && item.value != null && clean(item.value));
  const exactName = (item, field) => (field.labels || [field.label]).some((label) => attributeNameKey(label) === attributeNameKey(item.name));
  const bind = (items = []) => items.map((item) => {
    if (attributeId(item) || item.isCustom) return item;
    const matches = schema.filter((field) => field.id && !field.saleSpecification
      && matchesFieldAlias(item, field, new Set((field.labels || [field.label]).map(requiredAttributeKey))));
    const exact = matches.filter((field) => exactName(item, field));
    // A broad alias must not acquire the same ID as a distinct, precisely
    // named source property. Keep it unbound for its own field or description.
    const eligible = (exact.length ? exact : matches.filter((field) => !all.some((other) => other !== item
      && isDescriptionAttribute(other) === isDescriptionAttribute(item)
      && (attributeId(other) === field.id || (!attributeId(other) && exactName(other, field))))))
      // Anonymous DOM rows may include a supplier's same-name custom value.
      // They cannot acquire an ID already supplied by the structured record.
      .filter((field) => !all.some((other) => other !== item && !other.isCustom && !isDescriptionAttribute(other)
        && attributeId(other) === field.id));
    const ids = [...new Set(eligible.map((field) => field.id))];
    if (ids.length !== 1) return item;
    changed = true;
    return { ...item, id: ids[0] };
  });
  const attributes = bind(product.attributes);
  const customAttributes = bind(product.customAttributes);
  return changed ? { ...product, ...(product.attributes ? { attributes } : {}), ...(product.customAttributes ? { customAttributes } : {}) } : product;
}
