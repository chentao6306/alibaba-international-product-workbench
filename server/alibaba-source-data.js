import { alibabaProductIdFromPath } from './source-platform.js';
import { recoverDuplicateSkuDimensions } from './sku-dimensions.js';

const asNumber = (value) => {
  const number = Number(String(value ?? '').replace(/,/g, '').match(/-?[\d.]+/)?.[0]);
  return Number.isFinite(number) ? number : null;
};

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// Runs in the source page. Store reviews and recommendation cards can label
// their own products as unavailable while the requested product is healthy.
export function readAlibabaAvailabilityText() {
  const excluded = [
    'script', 'style', 'noscript', 'template', 'nav', 'footer', 'blockquote',
    ...['review', 'recommend', 'related', 'description'].flatMap(part =>
      ['data-module-name', 'data-testid', 'id', 'class'].map(attribute => `[${attribute}*="${part}" i]`)),
    '#detail_decorate_root',
  ].join(',');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded) || !parent.getClientRects().length) continue;
    const text = (node.textContent || '').trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

export function requireAlibabaSourceProduct(url, sourceId, text = '', { status = 200 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch {}
  const currentId = alibabaProductIdFromPath(parsed?.pathname);
  const platformPage = parsed && /(^|\.)alibaba\.com$/i.test(parsed.hostname);
  const restrictedPage = parsed && (/^(?:login|passport|captcha|punish)\./i.test(parsed.hostname)
    || /^\/(?:login|passport|captcha|punish|verify)(?:[/.]|$)/i.test(parsed.pathname)
    || /_____tmd_____/i.test(parsed.pathname + parsed.search));
  if (restrictedPage || [401, 403, 429].includes(status) || status >= 500) {
    throw Object.assign(new Error('来源页面要求登录、验证或暂时无法访问，请恢复后继续采集'), { code: 'SOURCE_PAGE_NOT_READY' });
  }
  const removed = /(?:This|The) product is (?:(?:currently )?unavailable|no longer available)|(?:product|item) (?:has been |was )?(?:removed|deleted)|此商品(?:已下架|暂不可用|不存在)|该商品(?:已下架|不存在)|商品已失效/i.test(text)
    || [404, 410].includes(status);
  // Only known product/search redirects qualify for automatic skipping. An
  // unknown navigation, blank page or service error must remain retryable.
  const redirected = Boolean(platformPage && sourceId && text.trim() && (currentId && currentId !== String(sourceId)
    || /^(?:\/|\/search\/page|\/trade\/search[^/]*)$/i.test(parsed.pathname)));
  if (!parsed || !/(^|\.)alibaba\.com$/i.test(parsed.hostname) || !currentId
    || String(sourceId || '') && currentId !== String(sourceId)
    || removed) {
    throw Object.assign(new Error('来源商品已失效、下架或跳转到其他页面，未采集推荐商品；请核对原商品链接'), {
      code: 'SOURCE_PRODUCT_UNAVAILABLE',
      canSkipProduct: Boolean(platformPage && (removed || redirected)),
      reason: removed ? 'removed' : 'redirected',
    });
  }
}

// Read product taxonomy only. Recommendation modules contain other products'
// category IDs and must never become the current product's publishing route.
export function extractAlibabaCategoryId(detailData) {
  const product = detailData?.globalData?.product || {};
  const explicit = [
    product.leafCategoryId,
    product.productCategoryId,
    product.categoryId,
    product.catId,
    product.category?.leafCategoryId,
    product.category?.id,
    detailData?.globalData?.global?.leafCategoryId,
    detailData?.globalData?.global?.categoryId,
    detailData?.globalData?.categoryId
  ];
  // Alibaba still uses short legacy IDs (for example Speakers = 518).
  // Category fields contain IDs, not free text; accept the complete numeric ID.
  const normalize = (value) => /^[1-9]\d{0,11}$/.test(String(value ?? '').trim()) ? String(value).trim() : '';
  for (const value of explicit) {
    const id = normalize(value);
    if (id) return id;
  }
  const preferredKeys = ['leafCategoryId', 'productCategoryId', 'categoryId', 'catId'];
  const seen = new Set();
  let visited = 0;
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value) || visited > 50000) return '';
    seen.add(value);
    visited += 1;
    if (Array.isArray(value)) {
      for (const child of [...value].reverse()) { const id = walk(child); if (id) return id; }
      return '';
    }
    for (const key of preferredKeys) {
      const id = normalize(value[key]);
      if (id) return id;
    }
    for (const child of Object.values(value)) {
      const id = walk(child);
      if (id) return id;
    }
    return '';
  }
  for (const [name, value] of Object.entries(detailData?.nodeMap || {})) {
    if (!/breadcrumb|category/i.test(name) || /recommend|related|similar|advert/i.test(name)) continue;
    const id = walk(value);
    if (id) return id;
  }
  return '';
}

export function readAlibabaCategoryDocument() {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const fromUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      if (!/(^|\.)alibaba\.com$/i.test(url.hostname)) return '';
      const candidate = url.searchParams.get('categoryId') || url.searchParams.get('catId')
        || url.pathname.match(/(?:_cid|\/cid\/|category[-/])([1-9]\d{0,11})(?:[./_-]|$)/i)?.[1];
      return /^[1-9]\d{0,11}$/.test(candidate || '') ? candidate : '';
    } catch { return ''; }
  };
  const roots = [...document.querySelectorAll('[data-testid*="breadcrumb" i], [class*="breadcrumb" i], nav[aria-label*="breadcrumb" i], [data-module-name="module_category"]')];
  const candidates = roots.map((root) => {
    const links = [...root.querySelectorAll('a[href]')].filter((link) => !/^(?:home|all categories|首页)$/i.test(clean(link.textContent)));
    const path = links.map((link) => clean(link.textContent)).filter((text) => text && text.length < 120);
    // Breadcrumbs are ordered from parent to leaf, so the last category link wins.
    const ids = links.map((link) => fromUrl(link.href)).filter(Boolean);
    return { path, id: ids.at(-1) || '' };
  }).sort((a, b) => b.path.length - a.path.length);
  const breadcrumb = candidates[0] || { path: [], id: '' };
  const meta = [...document.querySelectorAll('meta[name="categoryId" i], meta[name="leafCategoryId" i], meta[property="categoryId" i]')]
    .map((node) => clean(node.content)).find((value) => /^[1-9]\d{0,11}$/.test(value));
  return { path: breadcrumb.path, id: meta || breadcrumb.id };
}

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
  const fixedPrice = priceValue(price, 'fixedDollarPrice', 'fixedPrice');
  const minimum = priceValue(range, 'dollarPriceRangeLow', 'priceRangeLow', 'minPrice', 'minimumPrice') ?? fixedPrice;
  const maximum = priceValue(range, 'dollarPriceRangeHigh', 'priceRangeHigh', 'maxPrice', 'maximumPrice') ?? fixedPrice;
  const hasDollarPrice = price.fixedDollarPrice != null || range.dollarPriceRangeLow != null
    || (Array.isArray(price.productLadderPrices) && price.productLadderPrices.some((tier) => tier?.dollarPrice != null));
  const symbol = hasDollarPrice ? '$' : currencySymbol(detailData, price);
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
    unit, source: fixedPrice != null ? 'detailData.fixedPrice'
      : minimum != null && maximum != null ? 'detailData.productRangePrices' : 'detailData.productLadderPrices'
  } : null;
  return {
    price, sourcePriceRange, tiers, minimum: effectiveMinimum, maximum: effectiveMaximum,
    symbol, unit, formattedText: sourcePriceRange?.formattedText || formattedText
  };
}

// Structured descriptions are available before their lazy DOM mounts. Only
// read product-detail sections; recommendation cards are separate products.
export function extractAlibabaDescription(detailData) {
  const source = detailData?.nodeMap?.module_description?.privateData || {};
  const sections = ['productDescription', 'specification', 'sizeChart', 'dimensionDrawing', 'productDetails', 'customizationImages', 'companyInfo', 'certificationInfo', 'faqInfo', 'productCustomization', 'packingLogistics', 'paymentMethods'];
  const order = Array.isArray(source.viewOrder) ? source.viewOrder.filter((key) => sections.includes(key)) : sections;
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const images = [];
  const videos = [];
  const text = [];
  const html = [];
  for (const key of order) {
    const section = [];
    const append = item => {
      if (item?.type === 'image' && /^https?:\/\//i.test(item.url || '')) {
        if (!images.includes(item.url)) images.push(item.url);
        section.push(`<p data-testid="product-detail-image-simple"><img src="${escape(item.url)}" /></p>`);
      } else if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        text.push(item.text.trim());
        section.push(`<p data-testid="${key === 'productDescription' ? 'product-detail-text-sort' : 'product-detail-text'}">${escape(item.text.trim())}</p>`);
      } else if (item?.type === 'qa' && typeof item.question === 'string' && typeof item.answer === 'string') {
        text.push(item.question, item.answer);
        section.push(`<div data-testid="product-detail-qa"><div><div>${escape(item.question)}</div><div>${escape(item.answer)}</div></div></div>`);
      } else if (item?.type === 'video' && /^https?:\/\//i.test(item.url || '')) {
        videos.push({ role: 'detail', url: item.url, source: 'detailData.module_description' });
        section.push(`<video controls src="${escape(item.url)}"></video>`);
      }
    };
    for (const item of Array.isArray(source[key]?.details) ? source[key].details : []) append(item);
    for (const gallery of Array.isArray(source[key]?.imageSetDetails) ? source[key].imageSetDetails : []) {
      if (gallery.title) section.push(`<h3 data-testid="product-detail-title">${escape(gallery.title)}</h3>`);
      for (const item of Array.isArray(gallery.details) ? gallery.details : []) append(item);
    }
    if (section.length) {
      const title = source[key]?.title ? `<h2 data-testid="product-detail-title">${escape(source[key].title)}</h2>` : '';
      html.push(`<section data-module-name="module_structure_descption_${key}">${title}${section.join('')}</section>`);
    }
  }
  return { html: html.join(''), text: text.join('\n'), images, ...(videos.length ? { videos } : {}) };
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
  return recoverDuplicateSkuDimensions({ variantGroups, skus, firstSkuId: sku.firstSkuId || null });
}

export function extractAlibabaSourceData(detailData) {
  if (!detailData) return null;
  const product = detailData.globalData?.product || {};
  const categoryId = extractAlibabaCategoryId(detailData);
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
    sourceCategoryId: categoryId,
    variantGroups: variants.variantGroups,
    skus: variants.skus,
    sourceTradeAvailability: {
      tradeAvailable: product.tradeAvailable ?? null,
      sourcingTradeAvailable: product.sourcingTradeAvailable ?? null,
      exactSkuPricesPublished: variants.skus.length > 0 && variants.skus.every((sku) => Number(sku.price) > 0),
      exactSkuStockPublished: variants.skus.length > 0 && variants.skus.every((sku) => Number.isFinite(Number(sku.stock)))
    },
    evidence: { method: 'detailData', firstSkuId: variants.firstSkuId, categoryId, skuCount: variants.skus.length }
  };
}
