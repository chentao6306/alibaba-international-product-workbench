import { load } from 'cheerio';
import { parseCollectionUrl } from './source-platform.js';

const PLATFORM = 'made-in-china';
const scopeUrl = (url) => url.replace(/-\d+\.html$/, '-page.html');
const pageNumber = (url) => Number(url.match(/-(\d+)\.html$/)?.[1] || 0);
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export function extractMadeInChinaGroups(html, url) {
  const base = parseCollectionUrl(url, 'shop-products', PLATFORM).url;
  const shopUrl = `${new URL(base).origin}/`;
  const $ = load(html);
  const groups = new Map();
  const groupLink = (node) => {
    try {
      const link = parseCollectionUrl(new URL($(node).attr('href'), base).href, 'shop-products', PLATFORM).url;
      const id = new URL(link).pathname.match(/^\/product-group\/([^/]+)\//)?.[1];
      if (!id || new URL(link).origin !== new URL(base).origin) return null;
      const text = clean($(node).attr('title') || $(node).text());
      const count = text.match(/[（(]([\d,]+)[)）]\s*$/);
      const name = text.replace(/\s*[（(][\d,]+[)）]\s*$/, '');
      return name ? { externalId: id, name, url: link.replace(/-\d+\.html$/, '-1.html'),
        productCount: count ? Number(count[1].replaceAll(',', '')) : null } : null;
    } catch { return null; }
  };
  $('a[href*="/product-group/"]').each((_, node) => {
    const group = groupLink(node);
    if (!group) return;
    // Both the navigation dropdown and sidebar repeat these links. Prefer
    // the navigation hierarchy, without treating a seller group as a category.
    const parentNode = $(node).closest('.sr-nav-ssub-list').parent().children('a[href*="/product-group/"]').first();
    const parent = parentNode.length ? groupLink(parentNode[0]) : null;
    const previous = groups.get(group.externalId);
    groups.set(group.externalId, { ...group, ...previous,
      ...(parent && parent.externalId !== group.externalId ? { parentExternalId: parent.externalId, parentName: parent.name } : {}),
      ...(group.productCount != null ? { productCount: group.productCount } : {}) });
  });
  const total = clean($('body').text()).match(/Total\s+([\d,]+)\s+Products/i);
  const all = { externalId: 'all', name: '全部商品', url: `${shopUrl}product-list-1.html`,
    productCount: /\/product-list-\d+\.html$/.test(base) && total ? Number(total[1].replaceAll(',', '')) : null };
  const shopName = clean($('.title-txt a').first().text())
    || clean($('title').text()).match(/ - (.+?) - page \d+\.?$/i)?.[1] || new URL(base).hostname;
  return { readable: $('.prod-result-list').length > 0 || groups.size > 0,
    shopUrl, shopName, sourcePlatform: PLATFORM, groups: [all, ...groups.values()] };
}

export function extractMadeInChinaListing(html, url) {
  const base = parseCollectionUrl(url, 'shop-products', PLATFORM).url;
  const $ = load(html);
  const products = new Map();
  $('.prod-result-list .prod-result-item a[href]').each((_, node) => {
    try {
      const link = parseCollectionUrl(new URL($(node).attr('href'), base).href, 'product', PLATFORM);
      if (new URL(link.url).hostname === new URL(base).hostname) products.set(link.sourceId, link);
    } catch { /* Navigation, inquiry and recommendation links are not products. */ }
  });
  let nextUrl = '';
  for (const node of $('a.next.page-main[href]').toArray()) {
    try {
      const next = parseCollectionUrl(new URL($(node).attr('href'), base).href, 'shop-products', PLATFORM).url;
      if (scopeUrl(next) === scopeUrl(base) && pageNumber(next) > pageNumber(base)) { nextUrl = next; break; }
    } catch { /* Never follow pagination to another supplier or category. */ }
  }
  return { readable: $('.prod-result-list').length > 0, products: [...products.values()], nextUrl };
}

export async function collectMadeInChinaShop(link, onProgress, options, { readListing, collectLinks }) {
  const url = parseCollectionUrl(link.url, 'shop-products', PLATFORM).url;
  const allPages = options.allPages === true;
  const startPage = allPages ? 1 : Math.max(1, Math.floor(Number(options.startPage) || 1));
  const endPage = allPages ? null : Math.max(startPage, Math.floor(Number(options.endPage) || startPage));
  const maxProducts = options.maxProducts === null ? null
    : options.maxProducts === undefined ? (allPages ? null : 100) : Math.max(1, Math.floor(Number(options.maxProducts) || 100));
  const scope = JSON.stringify({ url, startPage, endPage, maxProducts });
  const paused = () => { throw Object.assign(new Error('已暂停采集，已发现的商品和处理进度已保留'), { code: 'COLLECT_PAUSED' }); };
  const prior = options.checkpoint;
  if (prior && prior.scope !== scope) throw new Error('店铺采集断点与当前链接或页码不一致，请新建采集任务');
  const state = prior ? structuredClone(prior) : {
    version: 1, stage: 'listing', scope, products: [], completedIds: [], visited: [], page: startPage - 1,
    nextUrl: url.replace(/-\d+\.html$/, `-${startPage}.html`),
  };
  while (state.stage === 'listing' && state.nextUrl && (maxProducts == null || state.products.length < maxProducts)) {
    if (options.shouldStop?.()) paused();
    const currentUrl = state.nextUrl;
    const currentPage = pageNumber(currentUrl);
    if ((endPage != null && currentPage > endPage) || state.visited.includes(currentUrl)) break;
    const listing = await readListing(currentUrl);
    if (!listing.readable) throw new Error('未读取到中国制造网店铺商品列表，请打开平台登录，确认店铺链接后重试');
    const products = new Map(state.products.map((product) => [product.sourceId, product]));
    for (const product of listing.products) if (!products.has(product.sourceId) && (maxProducts == null || products.size < maxProducts)) products.set(product.sourceId, product);
    state.products = [...products.values()];
    state.visited.push(currentUrl);
    state.page = currentPage;
    const next = listing.nextUrl;
    state.nextUrl = (endPage == null || currentPage < endPage) && next && scopeUrl(next) === scopeUrl(url) && pageNumber(next) > currentPage ? next : '';
    await options.onCheckpoint?.(state);
    if (onProgress({ stage: 'listing', page: currentPage, allPages, found: state.products.length, total: state.products.length }) === false || options.shouldStop?.()) paused();
    if (state.nextUrl && (maxProducts == null || state.products.length < maxProducts) && Number(options.delaySeconds) > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(60, Number(options.delaySeconds)) * 1000));
  }
  if (!state.products.length) throw new Error('指定店铺或页码没有找到商品，请检查店铺链接和采集范围');
  state.stage = 'detail';
  state.nextUrl = '';
  await options.onCheckpoint?.(state);
  return collectLinks(state.products, onProgress, options);
}
