import path from 'node:path';
import { hasExplicitHumanChallenge, hidePage, launchPersistent, revealPage, settlePage, syncAlibabaCookies, waitForHumanVerification } from './browser-runtime.js';
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

export function internationalFeaturedUrl(value) {
  const url = new URL(normalizeShopUrl(value));
  return `${url.protocol}//${url.host}/featureproductlist.html`;
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
    if (this.context) {
      try {
        const browser = this.context.browser();
        if (browser?.isConnected() !== false) {
          // The Electron login window may have refreshed the Alibaba session
          // after this context was created. Re-import the latest cookies before
          // starting another listing/detail request.
          await syncAlibabaCookies(this.context);
          this.context.pages();
          return this.context;
        }
      } catch {
      }
      await this.resetContext();
    }
    // Ordinary collection runs in Chromium's real headless mode, so Windows
    // never creates a desktop window or taskbar icon.
    this.context = await launchPersistent(this.profileDir, { headless: true });
    this.context.on('close', () => { this.context = null; this.verificationPage = null; });
    this.context.on('page', (page) => {
      if (!this.visible) hidePage(page).catch(() => {});
    });
    return this.context;
  }

  async resetContext() {
    const context = this.context;
    this.context = null;
    this.verificationPage = null;
    await context?.close().catch(() => {});
  }

  async completeHumanVerification(url) {
    await this.resetContext();
    const context = await launchPersistent(this.profileDir, { headless: false });
    this.context = context;
    this.visible = true;
    context.on('close', () => {
      if (this.context === context) this.context = null;
      this.verificationPage = null;
      this.visible = false;
    });
    const page = context.pages()[0] || await context.newPage();
    this.verificationPage = page;
    await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Inspect while hidden first. A transient redirect must not flash a
    // desktop window; reveal only when a real visible challenge is present.
    if (!await hasExplicitHumanChallenge(page)) {
      await this.resetContext();
      this.visible = false;
      return;
    }
    await revealPage(page);
    const completed = await waitForHumanVerification(page, { timeout: 300000 });
    if (!completed && await hasExplicitHumanChallenge(page)) {
      throw new Error('人工验证未完成，请重试');
    }
    await this.resetContext();
    this.visible = false;
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

  async withPage(callback, attempt = 0) {
    let context = await this.getContext();
    let page;
    try {
      page = await context.newPage();
    } catch {
      await this.resetContext();
      context = await this.getContext();
      try {
        page = await context.newPage();
      } catch {
        await this.resetContext();
        throw new Error('采集浏览器启动失败，请重试');
      }
    }
    try {
      await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
      await hidePage(this.verificationPage);
      this.visible = false;
      return await withSourceLocale(context, async () => {
        await hidePage(page);
        return callback(page);
      });
    } catch (error) {
      const message = String(error?.message || '');
      if (error?.code === 'HUMAN_VERIFICATION_REQUIRED' && attempt < 2) {
        await this.completeHumanVerification(error.verificationUrl || page.url());
        return this.withPage(callback, attempt + 1);
      }
      const closed = /target page, context or browser has been closed|browser has been closed|page has been closed|target closed/i.test(message);
      if (closed && attempt < 1) {
        await this.resetContext();
        return this.withPage(callback, attempt + 1);
      }
      if (closed) throw new Error('采集浏览器已关闭，请重试');
      throw error;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async listGroups(shopUrl) {
    const normalized = normalizeShopUrl(shopUrl);
    // Group reading is automatic and hidden. The verification helper reveals
    // the page only when Alibaba requires a human action.
    this.visible = false;
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
        const groupPageText = await page.locator('body').innerText().catch(() => '');
        if (map.size === 1 && /verify|captcha|验证|登录/i.test(groupPageText)) {
          throw new Error('国际站需要人工验证，请在弹出的验证页面完成验证后重试');
        }
        // The storefront's "Featured products" page is a separate listing
        // and is not included in the product-group module. Keep it as a
        // normal selectable group so collection, pagination and persistence
        // use the same path as every other group.
        const featuredUrl = internationalFeaturedUrl(normalized);
        let featuredCount = null;
        let featuredAvailable = false;
        try {
          const response = await page.goto(featuredUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await settlePage(page);
          await waitForHumanVerification(page);
          const featuredData = await readInternationalModules(page);
          featuredCount = featuredData.pageNav?.totalLines ?? featuredData.products.length ?? null;
          featuredAvailable = response?.ok() !== false
            && !/error\.alibaba\.com|error404/i.test(page.url())
            && Boolean(featuredData.pageNav || featuredData.products.length);
        } catch {
          // Some storefronts do not configure a featured-products page.
        }
        if (featuredAvailable) map.set('featured', { externalId: 'featured', name: '橱窗', url: featuredUrl, productCount: featuredCount });
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
        throw new Error('1688 需要人工验证，请在弹出的验证页面完成验证后重试');
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
        const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
        const meta = (name) => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content || '';
        const normalize = (value) => { try { return new URL(String(value || '').startsWith('//') ? `https:${value}` : String(value || ''), location.href).href; } catch { return ''; } };
        const bodyText = document.body?.innerText || '';
        const json = [];
        const visit = (value) => { if (!value || typeof value !== 'object') return; json.push(value); if (Array.isArray(value)) value.forEach(visit); else Object.values(value).forEach(visit); };
        for (const script of document.querySelectorAll('script[type="application/ld+json"], script:not([src])')) {
          try { const text = script.textContent || ''; if (/product|sku|price|spec|商品|规格/i.test(text)) visit(JSON.parse(text)); } catch {}
        }
        const images = [...new Set([
          ...json.flatMap((item) => [item.image, item.images, item.contentUrl]).flat(Infinity),
          ...[...document.querySelectorAll('img')].map((image) => image.currentSrc || image.src || image.getAttribute('data-lazy-src') || image.getAttribute('data-src') || image.getAttribute('data-original'))
        ].map(normalize).filter((src) => /^https?:/.test(src) && !/logo|avatar|icon|qr/i.test(src)))].slice(0, 40);
        const descriptionNode = document.querySelector('#desc-lazyload-container, [data-module-name*=description i], [class*=description i], [data-spm*=desc i], [id*=detail i]');
        const pairMap = new Map();
        const addPair = (name, value) => { const key = clean(name).replace(/[：:]$/, ''); const val = clean(value); if (key && val && key !== val && key.length < 100 && val.length < 500) pairMap.set(`${key}\u0000${val}`, { name: key, value: val, source: 'detail-dom' }); };
        for (const row of document.querySelectorAll('tr')) { const cells = [...row.querySelectorAll('th,td')].map((node) => clean(node.innerText || node.textContent)).filter(Boolean); if (cells.length >= 2) addPair(cells[0], cells.slice(1).join(' / ')); }
        for (const node of document.querySelectorAll('[class*=attribute i] li, [class*=props i] li, [class*=parameter i] li, [class*=property i] li')) { const match = clean(node.innerText || node.textContent).match(/^([^：:]{1,100})\s*[：:]\s*(.{1,500})$/); if (match) addPair(match[1], match[2]); }
        const attributes = [...pairMap.values()].slice(0, 120);
        const priceValues = [meta('product:price:amount'), ...json.flatMap((item) => [item.price, item.lowPrice, item.minPrice, item.offers?.price]).flat(Infinity), ...(bodyText.match(/[¥￥$]\s*[\d,]+(?:\.\d+)?/g) || [])].map((value) => clean(value).replace(/^[^\d]*/, '').replace(/,/g, '')).filter((value) => /^\d+(?:\.\d+)?$/.test(value));
        const price = priceValues[0] || '';
        const priceTiers = [];
        for (const node of document.querySelectorAll('tr,li,[class*=price i],[class*=ladder i]')) { const text = clean(node.innerText || node.textContent); const amount = text.match(/[¥￥$]\s*([\d,]+(?:\.\d+)?)/)?.[1]; if (!amount) continue; const numbers = [...text.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n > 0); const value = Number(amount.replace(/,/g, '')); const quantities = numbers.filter((n) => n !== value); const tier = { price: value.toFixed(2), minQuantity: quantities[0] || 1, maxQuantity: quantities[1] || null, currencySymbol: text.includes('$') ? '$' : '¥' }; if (value > 0 && !priceTiers.some((item) => item.price === tier.price && item.minQuantity === tier.minQuantity)) priceTiers.push(tier); }
        const variantMap = new Map();
        const addVariant = (name, values) => { const key = clean(name); const options = [...new Set(values.map(clean).filter((value) => value && value.length < 120))]; if (!key || !options.length) return; const current = variantMap.get(key) || { name: key, options: [], optionImages: {}, source: 'detail-dom' }; current.options = [...new Set([...current.options, ...options])].slice(0, 100); variantMap.set(key, current); };
        for (const select of document.querySelectorAll('select')) addVariant(select.getAttribute('name') || select.getAttribute('aria-label') || 'Specification', [...select.options].map((option) => option.textContent));
        const variantGroups = [...variantMap.values()];
        const skus = [...document.querySelectorAll('[class*=sku i] tr, [class*=sku i] li, [data-sku-id]')].map((node) => { const text = clean(node.innerText || node.textContent); const price = text.match(/[¥￥$]\s*([\d,]+(?:\.\d+)?)/)?.[1]?.replace(/,/g, ''); const stock = text.match(/(?:库存|stock|quantity)\s*[:：]?\s*(\d+)/i)?.[1]; return text ? { id: node.getAttribute('data-sku-id') || node.getAttribute('data-id') || '', name: text.slice(0, 300), ...(price ? { price } : {}), ...(stock ? { stock: Number(stock) } : {}), source: 'detail-dom' } : null; }).filter(Boolean).slice(0, 200);
        const categoryPath = [...document.querySelectorAll('nav a, [class*=breadcrumb i] a, [class*=category i] a')].map((node) => clean(node.innerText || node.textContent)).filter((value) => value && value.length < 100).filter((value, index, all) => all.indexOf(value) === index).slice(-8);
        const videoUrl = normalize(document.querySelector('video[src], video source[src], [data-video-url]')?.src || document.querySelector('[data-video-url]')?.getAttribute('data-video-url') || '');
        const packagingText = attributes.map((item) => `${item.name}:${item.value}`).join(' ');
        const weightMatch = packagingText.match(/(?:毛重|重量|包装重量|gross weight|weight)\s*[:：]?\s*([\d.]+)\s*(kg|公斤|千克|g|克)?/i);
        const sizeMatch = packagingText.match(/(?:包装尺寸|单个包装尺寸|package size|尺寸)\s*[:：]?\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)/i);
        const packaging = { ...(sizeMatch ? { length: sizeMatch[1], width: sizeMatch[2], height: sizeMatch[3] } : {}), ...(weightMatch ? { weight: Number(weightMatch[1]) * (/^(?:g|克)$/i.test(weightMatch[2] || '') ? 0.001 : 1) } : {}) };
        const keywords = clean(meta('keywords')).split(/[,，;；]/).map(clean).filter(Boolean).slice(0, 30);
        return {
          title: meta('og:title') || document.querySelector('h1')?.textContent || document.title,
          image: normalize(meta('og:image')) || images[0] || '', images,
          price,
          priceTiers, description: clean(descriptionNode?.innerText || '').slice(0, 20000), descriptionHtml: descriptionNode?.innerHTML?.slice(0, 90000) || '',
          attributes, variantGroups, skus, categoryPath, videoUrl, packaging, keywords
        };
      });
      const mergedImages = [...new Set([base.mainImage, ...(base.images || []), detail.image, ...(detail.images || [])].filter(Boolean))].slice(0, 40);
      return {
        ...base,
        sourceTitle: usefulProductTitle(detail.title) || base.sourceTitle,
        title: usefulProductTitle(detail.title) || base.title,
        mainImage: base.mainImage || detail.image || detail.images[0] || '',
        images: mergedImages, mainImages: mergedImages.slice(0, 6), detailImages: mergedImages.slice(6),
        sourcePrice: detail.price || base.sourcePrice,
        price: detail.price || base.price,
        ...(detail.priceTiers?.length ? { sourcePriceTiers: detail.priceTiers, priceTiers: detail.priceTiers, priceMode: 'quantity-tier' } : {}),
        description: detail.description || base.description || '', descriptionHtml: detail.descriptionHtml || base.descriptionHtml || '',
        attributes: detail.attributes?.length ? detail.attributes : (base.attributes || []), variantGroups: detail.variantGroups?.length ? detail.variantGroups : (base.variantGroups || []), skus: detail.skus?.length ? detail.skus : (base.skus || []),
        ...(detail.categoryPath?.length ? { sourceCategoryPath: detail.categoryPath, categoryPath: detail.categoryPath } : {}), ...(detail.videoUrl ? { videoUrl: detail.videoUrl } : {}), ...(Object.keys(detail.packaging || {}).length ? { packaging: { ...(base.packaging || {}), ...detail.packaging } } : {}), ...(detail.keywords?.length ? { keywords: detail.keywords } : {})
      };
    } catch (error) {
      return { ...base, collectWarning: error.message };
    }
  }
}
