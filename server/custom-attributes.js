import { REQUIRED_ATTRIBUTE_ALIASES } from './publish-reference.js';
import { isSourceInterfaceAttribute } from './category-attributes.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const keyOf = value => clean(value).normalize('NFKC').toLowerCase();

export function isSupplierCustomAttribute(item) {
  return Boolean(item?.isCustom) && !/^description-/.test(item.source || '')
    && !/packaging|delivery|shipping|logistics|supply\s*(?:ability|capacity)|包装|物流|发货|供货|供应能力/i.test(item.section || '')
    && !/^(?:selling units?|single package size|single gross weight|销售单位|单个包装尺寸|单个产品毛重)$/i.test(clean(item.name));
}

export function supplierCustomAttributes(product) {
  const rows = new Map();
  // Explicit editor values take precedence over older mixed source arrays.
  for (const item of [...(product.attributes || []).filter(isSupplierCustomAttribute), ...(product.customAttributes || [])]) {
    const name = clean(item?.name), value = [item?.value].flat().map(clean).filter(Boolean).join(', ');
    if (isSourceInterfaceAttribute(item)) continue;
    if (!name) continue;
    if (!value) { rows.delete(keyOf(name)); continue; }
    rows.set(keyOf(name), { ...item, name, value, isCustom: true });
  }
  return [...rows.values()];
}

const rootSelector = '#customMoreProperty';
const rowSelector = '.item:has(.attr-title input):has(.attr-value input)';
const failure = (name, reason) => Object.assign(new Error(`自定义属性“${name}”${reason}；已保留商品资料`),
  { code: 'PUBLISH_CUSTOM_ATTRIBUTE_REJECTED', fieldName: name, requiredFields: [name] });

export function customAttributePostingName(name) {
  if (!/[^\x00-\x7f]/.test(name)) return name;
  const aliases = REQUIRED_ATTRIBUTE_ALIASES.find(group => group.some(alias => keyOf(alias) === keyOf(name)));
  const english = aliases?.find(alias => /^[a-z0-9 ]+$/i.test(alias));
  if (!english) throw failure(name, '名称需要填写英文，未找到可确认的英文对应名称');
  return english.replace(/\b\w/g, letter => letter.toUpperCase());
}

function postingAttributes(product) {
  const rows = supplierCustomAttributes(product).map(item => ({ ...item, sourceName: item.name, name: customAttributePostingName(item.name) }));
  const seen = new Map();
  for (const row of rows) {
    const previous = seen.get(keyOf(row.name));
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

export async function fillCustomAttributes(page, product, fillAndVerify) {
  const expected = postingAttributes(product);
  if (!expected.length) return [];
  const root = page.locator(rootSelector);
  if (!await root.count()) throw failure(expected[0].name, '输入区域未加载');
  await root.scrollIntoViewIfNeeded();
  for (const item of expected) {
    const actual = await readCustomAttributes(page);
    let index = actual.findIndex(row => keyOf(row.name) === keyOf(item.name) || keyOf(row.name) === keyOf(item.sourceName));
    if (index < 0) index = actual.findIndex(row => !clean(row.name) && !clean(row.value));
    if (index < 0) {
      const add = root.locator('.add-attr-btn:visible');
      if (!await add.count() || !await add.isEnabled()) throw failure(item.name, '超过当前类目允许的数量');
      await add.click();
      index = actual.length;
      await root.locator(rowSelector).nth(index).waitFor({ state: 'visible', timeout: 3000 });
    }
    const row = root.locator(rowSelector).nth(index);
    for (const [selector, value, label] of [['.attr-title input', item.name, '名称'], ['.attr-value input', item.value, '值']]) {
      const input = row.locator(selector);
      const limit = Number(await input.getAttribute('maxlength')) || (label === '名称' ? 40 : 0);
      if (limit > 0 && value.length > limit) throw failure(item.name, `${label}超过平台 ${limit} 字符限制`);
      await fillAndVerify(input, value, `自定义属性${label}`);
      await input.press('Tab');
    }
  }
  return requireCustomAttributes(page, product);
}
