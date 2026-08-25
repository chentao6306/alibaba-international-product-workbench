import path from 'node:path';
import { hidePage, launchPersistent, revealPage, settlePage, waitForHumanVerification } from './browser-runtime.js';
import { SOURCE_LANGUAGE_HEADERS, withSourceLocale } from './source-locale.js';

function absoluteUrl(value, base) {
  if (!value) return '';
  try {
    return new URL(value.startsWith('//') ? `https:${value}` : value, base).href;
  } catch {
    return '';
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function usefulProductTitle(value) {
  const title = cleanText(value);
  return title && !/Alibaba Manufacturer Directory|Suppliers, Manufacturers, Exporters|Alibaba\.com\s*[-|]/i.test(title)
    ? title : '';
}

export function normalizeShopUrl(input) {
  let value = cleanText(input);
  const embeddedUrl = value.match(/https?:\/\/[^\s]+/i)?.[0];
  if (embeddedUrl) value = embeddedUrl.replace(/[）)\]】}>，,。；;]+$/, '');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  const domestic = /(^|\.)1688\.com$/i.test(url.hostname);
  const international = /(^|\.)alibaba\.com$/i.test(url.hostname);
  if (!domestic && !international) throw new Error('请输入 1688 国内站或阿里巴巴国际站店铺链接');
  if (domestic && !url.pathname.includes('/page/offerlist')) url.pathname = '/page/offerlist.htm';
  if (international && !/\/product(?:group)?list(?:-|\.)/i.test(url.pathname)) url.pathname = '/productlist.html';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function isInternationalShopUrl(value) {
  try { return /(^|\.)alibaba\.com$/i.test(new URL(value).hostname); } catch { return false; }
}

export function productIdFromUrl(value) {
  return value.match(/(?:detail\.1688\.com\/offer\/|\/offer\/)(\d+)\.html/i)?.[1]
    || value.match(/\/product-detail\/[^?#]*?(\d{8,})\.html/i)?.[1]
    || '';
}

async function readInternationalModules(page) {
  return page.locator('[module-data]').evaluateAll((nodes) => {
    const result = { groups: [], products: [], companyName: '', pageNav: null };
    const flattenGroups = (groups) => {
      for (const group of groups || []) {
        result.groups.push(group);
        flattenGroups(group.children);
      }
    };
    for (const node of nodes) {
      try {
        const raw = node.getAttribute('module-data') || '';
        const parsed = JSON.parse(decodeURIComponent(raw));
        const data = parsed?.mds?.moduleData?.data;
        if (!data) continue;
        if (data.companyName) result.companyName = data.companyName;
        if (Array.isArray(data.groups)) flattenGroups(data.groups);
        if (Array.isArray(data.productList)) {
          result.products.push(...data.productList);
          result.pageNav = data.pageNavView || null;
        }
      } catch {}
    }
    return result;
  });
}

export class ShopCollector {
  constructor(dataDir, detailReader = null) {
    this.profileDir = path.join(dataDir, 'collector-profile');
    this.detailReader = detailReader;
    this.context = null;
    this.visible = false;
    this.verificationPage = null;
  }

  async getContext() {
    if (this.context) return this.context;
    this.context = await launchPersistent(this.profileDir, { headless: false });
    this.context.on('close', () => { this.context = null; this.verificationPage = null; });
    return this.context;
  }

  status() {
    return {
      browserOpen: Boolean(this.context),
      visible: Boolean(this.visible),
      currentUrl: this.verificationPage?.url() || ''
    };
  }

  async open(shopUrl = '') {
    this.visible = true;
    const context = await this.getContext();
    this.verificationPage = context.pages()[0] || await context.newPage();
    const target = shopUrl ? normalizeShopUrl(shopUrl) : 'https://www.alibaba.com/';
    await withSourceLocale(context, async () => {
      await this.verificationPage.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
      await this.verificationPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    });
    await revealPage(this.verificationPage);
    return this.status();
  }

  async withPage(callback) {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
      await hidePage(this.verificationPage);
      this.visible = false;
      return await withSourceLocale(context, async () => {
        await hidePage(page);
        return callback(page);
      });
    } finally {
      await page.close().catch(() => {});
    }
  }

  async listGroups(shopUrl) {
    const normalized = normalizeShopUrl(shopUrl);
    return this.withPage(async (page) => {
      await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await settlePage(page);
      await waitForHumanVerification(page);
      const title = cleanText(await page.title());
      if (isInternationalShopUrl(normalized)) {
        const data = await readInternationalModules(page);
        const map = new Map();
        map.set('all', { externalId: 'all', name: '全部商品', url: normalized, productCount: data.pageNav?.totalLines ?? null });
        for (const group of data.groups) {
          if (group.id === undefined || group.id === null || !group.name || !group.url) continue;
          map.set(String(group.id), {
            externalId: String(group.id), name: cleanText(group.name),
            url: absoluteUrl(group.url, normalized), productCount: group.productCount ?? null
          });
        }
        if (map.size === 1 && /verify|captcha|sign in|验证|登录/i.test(await page.locator('body').innerText().catch(() => ''))) {
          throw new Error('国际站要求人工验证，请点击“打开采集浏览器”完成验证后重试');
        }
        if (map.size === 1) throw new Error('没有从该国际站页面读取到商品分组，请确认粘贴的是同行店铺首页');
        return {
          shopUrl: normalized,
          shopName: cleanText(data.companyName) || title.replace(/\s*[-|]\s*Alibaba.*$/i, '').trim() || new URL(normalized).hostname,
          groups: [...map.values()]
        };
      }
      const raw = await page.locator('a').evaluateAll((anchors) => anchors.map((anchor) => ({
        text: (anchor.textContent || anchor.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
        href: anchor.href,
        nearby: (anchor.parentElement?.textContent || '').replace(/\s+/g, ' ').trim()
      })));
      const map = new Map();
      map.set('all', { externalId: 'all', name: '全部商品', url: normalized, productCount: null });
      for (const item of raw) {
        const parsed = item.href.match(/offerlist_(\d+)\.htm/i);
        let externalId = parsed?.[1];
        if (!externalId) {
          try { externalId = new URL(item.href).searchParams.get('categoryId'); } catch {}
        }
        if (!externalId || !item.text || item.text.length > 50) continue;
        const count = item.nearby.match(/(?:\(|（)\s*(\d+)\s*(?:\)|）)/)?.[1];
        map.set(externalId, {
          externalId,
          name: item.text.replace(/[（(]\s*\d+\s*[）)]$/, '').trim(),
          url: absoluteUrl(item.href, normalized),
          productCount: count ? Number(count) : null
        });
      }
      if (map.size === 1 && /验证|captcha|登录/.test(await page.locator('body').innerText().catch(() => ''))) {
        throw new Error('1688 要求人工验证，请点击“打开采集浏览器”完成验证后重试');
      }
      return { shopUrl: normalized, shopName: title.replace(/[-_]1688.*$/i, '').trim() || new URL(normalized).hostname, groups: [...map.values()] };
    });
  }

  async collectGroup(groupUrl, onProgress = () => {}, options = {}) {
    return this.withPage(async (page) => {
      const items = new Map();
      let nextUrl = groupUrl;
      let pageNumber = 0;
      const startPage = Math.max(1, Number(options.startPage || 1));
      const endPage = Math.max(startPage, Number(options.endPage || 100));
      const delaySeconds = Math.max(0, Number(options.delaySeconds || 0));
      const international = isInternationalShopUrl(groupUrl);
      const shouldStop = () => typeof options.shouldStop === 'function' && options.shouldStop();
      while (nextUrl && pageNumber < endPage) {
        if (shouldStop()) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        pageNumber += 1;
        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await settlePage(page);
        await waitForHumanVerification(page);
        if (pageNumber < startPage) {
          onProgress({ stage: 'listing', page: pageNumber, found: items.size, skipped: true });
        }
        const internationalData = international ? await readInternationalModules(page) : null;
        const pageItems = international
          ? internationalData.products.map((product) => ({
              id: String(product.id || ''), url: product.url || '', title: product.subject || '',
              image: product.imageUrls?.original || product.imageUrls?.x350 || '',
              images: (product.imageUrlList || []).map((image) => image.original || image.x350).filter(Boolean),
              price: product.priceFrom || product.fobPriceWithoutUnit?.replace(/[^\d.]/g, '') || '',
              currencySymbol: product.currencySymbol || '$', moq: product.moq || '', text: product.fobPrice || ''
            }))
          : await page.locator('a').evaluateAll((anchors) => anchors.map((anchor) => {
              const href = anchor.href || '';
              if (!/(?:detail\.1688\.com\/offer\/|\/offer\/)\d+\.html/i.test(href)) return null;
              const container = anchor.closest('li, article, [class*=offer], [class*=item], [class*=product]') || anchor.parentElement;
              const image = container?.querySelector('img');
              const text = (container?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
              return {
                url: href,
                title: anchor.getAttribute('title') || image?.getAttribute('alt') || anchor.textContent || '',
                image: image?.getAttribute('data-lazy-src') || image?.getAttribute('data-src') || image?.getAttribute('src') || '',
                text
              };
            }).filter(Boolean));
        if (pageNumber >= startPage) for (const item of pageItems) {
          const sourceUrl = absoluteUrl(item.url, groupUrl);
          const sourceId = item.id || productIdFromUrl(sourceUrl);
          if (!sourceId) continue;
          const price = item.price || item.text.match(/[¥￥$]\s*([\d.]+)/)?.[1] || '';
          items.set(sourceId, {
            sourceId, sourceUrl, sourceTitle: cleanText(item.title),
            title: cleanText(item.title), mainImage: absoluteUrl(item.image, sourceUrl),
            images: (item.images || []).map((image) => absoluteUrl(image, sourceUrl)),
            sourcePrice: price, price, currencySymbol: item.currencySymbol || '¥', moq: item.moq || '',
            stock: 100, description: '', attributes: [], skus: []
          });
          if (delaySeconds) await page.waitForTimeout(delaySeconds * 1000);
        }
        onProgress({ stage: 'listing', page: pageNumber, found: items.size, startPage, endPage, destinationCountry: options.destinationCountry || '' });
        let next = '';
        if (international && internationalData?.pageNav) {
          const nav = internationalData.pageNav;
          const current = Number(nav.currentPage || pageNumber);
          const totalPages = Math.ceil(Number(nav.totalLines || 0) / Number(nav.pageLines || 1));
          const format = nav.urlCreator?.formatString || nav.formatString || '';
          if (current < totalPages && format) next = absoluteUrl(format.replace('{0}', String(current + 1)), page.url());
        } else {
          next = await page.locator('a').evaluateAll((anchors) => {
            const candidate = anchors.find((anchor) => /^(下一页|下页|next|>)$/i.test((anchor.textContent || '').replace(/\s+/g, '').trim()) && anchor.href && !anchor.className.includes('disabled'));
            return candidate?.href || '';
          });
        }
        if (!next || next === nextUrl) break;
        nextUrl = next;
      }

      const products = [...items.values()];
      if (options.sort === 'priceAsc') products.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
      if (options.sort === 'priceDesc') products.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
      if (international && this.detailReader) {
        return this.detailReader(products, (current, total, product) => {
          return onProgress({ stage: 'detail', current, total, found: products.length, product });
        }, options);
      }
      for (let index = 0; index < products.length; index += 1) {
        if (shouldStop()) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        products[index] = await this.readProductDetail(page, products[index]);
        const keepGoing = onProgress({ stage: 'detail', current: index + 1, total: products.length, found: products.length, product: products[index] });
        if (keepGoing === false) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        if (delaySeconds) await page.waitForTimeout(delaySeconds * 1000);
      }
      return products;
    });
  }

  async readProductDetail(page, base) {
    try {
      await page.goto(base.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await settlePage(page);
      const detail = await page.evaluate(() => {
        const meta = (name) => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content || '';
        const normalize = (value) => value?.startsWith('//') ? `https:${value}` : value || '';
        const images = [...document.querySelectorAll('img')].map((image) => normalize(
          image.getAttribute('data-lazy-src') || image.getAttribute('data-src') || image.currentSrc || image.src
        )).filter((src) => /^https?:/.test(src) && !/logo|avatar|icon|qr/i.test(src));
        const attributes = [...document.querySelectorAll('[class*=attribute] li, [class*=props] li, [class*=parameter] li')]
          .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 80);
        const skuTexts = [...document.querySelectorAll('[class*=sku] [class*=item], [class*=sku] li')]
          .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter((value) => value && value.length < 80).slice(0, 100);
        const bodyText = document.body?.innerText || '';
        const price = meta('product:price:amount') || bodyText.match(/[¥￥$]\s*([\d.]+)/)?.[1] || '';
        const descriptionNode = document.querySelector('[class*=description], #desc-lazyload-container, [data-spm*=desc]');
        return {
          title: meta('og:title') || document.querySelector('h1')?.textContent || document.title,
          image: normalize(meta('og:image')),
          images: [...new Set(images)].slice(0, 12),
          price,
          description: (descriptionNode?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000),
          attributes,
          skuTexts
        };
      });
      return {
        ...base,
        sourceTitle: usefulProductTitle(detail.title) || base.sourceTitle,
        title: usefulProductTitle(detail.title) || base.title,
        mainImage: base.mainImage || detail.image || detail.images[0] || '',
        images: isInternationalShopUrl(base.sourceUrl)
          ? [...new Set([base.mainImage, ...(base.images || [])].filter(Boolean))]
          : [...new Set([detail.image, base.mainImage, ...(base.images || []), ...detail.images].filter(Boolean))],
        sourcePrice: detail.price || base.sourcePrice,
        price: detail.price || base.price,
        description: detail.description,
        attributes: detail.attributes,
        skus: detail.skuTexts.map((name) => ({ name, price: detail.price || base.price, stock: 100 }))
      };
    } catch (error) {
      return { ...base, collectWarning: error.message };
    }
  }
}
