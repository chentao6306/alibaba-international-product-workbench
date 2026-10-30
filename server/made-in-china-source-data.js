import { load } from 'cheerio';
import { parseCollectionUrl } from './source-platform.js';
import { packagingFromAttributes } from './category-attributes.js';
import { sanitizeTemplateHtml } from './description-templates.js';

const PLATFORM = 'made-in-china';
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const list = (value) => Array.isArray(value) ? value : value ? [value] : [];
const positive = (value) => {
  const number = Number(clean(value).replaceAll(',', ''));
  return Number.isFinite(number) && number > 0 ? String(number) : '';
};
const hasType = (value, type) => list(value?.['@type']).includes(type);

// Supplier pages render their product data on the server. A regular public GET
// avoids loading chat, video and analytics for every item in a collection batch.
// Login/challenge/incomplete documents fall back to the existing browser flow.
export async function fetchMadeInChinaHtml(url, mode = 'product', { fetcher = fetch } = {}) {
  const source = parseCollectionUrl(url, mode, PLATFORM);
  const signal = AbortSignal.timeout(25000);
  let target = source.url;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    let response;
    try { response = await fetcher(target, { redirect: 'manual', signal }); }
    catch { return null; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      try {
        const next = parseCollectionUrl(new URL(response.headers.get('location'), target).href, mode, PLATFORM);
        if (mode === 'product' ? next.sourceId !== source.sourceId
          : next.url.replace(/-\d+\.html$/, '-page.html') !== source.url.replace(/-\d+\.html$/, '-page.html')) return null;
        target = next.url;
      } catch { return null; }
      continue;
    }
    if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > 6 * 1024 * 1024) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 6 * 1024 * 1024) return null;
        chunks.push(chunk);
      }
    } catch { return null; }
    return Buffer.concat(chunks).toString('utf8');
  }
  return null;
}

export async function readMadeInChinaProduct(url, options = {}) {
  const html = await fetchMadeInChinaHtml(url, 'product', options);
  if (!html) return null;
  const product = extractMadeInChinaProduct(html, url);
  return product.title && product.mainImages.length ? product : null;
}

// Only read the current product and its explicit variants, never recommendations,
// sample prices, company production capacity, or scripts executed as code.
export function extractMadeInChinaProduct(html, baseUrl) {
  const { sourceId } = parseCollectionUrl(baseUrl, 'product', PLATFORM);
  const $ = load(html);
  const decode = (value) => clean(load('<span></span>')('span').html(clean(value)).text());
  const absolute = (value) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value, baseUrl);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };
  const imageUrl = (value) => {
    const url = absolute(typeof value === 'string' ? value : value?.url || value?.contentUrl);
    return /(?:transparent|placeholder|loading)\.(?:png|gif)|\.svg(?:[?#]|$)/i.test(url) ? '' : url;
  };
  const imageList = (values) => [...new Set(values.flatMap(list).map(imageUrl).filter(Boolean))];
  const structured = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    try {
      for (const entry of list(JSON.parse($(node).text()))) {
        structured.push(entry, ...list(entry?.['@graph']));
      }
    } catch { /* A malformed optional schema must not hide visible product data. */ }
  });
  const sameProduct = (url) => {
    try { return parseCollectionUrl(absolute(url), 'product', PLATFORM).sourceId === sourceId; }
    catch { return false; }
  };
  const actualId = clean($('#productId').val());
  const canonical = $('link[rel="canonical"]').attr('href');
  if ((actualId && actualId !== sourceId) || (canonical && !sameProduct(canonical))) {
    throw new Error('中国制造网返回的商品与采集链接不一致，请检查商品是否已下架或链接是否正确');
  }
  const candidates = structured.filter((node) => hasType(node, 'Product') || hasType(node, 'ProductGroup'));
  const productUrl = (node) => node.url || list(node.offers)[0]?.url;
  const primary = candidates.find((node) => productUrl(node) && sameProduct(productUrl(node)))
    || candidates.find((node) => !productUrl(node)) || {};
  const title = clean($('.J-baseInfo-name, h1.sr-proMainInfo-baseInfoH1').first().text()) || decode(primary.name);
  const mainImages = imageList(list(primary.image).length ? list(primary.image) : [
    ...$('.J-pic-list-container .J-pic-large-item:not(.J-play-video) img').toArray().map((node) => $(node).attr('data-original') || $(node).attr('src')),
    title ? $('meta[property="og:image"]').attr('content') : '',
  ]).slice(0, 6);

  const attributes = new Map();
  const addAttribute = (name, value) => {
    const key = decode(name).replace(/[:：]\s*$/, '');
    const val = decode(value);
    if (key && val && key.length < 120 && val.length < 2000) attributes.set(key.toLowerCase(), { name: key, value: val, source: PLATFORM });
  };
  for (const item of list(primary.additionalProperty)) addAttribute(item.name, item.value);
  $('.product-attrs-list dt').each((_, node) => addAttribute($(node).text(), $(node).next('dd').text()));
  // Older supplier templates show the same attributes in two-column rows.
  $('#product .specification tr, .sr-proMainInfo-baseInfo-propertyAttr .property-item').each((_, node) => {
    const cells = $(node).children('th, td, .property-name, .property-value');
    if (cells.length === 2) addAttribute(cells.eq(0).text(), cells.eq(1).text());
  });
  const attribute = (pattern) => [...attributes.values()].find((item) => pattern.test(item.name))?.value || '';
  const offers = list(primary.offers)[0] || {};
  const priceBlock = $('.sr-proMainInfo-baseInfo-propertyPrice').first();
  const currencyCode = /US\s*\$|USD/i.test(priceBlock.text()) ? 'USD' : clean(offers.priceCurrency);
  const currencySymbol = ({ USD: '$', CNY: '¥', EUR: '€', GBP: '£' })[currencyCode] || currencyCode;
  const priceAmount = (value) => positive(clean(value).replace(/^(?:US\s*\$|USD|CNY|RMB|EUR|GBP|[$¥€£])\s*/i, ''));
  const tiers = [];
  priceBlock.find('.swiper-slide').each((_, node) => {
    const quantity = clean($(node).find('.swiper-unit-container').text()).replaceAll(',', '').match(/^(\d+)(?:\s*[-–]\s*(\d+)|\+)?/);
    const price = priceAmount($(node).find('.swiper-money-container').text());
    if (quantity && price && Number(quantity[1]) > 0) tiers.push({ minQuantity: Number(quantity[1]), ...(quantity[2] ? { maxQuantity: Number(quantity[2]) } : {}), price, currencySymbol });
  });
  const priceTiers = [...new Map(tiers.map((tier) => [tier.minQuantity, tier])).values()].sort((a, b) => a.minQuantity - b.minQuantity);
  const displayedPrice = clean(priceBlock.find('.only-one-priceNum-td-left').text());
  const rangeMatch = displayedPrice.replaceAll(',', '').match(/(?:US\s*\$|USD|CNY|RMB|EUR|GBP|[$¥€£])\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/i);
  const sourcePriceRange = !priceTiers.length && rangeMatch && Number(rangeMatch[1]) > 0 && Number(rangeMatch[2]) >= Number(rangeMatch[1])
    ? { minPrice: rangeMatch[1], maxPrice: rangeMatch[2], currencySymbol, formattedText: displayedPrice } : null;
  const moqText = clean(priceBlock.find('.only-one-priceNum-price, .swiper-unit-container').first().text());
  const moq = priceTiers[0]?.minQuantity || Number(moqText.replaceAll(',', '').match(/^(\d+)/)?.[1])
    || Number(attribute(/^MOQ|^Min(?:imum)?[ .-]*Order/i).replaceAll(',', '').match(/^(\d+)/)?.[1]) || '';
  const price = priceTiers[0]?.price || sourcePriceRange?.minPrice || priceAmount(displayedPrice) || positive(offers.price || offers.lowPrice);
  if (!priceTiers.length && price && moq && !sourcePriceRange) priceTiers.push({ minQuantity: moq, price, currencySymbol });
  const salesUnit = clean(priceBlock.find('.unit').first().text()) || clean(moqText.match(/\d\s+([a-z]+)(?:\s|\()/i)?.[1]);

  const detail = $('#product .rich-text, .detail-desc .rich-text').first().clone();
  detail.find('img').each((_, node) => {
    const image = $(node);
    image.attr('src', imageUrl(image.attr('data-original') || image.attr('data-src') || image.attr('src')));
  });
  const descriptionHtml = sanitizeTemplateHtml(detail.html() || '');
  const descriptionDocument = load(descriptionHtml);
  const detailImages = imageList(descriptionDocument('img').toArray().map((node) => descriptionDocument(node).attr('src'))).slice(0, 30);
  const packagingAttributes = [...attributes.values()].map((item) => /^package gross weight$/i.test(item.name) ? { ...item, name: 'Gross Weight' } : item);
  const packaging = packagingFromAttributes(packagingAttributes);
  const packageDescription = attribute(/^Transport Package$/i);
  if (packageDescription) packaging.description = packageDescription;

  // Product-level schema SKU is the listing ID, not a sales specification. Only
  // explicit hasVariant records establish combinations; do not expand Size text.
  const skus = [];
  const groups = new Map();
  for (const variant of list(primary.hasVariant)) {
    if (!variant?.sku) continue;
    const values = {};
    const pairs = [...list(variant.additionalProperty), ...['color', 'size', 'material', 'pattern'].filter((key) => variant[key]).map((key) => ({ name: key[0].toUpperCase() + key.slice(1), value: variant[key] }))];
    for (const pair of pairs) {
      const name = decode(pair.name), value = decode(pair.value);
      if (name && value) values[name] = value;
    }
    if (!Object.keys(values).length || skus.some((sku) => sku.id === String(variant.sku))) continue;
    for (const [name, value] of Object.entries(values)) {
      if (!groups.has(name)) groups.set(name, { name, options: [], source: PLATFORM });
      const group = groups.get(name);
      if (!group.options.includes(value)) group.options.push(value);
    }
    const variantOffer = list(variant.offers)[0] || {};
    const variantPrice = !variantOffer.priceCurrency || variantOffer.priceCurrency === currencyCode ? positive(variantOffer.price) : '';
    skus.push({ id: String(variant.sku), attributes: values, price: variantPrice, image: imageList(list(variant.image))[0] || '', source: PLATFORM, derived: false, evidence: { combination: JSON.stringify(values) } });
  }
  const breadcrumbs = structured.find((node) => hasType(node, 'BreadcrumbList'));
  const sourceCategoryPath = list(breadcrumbs?.itemListElement).filter((item) => item.item && !/^home$/i.test(item.name) && !sameProduct(typeof item.item === 'string' ? item.item : item.item?.['@id'])).map((item) => decode(item.name)).filter(Boolean);
  const video = structured.find((node) => hasType(node, 'VideoObject'));
  return {
    sourcePlatform: PLATFORM, sourceId, sourceUrl: baseUrl, title, sourceTitle: title, sourceOriginalTitle: title,
    sourceLanguage: /[\u3400-\u9fff]/.test(title) ? 'zh-CN' : 'en',
    mainImages, images: mainImages, mainImage: mainImages[0] || '', detailImages, descriptionHtml,
    description: clean(descriptionDocument.text()) || decode(primary.description), attributes: [...attributes.values()],
    price, sourcePrice: price, sourceCurrency: currencyCode, currencySymbol, priceTiers, moq, salesUnit,
    sourcePriceRange, ...(sourcePriceRange ? { fobPrice: { ...sourcePriceRange } } : {}),
    priceMode: sourcePriceRange ? 'fob-range' : skus.length && skus.every((sku) => sku.price) ? 'sku' : 'quantity-tier',
    variantGroups: [...groups.values()], skus,
    sourceStructuredEvidence: skus.length ? { platform: PLATFORM, skuCount: skus.length, skuIds: skus.map((sku) => sku.id) } : null,
    packaging, origin: attribute(/^Origin$/i), model: attribute(/^Model NO\.?$/i),
    sourceCategoryId: '', sourceCategoryPath, categoryId: '', categoryPath: [],
    videoUrl: absolute(video?.contentUrl), collectedDetailAt: new Date().toISOString(),
    collectWarning: !price ? '来源为询价商品或未公开售价，请在商品工作台填写美元售价后发布' : '',
  };
}
