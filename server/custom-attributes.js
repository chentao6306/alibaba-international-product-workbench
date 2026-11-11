import { REQUIRED_ATTRIBUTE_ALIASES } from './publish-reference.js';
import { attributeId, isSourceInterfaceAttribute } from './category-attributes.js';
import { clickPostingControl } from './posting-interaction.js';
import { closePostingAttributeMenus } from './posting-popups.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const keyOf = value => clean(value).normalize('NFKC').toLowerCase();

export function isSupplierCustomAttribute(item) {
  return Boolean(item?.isCustom) && !/^description-/.test(item.source || '')
    && !/packaging|delivery|shipping|logistics|supply\s*(?:ability|capacity)|包装|物流|发货|供货|供应能力/i.test(item.section || '')
    && !/^(?:selling units?|single package size|single gross weight|销售单位|单个包装尺寸|单个产品毛重)$/i.test(clean(item.name));
}

export function supplierCustomAttributes(product) {
  const rows = new Map();
  const explicit = new Map();
  const append = (groups, item) => {
    const name = clean(item?.name);
    if (!name || isSourceInterfaceAttribute(item)) return;
    const key = keyOf(name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  };
  for (const item of (product.attributes || []).filter(isSupplierCustomAttribute)) append(rows, item);
  for (const item of product.customAttributes || []) append(explicit, item);
  // A single explicit edit, including a cleared value, owns the entire old
  // source property. Duplicate rows within the same input group are different:
  // retaining their evidence must happen before any name-based overwrite.
  for (const [key, items] of explicit) rows.set(key, items);
  return [...rows].flatMap(([key, items]) => {
    const normalized = items.map(item => ({ ...item, name: clean(item.name),
      value: [item.value].flat().map(clean).filter(Boolean).join(', '), isCustom: true }));
    if (normalized.length === 1) return normalized[0].value ? normalized : [];
    const ids = new Set(items.map(attributeId).filter(Boolean));
    const knownCaptures = items.every(item => /^(?:dom|detailData\.attributes)$/.test(item.source || ''));
    const sameProperty = ids.size === 1 && items.every(item => attributeId(item) === [...ids][0]);
    const sameAnonymousCapture = !ids.size && new Set(items.map(item => `${item.source}\n${item.section || ''}`)).size === 1;
    const sameValue = new Set(normalized.map(item => item.value)).size === 1;
    // The editor preserves capture metadata while changing names and values.
    // Its explicit duplicate rows are not fresh source fragments merely
    // because they still carry an old source/section or property ID.
    const canJoin = ids.size <= 1 && (sameValue || (!explicit.has(key) && knownCaptures && (sameProperty || sameAnonymousCapture)));
    // Keep ambiguous/manual conflicts visible in the editor. The posting
    // preflight below rejects them before any row is added or value replaced.
    if (normalized.every(item => !item.value)) return [];
    if (!canJoin || normalized.some(item => !item.value)) return normalized;
    const value = sameValue ? normalized[0].value
      : [...new Set(items.flatMap(item => [item.value].flat().map(clean).filter(Boolean)))].join(', ');
    const provenance = items.flatMap(item => item.customValueSources || [{ name: item.name, value: item.value,
      source: item.source || '', section: item.section || '', propertyId: attributeId(item) }]);
    const uniqueProvenance = [...new Map(provenance.map(item => [JSON.stringify(item), item])).values()];
    const identified = normalized.find(item => attributeId(item)) || normalized[0];
    return [{ ...identified, value, customValueSources: uniqueProvenance }];
  });
}

const rootSelector = '#customMoreProperty';
const rowSelector = '.item:has(.attr-title input):has(.attr-value input)';
const failure = (name, reason) => Object.assign(new Error(`自定义属性“${name}”${reason}；已保留商品资料`),
  { code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED', fieldName: name, requiredFields: [name] });

// This source-exposed service label is longer than the custom form's 40-char
// limit. Drop only the redundant verb in this exact known label, retaining
// both services and the unchanged source value. Never truncate arbitrary
// labels or units. postingAttributes retains sourceName for transfer receipts
// and rejects collisions before the form is touched.
const COMPACT_CUSTOM_NAMES = new Map([
  ['provide mould making and sample making service', 'Mould making and sample making service'],
]);

export function customAttributePostingName(name) {
  const compact = COMPACT_CUSTOM_NAMES.get(keyOf(name));
  if (compact) return compact;
  if (!/[^\x00-\x7f]/.test(name)) return name;
  const aliases = REQUIRED_ATTRIBUTE_ALIASES.find(group => group.some(alias => keyOf(alias) === keyOf(name)));
  // Only known aliases are translated. Retain explicit unit suffixes such as
  // (W): removing the unit would change the custom property's meaning.
  const english = aliases?.find(alias => /^[a-z0-9 ]+(?:\([a-z0-9]+\))?$/i.test(alias));
  if (!english) throw failure(name, '名称需要填写英文，未找到可确认的英文对应名称');
  return english.replace(/\b\w/g, letter => letter.toUpperCase());
}

function postingAttributes(product) {
  const rows = supplierCustomAttributes(product).map(item => ({ ...item, sourceName: item.name, name: customAttributePostingName(item.name) }));
  const seen = new Map();
  for (const row of rows) {
    const previous = seen.get(keyOf(row.name));
    if (previous && attributeId(previous) && attributeId(row) && attributeId(previous) !== attributeId(row)) {
      throw failure(row.sourceName, '同名属性对应不同来源 ID，不能覆盖');
    }
    if (previous && previous.value !== row.value) throw failure(row.sourceName, '英文名称对应多个不同值，不能覆盖');
    seen.set(keyOf(row.name), row);
  }
  return [...seen.values()];
}

async function requireCustomValidation(page) {
  const errors = await page.locator(`${rootSelector} .next-form-item-help:visible, ${rootSelector} .next-message-error:visible, ${rootSelector} [role="alert"]:visible`).allTextContents();
  const message = errors.map(clean).filter(Boolean).join('；');
  if (message) throw failure('发布页', `校验未通过：${message}`);
}

export async function readCustomAttributes(page) {
  return page.locator(`${rootSelector} ${rowSelector}`).evaluateAll(nodes => nodes.map(node => ({
    name: node.querySelector('.attr-title input')?.value || '', value: node.querySelector('.attr-value input')?.value || '',
  })));
}

export async function requireCustomAttributes(page, product) {
  const expected = postingAttributes(product);
  if (!expected.length) return [];
  const actual = await readCustomAttributes(page);
  for (const item of expected) {
    if (!actual.some(row => keyOf(row.name) === keyOf(item.name) && clean(row.value) === item.value)) {
      throw failure(item.name, '未被发布页完整保留');
    }
  }
  await requireCustomValidation(page);
  // Callers track transfer coverage by the source label. Keep that identity
  // while reporting the actual English label committed on the posting form.
  return expected.map(item => ({ ...item, name: item.sourceName, postingName: item.name }));
}

async function customRowForWrite(root, page, item, timeoutMs) {
  let deadline = Date.now() + timeoutMs;
  let actual = [], add, dispatched = false, clickError;
  while (Date.now() <= deadline) {
    actual = await readCustomAttributes(page);
    let index = actual.findIndex(row => keyOf(row.name) === keyOf(item.name) || keyOf(row.name) === keyOf(item.sourceName));
    if (index < 0) index = actual.findIndex(row => !clean(row.name) && !clean(row.value));
    if (index >= 0) return root.locator(rowSelector).nth(index);
    add = root.locator('.add-attr-btn:visible').first();
    if (!await add.count()) add = root.getByRole('button', { name: /^(?:\+\s*)?(?:添加自定义属性|新增自定义属性|Add custom attribute)$/i }).first();
    if (!dispatched && await add.count() && await add.isVisible() && await add.isEnabled()) {
      // Re-read the actual rows after dispatch, including a timed-out click.
      // Never dispatch a second add while the first result is uncertain.
      try {
        // A custom-name recommendation can reopen between the actionability
        // trial and dispatch when Add is beside the sticky footer. Move the
        // trigger into the usable form first, then dismiss the old input UI.
        // Never retry the actual add if its result is uncertain.
        await add.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
        if (!await closePostingAttributeMenus(page, add)) throw failure(item.name, '输入建议菜单尚未关闭');
        // Reading existing rows can exhaust the row-wait budget on a busy
        // renderer. The verified click keeps its normal action budget.
        await clickPostingControl(page, add, { beforeDispatch: async () => {
          if (!await closePostingAttributeMenus(page, add)) throw failure(item.name, '输入建议菜单尚未关闭');
        } });
      } catch (error) {
        if (error.code !== 'PUBLISH_CONTROL_RESULT_UNKNOWN') throw error;
        clickError = error;
      }
      dispatched = true;
      // Locating/scrolling/clicking can consume the entire original budget.
      // Give the resulting row its own bounded settlement window.
      deadline = Date.now() + timeoutMs;
      continue;
    }
    await page.waitForTimeout(100);
  }
  // Read once more at the boundary: the native row can appear while the last
  // wait is completing. Do not report an old row count after a successful add.
  actual = await readCustomAttributes(page);
  const index = actual.findIndex(row => keyOf(row.name) === keyOf(item.name) || keyOf(row.name) === keyOf(item.sourceName)
    || !clean(row.name) && !clean(row.value));
  if (index >= 0) return root.locator(rowSelector).nth(index);
  const message = dispatched ? '新增输入行后未能确认，已停止重复添加'
    : `当前已显示 ${actual.length} 项，新增入口不可用或尚未加载，未确认平台数量上限`;
  const error = failure(item.name, message);
  error.diagnostics = { section: 'custom-attributes', existingRows: actual.length, addDispatched: dispatched };
  if (clickError) error.cause = clickError.cause || clickError;
  throw error;
}

export async function fillCustomAttributes(page, product, fillAndVerify, { timeoutMs = 3000 } = {}) {
  const expected = postingAttributes(product);
  if (!expected.length) return [];
  const root = page.locator(rootSelector);
  if (!await root.count()) throw failure(expected[0].name, '输入区域未加载');
  await root.scrollIntoViewIfNeeded();
  for (const item of expected) {
    // Stable passes revisit this section after other dependent fields. Do not
    // refocus an already committed name and reopen its recommendations.
    const actual = await readCustomAttributes(page);
    if (actual.some(row => keyOf(row.name) === keyOf(item.name) && clean(row.value) === item.value)) continue;
    const row = await customRowForWrite(root, page, item, timeoutMs);
    for (const [selector, value, label] of [['.attr-title input', item.name, '名称'], ['.attr-value input', item.value, '值']]) {
      const input = row.locator(selector);
      const limit = Number(await input.getAttribute('maxlength')) || (label === '名称' ? 40 : 0);
      if (limit > 0 && value.length > limit) throw failure(item.name, `${label}超过平台 ${limit} 字符限制`);
      if (clean(await input.inputValue()) !== value) await fillAndVerify(input, value, `自定义属性${label}`);
    }
    // fillAndVerify already blurs each field and reads it back. A second Tab
    // can focus another name input and open a new menu over the next Add.
    if (!await closePostingAttributeMenus(page)) throw failure(item.name, '输入建议菜单尚未关闭');
    const committed = await readCustomAttributes(page);
    if (!committed.some(row => keyOf(row.name) === keyOf(item.name) && clean(row.value) === item.value)) {
      throw failure(item.name, '关闭输入建议后未被发布页完整保留');
    }
  }
  return requireCustomAttributes(page, product);
}
