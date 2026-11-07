// Shared spreadsheet identity and price operations; never change source evidence.
const RESERVED = new Set(['productId', 'sourceId', 'sourcePlatform', 'product', 'id', 'code', 'skuCode', 'price', 'stock', 'image', 'enabled', 'currencySymbol', 'attributes']);
const present = (value) => value !== '' && value != null;
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

export function exportSkuRows(products) {
  return products.flatMap((product) => (product.skus || []).map((sku) => ({
    productId: String(product.id), sourceId: String(product.sourceId || ''), product: product.title,
    sourcePlatform: product.sourcePlatform || '', id: String(sku.id || ''), code: sku.code || '',
    ...Object.fromEntries(Object.entries(sku.attributes || {}).filter(([key]) => !RESERVED.has(key))),
    ...(Object.keys(sku.attributes || {}).some((key) => RESERVED.has(key)) ? { attributes: JSON.stringify(sku.attributes) } : {}),
    price: sku.price ?? '', stock: sku.stock ?? '', image: sku.image || '', enabled: sku.enabled !== false,
    currencySymbol: product.currencySymbol || '',
  })));
}

export function importSkuRows(products, rows) {
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    const label = `SKU 表格第 ${index + 2} 行`;
    let matches;
    if (present(row.productId)) {
      matches = products.filter((product) => String(product.id) === String(row.productId));
      if (!matches.length) matches = products.filter((product) => String(product.sourceId || '') === String(row.productId)
        && (!row.sourcePlatform || row.sourcePlatform === product.sourcePlatform));
    } else if (present(row.product)) matches = products.filter((product) => product.title === row.product);
    else matches = products;
    if (matches.length !== 1) fail(`${label}无法唯一对应商品，请使用重新导出的 productId 列`);
    const product = matches[0];
    if (row.currencySymbol && product.currencySymbol && row.currencySymbol !== product.currencySymbol) fail(`${label}币种与商品不一致，请先核对价格币种`);
    let attributes = {};
    if (present(row.attributes)) {
      try { attributes = JSON.parse(row.attributes); } catch { fail(`${label}属性格式无效`); }
      if (!attributes || Array.isArray(attributes) || typeof attributes !== 'object') fail(`${label}属性格式无效`);
    }
    Object.assign(attributes, Object.fromEntries(Object.entries(row).filter(([key, value]) => !RESERVED.has(key) && present(value))));
    const original = (product.skus || []).find((sku) => row.id && String(sku.id) === String(row.id))
      || (product.skus || []).find((sku) => (row.code || row.skuCode) && sku.code === (row.code || row.skuCode));
    const number = (key, fallback) => {
      const value = present(row[key]) ? Number(row[key]) : fallback;
      if (present(value) && (!Number.isFinite(Number(value)) || Number(value) < 0)) fail(`${label}${key === 'price' ? '价格' : '库存'}无效`);
      return value;
    };
    const sku = { ...original, id: String(row.id || original?.id || `${product.id}-sku-${index + 1}`),
      code: row.code || row.skuCode || original?.code || '', attributes,
      price: number('price', original?.price ?? product.price ?? ''), stock: number('stock', original?.stock ?? product.stock ?? ''),
      image: row.image || original?.image || '', enabled: present(row.enabled) ? !/^(false|0|否)$/i.test(String(row.enabled)) : original?.enabled !== false,
      source: 'csv', derived: false,
    };
    const list = groups.get(product.id) || [];
    if (list.some((item) => item.id === sku.id)) fail(`${label}包含重复 SKU 编号`);
    list.push(sku); groups.set(product.id, list);
  }
  return groups;
}

export function transformProductPrices(product, transform) {
  const percent = Number(transform.percent ?? 0), fixed = Number(transform.fixed ?? 0);
  if (!Number.isFinite(percent) || !Number.isFinite(fixed)) fail('价格调整比例和金额必须是有效数字');
  const price = (value) => {
    if (!present(value)) return value;
    const result = Number(value) * (1 + percent / 100) + fixed;
    if (!Number.isFinite(result) || result <= 0 || result < 0.005) fail('调整后价格必须大于 0，请检查加价比例和金额');
    return result.toFixed(2);
  };
  const tiers = (values) => values.map((tier) => ({ ...tier, price: price(tier.price) }));
  const next = { price: price(product.price) };
  if (product.priceTiers) next.priceTiers = tiers(product.priceTiers);
  if (product.skus) next.skus = product.skus.map((sku) => ({ ...sku, price: price(sku.price) }));
  if (product.fobPrice) next.fobPrice = { ...product.fobPrice, minPrice: price(product.fobPrice.minPrice), maxPrice: price(product.fobPrice.maxPrice),
    ...(product.fobPrice.tiers ? { tiers: tiers(product.fobPrice.tiers) } : {}) };
  return next;
}
