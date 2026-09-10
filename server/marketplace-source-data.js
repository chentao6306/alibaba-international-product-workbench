import { load } from 'cheerio';
import JSON5 from 'json5';

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const list = (value) => Array.isArray(value) ? value : [];
const amount = (value) => {
  const raw = typeof value === 'object' && value ? value.value ?? value.amount ?? value.price : value;
  const match = text(raw).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match && Number(match[0]) > 0 ? match[0] : '';
};

export function marketplaceDescriptionHtml(content) {
  const value = String(content || '').trim();
  if (value.startsWith('<')) return value;
  const details = readAssignedJson(value, 'offer_details');
  if (typeof details?.content === 'string') return details.content;
  const match = value.match(/^(?:var\s+)?(?:window\.)?desc\s*=\s*([\s\S]*?)\s*;?$/);
  if (!match) return '';
  try { const parsed = JSON5.parse(match[1]); return typeof parsed === 'string' ? parsed : ''; }
  catch { return ''; }
}

// Parse JSON assignments as data. Never evaluate scripts from a supplier page.
export function readAssignedJson(script, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:window\\.)?${escaped}\\s*=\\s*`).exec(script);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (!['{', '['].includes(script[start])) return null;
  let depth = 0;
  let quoted = false;
  let escape = false;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index];
    if (quoted) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (!depth) { try { return JSON.parse(script.slice(start, index + 1)); } catch { return null; } }
    }
  }
  return null;
}

export function extractMarketplaceProduct(html, platform, baseUrl, pageData = {}) {
  const $ = load(html);
  const context = platform === '1688' ? pageData.context?.result : null;
  const modules = context?.data || {};
  const model = context?.global?.globalData?.model || {};
  const offer = model.offerDetail || {};
  const expectedId = new URL(baseUrl).pathname.match(/\/offer\/(\d+)/)?.[1];
  const actualId = String(offer.offerId || modules.gallery?.fields?.offerId || '');
  if (actualId && expectedId && actualId !== expectedId) throw new Error('详情页返回的商品 ID 与采集链接不一致，请刷新后重试');
  const modern = Boolean(actualId && context);
  const gallery = modules.gallery?.fields || {};
  const trade = model.tradeModel || {};
  const packageInfo = modules.productPackInfo?.fields || {};
  const modernProduct = {
    subject: modules.productTitle?.fields?.title || offer.subject || gallery.subject,
    images: gallery.mainImage?.length ? gallery.mainImage : offer.mainImageList || offer.imageList,
    skuProps: offer.skuProps, skuMap: trade.skuMap,
    priceRanges: modules.mainPrice?.fields?.priceModel?.currentPrices || trade.offerPriceModel?.currentPrices,
    minPrice: trade.minPrice, beginAmount: trade.beginAmount,
    leafCategoryId: offer.leafCategoryId || modules.description?.fields?.leafCategoryId,
    descriptionUrl: modules.description?.fields?.detailUrl || offer.detailUrl,
    videoUrl: gallery.video?.videoUrl,
    attributes: (offer.featureAttributes || []).map((item) => ({ attrName: item.name, attrValue: item.value || list(item.values).join(',') })),
  };
  const roots = modern ? [modernProduct] : Object.values(pageData).filter((value) => value && typeof value === 'object');
  for (const node of modern ? [] : $('script:not([src])').toArray()) {
    const script = $(node).text();
    try { roots.push(JSON.parse(script)); } catch {}
    for (const name of ['runParams', '__INIT_DATA', '__INIT_DATA__', '__GLOBAL_DATA', '__GLOBAL_DATA__', '__NEXT_DATA__']) {
      const data = readAssignedJson(script, name);
      if (data) roots.push(data);
    }
  }
  const nodes = [];
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 18 || seen.has(node) || nodes.length > 30000) return;
    seen.add(node); nodes.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (!/recommend|relatedProducts|similarProducts|youMayLike|advertisement|shopInfo|sellerModel|buyerModel|companyInfo/i.test(key)) visit(value, depth + 1);
    }
  };
  roots.forEach((root) => visit(root));
  const find = (key) => nodes.find((node) => node[key] != null)?.[key];
  const absolute = (value) => {
    if (!value || typeof value !== 'string') return '';
    try { const url = new URL(value, baseUrl); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; }
  };
  const images = (values) => [...new Set(values.flat(Infinity).map((item) => absolute(typeof item === 'string' ? item : item?.originalImageURI || item?.fullPathImageURI || item?.imageUrl || item?.url)).filter(Boolean))];
  const ldProduct = nodes.find((node) => list(node['@type']).includes('Product') || node['@type'] === 'Product') || {};
  const subject = find('titleModule')?.subject || find('productInfoComponent')?.subject || find('subject') || ldProduct.name;
  const title = text(subject || $('meta[property="og:title"]').attr('content') || $('title').text() || $('h1').first().text()).replace(/\s*[-|]\s*(?:Alibaba|AliExpress|1688|阿里巴巴).*$/i, '');
  const mainImages = images([
    find('imagePathList') || [], find('imageList') || [], find('images') || [],
    ldProduct.image || [], (modern ? [] : $('[class*="gallery"] img, [class*="main-image"] img, [class*="detail-gallery"] img').toArray())
      .map((node) => $(node).attr('data-src') || $(node).attr('src')),
    modern ? '' : $('meta[property="og:image"]').attr('content'),
  ]).slice(0, 6);
  const attrs = new Map();
  const add = (name, value) => { const key = text(name); const val = text(value); if (key && val && key.length < 100 && val.length < 1000) attrs.set(key.toLowerCase(), { name: key, value: val, source: platform }); };
  for (const node of nodes) {
    if (node.attrName || node.attributeName || node.propName) add(node.attrName || node.attributeName || node.propName, node.attrValue || node.attributeValue || node.propValue);
  }
  for (const row of (modern ? $('.attr-descriptions tr') : $('tr')).toArray()) {
    const cells = $(row).find('th,td').toArray().map((node) => text($(node).text()));
    for (let index = 0; index + 1 < cells.length; index += 2) add(cells[index], cells[index + 1]);
  }
  const groups = [];
  const definitions = list(find('productSKUPropertyList')).length ? list(find('productSKUPropertyList')) : list(find('skuProps'));
  const optionKeys = new Map();
  for (const definition of definitions) {
    const name = text(definition.skuPropertyName || definition.prop || definition.name);
    const options = [];
    const optionImages = {};
    for (const option of list(definition.skuPropertyValues || definition.value || definition.values)) {
      const label = text(typeof option === 'string' ? option : option.propertyValueDisplayName || option.propertyValueName || option.name || option.value);
      if (!label) continue;
      options.push(label);
      const image = absolute(option.skuPropertyImagePath || option.imageUrl || option.image);
      if (image) optionImages[label] = image;
      optionKeys.set(`${definition.skuPropertyId}:${option.propertyValueId}`, { name, value: label });
    }
    if (name && options.length) groups.push({ name, options: [...new Set(options)], optionImages, source: platform });
  }
  const skus = [];
  for (const sku of list(find('skuPriceList'))) {
    const attributes = {};
    for (const token of String(sku.skuAttr || '').split(';')) {
      const pair = optionKeys.get(token.split('#')[0]);
      if (pair) attributes[pair.name] = pair.value;
    }
    skus.push({ id: String(sku.skuId || ''), attributes, price: amount(sku.skuVal?.skuAmount || sku.skuVal?.skuCalPrice), stock: sku.skuVal?.availQuantity,
      source: platform, derived: false, evidence: { combination: String(sku.skuAttr || '') } });
  }
  for (const [key, sku] of Object.entries(find('skuMap') || {})) {
    if (!sku || typeof sku !== 'object') continue;
    const combination = text(sku.specAttrs || key).replace(/&gt;/g, '>');
    const values = combination.split(/[;>]/).map(text);
    const attributes = Object.fromEntries(groups.map((group, index) => [group.name, values[index]]).filter(([, value]) => value));
    skus.push({ id: String(sku.skuId || key), attributes, price: amount(sku.price || sku.discountPrice), stock: sku.canBookCount ?? sku.stock,
      source: platform, derived: false, evidence: { combination } });
  }
  const offers = list(ldProduct.offers)[0] || ldProduct.offers || {};
  const currencyCode = platform === '1688' ? 'CNY' : text(find('currencyCode') || find('currency') || offers.priceCurrency || '');
  const currencySymbol = ({ USD: '$', CNY: '¥', EUR: '€', GBP: '£' })[currencyCode] || currencyCode;
  const tiers = list(find('priceRange') || find('priceRangeList') || find('priceRanges')).map((tier) => ({ minQuantity: Number(tier.startQuantity || tier.beginAmount || tier.startAmount || 1), price: amount(tier.price), currencySymbol })).filter((tier) => tier.price);
  const price = tiers[0]?.price || amount(find('minPrice') || find('formatedPrice') || offers.price || offers.lowPrice || $('meta[property="product:price:amount"]').attr('content')) || skus.find((sku) => sku.price)?.price || '';
  const detailNode = pageData.shadowDescription ? load(`<div id="source-detail">${pageData.shadowDescription}</div>`)('#source-detail') : $('#desc-lazyload-container, #product-description, [class*="detail-desc-decorate"], [class*="description--origin"], [data-pl="product-description"]').first().clone();
  detailNode.find('script,style,iframe,button,object,embed,link,meta').remove();
  detailNode.find('*').each((_, node) => {
    for (const name of Object.keys(node.attribs || {})) if (/^on/i.test(name) || /^(?:javascript|data:text\/html):/i.test(node.attribs[name])) $(node).removeAttr(name);
  });
  detailNode.find('img').each((_, node) => { const image = $(node); image.attr('src', absolute(image.attr('data-src') || image.attr('data-lazy-src') || image.attr('src'))); });
  const descriptionHtml = detailNode.html() || '';
  const detailImages = images(detailNode.find('img').toArray().map((node) => $(node).attr('src'))).slice(0, 30);
  const descriptionUrl = absolute(find('descriptionUrl') || find('detailUrl') || find('detailDesc') || '');
  const categoryId = text(find('leafCategoryId') || find('categoryId') || '');
  const categoryPath = $('[class*="breadcrumb"] a').toArray().map((node) => text($(node).text())).filter(Boolean);
  const attribute = (expression) => [...attrs.values()].find((item) => expression.test(item.name))?.value || '';
  const weightText = attribute(/^(?:包装重量|毛重|gross weight|package weight)(?:\s*\(kg\))?$/i);
  const weight = amount(weightText);
  const packaging = weight && /kg|千克|公斤/i.test(weightText) ? { weight } : {};
  if (modern) {
    if (Number(packageInfo.unitWeight) > 0) packaging.weight = Number(packageInfo.unitWeight);
    const sizes = packageInfo.pieceWeightScale?.pieceWeightScaleInfo || [];
    // A single size row applies to the whole item. Distinct SKU sizes stay in source attributes.
    if (sizes.length === 1) {
      const columns = packageInfo.pieceWeightScale?.columnList || [];
      for (const key of ['length', 'width', 'height']) if (Number(sizes[0][key]) > 0 && /cm|厘米/.test(columns.find((c) => c.name === key)?.label || '')) packaging[key] = Number(sizes[0][key]);
      if (!packaging.weight && Number(sizes[0].weight) > 0 && /\(g\)|克/.test(columns.find((c) => c.name === 'weight')?.label || '')) packaging.weight = Number(sizes[0].weight) / 1000;
    }
  }
  const sourceStructuredEvidence = skus.length ? { skuCount: skus.length, skuIds: skus.map((sku) => sku.id), platform } : null;
  return {
    sourcePlatform: platform, title, sourceTitle: title, sourceOriginalTitle: title, sourceUrl: baseUrl,
    sourceLanguage: /[\u3400-\u9fff]/.test(title) ? 'zh-CN' : 'en',
    mainImages, images: mainImages, mainImage: mainImages[0] || '', detailImages,
    descriptionHtml, description: text(detailNode.text()) || text(ldProduct.description), descriptionUrl,
    attributes: [...attrs.values()], variantGroups: groups, skus,
    sourcePrice: price, price, currencySymbol, sourceCurrency: currencyCode,
    priceTiers: tiers.length ? tiers : price ? [{ minQuantity: 1, price, currencySymbol }] : [],
    moq: tiers[0]?.minQuantity || Number(find('beginAmount')) || 1,
    packaging,
    ...(modern && Number.isFinite(Number(trade.canBookedAmount)) ? { stock: Number(trade.canBookedAmount) } : {}),
    ...(modern ? { sourcePackaging: packageInfo.pieceWeightScale || null, salesUnit: trade.unit || '' } : {}),
    sourceStructuredEvidence,
    priceMode: skus.length && skus.every((sku) => sku.price) ? 'sku' : 'quantity-tier',
    sourceCategoryId: categoryId, sourceCategoryPath: categoryPath.length ? categoryPath : offer.leafCategoryName ? [offer.leafCategoryName] : [], categoryId: '', categoryPath: [],
    origin: [...attrs.values()].find((item) => /^(?:产地|原产地|place of origin|origin)$/i.test(item.name))?.value || '',
    videoUrl: absolute(find('videoUrl') || $('video').attr('src')), collectedDetailAt: new Date().toISOString(),
  };
}
