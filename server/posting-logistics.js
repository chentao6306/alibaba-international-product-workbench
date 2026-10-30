import { clickPostingControl } from './posting-interaction.js';

// These exact checklist phrases describe eligibility for a transactional
// listing. They are not a rejection unless the page renders them as an error.
export function isLogisticsReadinessHint(text) {
  const normalized = String(text || '').normalize('NFKC').replace(/[\s:：;；,，。()（）]/g, '');
  if (!normalized) return false;
  const remainder = normalized
    .replace(/填写完整物流信息后选择物流提供方式(?:即运费模[版板]的选择)?/g, '')
    .replace(/(?:最小起订量的发货期|重量|体积|物流属性)(?:已填写|未填写)/g, '');
  return remainder === '';
}

// Serialized into the posting page. Product properties, sample packaging and
// commercial text are separate domains, even when their labels contain weight.
export function readPostingLogistics() {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (node) => Boolean(node?.getClientRects().length);
  const classify = (text) => {
    if (/weight|gross|重量|毛重/i.test(text)) return 'weight';
    if (/length|包装长|(?:^|\s)长(?:\s|[（(]|$)/i.test(text)) return 'length';
    if (/width|包装宽|(?:^|\s)宽(?:\s|[（(]|$)/i.test(text)) return 'width';
    if (/height|包装高|(?:^|\s)高(?:\s|[（(]|$)/i.test(text)) return 'height';
    if (/volume|体积/i.test(text)) return 'volume';
    return '';
  };
  const fields = [];
  for (const node of document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea')) {
    if (!visible(node) || node.disabled || node.readOnly || node.closest('.sell-catProp-item, #struct-specification, [data-attribute-id], [data-property-id], [id*="sample" i]')) continue;
    const own = `${node.name || ''} ${node.id || ''} ${node.placeholder || ''} ${node.getAttribute('aria-label') || ''}`;
    const root = node.closest('#pkgMeasure, #pkgWeight, #struct-logistics, #logistics, [id*="logistics" i], [id*="packaging" i], [class*="logistics" i]');
    const context = clean(node.closest('label, [role="gridcell"], .next-form-item')?.textContent || node.parentElement?.textContent);
    if (!root && !/pkg(?:Weight|Length|Width|Height)|grossWeight|package(?:Weight|Length|Width|Height)|包装|毛重/i.test(own + ' ' + context)) continue;
    let key = classify(own) || classify(context);
    const measure = node.closest('#pkgMeasure');
    if (measure) key = ['length', 'width', 'height'][[...measure.querySelectorAll('input')].indexOf(node)] || key;
    if (!key) continue;
    const unitText = `${own} ${context}`;
    const unit = key === 'volume' ? (/m[³3]|cbm|立方米/i.test(unitText) && !/cm[³3]/i.test(unitText) ? 'm3' : 'cm3')
      : key === 'weight' ? (/\b(?:g|grams?)\b|(?:^|[^千公])克(?:$|\s|[)）])/i.test(unitText) ? 'g' : /\b(?:lb|lbs)\b/i.test(unitText) ? 'lb' : 'kg')
        : /\bmm\b|毫米/i.test(unitText) ? 'mm' : /\b(?:inch|inches|in)\b|英寸/i.test(unitText) ? 'in' : /\bm\b|(?:^|[^厘毫])米(?:$|\s|[)）])/i.test(unitText) ? 'm' : 'cm';
    const index = fields.length;
    node.setAttribute('data-posting-logistics', String(index));
    fields.push({ index, key, unit, value: node.value, required: node.required || node.getAttribute('aria-required') === 'true'
      || Boolean(node.closest('.next-form-item')?.querySelector('.required')) });
  }
  return fields;
}

export function logisticsControlValue(packaging, field) {
  const positive = (value) => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
  const key = field.key;
  let value;
  if (key === 'volume') {
    if (!['length', 'width', 'height'].every((key) => positive(packaging[key]))) return null;
    value = Number(packaging.length) * Number(packaging.width) * Number(packaging.height);
    if (field.unit === 'm3') value /= 1e6;
  } else {
    if (!positive(packaging[key])) return null;
    value = Number(packaging[key]);
    const factors = key === 'weight' ? { kg: 1, g: 1000, lb: 1 / 0.45359237 } : { cm: 1, mm: 10, m: 0.01, in: 1 / 2.54 };
    value *= factors[field.unit] ?? 1;
  }
  return String(Number(value.toPrecision(12)));
}

export function missingLogisticsFields(fields, packaging, { complete = false, allowPartial = false } = {}) {
  const labels = { weight: '包装重量', length: '包装长', width: '包装宽', height: '包装高', volume: '包装体积' };
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const active = fields.some((field) => positive(field.value));
  return fields.filter((field) => {
    const expected = logisticsControlValue(packaging, field);
    if (!positive(field.value)) return complete || field.required || expected != null || (!allowPartial && active);
    // A dependent form rebuild can replace a previously verified number with
    // another positive value. Recheck the supplied fact in the control's unit.
    return expected != null && Math.abs(Number(field.value) - Number(expected)) > Math.max(1, Math.abs(Number(expected))) * 1e-10;
  })
    .map((field) => ({ field: field.key, label: labels[field.key], reason: logisticsControlValue(packaging, field) == null ? 'missing_source' : 'not_committed' }));
}

export function sourceLogisticsAttributes(product) {
  const value = product.logisticsAttributes ?? (product.attributes || [])
    .find((item) => /^(?:物流属性|logistics attributes?)$/i.test(String(item.name).trim()))?.value;
  return [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[\n；;]/)).map((value) => String(value).trim()).filter(Boolean))];
}

// Values committed in the form immediately before the successful action.
// Canonical kg/cm values let a later explicit reference survive UI unit changes.
export async function capturePostingLogistics(page) {
  const fields = await page.evaluate(readPostingLogistics);
  const packaging = {};
  for (const key of ['weight', 'length', 'width', 'height']) {
    const candidates = fields.filter((field) => field.key === key && Number(field.value) > 0).map((field) => {
      const factors = key === 'weight' ? { kg: 1, g: 0.001, lb: 0.45359237 } : { cm: 1, mm: 0.1, m: 100, in: 2.54 };
      return Number((Number(field.value) * (factors[field.unit] ?? 1)).toPrecision(12));
    });
    if (candidates.length && candidates.every((value) => Math.abs(value - candidates[0]) < 1e-8)) packaging[key] = candidates[0];
  }
  const controls = await page.evaluate(() => {
    const visible = (node) => Boolean(node.getClientRects().length);
    const contents = [...document.querySelectorAll('#logisticsProperty .logistics-property-content')].filter(visible);
    const logisticsAttributes = [...new Set(contents.flatMap((node) => (node.innerText || '').split(/[\n；;]/).map((text) => text.trim()).filter(Boolean)))];
    const root = [...document.querySelectorAll('#shippingTemplateId')].find(visible);
    const field = root?.matches('input,select') ? root : root?.querySelector('input,select');
    const freightTemplate = field?.tagName === 'SELECT' ? [...field.selectedOptions].filter((option) => option.value).map((option) => option.textContent.trim()).join('')
      : root?.querySelector('.next-select-values em, .next-tag-body')?.textContent?.trim() || (field?.readOnly ? field.value : '');
    return { logisticsAttributes, ...(freightTemplate ? { freightTemplate } : {}) };
  });
  return { packaging, ...controls };
}

export async function fillLogisticsAttributes(page, product) {
  const values = sourceLogisticsAttributes(product);
  if (!values.length) return false;
  const normalize = (value) => String(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const targets = values.map(normalize);
  if (targets.length > 1 && targets.some((value) => /^(?:普货|generalcargo)$/.test(value))) {
    throw Object.assign(new Error('物流属性不能同时选择普货和电池、液体等特殊属性'), { code: 'PUBLISH_REQUIRED_DATA_MISSING', requiredFields: ['物流属性'] });
  }
  const content = page.locator('#logisticsProperty .logistics-property-content:visible').last();
  const committed = async () => {
    const text = normalize(await content.innerText({ timeout: 1000 }).catch(() => ''));
    return targets.every((value) => text.includes(value));
  };
  if (await committed()) return true;
  const add = page.locator('#logisticsProperty button:visible').last();
  if (!await add.count()) return false;
  await clickPostingControl(page, add);
  const dialog = page.locator('.product-attr-dialog:visible').last();
  try {
    const tags = dialog.locator('.tagWrapper .tag');
    await tags.first().waitFor({ state: 'visible', timeout: 15000 });
    const options = await tags.allTextContents();
    const indices = targets.map((value) => options.findIndex((option) => normalize(option) === value));
    if (indices.some((index) => index < 0)) return false;
    for (let index = 0; index < options.length; index++) {
      const selected = /\bisSelected\b/.test(await tags.nth(index).getAttribute('class') || '');
      if (selected !== indices.includes(index)) await clickPostingControl(page, tags.nth(index), { timeout: 3000 });
    }
    await clickPostingControl(page, dialog.getByRole('button', { name: /^(?:确认|Confirm|OK)$/i }));
    const deadline = Date.now() + 3000;
    do { if (await committed()) return true; await page.waitForTimeout(150); } while (Date.now() < deadline);
    return false;
  } finally {
    if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: /^(?:取消|Cancel)$/i }).click({ timeout: 1500 }).catch(() => {});
  }
}
