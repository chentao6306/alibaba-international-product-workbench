import { requiredAttributeKey } from './publish-reference.js';
import { browserResourcePolicy } from './browser-resource-policy.js';

const valueKey = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const skuKey = (attributes) => JSON.stringify(Object.entries(attributes || {}).map(([name, value]) => [requiredAttributeKey(name), valueKey(value)]).sort());

// Alibaba virtualizes the SKU body and merges repeating property cells. Its
// header records the complete ordered options and data-row gives the absolute
// combination index, so neither scrolling nor merged cells can shift a SKU.
export async function fillReferencedSkuRows(page, product, fill, onProgress = () => {}, { timeoutMs = browserResourcePolicy().constrained ? 20000 : 10000 } = {}) {
  if (!product.categoryReference || !product.skus?.length || !product.variantGroups?.some((group) => group.options?.length)) return { filled: 0 };
  const root = page.locator('#sku');
  const notReady = () => Object.assign(new Error('国际站引用规格表尚未完成加载，已保留商品和任务进度，未提交当前商品'), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '引用规格表' });
  onProgress('等待并核对引用规格表');
  await root.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => { throw notReady(); });
  // Alibaba defers its virtualized SKU headers until the section is on-screen.
  await root.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => { throw notReady(); });
  const readGroups = () => root.locator('.sku-header th').evaluateAll((nodes) => nodes.map((node) => ({
    name: node.querySelector('.th-saleProps-label > span')?.textContent?.trim(),
    options: [...node.querySelectorAll('.checkSelectBabel .labelText')].map((option) => option.textContent.trim()),
  })).filter((group) => group.name && group.options.length));
  const deadline = performance.now() + timeoutMs;
  let groups = await readGroups();
  while (!groups.length) {
    if (performance.now() >= deadline) throw notReady();
    await page.waitForTimeout(150);
    groups = await readGroups();
  }
  const total = groups.reduce((count, group) => count * group.options.length, groups.length ? 1 : 0);
  if (!total || total > 5000) throw new Error('引用规格表结构无法识别或组合超过 5000 行');
  const expected = new Map(product.skus.map((sku) => [skuKey(sku.attributes), sku]));
  const resolved = Array.from({ length: total }, (_, index) => {
    let remainder = index;
    const attributes = {};
    for (let i = groups.length - 1; i >= 0; i--) {
      attributes[groups[i].name] = groups[i].options[remainder % groups[i].options.length];
      remainder = Math.floor(remainder / groups[i].options.length);
    }
    return { attributes, sku: expected.get(skuKey(attributes)) };
  });
  const matched = new Set(resolved.filter((row) => row.sku).map((row) => row.sku));
  if (product.skus.some((sku) => !matched.has(sku))) throw new Error('引用 SKU 与国际站规格组合不一致，请检查规格选项');
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
        if (await toggle.count() && await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
        await fill(row.locator('[data-name="skuOuterId"] input'), String(sku.code || sku.skuCode || ''), `第 ${index + 1} 行商品编码`);
        await fill(row.locator('[data-name="skuStock"] input').first(), sku.stock ?? '', `第 ${index + 1} 行可售数量`);
      }
      if (await toggle.count()) {
        if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) await toggle.click();
        if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) throw new Error(`第 ${index + 1} 行 SKU 启用状态未保存`);
      } else if (!enabled) throw new Error(`第 ${index + 1} 行 SKU 无法停用`);
      completed.add(index);
    }
    onProgress(`复核引用 SKU ${completed.size}/${total}`);
    if (completed.size === total) break;
    stagnant = before === completed.size ? stagnant + 1 : 0;
    if (stagnant >= 4) throw new Error(`引用 SKU 表仅核对 ${completed.size}/${total} 行，尚未提交`);
    await scroll.evaluate((node) => { node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + Math.max(48, node.clientHeight - 48)); node.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(180);
  }
  return { filled: completed.size };
}
