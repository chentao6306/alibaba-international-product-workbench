import { requiredAttributeKey } from './publish-reference.js';
import { browserResourcePolicy } from './browser-resource-policy.js';
import { clickPostingControl } from './posting-interaction.js';

const valueKey = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const nameKey = (name) => /^(?:socket standard|socket type|plug type|output plug|connector type|connector|插座标准|插头类型|输出插头|连接器类型)$/i.test(String(name || '').trim())
  ? requiredAttributeKey('plug type') : requiredAttributeKey(name);
const skuKey = (attributes) => JSON.stringify(Object.entries(attributes || {}).map(([name, value]) => [nameKey(name), valueKey(value)]).sort());

export function usesSkuPricing(product) {
  const skus = (product.skus || []).filter(sku => sku.enabled !== false);
  return skus.length > 0 && (product.priceMode === 'sku'
    || new Set(skus.filter(sku => Number(sku.price) > 0).map(sku => Number(sku.price))).size > 1);
}

export const SKU_PRICE_INPUT = '[data-name="skuPrice"] input, [data-name="price"] input, input[name*="skuPrice" i]';

const SKU_PRICING_LABEL = /^(?:根据规格设置价格|按(?:商品)?规格(?:设置)?(?:报价|定价|价格)?|按\s*SKU(?:设置)?(?:价格|定价)|Price by SKU|SKU pricing|Pricing by SKU|Set prices? by (?:SKU|variants?|specifications?)|Per SKU)(?:\s*[\uE000-\uF8FF])*$/i;

async function skuPricingControl(page) {
  for (const locator of [page.getByRole('radio', { name: SKU_PRICING_LABEL }),
    page.locator('#scPrice .item-label, #struct-scPrice .item-label').filter({ hasText: SKU_PRICING_LABEL }),
    page.locator('label').filter({ hasText: SKU_PRICING_LABEL })]) {
    const control = locator.filter({ visible: true }).first();
    if (await control.count()) return control;
  }
  return null;
}

async function skuPricingSelected(control) {
  return control.evaluate(node => {
    const root = node.closest('.icbuRadio-item, label, [role="radio"]') || node;
    const radio = root.matches('input[type="radio"]') ? root : root.querySelector('input[type="radio"]');
    if (radio) return radio.checked;
    const aria = root.getAttribute('aria-checked');
    return aria == null ? null : aria === 'true';
  }).catch(() => false);
}

export function skuMinimumOrderQuantity(product) {
  const raw = [product.minOrder, product.moq, product.priceTiers?.[0]?.minQuantity]
    .find(value => value != null && String(value).trim() !== '') ?? 1;
  // The collected MOQ can carry its selling unit. Do not type that unit (or
  // thousands separators) into a numeric control, or guess a range's endpoint.
  const unit = '(?:pieces?|pcs|sets?|pairs?|units?|items?|bags?|boxes?|cartons?|packs?|kilograms?|kg|grams?|g|(?:square |cubic )?(?:meters?|metres?)|m[²³23]?|(?:metric )?tons?|tonnes?|liters?|litres?|l|rolls?|sheets?|dozens?|feet|foot|ft|yards?|pounds?|lbs?|件|个|套|双|包|箱|千克|公斤|克|平方米|立方米|米|吨|升|卷)';
  const match = String(raw).trim().match(new RegExp(`^((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)\\s*(?:${unit}(?:\\s*\\/\\s*${unit})?)?$`, 'i'));
  const value = match ? Number(match[1].replaceAll(',', '')) : NaN;
  if (!(value > 0) || !Number.isFinite(value)) throw Object.assign(new Error(`来源最小起订量“${raw}”不能明确转换为数量，请核对商品交易信息；未提交商品`), { code: 'PUBLISH_SOURCE_DATA_INVALID', fieldName: '最小起订量' });
  return value;
}

async function skuQuantityControl(page) {
  // Separate priority queries matter: a comma selector takes DOM order and
  // previously chose an earlier customization/sample/ladder quantity.
  const selectors = [
    'input#minOrderQuantity, input[name="minOrderQuantity"], input[uitype="minOrderQuantity"]',
    '#struct-minOrderQuantity input, [id="minOrderQuantity"] input',
    'input[placeholder*="起订"], input[placeholder*="minimum order" i]',
    '#struct-scPrice input[role="input-quantity"], #scPrice input[role="input-quantity"]',
  ];
  for (const selector of selectors) {
    const candidates = page.locator(selector).filter({ visible: true });
    const eligible = [];
    for (let index = 0; index < await candidates.count(); index++) {
      const field = candidates.nth(index);
      if (await field.evaluate(node => !node.closest('#sku, .posting-field-ladder, .customizedServices, #customizedServices, #struct-customizedServices, #sample, #struct-sample')).catch(() => false)) eligible.push(field);
    }
    if (eligible.length > 1) return { ambiguous: true };
    if (eligible.length === 1) return { field: eligible[0] };
  }
  return {};
}

export async function requireSkuMinimumOrder(page, product) {
  if (!usesSkuPricing(product)) return null;
  const expected = skuMinimumOrderQuantity(product);
  const { field, ambiguous } = await skuQuantityControl(page);
  const actual = await field?.inputValue({ timeout: 750 }).catch(() => '');
  const control = await skuPricingControl(page);
  if (ambiguous || !field || !String(actual ?? '').trim() || Number(String(actual).replaceAll(',', '')) !== expected
    || (control ? await skuPricingSelected(control) === false : !await page.locator(`#sku ${SKU_PRICE_INPUT.split(', ').join(', #sku ')}`).filter({ visible: true }).count())) {
    throw Object.assign(new Error('提交前最小起订量或按规格定价状态发生变化，已停止提交，请重试当前商品'), {
      code: 'PUBLISH_FIELD_NOT_READY', fieldName: '最小起订量', diagnostics: { reason: 'sku-minimum-order-changed', expected, actual, ambiguous: Boolean(ambiguous) },
    });
  }
  return { expected, actual: Number(String(actual).replaceAll(',', '')) };
}

export async function reconcileSkuMinimumOrder(page, product, { timeoutMs = 10000 } = {}) {
  if (!usesSkuPricing(product)) return null;
  // Dependent commerce/media controls may recreate this input. Repair only
  // its value here, without changing the pricing mode or rebuilding the SKU table.
  await commitSkuMinimumOrder(page, product, timeoutMs);
  return requireSkuMinimumOrder(page, product);
}

async function commitSkuMinimumOrder(page, product, timeoutMs) {
  const expected = skuMinimumOrderQuantity(product);
  const deadline = performance.now() + timeoutMs;
  let actual = '', reason = 'missing', attempts = 0, stableSince = 0;
  while (performance.now() < deadline) {
    const { field, ambiguous } = await skuQuantityControl(page);
    if (ambiguous) { reason = 'ambiguous'; break; }
    if (field && await field.isEditable().catch(() => false)) {
      actual = await field.inputValue({ timeout: 750 }).catch(() => '');
      if (String(actual).trim() && Number(String(actual).replaceAll(',', '')) === expected) {
        stableSince ||= performance.now();
        if (performance.now() - stableSince >= 450) return;
      } else {
        stableSince = 0;
        reason = 'rejected-or-replaced';
        // Normal input/blur events must reach the controlled form. Re-query
        // after replacement; do not force a DOM value that the model rejected.
        try {
          if (attempts++ % 3 === 2) {
            await field.click({ timeout: 750 });
            await field.press('Control+A', { timeout: 750 });
            await field.pressSequentially(String(expected), { delay: 20, timeout: 1000 });
          } else await field.fill(String(expected), { timeout: 750 });
          await field.press('Tab', { timeout: 750 });
        } catch (error) { if (page.isClosed()) throw error; }
      }
    } else { stableSince = 0; reason = field ? 'not-editable' : 'missing'; }
    await page.waitForTimeout(Math.min(150, Math.max(1, deadline - performance.now())));
  }
  throw Object.assign(new Error(reason === 'missing'
    ? '按规格定价的最小起订量输入框尚未加载，未提交当前商品'
    : '最小起订量未被当前发布表单稳定接受；已保留商品资料，未提交当前商品'), {
    code: 'PUBLISH_FIELD_NOT_READY', fieldName: '最小起订量', diagnostics: { reason, expected, actual, attempts },
  });
}

export async function selectSkuPricing(page, product, fill, { timeoutMs = 10000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  const prices = page.locator(`#sku ${SKU_PRICE_INPUT.split(', ').join(', #sku ')}`).filter({ visible: true });
  let control;
  let skuRevealed = false;
  // The mode is lazy-rendered and can be replaced after sales properties change.
  // Reveal the pricing section and re-query; a single count() is not readiness.
  do {
    if (!skuRevealed) {
      const sku = page.locator('#sku').filter({ visible: true });
      if (await sku.count()) skuRevealed = await sku.scrollIntoViewIfNeeded({ timeout: Math.max(1, Math.min(1000, deadline - performance.now())) }).then(() => true, () => false);
      // Mounting the virtual SKU table updates the pricing-mode options.
      if (skuRevealed) await page.waitForTimeout(150);
    }
    const section = page.locator('#struct-scPrice, #scPrice, #struct-priceAndInventory, #sku').filter({ visible: true }).first();
    if (await section.count()) await section.scrollIntoViewIfNeeded({ timeout: Math.max(1, Math.min(1000, deadline - performance.now())) }).catch(() => {});
    control = await skuPricingControl(page);
    if (control || await prices.count()) break;
    if (performance.now() < deadline) await page.waitForTimeout(Math.min(150, deadline - performance.now()));
  } while (performance.now() < deadline);
  if (!control && !await prices.count()) {
    const options = await page.locator('#scPrice .item-label, #struct-scPrice label, #struct-scPrice [role="radio"]').filter({ visible: true })
      .allTextContents().then(values => [...new Set(values.map(value => value.trim()).filter(Boolean))]);
    throw Object.assign(new Error(`当前发布页等待规格联动后仍未提供按规格定价${options.length ? `（可见方式：${options.join('、')}）` : ''}；请核对该账号及类目的定价方式，各规格价格已保留，未合并价格或提交商品`), {
      code: 'PUBLISH_FIELD_NOT_READY', fieldName: '规格价格', diagnostics: { reason: 'sku-pricing-mode-missing', options },
    });
  }
  if (control && !await skuPricingSelected(control)) await clickPostingControl(page, control, { timeout: timeoutMs });
  // MOQ is shared across combinations, but its price is never a substitute
  // for per-SKU values. SKU prices are committed after the matrix is ready.
  await commitSkuMinimumOrder(page, product, timeoutMs);
  if (control) {
    const freshControl = await skuPricingControl(page);
    const selected = freshControl && await skuPricingSelected(freshControl);
    if (selected === false || (selected !== true && !await prices.count())) {
      throw Object.assign(new Error('按规格定价未生效，未提交当前商品'), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '规格价格' });
    }
  }
}

export function resolveReferencedSkuRows(product, groups, { appliedGroups = [], normalizeValue = (value) => value } = {}) {
  const mismatch = () => new Error('商品 SKU 与国际站规格组合不一致，请检查规格选项');
  const total = groups.reduce((count, group) => count * group.options.length, groups.length ? 1 : 0);
  if (!total || total > 5000) throw mismatch();
  const targetNames = new Set(groups.map((group) => nameKey(group.name)));
  const expected = new Map();
  for (const sku of product.skus) {
    const attributes = Object.fromEntries(Object.entries(sku.attributes || {}).map(([name, value]) => [nameKey(name), value]));
    for (const group of appliedGroups) {
      const sourceNames = (group.sourceGroups || [group.name]).map(nameKey);
      if (sourceNames.some((name) => attributes[name] == null)) continue;
      const rawValue = group.sourceGroups?.length
        ? sourceNames.map((name) => normalizeValue(attributes[name])).join(' / ')
        : attributes[sourceNames[0]];
      // The field writer observed this label on the same selected attribute
      // ID. This also covers translations absent from the static alias list.
      let targetName = nameKey(group.targetName || group.name);
      if (group.sourceGroups?.length && groups.length === 1) targetName = nameKey(groups[0].name);
      if (!targetNames.has(targetName)) continue;
      const actualValue = group.appliedValues?.[rawValue] ?? group.appliedValues?.[normalizeValue(rawValue)] ?? rawValue;
      sourceNames.forEach((name) => delete attributes[name]);
      attributes[targetName] = actualValue;
    }
    // A constant descriptive attribute may be absent from the target matrix.
    // Only omit it when every source SKU agrees; never collapse real variants.
    for (const name of Object.keys(attributes)) {
      if (targetNames.has(name)) continue;
      const values = product.skus.map((item) => Object.entries(item.attributes || {}).find(([key]) => nameKey(key) === name)?.[1]);
      if (values.every((value) => value != null && valueKey(normalizeValue(value)) === valueKey(normalizeValue(attributes[name])))) delete attributes[name];
    }
    const key = skuKey(Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, normalizeValue(value)])));
    if (expected.has(key)) throw new Error('商品 SKU 转换后出现重复规格组合，未写入价格、编码和库存');
    expected.set(key, sku);
  }
  const resolved = Array.from({ length: total }, (_, index) => {
    let remainder = index;
    const attributes = {};
    for (let i = groups.length - 1; i >= 0; i--) {
      attributes[groups[i].name] = normalizeValue(groups[i].options[remainder % groups[i].options.length]);
      remainder = Math.floor(remainder / groups[i].options.length);
    }
    return { attributes, sku: expected.get(skuKey(attributes)) };
  });
  const matched = new Set(resolved.filter((row) => row.sku).map((row) => row.sku));
  if (matched.size !== product.skus.length || resolved.filter((row) => row.sku).length !== matched.size) throw mismatch();
  return resolved;
}

// Alibaba virtualizes the SKU body and merges repeating property cells. Its
// header records the complete ordered options and data-row gives the absolute
// combination index, so neither scrolling nor merged cells can shift a SKU.
export async function fillReferencedSkuRows(page, product, fill, onProgress = () => {}, { timeoutMs = browserResourcePolicy().constrained ? 20000 : 10000, appliedGroups = [], normalizeValue } = {}) {
  const priceBySku = usesSkuPricing(product);
  if ((!product.categoryReference && !priceBySku) || !product.skus?.length || !product.variantGroups?.some((group) => group.options?.length)) return { filled: 0 };
  const root = page.locator('#sku');
  const notReady = () => Object.assign(new Error('国际站规格表尚未完成加载，已保留商品和任务进度，未提交当前商品'), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '规格表' });
  onProgress('等待并核对规格表');
  await root.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => { throw notReady(); });
  // Alibaba defers its virtualized SKU headers until the section is on-screen.
  await root.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => { throw notReady(); });
  const readGroups = () => root.locator('.sku-header th').evaluateAll((nodes) => nodes.map((node) => ({
    name: node.querySelector('.th-saleProps-label > span')?.textContent?.trim(),
    options: [...node.querySelectorAll('.checkSelectBabel .labelText')].map((option) => option.textContent.trim()),
  })).filter((group) => group.name && group.options.length));
  const deadline = performance.now() + timeoutMs;
  let resolved;
  while (!resolved) {
    const groups = await readGroups();
    try {
      if (!groups.length) throw notReady();
      resolved = resolveReferencedSkuRows(product, groups, { appliedGroups, normalizeValue });
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await page.waitForTimeout(150);
    }
  }
  const total = resolved.length;
  const scroll = root.locator('.virtualized-table-scroll-wrapper');
  await scroll.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  const completed = new Set();
  let stagnant = 0;
  while (completed.size < total) {
    const indices = await root.locator('[data-name="skuOuterId"][data-row]').evaluateAll((nodes) => [...new Set(nodes.map((node) => Number(node.dataset.row)))].sort((a, b) => a - b));
    const before = completed.size;
    for (const index of indices) {
      if (completed.has(index) || !resolved[index]) continue;
      const sku = resolved[index].sku;
      const row = root.locator(`[data-name="skuOuterId"][data-row="${index}"]`).locator('xpath=..');
      const toggle = row.locator('[data-name="operate"] [role="switch"]');
      const enabled = Boolean(sku && sku.enabled !== false);
      // Disabled reference rows still retain their code and quantity. Enable
      // briefly when needed so Alibaba allows the input, then restore state.
      if (sku) {
        if (await toggle.count() && await toggle.getAttribute('aria-checked') !== 'true') await clickPostingControl(page, toggle);
        if (priceBySku && (enabled || Number(sku.price) > 0)) {
          if (!(Number(sku.price) > 0)) throw new Error(`第 ${index + 1} 行 SKU 缺少有效价格，未使用统一价格替代`);
          const price = row.locator(SKU_PRICE_INPUT).filter({ visible: true }).first();
          await price.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => { throw notReady(); });
          await fill(price, Number(sku.price).toFixed(2), `第 ${index + 1} 行规格价格`);
          if (Number(await price.inputValue()) !== Number(Number(sku.price).toFixed(2))) throw new Error(`第 ${index + 1} 行规格价格未保存`);
        }
        await fill(row.locator('[data-name="skuOuterId"] input'), String(sku.code || sku.skuCode || ''), `第 ${index + 1} 行商品编码`);
        await fill(row.locator('[data-name="skuStock"] input').first(), sku.stock ?? '', `第 ${index + 1} 行可售数量`);
      }
      if (await toggle.count()) {
        if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) await clickPostingControl(page, toggle);
        if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) throw new Error(`第 ${index + 1} 行 SKU 启用状态未保存`);
      } else if (!enabled) throw new Error(`第 ${index + 1} 行 SKU 无法停用`);
      completed.add(index);
    }
    onProgress(`复核 SKU ${completed.size}/${total}`);
    if (completed.size === total) break;
    stagnant = before === completed.size ? stagnant + 1 : 0;
    if (stagnant >= 4) throw new Error(`商品 SKU 表仅核对 ${completed.size}/${total} 行，尚未提交`);
    await scroll.evaluate((node) => { node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + Math.max(48, node.clientHeight - 48)); node.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(180);
  }
  return { filled: completed.size };
}
