const asNumber = (value) => {
  const number = Number(String(value ?? '').replace(/,/g, '').match(/-?[\d.]+/)?.[0]);
  return Number.isFinite(number) ? number : null;
};

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function findAssignedObject(scriptText, assignmentName) {
  const source = String(scriptText || '');
  const marker = new RegExp(`(?:window\\.)?${assignmentName}\\s*=\\s*`).exec(source);
  if (!marker) return '';
  const start = source.indexOf('{', marker.index + marker[0].length);
  if (start < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return '';
}

export function parseAlibabaDetailDataScript(scriptText) {
  const json = findAssignedObject(scriptText, 'detailData');
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function currencySymbol(detailData, price) {
  const currencyName = clean(detailData?.globalData?.global?.productPriceCurrencySimpleName);
  if (/\$/.test(currencyName)) return '$';
  if (/[¥￥]/.test(currencyName)) return '¥';
  const pattern = clean(price?.currencyRule?.currencyPattern);
  if (/\$/.test(pattern)) return '$';
  if (/[¥￥]/.test(pattern)) return '¥';
  return '$';
}

function priceValue(value, ...keys) {
  for (const key of keys) {
    const parsed = asNumber(value?.[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function structuredPrice(detailData) {
  const product = detailData?.globalData?.product || {};
  const price = product.customPrice || product.price || {};
  const range = price.productRangePrices || {};
  // The dollar fields are Alibaba's stable USD source values. priceRangeLow
  // follows the visitor currency and can change with cookies or destination.
  const minimum = priceValue(range, 'dollarPriceRangeLow', 'priceRangeLow', 'minPrice', 'minimumPrice');
  const maximum = priceValue(range, 'dollarPriceRangeHigh', 'priceRangeHigh', 'maxPrice', 'maximumPrice');
  const symbol = currencySymbol(detailData, price);
  const unit = clean(price.unit || detailData?.nodeMap?.module_sample_new?.privateData?.priceList?.[0]?.priceUnit || '');
  const formattedText = minimum != null && maximum != null
    ? `${symbol}${minimum.toFixed(2)}${maximum !== minimum ? `-${Number(maximum.toFixed(2))}` : ''}`
    : clean(range.priceRangeText || detailData?.nodeMap?.module_sample_new?.privateData?.priceList?.[0]?.formatPrice);
  const ladderSource = Array.isArray(price.productLadderPrices) ? price.productLadderPrices : [];
  const tiers = ladderSource.map((tier) => {
    const tierPrice = priceValue(tier, 'dollarPrice', 'price', 'unitPrice', 'minPrice');
    const minQuantity = priceValue(tier, 'minQuantity', 'startQuantity', 'minimumQuantity', 'minOrderQuantity', 'beginAmount', 'min', 'localMin');
    const parsedMaximum = priceValue(tier, 'maxQuantity', 'endQuantity', 'maximumQuantity', 'endAmount', 'max', 'localMax');
    const maxQuantity = parsedMaximum != null && parsedMaximum > 0 ? parsedMaximum : null;
    if (!(tierPrice > 0) || !(minQuantity > 0)) return null;
    return { price: tierPrice.toFixed(2), minQuantity, maxQuantity, currencySymbol: symbol, source: 'detailData' };
  }).filter(Boolean).sort((left, right) => left.minQuantity - right.minQuantity);
  const tierPrices = tiers.map((tier) => Number(tier.price)).filter((value) => value > 0);
  const effectiveMinimum = minimum ?? (tierPrices.length ? Math.min(...tierPrices) : null);
  const effectiveMaximum = maximum ?? (tierPrices.length ? Math.max(...tierPrices) : null);
  const stableAmount = (value) => Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
  const stableLadderText = effectiveMinimum != null && effectiveMaximum != null
    ? `${symbol}${stableAmount(effectiveMinimum)}${effectiveMaximum !== effectiveMinimum ? `-${stableAmount(effectiveMaximum)}` : ''}`
    : '';
  const sourcePriceRange = effectiveMinimum != null && effectiveMaximum != null ? {
    minPrice: effectiveMinimum.toFixed(2), maxPrice: effectiveMaximum.toFixed(2), currencySymbol: symbol,
    formattedText: (minimum != null && maximum != null ? formattedText : stableLadderText)
      || `${symbol}${effectiveMinimum.toFixed(2)}-${effectiveMaximum.toFixed(2)}`,
    unit, source: minimum != null && maximum != null ? 'detailData.productRangePrices' : 'detailData.productLadderPrices'
  } : null;
  return {
    price, sourcePriceRange, tiers, minimum: effectiveMinimum, maximum: effectiveMaximum,
    symbol, unit, formattedText: sourcePriceRange?.formattedText || formattedText
  };
}

function structuredVariants(detailData) {
  const sku = detailData?.globalData?.product?.sku || {};
  const attrs = Array.isArray(sku.skuAttrs) ? sku.skuAttrs : [];
  const variantGroups = attrs.map((attribute) => {
    const values = Array.isArray(attribute.values) ? attribute.values : [];
    const options = values.map((value) => clean(value.name)).filter(Boolean);
    return {
      id: String(attribute.id ?? ''), name: clean(attribute.name), type: clean(attribute.type || 'TEXT'), options,
      optionIds: Object.fromEntries(values.map((value) => [clean(value.name), String(value.id ?? '')]).filter(([name]) => name)),
      optionImages: Object.fromEntries(values.map((value) => [clean(value.name), clean(value.originImage || value.imageUrl || value.image)]).filter(([name, image]) => name && image)),
      source: 'detailData.skuAttrs'
    };
  }).filter((group) => group.name && group.options.length);
  const valueIndex = new Map();
  for (const attribute of attrs) {
    for (const value of attribute.values || []) {
      valueIndex.set(`${attribute.id}:${value.id}`, { name: clean(attribute.name), value: clean(value.name), image: clean(value.originImage || value.imageUrl || value.image) });
    }
  }
  const skuInfoMap = sku.skuInfoMap && typeof sku.skuInfoMap === 'object' ? sku.skuInfoMap : {};
  const skus = Object.entries(skuInfoMap).map(([combination, info], index) => {
    const selected = combination.split(';').map((part) => part.trim()).filter(Boolean).map((part) => valueIndex.get(part)).filter(Boolean);
    const attributes = Object.fromEntries(selected.map((item) => [item.name, item.value]));
    const exactPrice = priceValue(info, 'dollarPrice', 'salePrice', 'skuPrice', 'price', 'discountPrice');
    const exactStock = priceValue(info, 'stock', 'inventory', 'quantity', 'amountOnSale');
    return {
      id: String(info?.id || sku.firstSkuId || `source-sku-${index + 1}`), attributes,
      name: Object.values(attributes).join(' / '), code: clean(info?.skuCode || info?.code),
      ...(exactPrice != null ? { price: exactPrice.toFixed(2) } : {}),
      ...(exactStock != null ? { stock: exactStock } : {}),
      image: selected.map((item) => item.image).find(Boolean) || '', source: 'detailData.skuInfoMap', derived: false,
      evidence: { method: 'detailData.skuInfoMap', combination, exactPricePublished: exactPrice != null, exactStockPublished: exactStock != null }
    };
  });
  return { variantGroups, skus, firstSkuId: sku.firstSkuId || null };
}

export function extractAlibabaSourceData(detailData) {
  if (!detailData) return null;
  const product = detailData.globalData?.product || {};
  const pricing = structuredPrice(detailData);
  const variants = structuredVariants(detailData);
  return {
    sourcePriceRange: pricing.sourcePriceRange,
    sourcePriceTiers: pricing.tiers,
    price: pricing.minimum,
    maxPrice: pricing.maximum,
    currencySymbol: pricing.symbol,
    sourcePriceText: pricing.sourcePriceRange?.formattedText || pricing.formattedText || '',
    salesUnit: pricing.unit,
    priceMode: pricing.tiers.length ? 'quantity-tier' : pricing.sourcePriceRange ? 'source-range' : '',
    variantGroups: variants.variantGroups,
    skus: variants.skus,
    sourceTradeAvailability: {
      tradeAvailable: product.tradeAvailable ?? null,
      sourcingTradeAvailable: product.sourcingTradeAvailable ?? null,
      exactSkuPricesPublished: variants.skus.length > 0 && variants.skus.every((sku) => Number(sku.price) > 0),
      exactSkuStockPublished: variants.skus.length > 0 && variants.skus.every((sku) => Number.isFinite(Number(sku.stock)))
    },
    evidence: { method: 'detailData', firstSkuId: variants.firstSkuId }
  };
}
