export const SOURCE_PLATFORMS = [
  { id: 'alibaba.com', label: '阿里巴巴国际站' },
  { id: '1688', label: '1688' },
  { id: 'aliexpress', label: '速卖通' },
  { id: 'made-in-china', label: '中国制造网' },
];

export function sourcePlatform(product = {}) {
  let host = '';
  try { host = new URL(product.sourceUrl || product.source?.url || '').hostname; } catch {}
  if (/(^|\.)1688\.com$/i.test(host)) return '1688';
  if (/(^|\.)aliexpress\.(?:com|us|ru)$/i.test(host)) return 'aliexpress';
  if (/(^|\.)alibaba\.com$/i.test(host)) return 'alibaba.com';
  if (/(^|\.)made-in-china\.com$/i.test(host)) return 'made-in-china';
  const recorded = product.sourcePlatform || product.source?.platform;
  return SOURCE_PLATFORMS.some((item) => item.id === recorded) ? recorded : 'alibaba.com';
}

export function sourcePlatformLabel(product) {
  return SOURCE_PLATFORMS.find((item) => item.id === sourcePlatform(product)).label;
}

export function parseCollectionUrl(input, mode = 'product', expectedPlatform = '') {
  const text = String(input || '').trim();
  const embedded = text.match(/https?:\/\/[^\s<>"\u3000]+/i)?.[0] || text;
  let url;
  try { url = new URL(/^https?:\/\//i.test(embedded) ? embedded : `https://${embedded}`); } catch {
    throw new Error('请输入完整的商品或搜索结果链接');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('不支持该链接');
  const host = url.hostname.toLowerCase();
  const platform = /(^|\.)1688\.com$/.test(host) ? '1688'
    : /(^|\.)aliexpress\.(?:com|us|ru)$/.test(host) ? 'aliexpress'
      : /(^|\.)alibaba\.com$/.test(host) ? 'alibaba.com'
        : /(^|\.)made-in-china\.com$/.test(host) ? 'made-in-china' : '';
  if (!platform || (expectedPlatform && platform !== expectedPlatform)) throw new Error('链接与当前采集平台不一致');
  url.hash = '';
  if (mode === 'shop-products') {
    if (platform !== 'made-in-china' || !/^[a-z0-9-]+\.en\.made-in-china\.com$/.test(host)
      || !/^(?:\/|\/product-list-\d+\.html|\/product-group\/[a-z0-9]+\/[^/]+-\d+\.html)$/i.test(url.pathname)) {
      throw new Error('请输入中国制造网供应商店铺首页、商品列表或店铺分类链接');
    }
    if (url.pathname === '/') url.pathname = '/product-list-1.html';
    url.search = '';
    return { url: url.href, platform, sourceId: '', mode };
  }
  if (mode === 'image-search') {
    if (platform !== 'alibaba.com' || !/^\/(?:search\/page|trade\/search|picture\/search|image\/search)/i.test(url.pathname)) {
      throw new Error('请输入阿里巴巴国际站以图搜品的完整结果页链接');
    }
    if (![...url.searchParams.keys()].length) throw new Error('搜索链接缺少查询参数，请复制浏览器中的完整结果页地址');
    return { url: url.href, platform, sourceId: '', mode };
  }
  const sourceId = platform === '1688' ? url.pathname.match(/^\/offer\/(\d+)\.html$/i)?.[1]
    : platform === 'aliexpress' ? url.pathname.match(/^\/(?:i|item)\/(\d+)\.html$/i)?.[1]
      : platform === 'made-in-china' ? url.pathname.match(/^\/product\/([a-z0-9]{6,64})\/[^/]+\.html$/i)?.[1]
      : url.pathname.match(/^\/product-detail\/[^/]*_(\d+)\.html$/i)?.[1];
  if (!sourceId) throw new Error('请输入商品详情页链接，不支持店铺首页或短链接');
  return { url: url.href, platform, sourceId, mode: 'product' };
}

export function collectionUrls(input, mode, platform) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  const parsed = lines.filter((line) => String(line).trim()).map((line) => parseCollectionUrl(line, mode, platform));
  if (!parsed.length) throw new Error('请至少填写一个链接');
  if (parsed.length > 1000 || (['image-search', 'shop-products'].includes(mode) && parsed.length !== 1)) throw new Error('单次最多 1000 个商品链接；店铺或以图搜品每次填写一个列表链接');
  return [...new Map(parsed.map((item) => [item.sourceId ? `${item.platform}:${item.sourceId}` : item.url, item])).values()];
}

export function crossPlatformPublishErrors(product) {
  if (sourcePlatform(product) === 'alibaba.com') return [];
  const errors = [];
  if (product.currencySymbol !== '$') errors.push('请设置美元售价或换算汇率');
  if (/[\u3400-\u9fff]/.test(product.title || '')) errors.push('请填写英文商品标题');
  if (!product.categoryId) errors.push('请选择国际站目标类目');
  return errors;
}

export function convertProductPrices(product, rate) {
  const multiplier = Number(rate);
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('换算汇率必须大于 0');
  const price = (value) => {
    if (!(Number(value) > 0)) return value;
    const converted = Number(value) * multiplier;
    if (!Number.isFinite(converted) || converted < 0.005) throw new Error('换算后价格无效或低于 0.01 美元，请调整汇率或手动定价');
    return converted.toFixed(2);
  };
  const range = product.sourcePriceRange;
  const fob = product.fobPrice;
  return {
    price: price(product.price), currencySymbol: '$',
    priceTiers: (product.priceTiers || []).map((tier) => ({ ...tier, price: price(tier.price), currencySymbol: '$' })),
    skus: (product.skus || []).map((sku) => ({ ...sku, price: price(sku.price) })),
    ...(fob && (Number(fob.minPrice) > 0 || fob.tiers?.length) ? {
      fobPrice: { ...fob, minPrice: price(fob.minPrice), maxPrice: price(fob.maxPrice), currencySymbol: '$', tiers: (fob.tiers || []).map((tier) => ({ ...tier, price: price(tier.price), currencySymbol: '$' })) },
    } : range ? { fobPrice: { minPrice: price(range.minPrice), maxPrice: price(range.maxPrice), currencySymbol: '$' }, priceMode: 'fob-range' } : {}),
    priceConversion: { sourceCurrency: product.currencySymbol, rate: multiplier, at: new Date().toISOString() },
  };
}
