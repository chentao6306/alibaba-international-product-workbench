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

export async function selectSkuPricing(page, product, fill, { timeoutMs = 10000 } = {}) {
  const label = /^(?:根据规格设置价格|按(?:商品)?规格(?:设置)?(?:报价|定价|价格)?|按SKU(?:设置)?(?:价格|定价)|Price by SKU|Set prices? by (?:SKU|variants?|specifications?)|Per SKU)$/i;
  const radio = page.getByRole('radio', { name: label }).filter({ visible: true }).first();
  const labelled = page.locator('label').filter({ hasText: label }).filter({ visible: true }).first();
  const control = await radio.count() ? radio : labelled;
  if (await control.count()) {
    const checked = await control.isChecked().catch(() => control.getAttribute('aria-checked').then(value => value === 'true'));
    if (!checked) await clickPostingControl(page, control);
  } else if (!await page.locator(`#sku ${SKU_PRICE_INPUT.split(', ').join(', #sku ')}`).count()) {
    throw Object.assign(new Error('当前发布页未找到按规格定价选项，未将不同规格价格合并为单一价格'), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '规格价格' });
  }
  // MOQ is shared across combinations, but its price is never a substitute
  // for per-SKU values. SKU prices are committed after the matrix is ready.
  const quantity = page.locator('input[placeholder*="起订"], input[placeholder*="minimum order" i], input[role="input-quantity"]:not(#sku input)').filter({ visible: true }).first();
  if (await quantity.count()) await fill(quantity, product.minOrder || product.moq || 1, '起订量');
  if (await radio.count() && !await radio.isChecked().catch(() => false)) {
    await radio.waitFor({ state: 'visible', timeout: timeoutMs });
    if (!await radio.isChecked()) throw new Error('按规格定价未生效，未提交当前商品');
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
