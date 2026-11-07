import { readPostingAttributeSchema } from './category-attributes.js';
import { requiredAttributeKey } from './publish-reference.js';

// The Electron seller window owns a separate authenticated session. This
// narrow adapter lets the same read-only capture run there without creating
// another browser or copying credentials into a new navigation.
export async function captureSellerReferenceWithExecutor(execute) {
  const evaluate = (fn, value) => execute(`(${fn.toString()})(${JSON.stringify(value) ?? 'undefined'})`);
  const locator = (selector) => ({
    count: () => evaluate((selector) => document.querySelectorAll(selector).length, selector),
    locator: (child) => locator(`${selector} ${child}`),
    evaluateAll: (fn) => execute(`(${fn.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(selector)})))`),
    evaluate: (fn, value) => execute(`(${fn.toString()})(document.querySelector(${JSON.stringify(selector)}),${JSON.stringify(value) ?? 'undefined'})`),
    scrollIntoViewIfNeeded: () => evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), selector),
    innerText: () => evaluate((selector) => document.querySelector(selector)?.innerText || '', selector),
  });
  const metadata = await evaluate(() => {
    const url = new URL(location.href);
    if (!/(?:^|\.)alibaba\.com$/i.test(url.hostname) || !/^https?:$/.test(url.protocol)) throw new Error('请打开国际站卖家商品编辑表单');
    const fields = [...document.querySelectorAll('input[name="productTitle" i], textarea[name="productTitle" i], input[name="productName" i], textarea[name="productName" i], input[name="subject" i], #struct-title input, #struct-title textarea, .posting-field-title input, input[name="title" i]')];
    return { productId: url.searchParams.get('productId') || url.searchParams.get('itemId') || '',
      categoryId: url.searchParams.get('catId') || url.searchParams.get('categoryId') || document.querySelector('input[name="catId"], input[name="categoryId"]')?.value || '',
      title: fields.find((field) => field.getClientRects().length)?.value || '' };
  });
  return readSellerReference({ evaluate, locator, waitForTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, metadata);
}

// Read a seller form already opened by the user. No submission, navigation or
// changes to field values; virtualized tables must be read in full.
export async function readSellerReference(page, { productId, categoryId, title }) {
  if (!/^\d+$/.test(productId || '') || !/^\d+$/.test(categoryId || '') || !title?.trim()) {
    throw new Error('请在卖家窗口打开已有商品的编辑表单，需能识别商品 ID、类目和标题');
  }
  const schema = await page.evaluate(readPostingAttributeSchema);
  const attributes = schema.filter((field) => !field.saleSpecification && field.values.length).map((field) => ({
    ...(field.id ? { id: field.id } : {}), name: field.label,
    value: field.values.length === 1 ? field.values[0] : field.values, source: 'seller-form',
  }));
  if (!attributes.length) throw new Error('当前表单尚未读取到商品属性，请等待表单加载后重试');
  const root = page.locator('#sku');
  let variantGroups = [], skus = [];
  if (await root.count()) {
    await root.scrollIntoViewIfNeeded();
    const deadline = Date.now() + 8000;
    do {
      variantGroups = await root.locator('.sku-header th').evaluateAll((nodes) => nodes.map((node) => ({
        name: node.querySelector('.th-saleProps-label > span')?.textContent?.trim(),
        options: [...node.querySelectorAll('.checkSelectBabel .labelText')].map((item) => item.textContent.trim()).filter(Boolean),
      })).filter((group) => group.name && group.options.length));
      if (variantGroups.length || !schema.some((field) => field.saleSpecification && field.values.length)) break;
      await page.waitForTimeout(200);
    } while (Date.now() < deadline);
  }
  const specificationFields = schema.filter((field) => field.saleSpecification && field.values.length);
  if (specificationFields.length && !variantGroups.length) throw new Error('规格表未完成加载，请滚动到规格区域后重新读取');
  if (variantGroups.length) {
    const total = variantGroups.reduce((count, group) => count * group.options.length, 1);
    if (total > 5000) throw new Error('引用规格超过 5000 行，请先精简规格');
    const scroll = root.locator('.virtualized-table-scroll-wrapper');
    if (!await scroll.count()) throw new Error('没有识别到完整规格表，未保存模板');
    const position = await scroll.evaluate((node) => node.scrollTop);
    const rows = new Map();
    const deadline = Date.now() + 20000;
    try {
      await scroll.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
      while (rows.size < total && Date.now() < deadline) {
        await page.waitForTimeout(150);
        const visible = await root.locator('[data-name="skuOuterId"][data-row]').evaluateAll((cells) => cells.map((cell) => {
          const row = cell.parentElement;
          const stock = row.querySelector('[data-name="skuStock"] input')?.value ?? '';
          const enabled = row.querySelector('[data-name="operate"] [role="switch"]')?.getAttribute('aria-checked');
          return { index: Number(cell.dataset.row), code: cell.querySelector('input')?.value || '',
            stock: stock === '' ? null : Number(stock), ...(enabled == null ? {} : { enabled: enabled === 'true' }) };
        }));
        for (const row of visible) if (Number.isInteger(row.index) && row.index >= 0 && row.index < total) rows.set(row.index, row);
        if (rows.size === total) break;
        const moved = await scroll.evaluate((node) => {
          const previous = node.scrollTop;
          node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, previous + Math.max(48, node.clientHeight - 48));
          node.dispatchEvent(new Event('scroll')); return node.scrollTop !== previous;
        });
        if (!moved) break;
      }
    } finally { await scroll.evaluate((node, value) => { node.scrollTop = value; node.dispatchEvent(new Event('scroll')); }, position); }
    if (rows.size !== total) throw new Error(`规格只读取到 ${rows.size}/${total} 行，未保存不完整模板`);
    skus = Array.from({ length: total }, (_, index) => {
      let remainder = index;
      const attributes = {};
      for (let i = variantGroups.length - 1; i >= 0; i--) {
        attributes[variantGroups[i].name] = variantGroups[i].options[remainder % variantGroups[i].options.length];
        remainder = Math.floor(remainder / variantGroups[i].options.length);
      }
      const { index: rowIndex, ...row } = rows.get(index);
      if (row.stock !== null && (!Number.isFinite(row.stock) || row.stock < 0)) throw new Error('规格库存无法识别，未保存模板');
      return { ...row, attributes };
    });
    for (const group of variantGroups) {
      const field = specificationFields.find((item) => requiredAttributeKey(item.label) === requiredAttributeKey(group.name));
      if (field?.id) group.id = field.id;
      if (field) {
        group.optionImages = await page.locator(`[data-posting-attribute-row="${field.rowIndex}"]`).evaluate((row, options) => {
          const result = {};
          for (const option of options) {
            const items = [...row.querySelectorAll('.posting-feild-color-item, .posting-field-color-item, [class*="value-item"], [class*="spec-item"]')];
            const item = items.find((node) => [...node.querySelectorAll('input')].some((input) => input.value.trim() === option)
              || node.querySelector('label')?.textContent.trim() === option);
            if (!item) continue;
            const preview = item.querySelector('.value-preview.uploaded img, .custom-upload-image.uploaded img, .custom-upload-image [data-role="preview"] img');
            const url = preview?.getAttribute('src') || '';
            if (/^(?:https?:)?\/\//i.test(url) && !/placeholder|loading/i.test(url)) result[option] = new URL(url, location.href).href;
          }
          return result;
        }, group.options);
      }
    }
  }
  const categoryText = await page.locator('body').innerText();
  const path = categoryText.match(/(?:当前类目|Current category)\s*[:：]\s*([^\n]+)/i)?.[1]?.replace(/\|.*$/, '').trim();
  const categoryPath = path ? path.split(/\s*(?:>{1,2}|»|→)\s*/).filter(Boolean) : [];
  const template = { id: `seller-${productId}`, title: title.trim(), categoryId, categoryPath, attributes, variantGroups, skus };
  return { id: template.id, title: template.title, capturedAt: new Date().toISOString(), sourceProductId: productId,
    referenceTemplate: template };
}
