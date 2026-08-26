import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { load } from 'cheerio';
import { hidePage, launchPersistent, revealPage, settlePage, waitForHumanVerification } from './browser-runtime.js';
import { SOURCE_LANGUAGE_HEADERS, withSourceLocale } from './source-locale.js';

const WORKBENCH_URL = 'https://i.alibaba.com/';
const TITLE_SELECTORS = [
  'input[name="productTitle"]',
  'input[placeholder*="商品标题"]', 'input[placeholder*="标题"]',
  'input[placeholder*="product title" i]', 'input[placeholder*="product name" i]',
  'input[placeholder*="enter a title" i]', 'input[name*="title" i]',
  'textarea[placeholder*="标题"]', 'textarea[placeholder*="title" i]'
];

const PROMOTIONAL_TEXT = /(?:Alibaba\s*Lens|免费比价插件|寻找价格更低|相似商品|省时又省钱|下载扩展程序|Accio\s*Work|报告可疑活动|report suspicious activity|find similar products)/i;

export function isPromotionalText(value) {
  return PROMOTIONAL_TEXT.test(String(value || '').replace(/\s+/g, ' ').trim());
}

export function sanitizeCategoryPath(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter((value) => value && value.length < 120 && !isPromotionalText(value)))];
}

export function sanitizeCollectedProduct(product) {
  const categoryPath = sanitizeCategoryPath(product.sourceCategoryPath || product.categoryPath);
  const productType = isPromotionalText(product.productType)
    ? (categoryPath.at(-1) || '')
    : String(product.productType || '').trim();
  const keywords = (Array.isArray(product.keywords) ? product.keywords : []).filter((value) => !isPromotionalText(value));
  const subtitle = isPromotionalText(product.subtitle) ? '' : product.subtitle;
  const description = String(product.description || '').replace(/供应商的产品说明\s*报告可疑活动/gi, '').trim();
  return { ...product, ...(categoryPath.length ? { sourceCategoryPath: categoryPath } : {}), productType, keywords, subtitle, description };
}

const CATEGORY_LEAF_ALIASES = new Map([
  ['drones accessories', 'drones accessories'], ['无人机配件', 'drones accessories'],
  ['camera photo accessories', 'camera photo accessories'], ['相机照片配件', 'camera photo accessories'],
  ['other consumer electronics', 'other consumer electronics'], ['其他消费电子产品', 'other consumer electronics'],
  ['rugged phone', 'rugged phone'], ['坚固型手机', 'rugged phone'],
  ['motor controllers', 'motor controllers'], ['motor controller', 'motor controllers'], ['电机控制器', 'motor controllers']
]);

export function canonicalCategoryLeaf(value) {
  const normalized = String(value || '').toLowerCase().replace(/[,&._-]/g, ' ').replace(/\s+/g, ' ').trim();
  return CATEGORY_LEAF_ALIASES.get(normalized) || normalized;
}

export function parseDeliveryTiers(deliveryTime) {
  if (!Array.isArray(deliveryTime) || deliveryTime.length < 2) return [];
  const quantityRow = Array.isArray(deliveryTime[0]) ? deliveryTime[0].slice(1) : [];
  const leadRow = Array.isArray(deliveryTime[1]) ? deliveryTime[1].slice(1) : [];
  return quantityRow.map((range, index) => {
    const text = String(range || '').replace(/\s+/g, ' ').trim();
    const upperMatch = text.match(/(?:^|[-–])\s*(\d+)\s*$/);
    const upperQuantity = upperMatch ? Number(upperMatch[1]) : null;
    const leadText = String(leadRow[index] || '').replace(/\s+/g, ' ').trim();
    const leadDays = leadText.match(/\d+(?:\.\d+)?/)?.[0] || '';
    return { range: text, upperQuantity, leadText, leadDays };
  }).filter((tier) => tier.range || tier.leadText);
}

export function isAlibabaInternationalUrl(value) {
  try { return /(^|\.)alibaba\.com$/i.test(new URL(value).hostname); } catch { return false; }
}

export function isProductPostingUrl(value) {
  try {
    const url = new URL(value);
    return /(?:^|-)productposting\.alibaba\.com$/i.test(url.hostname)
      || /^post\.alibaba\.com$/i.test(url.hostname);
  } catch { return false; }
}

export function categoryMismatchMessage(product, category) {
  const title = product?.title || '';
  const targetPath = sanitizeCategoryPath(product?.categoryPath);
  const sourcePath = sanitizeCategoryPath(product?.sourceCategoryPath);
  const expectedPath = targetPath.length ? targetPath : sourcePath;
  const actualPath = String(category || '').split(/\s*(?:>>|>|\/|\\)\s*/).map((value) => value.trim()).filter(Boolean);
  if (expectedPath.length && actualPath.length) {
    const expectedLeaf = canonicalCategoryLeaf(expectedPath.at(-1));
    const actualLeaf = canonicalCategoryLeaf(actualPath.at(-1));
    if (expectedLeaf && actualLeaf && expectedLeaf !== actualLeaf) {
      return `当前发布类目“${category}”与商品目标类目“${expectedPath.join(' >> ')}”不一致，请绑定目标类目的国际站发布表单`;
    }
  }
  const electronics = /\b(phone|smartphone|mobile|tablet|pad)\b/i.test(title);
  const serviceCategory = /商务服务|认证、检验|检验和质量控制|business service|inspection service/i.test(category || '');
  if (electronics && serviceCategory) {
    return `当前发布类目“${category}”与手机/平板商品不匹配，请先切换到对应电子产品类目`;
  }
  const sourceCategory = `${product?.productType || ''} ${(product?.sourceCategoryPath || []).join(' ')}`;
  const motorProduct = /motor controllers?|brushless.*motor|电机控制器|无刷.*电机/i.test(`${title} ${sourceCategory}`);
  const consumerElectronics = /消费电子|consumer electronics/i.test(category || '');
  if (motorProduct && consumerElectronics) {
    return `当前发布类目“${category}”与电机控制器商品不匹配，请绑定 Power Transmission > Motors > Motor Controllers 类目发布页`;
  }
  return '';
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      if (await locator.isVisible().catch(() => false)) return locator;
    }
  }
  return null;
}

async function waitForFirstVisible(page, selectors, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const locator = await firstVisible(page, selectors);
    if (locator) return locator;
    await page.waitForTimeout(300);
  }
  return null;
}

async function firstVisibleByText(page, text, exact = true) {
  const candidates = page.getByText(text, { exact });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function fillFirst(page, selectors, value) {
  if (value === undefined || value === null || value === '') return false;
  const locator = await firstVisible(page, selectors);
  if (!locator) return false;
  await locator.fill(String(value));
  return true;
}

async function fillAndVerify(locator, value, fieldName) {
  const expected = String(value ?? '').trim();
  await locator.fill(expected);
  await locator.press('Tab').catch(() => {});
  await locator.page().waitForTimeout(150);
  let actual = (await locator.inputValue().catch(() => '')).trim();
  if (actual !== expected) {
    await locator.evaluate((node, nextValue) => {
      const prototype = node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(node, nextValue);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.blur();
    }, expected);
    await locator.page().waitForTimeout(150);
    actual = (await locator.inputValue().catch(() => '')).trim();
  }
  if (actual !== expected) throw new Error(`${fieldName}写入失败，国际站输入框未保留内容`);
}

async function commitControlledInput(locator, value) {
  const expected = String(value ?? '').trim();
  await locator.evaluate((node, nextValue) => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(node, nextValue);
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.blur();
  }, expected).catch(() => {});
}

function compactText(value, limit = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function visibleFeedback(page) {
  const selectors = [
    '[role="alert"]', '.next-message', '.next-notice', '.next-feedback',
    '.next-balloon', '.next-dialog', '[class*="toast"]', '[class*="message"]',
    '[class*="error"]', '[class*="invalid"]', '[class*="feedback"]'
  ];
  const messages = [];
  for (const selector of selectors) {
    const nodes = page.locator(selector);
    const count = Math.min(await nodes.count().catch(() => 0), 20);
    for (let index = 0; index < count; index += 1) {
      const node = nodes.nth(index);
      if (!await node.isVisible().catch(() => false)) continue;
      const text = compactText(await node.innerText().catch(() => ''));
      if (text && !messages.includes(text)) messages.push(text);
    }
  }
  return messages;
}

async function currentFormDiagnostics(page) {
  const main = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const snapshot = (node, levels = 3) => {
      const ancestors = [];
      let current = node;
      for (let level = 0; current && level < levels; level += 1, current = current.parentElement) {
        ancestors.push({
          tag: current.tagName,
          id: current.id || '',
          className: String(current.className || '').slice(0, 250),
          text: clean(current.innerText).slice(0, 800),
          html: current.outerHTML.slice(0, 8000)
        });
      }
      return ancestors;
    };
    const colorInputs = [...document.querySelectorAll('[role="colorCombobox"]')].map((node) => ({
      visible: visible(node), value: node.value || '', ancestors: snapshot(node, 5)
    }));
    const colorSpecContainers = [...document.querySelectorAll('.posting-feild-color-item-container, [class*="color"]')]
      .filter((node) => /color|颜色/i.test(String(node.className || '') + ' ' + clean(node.innerText || '')))
      .slice(0, 12).map((node) => ({ visible: visible(node), text: clean(node.innerText).slice(0, 500), html: node.outerHTML.slice(0, 5000) }));
    const textareas = [...document.querySelectorAll('textarea')].map((node) => ({
      id: node.id || '', name: node.name || '', visible: visible(node), valueLength: node.value?.length || 0,
      className: String(node.className || '').slice(0, 250), html: node.outerHTML.slice(0, 2500)
    })).filter((item) => item.id || item.name || item.valueLength);
    const iframes = [...document.querySelectorAll('iframe')].map((node) => ({
      id: node.id || '', name: node.name || '', src: node.src || '', visible: visible(node),
      parent: snapshot(node.parentElement, 2)
    }));
    const fileInputs = [...document.querySelectorAll('input[type="file"]')].map((node) => ({
      accept: node.getAttribute('accept') || '', multiple: node.hasAttribute('multiple'), visible: visible(node),
      html: node.outerHTML.slice(0, 2500), ancestors: snapshot(node, 4)
    }));
    const overlays = [...document.querySelectorAll('[role="dialog"], .mce-window, .next-dialog, .next-overlay-inner, [class*="modal"]')]
      .filter(visible).map((node) => ({ text: clean(node.innerText).slice(0, 2000), html: node.outerHTML.slice(0, 12000) }))
      .filter((item) => item.text).slice(0, 20);
    const ordinaryLabels = [...document.querySelectorAll('label,span,div')]
      .filter((node) => clean(node.textContent) === '普通编辑')
      .map((node) => snapshot(node, 5));
    const errors = [...document.querySelectorAll('[class*="error"], [class*="invalid"], [class*="feedback"]')]
      .filter(visible).map((node) => ({ text: clean(node.innerText).slice(0, 1000), html: node.outerHTML.slice(0, 5000) }))
      .filter((item) => item.text).slice(0, 20);
    const editors = [...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])]
      .filter((editor, index, all) => editor && all.indexOf(editor) === index)
      .map((editor) => ({ id: editor.id || '', hidden: Boolean(editor.hidden), contentLength: editor.getContent?.().length || 0 }));
    return { colorInputs, colorSpecContainers, textareas, iframes, fileInputs, overlays, ordinaryLabels, errors, editors };
  });
  main.frameBodies = [];
  for (const frame of page.frames()) {
    const body = frame.locator('body');
    main.frameBodies.push({
      url: frame.url(),
      className: await body.getAttribute('class').catch(() => ''),
      contentEditable: await body.getAttribute('contenteditable').catch(() => ''),
      htmlLength: (await body.innerHTML().catch(() => '')).length,
      text: compactText(await body.innerText().catch(() => ''), 500)
    });
  }
  return main;
}

async function waitForActionResult(page, action, mode, originalUrl) {
  const responses = [];
  const onResponse = (response) => {
    const request = response.request();
    if (!['POST', 'PUT', 'PATCH'].includes(request.method())) return;
    responses.push({ url: response.url(), status: response.status() });
  };
  page.on('response', onResponse);
  try {
    await action.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await waitForHumanVerification(page, { timeout: 300000 });
      await page.waitForTimeout(400);
      const url = page.url();
      const feedback = await visibleFeedback(page);
      const combined = feedback.join(' ');
      const blockingFeedback = /报错反馈|错误项|必填项.*不能为空|请上传相关产品图片|请不要输入如下非英文字符|required|invalid/i.test(combined);
      const succeeded = mode === 'submit'
        ? /发布成功|提交成功|审核中|successfully\s+(?:submitted|published)|submitted successfully/i.test(combined)
        : /保存成功|草稿.*成功|已保存|successfully\s+saved|saved successfully/i.test(combined);
      if (succeeded && mode === 'submit' && blockingFeedback) {
        // Alibaba can show a generic success-like toast while the quality
        // panel still contains blocking errors. Never report a public publish
        // as successful in that state.
        continue;
      }
      if (succeeded) return { verifiedBy: 'feedback', feedback, responses };
      if (url !== originalUrl && !/\/product\/publish\.htm/i.test(new URL(url).pathname)) {
        return { verifiedBy: 'navigation', feedback, responses };
      }
    }
    const feedback = await visibleFeedback(page);
    const relevant = feedback
      .filter((text) => /必填|不能为空|请填写|请上传|请不要输入|非英文|至少|错误|失败|error|required/i.test(text))
      .sort((left, right) => left.length - right.length);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const errorPanel = bodyText.match(/报错反馈[\s\S]{0,1200}/)?.[0]
      ?.split(/商品质量助手|基本信息|当前商品类型/)[0]
      ?.replace(/\s+/g, ' ')
      ?.trim() || '';
    const detail = relevant.slice(0, 8).join('；') || errorPanel || feedback[0] || '';
    throw new Error(`${mode === 'submit' ? '提交' : '保存草稿'}后未检测到国际站成功反馈${detail ? `：${detail}` : ''}`);
  } finally {
    page.off('response', onResponse);
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

const ATTRIBUTE_NAME_TRANSLATIONS = new Map(Object.entries({
  '防护等级': 'Protection Level',
  '电池容量': 'Battery Capacity',
  '屏幕': 'Screen Size',
  '蜂窝网络': 'Cellular Network',
  'gps': 'GPS',
  '操作系统': 'Operating System',
  '处理器型号': 'Processor Model',
  '手机中央处理器': 'CPU',
  '快速充电': 'Fast Charging',
  '显示类型': 'Display Type',
  '屏幕 resolution': 'Screen Resolution',
  '屏幕刷新率': 'Screen Refresh Rate',
  '后置摄像头': 'Rear Camera',
  '前置摄像头': 'Front Camera',
  '品牌名称': 'Brand Name',
  '操作语言': 'Operating Languages',
  '功能/特性': 'Features',
  '产地': 'Place of Origin',
  '型号': 'Model Number',
  '定制包装': 'Custom Packaging MOQ',
  '销售单位': 'Selling Unit',
  '单个包装尺寸': 'Single Package Size',
  '单个产品毛重': 'Single Gross Weight',
  '颜色': 'Color',
  '运行内存': 'RAM',
  '存储容量': 'Storage Capacity'
}));

const TEXT_TRANSLATIONS = [
  ['联发科天玑', 'MediaTek Dimensity '], ['联发科', 'MediaTek '],
  ['北斗', 'BeiDou'], ['伽利略', 'Galileo'], ['荷兰语', 'Dutch'], ['英文', 'English'],
  ['法式', 'French'], ['法语', 'French'], ['德语', 'German'], ['西班牙语', 'Spanish'],
  ['葡萄牙语', 'Portuguese'], ['意大利语', 'Italian'], ['俄语', 'Russian'], ['阿拉伯语', 'Arabic'],
  ['八核', 'Octa Core'], ['四核', 'Quad Core'], ['防水', 'Waterproof'], ['防尘', 'Dustproof'],
  ['防震', 'Shockproof'], ['是', 'Yes'], ['否', 'No'], ['单个商品', 'Single item'],
  ['黑色', 'Black'], ['白色', 'White'], ['蓝色', 'Blue'], ['绿色', 'Green'], ['橙色', 'Orange'],
  ['红色', 'Red'], ['黄色', 'Yellow'], ['紫色', 'Purple'], ['银色', 'Silver'], ['灰色', 'Gray'],
  ['内置投影仪', 'Built in Projector'], ['厘米', 'cm'], ['公斤', 'kg'], ['毫安时', 'mAh'],
  ['瓦', 'W'], ['英寸', 'inch'], ['像素', 'MP'], ['光固化', '']
];

function englishSpecText(value, fallback = '') {
  let translated = String(value || '');
  for (const [source, target] of TEXT_TRANSLATIONS) translated = translated.replaceAll(source, target);
  translated = translated
    .replace(/[，、]/g, ', ')
    .replace(/[×]/g, ' x ')
    .replace(/[：]/g, ': ')
    .replace(/[\u3400-\u9fff]/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
  return /[A-Za-z0-9]/.test(translated) ? translated : fallback;
}

function englishAttributeName(name, index) {
  const exact = ATTRIBUTE_NAME_TRANSLATIONS.get(String(name || '').trim());
  return exact || englishSpecText(name, `Specification ${index + 1}`);
}

function englishDescriptionText(value) {
  const source = String(value || '').trim();
  if (!source || /^(?:供应商的产品说明|产品描述|商品描述|supplier product description)$/i.test(source)) return '';
  return englishSpecText(source, '');
}

export function sanitizeSourceDescriptionHtml(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const $ = load(`<body>${source}</body>`, null, false);
  $('script,style,form,input,button,iframe,object,embed,noscript').remove();
  $('*').each((_, node) => {
    const element = $(node);
    for (const name of Object.keys(node.attribs || {})) {
      if (/^on/i.test(name) || ['id', 'class', 'data-spm', 'contenteditable'].includes(name)) element.removeAttr(name);
    }
    const ownText = element.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    if (/\b(?:contact us|company profile|company information|about us|our factory|supplier information)\b/i.test(ownText)
      || /(?:whats?app|wechat|skype|e-?mail|tel(?:ephone)?)[\s:：]*[+\w@.-]{4,}/i.test(ownText)) {
      const tagName = String(node.tagName || node.name || '').toUpperCase();
      if (!['BODY', 'HTML'].includes(tagName)) element.remove();
      return;
    }
    element.contents().filter((__, child) => child.type === 'text').each((__, child) => {
      const translated = englishDescriptionText(child.data);
      child.data = translated ? ` ${translated} ` : '';
    });
  });
  $('a').each((_, node) => {
    const element = $(node);
    element.removeAttr('href').removeAttr('target').removeAttr('rel');
  });
  $('img').each((_, node) => {
    const element = $(node);
    element.removeAttr('srcset').removeAttr('data-spm-anchor-id').attr('alt', englishSpecText(element.attr('alt'), 'Product detail'));
  });
  return $.root().html()?.trim() || '';
}

export function buildLegacyDescriptionHtml(product) {
  const attributes = (product.attributes || []).slice(0, 24).map((item, index) => ({
    name: englishAttributeName(item.name, index),
    value: englishSpecText(item.value, 'See product images')
  }));
  const description = englishDescriptionText(product.description);
  const title = englishSpecText(product.title, 'Product Description');
  // Source HTML often contains stale CDN placeholders that Alibaba's editor
  // marks as expired. Detail images are uploaded separately below, so keep
  // the source text/layout but omit remote image tags from the publish copy.
  const sourceHtml = sanitizeSourceDescriptionHtml(product.descriptionHtml).replace(/<img\b[^>]*>/gi, '');
  return [
    `<h2>${escapeHtml(title)}</h2>`,
    description ? `<p>${escapeHtml(description).replace(/\n/g, '<br>')}</p>` : '',
    sourceHtml,
    product.videoUrl ? `<p><strong>Product Video:</strong> <a href="${escapeHtml(product.videoUrl)}" target="_blank" rel="noopener">View source product video</a></p>` : '',
    (product.variantGroups || []).length ? `<h3>Available Specifications</h3><table style="width:100%;border-collapse:collapse">${product.variantGroups.map((group, index) => `<tr><td style="border:1px solid #ddd;padding:8px"><strong>${escapeHtml(englishAttributeName(group.name, index))}</strong></td><td style="border:1px solid #ddd;padding:8px">${escapeHtml((group.options || []).map((option) => englishSpecText(option, 'Option')).join(', '))}</td></tr>`).join('')}</table>` : '',
    attributes.length ? `<table style="width:100%;border-collapse:collapse">${attributes.map((item) => `<tr><td style="border:1px solid #ddd;padding:8px"><strong>${escapeHtml(item.name)}</strong></td><td style="border:1px solid #ddd;padding:8px">${escapeHtml(item.value)}</td></tr>`).join('')}</table>` : ''
  ].filter(Boolean).join('');
}

export function sourceDetailHasBrokenImages(value) {
  const html = String(value || '');
  return /(?:src|data-src)\s*=\s*["'](?:about:blank|data:image\/gif;base64,R0lGODlhAQABA)["']/i.test(html)
    || /(?:broken|失效|image\s+not\s+found|图片.*失效)/i.test(html);
}

function attributeValue(product, ...names) {
  const wanted = names.map((name) => name.toLowerCase());
  return (product.attributes || []).find((item) => wanted.includes(String(item.name || '').toLowerCase()))?.value || '';
}

export function hasCompleteSourceData(product) {
  return (product.mainImages || product.images || []).length >= 4
    && (product.detailImages || []).length >= 1
    && (product.attributes || []).length >= 2
    && Boolean(product.origin);
}

export function validateProductData(product) {
  const errors = [];
  const mainImages = product.mainImages || product.images || [];
  if (!String(product.title || '').trim()) errors.push('缺少商品标题');
  if (numericValue(product.price) <= 0) errors.push('销售价格无效');
  if (mainImages.length < 4) errors.push(`主图不足 4 张（当前 ${mainImages.length} 张）`);
  if (!(product.detailImages || []).length) errors.push('缺少详情图片');
  if (sourceDetailHasBrokenImages(product.descriptionHtml)) errors.push('详情描述包含失效图片，请先清理后再发布');
  if ((product.attributes || []).length < 2) errors.push('商品属性不足 2 项');
  if (!String(product.origin || '').trim()) errors.push('缺少产地');
  if (!product.packaging || numericValue(product.packaging.weight) <= 0) errors.push('缺少包装重量');
  if ((product.variantGroups || []).length && !(product.skus || []).length) errors.push('存在产品规格但缺少 SKU 明细');
  if ((product.skus || []).some((sku) => numericValue(sku.price) <= 0 || numericValue(sku.stock) < 0)) errors.push('SKU 价格或库存无效');
  if (!String(product.description || product.descriptionHtml || '').trim()) errors.push('缺少商品详情');
  const tiers = canonicalizePriceTiers(product.priceTiers || []);
  if (product.priceTiers) product.priceTiers = tiers;
  if (tiers.some((tier) => numericValue(tier.price) <= 0 || numericValue(tier.minQuantity) <= 0)) {
    errors.push('阶梯价格或起订量无效');
  }
  for (let index = 1; index < tiers.length; index += 1) {
    if (numericValue(tiers[index].minQuantity) <= numericValue(tiers[index - 1].minQuantity)) {
      errors.push('阶梯价起订量必须递增');
      break;
    }
  }
  return errors;
}

export function canonicalizePriceTiers(tiers) {
  const byMinimum = new Map();
  for (const tier of Array.isArray(tiers) ? tiers : []) {
    const minQuantity = numericValue(tier.minQuantity);
    const price = numericValue(tier.price);
    if (!minQuantity || !price || byMinimum.has(minQuantity)) continue;
    byMinimum.set(minQuantity, {
      ...tier,
      minQuantity,
      maxQuantity: tier.maxQuantity == null || tier.maxQuantity === '' ? null : numericValue(tier.maxQuantity),
      price: price.toFixed(2)
    });
  }
  return [...byMinimum.values()].sort((a, b) => a.minQuantity - b.minQuantity);
}

function numericValue(value) {
  const number = Number(String(value ?? '').replace(/,/g, '').match(/[\d.]+/)?.[0] || 0);
  return Number.isFinite(number) ? number : 0;
}

export function parsePriceTiers(text) {
  const tiers = [];
  const pattern = /(US\s*\$|[$¥￥])\s*([\d,]+(?:\.\d{1,2})?)\s*(?:(\d[\d,]*)\s*[-–~]\s*(\d[\d,]*)|[≥>]\s*(\d[\d,]*))\s*(?:pieces?|sets?|boxes?|units?|pairs?|meters?|kilograms?|tons?|cartons?|bags?|packs?|件|套|箱|个|对|米|公斤|吨|包)/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    const minQuantity = Number(String(match[3] || match[5] || '1').replace(/,/g, ''));
    const maxQuantity = match[4] ? Number(match[4].replace(/,/g, '')) : null;
    const price = Number(match[2].replace(/,/g, ''));
    if (!price || !minQuantity) continue;
    tiers.push({
      price: price.toFixed(2),
      minQuantity,
      maxQuantity,
      currencySymbol: /\$/.test(match[1]) ? '$' : '¥'
    });
  }
  return canonicalizePriceTiers(tiers);
}

export function normalizePriceTiers(tiers, basePrice, baseCurrencySymbol = '$') {
  if (!tiers.length) return [];
  const normalizedBase = numericValue(basePrice);
  const sourceCurrency = tiers[0].currencySymbol || baseCurrencySymbol;
  const canonical = canonicalizePriceTiers(tiers);
  if (!normalizedBase || sourceCurrency === baseCurrencySymbol) {
    return canonical.map((tier) => ({ ...tier, currencySymbol: sourceCurrency }));
  }
  const anchor = numericValue(canonical.at(-1)?.price);
  if (!anchor) return [];
  const factor = normalizedBase / anchor;
  if (!Number.isFinite(factor) || factor <= 0) return [];
  return canonical.map((tier) => ({
    ...tier,
    sourcePrice: tier.price,
    sourceCurrencySymbol: sourceCurrency,
    price: (numericValue(tier.price) * factor).toFixed(2),
    currencySymbol: baseCurrencySymbol,
    currencyNormalized: true
  }));
}

export function buildSkuCombinations(groups, price, stock) {
  const normalized = (groups || []).map((group) => ({
    name: String(group.name || '').trim(),
    options: [...new Set((group.options || []).map((option) => String(option || '').trim()).filter(Boolean))],
    optionImages: group.optionImages || {}
  })).filter((group) => group.name && group.options.length);
  if (!normalized.length) return [];
  let combinations = [{ attributes: {} }];
  for (const group of normalized) {
    combinations = combinations.flatMap((combination) => group.options.map((option) => ({
      attributes: { ...combination.attributes, [group.name]: option }
    })));
  }
  return combinations.map((combination, index) => ({
    id: `sku-${index + 1}`,
    ...combination,
    name: Object.values(combination.attributes).join(' / '),
    price: String(price || ''),
    stock: Number(stock || 0),
    code: '',
    image: normalized.map((group) => group.optionImages?.[combination.attributes[group.name]]).find(Boolean) || '',
    source: 'derived',
    derived: true,
    evidence: { method: 'cartesian-product', fields: ['price', 'stock'] }
  }));
}

async function fieldByLabel(page, label) {
  const token = `codex-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const found = await page.evaluate(({ labelText, marker }) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const labels = [...document.querySelectorAll('label,div,span,h3,h4')]
      .filter((node) => clean(node.textContent) === labelText);
    for (const labelNode of labels) {
      let container = labelNode;
      for (let level = 0; container && level < 7; level += 1, container = container.parentElement) {
        const input = [...container.querySelectorAll('input:not([type="hidden"]),textarea,[contenteditable="true"]')].find(visible);
        if (!input) continue;
        input.setAttribute('data-codex-field', marker);
        return true;
      }
    }
    return false;
  }, { labelText: label, marker: token });
  return found ? page.locator(`[data-codex-field="${token}"]`) : null;
}

async function fieldByAnyLabel(page, labels) {
  for (const label of labels.filter(Boolean)) {
    const field = await fieldByLabel(page, label);
    if (field) return field;
  }
  return null;
}

async function fillChoice(page, locator, value) {
  if (!locator || !value) return false;
  await locator.click().catch(() => {});
  await locator.fill(String(value)).catch(() => {});
  await page.waitForTimeout(350);
  const exactOption = page.getByText(String(value), { exact: true }).last();
  if (await exactOption.isVisible().catch(() => false)) await exactOption.click().catch(() => {});
  else {
    await locator.press('ArrowDown').catch(() => {});
    await locator.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(250);
  return true;
}

async function fillColorSpec(page, values) {
  const colors = [...new Set((values || []).map((value) => englishSpecText(value)).filter(Boolean))];
  if (!colors.length) return false;
  const colorRows = () => page.locator('.posting-feild-color-item');
  // Do not fall back to generic "please enter or select" inputs here. The
  // publish form contains hidden autocomplete templates and unrelated
  // attribute inputs with the same placeholder; treating those as color
  // controls caused valid products in categories without a color field to
  // fail before submission.
  const colorInputSelector = [
    '.posting-field-color-select input[role="colorCombobox"]',
    '.posting-feild-color-select input[role="colorCombobox"]',
    '.posting-feild-color-item input[role="colorCombobox"]',
    '.posting-feild-color-item-container input[role="colorCombobox"]',
    '.posting-field-color-select input[placeholder*="请输入"]',
    '.posting-feild-color-select input[placeholder*="请输入"]',
    '.posting-feild-color-item input[placeholder*="请输入"]',
    '.posting-feild-color-item-container input[placeholder*="请输入"]'
  ].join(', ');
  const selectedColors = async () => page.locator('.posting-feild-color-item input[role="colorCombobox"], .posting-feild-color-item-container input[role="colorCombobox"], .posting-field-color-select input[role="colorCombobox"], .posting-feild-color-select input[role="colorCombobox"]').evaluateAll((nodes) => nodes
    .map((node) => String(node.value || '').replace(/\s+/g, ' ').trim()).filter(Boolean)).catch(() => []);
  const removeEmptyColorRows = async () => {
    const rows = colorRows();
    const count = await rows.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const row = rows.nth(index);
      const label = String(await row.locator('.next-sr-only').innerText().catch(() => '')).trim();
      const inputValue = String(await row.locator('input').inputValue().catch(() => '')).trim();
      if (label || inputValue) continue;
      const remove = row.locator('button, [role="button"], [class*="delete"], [class*="remove"]').last();
      if (await remove.isVisible().catch(() => false)) await remove.click({ force: true }).catch(() => {});
    }
  };
  const colorInput = await firstVisible(page, [colorInputSelector]);
  if (!colorInput) return false;
  for (const color of colors) {
    if ((await selectedColors()).some((item) => item.trim().toLowerCase() === color.toLowerCase())) continue;
    const inputs = page.locator(colorInputSelector);
    let input = null;
    for (let inputIndex = 0; inputIndex < await inputs.count().catch(() => 0); inputIndex += 1) {
      const candidate = inputs.nth(inputIndex);
      if (await candidate.isVisible().catch(() => false) && !(await candidate.inputValue().catch(() => ''))) { input = candidate; break; }
    }
    if (!input) break;
    await input.click({ force: true });
    await input.fill(color);
    await page.waitForTimeout(500);
    // The international form renders the suggestion as a plain list item on
    // some categories (without role="option"). Prefer the last visible exact
    // match so we commit the suggestion instead of leaving raw text in the
    // combobox, which later produces “颜色规格未成功添加”.
    let committed = false;
    const option = page.getByRole('option', { name: color, exact: true }).last();
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true }).catch(() => {});
      committed = true;
    } else {
      committed = await page.evaluate((expected) => {
        const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
        const candidates = [...document.querySelectorAll('li, [role="option"], [class*="menu-item"], [class*="option-item"], [class*="select-option"]')]
          .filter((node) => visible(node) && String(node.textContent || '').replace(/\s+/g, ' ').trim() === expected);
        const target = candidates.at(-1);
        if (!target) return false;
        target.click();
        return true;
      }, color).catch(() => false);
    }
    // Always send the keyboard confirmation as well. Alibaba's autocomplete
    // keeps the typed text in the input when a mouse click hits the label span
    // instead of the option controller; ArrowDown+Enter commits the value in
    // that implementation and is idempotent after a successful mouse click.
    await input.press('ArrowDown').catch(() => {});
    await input.press('Enter').catch(() => {});
    // Some Alibaba categories render the suggestion as an unlabelled div and
    // Playwright's role/text locators miss the click target. Trigger the same
    // bubbling mouse sequence in the page as a final selection fallback.
    if (!(await selectedColors()).some((item) => item.toLowerCase() === color.toLowerCase())) {
      await page.evaluate((expected) => {
        const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
        const candidates = [...document.querySelectorAll('li, [role="option"], [class*=menu] *, [class*=popup] *, [class*=overlay] *')]
          .filter((node) => visible(node) && !['INPUT', 'TEXTAREA'].includes(node.tagName) && String(node.textContent || '').replace(/\s+/g, ' ').trim() === expected);
        const target = candidates.at(-1);
        if (!target) return false;
        for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        return true;
      }, color).catch(() => false);
      await input.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(450);
    const addCandidates = [page.getByText('+ 添加', { exact: true }), page.getByText('添加', { exact: true })];
    let addClicked = false;
    for (const candidate of addCandidates) {
      if (!await candidate.last().isVisible().catch(() => false)) continue;
      await candidate.last().click({ force: true }).catch(() => {});
      addClicked = true;
      break;
    }
    if (!addClicked) await input.press('Enter').catch(() => {});
    await page.waitForTimeout(500);
  }
  await removeEmptyColorRows();
  const selected = await selectedColors();
  // On the current form a committed value remains in the combobox input (the
  // screen reader span is empty), so the input values are the authoritative
  // success signal. Require no empty row to remain either.
  const rows = colorRows();
  const rowCount = await rows.count().catch(() => 0);
  return colors.every((color) => selected.some((item) => item.trim().toLowerCase() === color.toLowerCase())) && rowCount >= colors.length;
}

async function fillVariantSpecs(page, variantGroups) {
  const groups = (variantGroups || []).filter((group) => group?.name && !/颜色|colou?r/i.test(group.name));
  const unmapped = [];
  for (const group of groups) {
    for (const rawValue of [...new Set(group.options || [])]) {
      const value = englishSpecText(rawValue);
      if (!value) continue;
      const option = await page.locator('label, span, div').filter({ hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).last();
      if (!await option.isVisible().catch(() => false)) {
        unmapped.push(`${group.name}: ${value}`);
        continue;
      }
      let checked = await option.evaluate((node) => {
        const host = node.closest('label') || node.parentElement;
        const input = host?.querySelector('input[type="checkbox"], input[type="radio"]');
        if (!input) return false;
        if (!input.checked) input.click();
        return true;
      }).catch(() => false);
      if (!checked) {
        await option.click({ force: true }).catch(() => {});
        checked = true;
      }
      await page.waitForTimeout(120);
    }
  }
  return { unmapped };
}

async function enableSpecImageUpload(page, product, colorGroup, downloadImages) {
  const colorValues = [...new Set(colorGroup?.options || [])].map((value) => englishSpecText(value)).filter(Boolean);
  const imageUrl = colorValues.map((value) => colorGroup?.optionImages?.[value] || colorGroup?.optionImages?.[colorGroup.options?.find((item) => englishSpecText(item) === value)]).find(Boolean);
  if (!imageUrl) return false;

  // The product-specification selector is separate from the hidden color row.
  // Enable the source color spec first so Alibaba materializes its combobox
  // and specification-image switch.
  const colorToggle = page.locator('label.next-checkbox-wrapper').filter({ hasText: /^Color$/i }).last();
  if (await colorToggle.isVisible().catch(() => false)) {
    const input = colorToggle.locator('input[type="checkbox"]').first();
    if (await input.count().catch(() => 0) && !await input.isChecked().catch(() => false)) {
      await colorToggle.click({ force: true }).catch(() => {});
      await page.waitForTimeout(350);
    }
  }

  const row = page.locator('#p-191288010');
  if (!await row.isVisible().catch(() => false)) return false;
  const imageSwitch = row.locator('[role="switch"]').first();
  if (await imageSwitch.isVisible().catch(() => false) && await imageSwitch.getAttribute('aria-checked').catch(() => 'false') !== 'true') {
    await imageSwitch.click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
  }
  const files = await downloadImages([imageUrl], 'spec', 1);
  if (!files.length) return false;
  const input = row.locator('input[type="file"]').last();
  if (!await input.count().catch(() => 0)) return false;
  await input.setInputFiles(files[0]);
  await page.waitForTimeout(1800);
  return true;
}

async function switchToLegacyDetails(page) {
  const oldMode = page.getByRole('button', { name: '返回老版', exact: true }).first();
  if (await oldMode.isVisible().catch(() => false)) {
    await oldMode.click();
    await page.waitForTimeout(350);
    const confirm = page.getByRole('button', { name: '继续返回旧版', exact: true }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  const normalEditor = page.getByText('普通编辑', { exact: true }).last();
  if (await normalEditor.isVisible().catch(() => false)) await normalEditor.click().catch(() => {});
  await page.waitForTimeout(600);
}

export class SellerPublisher {
  constructor(dataDir) {
    this.profileDir = path.join(dataDir, 'seller-profile');
    this.sourceProfileDir = path.join(dataDir, 'source-profile');
    this.imageDir = path.join(dataDir, 'publish-images');
    this.videoDir = path.join(dataDir, 'publish-videos');
    this.context = null;
    this.sourceContext = null;
    this.page = null;
    this.visible = false;
  }

  async sourceBrowser() {
    // Reuse the signed-in seller session first. A fresh public profile is often
    // challenged by Alibaba before the product page can be rendered.
    if (this.context) return this.context;
    if (!this.sourceContext) {
      this.sourceContext = await launchPersistent(this.sourceProfileDir, {
        headless: false,
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      this.sourceContext.on('close', () => { this.sourceContext = null; });
    }
    return this.sourceContext;
  }

  async open(options = {}) {
    if (!this.context) {
      this.context = await launchPersistent(this.profileDir, { headless: false });
      this.context.on('close', () => { this.context = null; this.page = null; });
    }
    const pages = this.context.pages();
    this.page = pages.find((item) => isAlibabaInternationalUrl(item.url())) || pages[0] || await this.context.newPage();
    if (this.page.url() === 'about:blank' || !isAlibabaInternationalUrl(this.page.url())) {
      await this.page.goto(WORKBENCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    if (options.reveal) { await revealPage(this.page); this.visible = true; }
    else { await hidePage(this.page); this.visible = false; }
    return this.status();
  }

  status() {
    return {
      browserOpen: Boolean(this.context),
      visible: this.visible,
      currentUrl: this.page?.url() || '',
      onAlibabaInternational: Boolean(isAlibabaInternationalUrl(this.page?.url() || ''))
    };
  }

  async hide() {
    if (this.page) await hidePage(this.page);
    this.visible = false;
  }

  async currentSellerPage() {
    await this.open();
    const pages = this.context.pages();
    const current = [...pages].reverse().find((item) => isAlibabaInternationalUrl(item.url()));
    if (current) this.page = current;
    return this.page;
  }

  async findPostingFormPage(options = {}) {
    await this.open(options);
    const candidates = [...this.context.pages()].reverse().filter((page) => isProductPostingUrl(page.url()));
    for (const page of candidates) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      if (await firstVisible(page, TITLE_SELECTORS)) {
        this.page = page;
        return page;
      }
    }
    if (candidates[0]) this.page = candidates[0];
    return this.page;
  }

  async bindCurrentPage() {
    const page = await this.findPostingFormPage({ reveal: true });
    const url = page.url();
    if (!isAlibabaInternationalUrl(url) || /login|passport/i.test(url)) {
      throw new Error('请先登录 My Alibaba，再进入国际站商品发布页面');
    }
    if (!isProductPostingUrl(url)) {
      throw new Error('当前不是国际站商品发布页，请进入 Products → Post Products，选好类目并打开发布表单');
    }
    await settlePage(page);
    const titleField = await firstVisible(page, TITLE_SELECTORS);
    if (/\/product\/(?:easyListing|category)\.htm/i.test(new URL(url).pathname) && !titleField) {
      throw new Error('当前仍是商品类目选择页。请先选择完整类目并点击“我已阅读如上规则，现在发布产品”，进入商品填写表单后再绑定');
    }
    if (!titleField) {
      throw new Error('当前页面不是商品填写表单，尚未找到商品标题输入框');
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const category = bodyText.match(/当前类目：\s*([^\n]+)/)?.[1]?.trim() || '';
    return { url, title: await page.title(), category };
  }

  async inspectPublishPage(publishPageUrl, query = '', detailMode = '') {
    if (!isProductPostingUrl(publishPageUrl)) throw new Error('尚未绑定有效的国际站商品发布页');
    const page = await this.currentSellerPage();
    await page.goto(publishPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settlePage(page);
    if (detailMode === 'old') {
      const oldMode = page.getByRole('button', { name: '返回老版', exact: true }).first();
      if (await oldMode.isVisible().catch(() => false)) {
        await oldMode.click();
        await page.waitForTimeout(400);
        const confirmOldMode = page.getByRole('button', { name: '继续返回旧版', exact: true }).first();
        if (await confirmOldMode.isVisible().catch(() => false)) await confirmOldMode.click();
        await page.waitForTimeout(1200);
      }
    }
    if (query) {
      const searchbox = page.getByRole('searchbox').first();
      if (await searchbox.isVisible().catch(() => false)) {
        await searchbox.fill(query);
        const searchButton = page.getByRole('button', { name: '搜索', exact: true }).first();
        if (await searchButton.isVisible().catch(() => false)) await searchButton.click();
        await page.waitForTimeout(2500);
      }
    }
    const frames = [];
    for (const frame of page.frames()) {
      const fields = await frame.locator('input, textarea, [contenteditable="true"], [role="textbox"]').evaluateAll((nodes) => nodes.slice(0, 100).map((node) => {
        const contexts = [];
        let parent = node.parentElement;
        for (let level = 0; parent && level < 8; level += 1, parent = parent.parentElement) {
          const text = (parent.innerText || '').replace(/\s+/g, ' ').trim();
          if (text && !contexts.includes(text)) contexts.push(text.slice(0, 500));
        }
        return {
          tag: node.tagName, type: node.getAttribute('type') || '', name: node.getAttribute('name') || '',
          placeholder: node.getAttribute('placeholder') || '', ariaLabel: node.getAttribute('aria-label') || '',
          role: node.getAttribute('role') || '', className: String(node.className || '').slice(0, 180),
          visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length), contexts
        };
      })).catch(() => []);
      const buttons = await frame.locator('button, [role="button"]').evaluateAll((nodes) => nodes.slice(0, 100).map((node) => ({
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        ariaLabel: node.getAttribute('aria-label') || '', className: String(node.className || '').slice(0, 180),
        visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
      }))).catch(() => []);
      frames.push({ url: frame.url(), name: frame.name(), fields, buttons });
    }
    const snippets = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      return ['商品图片&视频', '商品属性', '颜色', '发货期', '详情图片'].flatMap((label) => {
        const node = [...document.querySelectorAll('div,span,h2,h3,h4,label')]
          .find((item) => clean(item.textContent) === label || clean(item.textContent).startsWith(`${label} (`));
        if (!node) return [];
        const ancestors = [];
        let ancestor = node;
        for (let level = 0; ancestor && level < 8; level += 1, ancestor = ancestor.parentElement) {
          ancestors.push({ tag: ancestor.tagName, id: ancestor.id || '', className: String(ancestor.className || '').slice(0, 180), text: clean(ancestor.innerText).slice(0, 300) });
        }
        let container = node;
        for (let level = 0; container.parentElement && level < 3; level += 1) container = container.parentElement;
        return [{ label, ancestors, html: container.outerHTML.slice(0, 18000) }];
      });
    }).catch(() => []);
    return {
      url: page.url(), title: await page.title(), frames, snippets,
      text: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 5000)
    };
  }

  async inspectSourcePage(sourceUrl) {
    if (!isAlibabaInternationalUrl(sourceUrl)) throw new Error('仅支持检查阿里巴巴国际站商品页');
    await this.open();
    const context = await this.sourceBrowser();
    const page = await context.newPage();
    try {
      await hidePage(page);
      const pageData = await withSourceLocale(context, async () => {
        await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await settlePage(page);
        await page.waitForTimeout(2500);
        return await page.evaluate(() => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const scripts = [...document.scripts].map((script) => ({
          id: script.id || '', type: script.type || '', src: script.src || '',
          text: script.src ? '' : script.textContent || ''
        })).filter((script) => /product|sku|attribute|image|detail|delivery|freight|offer|1601498661421/i.test(`${script.id} ${script.src} ${script.text}`))
          .slice(0, 30).map((script) => ({ ...script, text: script.text.slice(0, 12000) }));
        const sections = [...document.querySelectorAll('h1,h2,h3,h4,dt,dd,li,[class*=attribute],[class*=spec],[class*=sku],[class*=detail]')]
          .map((node) => clean(node.textContent)).filter((text) => text && text.length < 500).slice(0, 300);
        const snippets = ['重要属性', '包装和发货信息', '编辑选择', '交货时间', 'Key attributes', 'Packaging and delivery', 'Customization options', 'Certificates'].flatMap((label) => {
          const node = [...document.querySelectorAll('h1,h2,h3,h4,div,span')]
            .find((item) => clean(item.textContent) === label);
          if (!node) return [];
          const container = node.parentElement?.parentElement || node.parentElement || node;
          return [{ label, html: container.outerHTML.slice(0, 20000) }];
        });
        const images = [...document.images].map((image) => ({
          src: image.currentSrc || image.src || '', alt: image.alt || '',
          width: image.naturalWidth, height: image.naturalHeight,
          className: String(image.className || '').slice(0, 120)
        })).filter((image) => image.src && image.width >= 200 && image.height >= 200).slice(0, 100);
        return {
          url: location.href, title: document.title,
          documentLanguage: document.documentElement?.lang || '',
          metaLanguage: document.querySelector('meta[http-equiv="content-language"], meta[name="language"]')?.content || '',
          loginRequired: /login\.alibaba\.com/.test(location.href) || /Enter your email or member ID|Sign in/.test(document.body?.innerText || ''),
          text: clean(document.body?.innerText).slice(0, 12000), scripts, sections, snippets, images
        };
        });
      });
      return pageData;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async inspectCurrentForm() {
    const page = await this.currentSellerPage();
    return { url: page.url(), diagnostics: await currentFormDiagnostics(page) };
  }

  async diagnoseMainImageUploader(publishPageUrl) {
    if (!isProductPostingUrl(publishPageUrl)) throw new Error('尚未绑定有效的国际站商品发布页');
    const page = await this.currentSellerPage();
    const attempts = [];
    for (let level = 0; level < 7; level += 1) {
      await page.goto(publishPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await settlePage(page);
      const trigger = await waitForFirstVisible(page, [
        '.image-upload-list-item #image-placeholder-span',
        '.image-upload-list-item #image-placeholder-icon',
        '.image-upload-list-item .image-upload-photobank-placeholder'
      ], 20000);
      if (!trigger) throw new Error('等待 20 秒后仍未找到主图上传占位入口');
      await trigger.click();
      await page.waitForTimeout(800);
      const candidates = page.getByText('本地上传', { exact: false });
      const count = await candidates.count().catch(() => 0);
      const visibleCandidates = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          const ancestors = await candidate.evaluate((node) => {
            const result = [];
            let current = node;
            for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
              result.push({
                depth,
                tag: current.tagName,
                id: current.id || '',
                className: String(current.className || ''),
                role: current.getAttribute('role') || '',
                html: current.outerHTML.slice(0, 3000)
              });
            }
            return result;
          });
          visibleCandidates.push({ index, ancestors });
        }
      }
      const selected = visibleCandidates[0];
      const localUpload = selected ? candidates.nth(selected.index) : null;
      if (!localUpload) {
        attempts.push({ level, result: 'no-visible-local-upload', menuText: compactText(await page.locator('body').innerText(), 1000) });
        continue;
      }
      let clickable = localUpload;
      for (let parent = 0; parent < level; parent += 1) clickable = clickable.locator('xpath=..');
      const html = await clickable.evaluate((node) => node.outerHTML.slice(0, 4000)).catch(() => '');
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 2500 }).catch(() => null);
      await clickable.click({ force: true }).catch(() => {});
      const chooser = await chooserPromise;
      const fileInputs = await page.locator('input[type="file"]').evaluateAll((nodes) => nodes.map((node) => ({
        accept: node.getAttribute('accept') || '', multiple: node.hasAttribute('multiple'),
        className: String(node.className || ''), outerHTML: node.outerHTML.slice(0, 1000)
      }))).catch(() => []);
      attempts.push({
        level,
        candidateIndex: selected.index,
        html,
        visibleCandidates: level === 0 ? visibleCandidates : undefined,
        chooser: chooser ? { multiple: chooser.isMultiple() } : null,
        fileInputs
      });
      if (chooser || fileInputs.length) break;
    }
    return { url: page.url(), attempts };
  }

  async diagnoseVideoUploader(publishPageUrl) {
    if (!isProductPostingUrl(publishPageUrl)) throw new Error('尚未绑定有效的国际站商品发布页');
    const page = await this.currentSellerPage();
    await page.goto(publishPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settlePage(page);
    const placeholder = await firstVisible(page, ['.video-upload-placeholder']);
    if (!placeholder) throw new Error('未找到主图视频入口');
    await placeholder.click({ force: true });
    await page.waitForTimeout(1200);
    const deadline = Date.now() + 30000;
    let frame = null;
    while (Date.now() < deadline) {
      frame = page.frames().find((item) => /videobank\/popSelect\.htm/i.test(item.url()));
      if (frame) break;
      await page.waitForTimeout(250);
    }
    if (!frame) throw new Error('视频银行弹窗未加载');
    const controls = await frame.locator('button,a,input,[role="button"],[role="link"]').evaluateAll((nodes) => nodes.map((node) => ({
      tag: node.tagName, text: String(node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      type: node.getAttribute('type') || '', accept: node.getAttribute('accept') || '', href: node.href || '',
      visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length), html: node.outerHTML.slice(0, 1500)
    })).filter((item) => item.visible));
    return { url: frame.url(), text: compactText(await frame.locator('body').innerText(), 3000), controls };
  }

  async enrichSourceProducts(products, onProgress = () => {}, options = {}) {
    // Source collection must not depend on the seller workbench being
    // reachable. The source profile can read public product pages directly;
    // opening i.alibaba here made a fresh server fail before collection even
    // started when the seller session was logged out or the workbench was
    // temporarily unavailable.
    const context = await this.sourceBrowser();
    const page = await context.newPage();
    const enriched = [];
    try {
      await hidePage(page);
      await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
      for (let index = 0; index < products.length; index += 1) {
        if (typeof options.shouldStop === 'function' && options.shouldStop()) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        enriched.push(await withSourceLocale(context, () => this.readSourceProduct(page, products[index]), options));
        const keepGoing = onProgress(index + 1, products.length, enriched[index]);
        if (keepGoing === false) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        if (Number(options.delaySeconds || 0) > 0) await page.waitForTimeout(Number(options.delaySeconds) * 1000);
      }
      return enriched;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async readSourceProduct(page, base) {
    await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
    await page.goto(base.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await waitForHumanVerification(page, { timeout: 300000 });
    await page.waitForTimeout(450);
    await page.locator('[data-module-name="module_description"], [data-testid="module-description"]').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.locator('[data-module-name="module_product_specification"] iframe, iframe[src*="descIframe"]')
      .first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    if (/login|passport/i.test(page.url())) {
      throw new Error('读取商品详情需要登录，请先打开 My Alibaba 并登录后重新采集');
    }
    await page.locator('iframe[src*="descIframe"]')?.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    let detailFrame = page.frames().find((frame) => /descIframe\.html/i.test(frame.url()));
    // Alibaba serves the rich-text description through different iframe URLs
    // depending on the product template. If the canonical descIframe is not
    // present, inspect loaded child frames and choose the one containing real
    // product images/content instead of treating the detail as empty.
    if (!detailFrame) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame() || /login|passport|captcha|photobank|videobank/i.test(frame.url())) continue;
        const candidate = await frame.evaluate(() => {
          const root = document.body || document.documentElement;
          const html = root?.innerHTML || '';
          const images = [...(root?.querySelectorAll('img') || [])].filter((image) => /\/kf\//i.test(image.currentSrc || image.src || image.getAttribute('data-src') || '')).length;
          return { htmlLength: html.length, images };
        }).catch(() => null);
        if (candidate && candidate.htmlLength > 200 && candidate.images > 0) { detailFrame = frame; break; }
      }
    }
    const iframeDetail = detailFrame ? await detailFrame.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const absolute = (value) => {
        try { return new URL(String(value || '').startsWith('//') ? `https:${value}` : value, location.href).href; }
        catch { return ''; }
      };
      const root = document.body || document.documentElement;
      const images = [...root.querySelectorAll('img')].map((image) => ({
        src: absolute(image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-original')),
        alt: clean(image.alt || '')
      })).filter((image) => image.src && /\/kf\//i.test(image.src));
      return {
        html: root?.innerHTML || '',
        text: clean(root?.innerText || ''),
        images
      };
    }).catch(() => null) : null;
    const detail = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const absolute = (value) => {
        if (!String(value || '').trim()) return '';
        try { return new URL(String(value || '').startsWith('//') ? `https:${value}` : value, location.href).href; }
        catch { return ''; }
      };
      const unique = (values) => [...new Set(values.map(absolute).filter(Boolean))];
      const textOf = (node) => clean(node?.textContent || '');
      const labelValue = (labels) => {
        const wanted = labels.map((label) => label.toLowerCase());
        const nodes = [...document.querySelectorAll('tr, li, div, span')];
        for (const node of nodes) {
          const text = textOf(node);
          const lower = text.toLowerCase();
          const label = wanted.find((item) => lower.startsWith(`${item}:`) || lower.startsWith(`${item}：`) || lower.includes(`${item}:`));
          if (!label) continue;
          const value = text.replace(new RegExp(`^.*?${label}\\s*[:：]?\\s*`, 'i'), '').trim();
          if (value && value.length < 300 && value.toLowerCase() !== label) return value;
        }
        return '';
      };
      const jsonObjects = [];
      const visitJson = (value) => {
        if (!value || typeof value !== 'object') return;
        jsonObjects.push(value);
        if (Array.isArray(value)) value.forEach(visitJson);
        else Object.values(value).forEach(visitJson);
      };
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { visitJson(JSON.parse(script.textContent || 'null')); } catch {}
      }
      const mainImages = unique([
        ...jsonObjects.filter((item) => item['@type'] === 'ImageObject').map((item) => item.contentUrl),
        ...[...document.querySelectorAll('img[src*="/kf/"]')]
          .filter((image) => /_960x960|_720x720/.test(image.currentSrc || image.src))
          .map((image) => image.currentSrc || image.src)
      ]).slice(0, 6);
      const descriptionModule = document.querySelector('[data-module-name="module_description"], [data-testid="module-description"]');
      const sourceDetailImages = unique([...((descriptionModule || document).querySelectorAll('img'))]
        .filter((image) => /\/kf\//.test(image.currentSrc || image.src)
          && (image.naturalWidth >= 300 || /id-w-\[100%\]|_\d+x\d+/.test(String(image.className) + ' ' + (image.currentSrc || image.src))))
        .map((image) => image.currentSrc || image.src)).filter((url) => !mainImages.includes(url)).slice(0, 30);
      // Do not silently turn main images into detail images. A product with
      // no real detail-image module must remain incomplete so the publisher
      // can stop and ask for review instead of inventing source data.
      const detailImages = sourceDetailImages;
      const attributes = [...document.querySelectorAll('[data-testid="module-attribute-row"]')].map((row) => ({
        name: clean(row.querySelector('[data-testid="module-attribute-name"]')?.getAttribute('title')
          || row.querySelector('[data-testid="module-attribute-name"]')?.textContent),
        value: clean(row.querySelector('[data-testid="module-attribute-value"]')?.getAttribute('title')
          || row.querySelector('[data-testid="module-attribute-value"]')?.textContent),
        section: clean(row.closest('[data-testid="module-attribute-group"]')?.querySelector('[data-testid="module-attribute-group-title"]')?.textContent) || 'Product Attributes',
        source: 'dom'
      })).filter((item) => item.name && item.value);
      if (attributes.length < 2) {
        const fallbackAttributes = [...document.querySelectorAll('table tr, [class*=attribute] li, [class*=parameter] li')].map((row) => {
          const cells = [...row.querySelectorAll('th,td')].map(textOf).filter(Boolean);
          const text = textOf(row);
          if (cells.length >= 2) return { name: cells[0], value: cells.slice(1).join(' ') };
          const match = text.match(/^([^:：]{1,80})\s*[:：]\s*(.{1,240})$/);
          return match ? { name: clean(match[1]), value: clean(match[2]) } : null;
        }).filter((item) => item?.name && item?.value);
        attributes.push(...fallbackAttributes);
      }
      const variantGroupsRaw = [...document.querySelectorAll('[data-testid="sku-list"]')].map((group) => ({
        name: clean(group.querySelector('[data-testid="sku-list-title"]')?.textContent),
        options: [...group.querySelectorAll('[data-testid*="sku-item"]')].map((option) => clean(
          option.querySelector('img')?.alt || option.textContent
        )).filter(Boolean),
        optionImages: Object.fromEntries([...group.querySelectorAll('[data-testid*="sku-item"]')].map((option) => [
          clean(option.querySelector('img')?.alt || option.textContent), absolute(option.querySelector('img')?.src || '')
        ]).filter(([name, image]) => name && image))
      })).filter((group) => group.name && group.options.length);
      const variantGroups = [...new Map(variantGroupsRaw.map((group) => [`${group.name}:${group.options.join('|')}`, group])).values()];
      const leadRows = [...document.querySelectorAll('[data-module-name="module_lead"] tr, [class*=lead-time] tr, [class*=shipping] tr')]
        .map((row) => [...row.cells].map((cell) => clean(cell.textContent))).filter((row) => row.length > 1);
      const attrMap = Object.fromEntries(attributes.map((item) => [item.name.toLowerCase(), item.value]));
      const packageSize = (attrMap['单个包装尺寸'] || attrMap['single package size'] || '').match(/([\d.]+)\s*[xX×]\s*([\d.]+)\s*[xX×]\s*([\d.]+)/);
      const weight = (attrMap['单个产品毛重'] || attrMap['single gross weight'] || '').match(/[\d.]+/)?.[0] || '';
      const video = jsonObjects.find((item) => item['@type'] === 'VideoObject');
      const productJson = jsonObjects.find((item) => item['@type'] === 'Product');
      const priceText = clean([
        document.querySelector('[data-module-name="module_price"]')?.textContent,
        document.querySelector('[data-testid*="price"]')?.textContent,
        productJson?.offers?.price,
        document.body?.innerText?.match(/(?:¥|￥|\$)\s*[\d,.]+\s*(?:\d+\s*[-–]\s*\d+|≥\s*[\d,]+)?/g)?.join(' ')
      ].filter(Boolean).join(' '));
      const categoryPath = [...document.querySelectorAll('nav a, [data-testid*="breadcrumb"] a')]
        .map((node) => clean(node.textContent)).filter((text) => text && text.length < 80
          && !/(?:Alibaba\s*Lens|免费比价插件|寻找价格更低|相似商品|下载扩展程序|Accio\s*Work|报告可疑活动|report suspicious activity)/i.test(text)).slice(0, 8);
      const highlights = [...document.querySelectorAll('[data-module-name*="highlight"] li, [data-module-name*="highlight"] p')]
        .map((node) => clean(node.textContent)).filter(Boolean).slice(0, 12);
      const descriptionHtml = (descriptionModule?.innerHTML || '').replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 90000);
      const keywords = clean(document.querySelector('meta[name="keywords"]')?.content || '').split(/[,，]/)
        .map((value) => value.trim())
        .filter((value) => value && !/\s+-\s+Buy Product on Alibaba\.com$/i.test(value))
        .slice(0, 30);
      const subtitle = clean(document.querySelector('[data-module-name*="subtitle"], [class*=subtitle]')?.textContent || '');
      const paymentMethod = labelValue(['payment terms', 'payment method', '付款方式']);
      const salesUnit = labelValue(['unit', 'unit type', '计量单位', '销售单位']) || 'Piece';
      const shippingText = clean(document.querySelector('[data-module-name*="shipping"], [class*=shipping]')?.textContent || '');
      const sourceServices = [...document.querySelectorAll('[data-module-name*="service"], [class*=service], [class*=certificate]')].map(textOf).filter((text) => text.length > 2 && text.length < 500).slice(0, 20);
      const certificateAttribute = attributes.find((item) => /^(?:证书|certificates?|certification)$/i.test(item.name));
      const certificateRoot = document.querySelector('[data-testid="certifications"], [data-module-name="module_certification"]');
      const certificates = certificateRoot
        ? [...certificateRoot.querySelectorAll('[class*=grid] > div')].map((card) => {
            const name = clean(card.querySelector('[class*="font-semibold"]')?.textContent || '');
            const description = clean(card.querySelector('[class*="text-xs"]')?.textContent || '');
            return { name, number: '', description, verified: null, source: 'dom' };
          }).filter((item) => item.name)
        : (certificateAttribute?.value || '').split(/[,，、;/]+/).map((name) => clean(name)).filter(Boolean).map((name) => ({ name, number: '', verified: null, source: 'attribute' }));
      const customizationRoot = [...document.querySelectorAll('[data-section], [data-module-name], div')]
        .filter((node) => {
          const text = clean(node.textContent);
          return /Customization options/i.test(text) && /Customized logo|Customized packaging|Graphic customization/i.test(text) && text.length < 1200;
        })
        .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0] || null;
      let customizations = customizationRoot
        ? [...customizationRoot.querySelectorAll('span')].filter((node) => /^(?:Customized logo|Customized packaging|Graphic customization|自定义徽标|图形自定义|定制包装)$/i.test(clean(node.textContent))).map((node) => {
            const rowText = clean(node.parentElement?.parentElement?.textContent || node.parentElement?.textContent || '');
            const match = rowText.match(/(\\d+)\\s*(pieces?|sets?|units?|件|套)/i);
            return { name: clean(node.textContent), minimumQuantity: match ? Number(match[1]) : null, unit: clean(match?.[2] || ''), source: 'dom' };
          })
        : [];
      if (customizationRoot) {
        const text = clean(customizationRoot.textContent);
        const parsed = [...text.matchAll(/(Customized logo|Customized packaging|Graphic customization|自定义徽标|图形自定义|定制包装)[\s\S]{0,100}?(?:Min\. order:\s*)?(\d+)\s*(pieces?|sets?|units?|件|套)/gi)]
          .map((match) => ({ name: clean(match[1]), minimumQuantity: Number(match[2]), unit: clean(match[3]), source: 'dom' }));
        if (parsed.length) customizations = parsed;
      }
      return {
        originalTitle: clean(document.querySelector('h1')?.textContent || productJson?.name || document.title),
        mainImages, detailImages, attributes, variantGroups, leadTime: leadRows,
        packaging: { length: packageSize?.[1] || '', width: packageSize?.[2] || '', height: packageSize?.[3] || '', weight },
        origin: attrMap['产地'] || attrMap['原产地'] || attrMap['place of origin'] || attrMap['country/region of manufacture'] || '',
        model: attrMap['型号'] || attrMap['model number'] || '',
        brand: attrMap['品牌名称'] || attrMap['品牌'] || attrMap['brand name'] || attrMap['brand'] || '',
        productType: categoryPath.at(-1) || '', categoryPath, priceText, subtitle, keywords,
        salesUnit, paymentMethod, shippingText, services: { sourceTexts: sourceServices, customizations }, certificates,
        descriptionHtml,
        description: highlights.join('\n') || clean(descriptionModule?.innerText).slice(0, 12000),
        videoUrl: absolute(video?.contentUrl || ''),
        dataCompleteness: {
          mainImages: mainImages.length, detailImages: detailImages.length,
          sourceDetailImages: sourceDetailImages.length, detailImagesDerived: !sourceDetailImages.length,
          attributes: attributes.length, variantGroups: variantGroups.length,
          priceText: Boolean(priceText), descriptionHtml: Boolean(descriptionHtml), shipping: Boolean(shippingText), services: sourceServices.length,
          certificates: certificates.length, customizations: customizations.length
        },
        documentLanguage: document.documentElement?.lang || '',
        metaLanguage: document.querySelector('meta[http-equiv="content-language"], meta[name="language"]')?.content || '',
        renderTextSample: clean(document.body?.innerText).slice(0, 3000)
      };
    });
    if (iframeDetail?.html && iframeDetail.html.length > 80) {
      detail.descriptionHtml = iframeDetail.html.slice(0, 90000);
      detail.description = iframeDetail.text.slice(0, 12000);
      const iframeImages = iframeDetail.images.map((image) => image.src).filter(Boolean);
      detail.detailImages = [...new Set([...detail.detailImages, ...iframeImages])].filter((url) => !detail.mainImages.includes(url)).slice(0, 30);
      detail.dataCompleteness.detailImages = detail.detailImages.length;
      detail.dataCompleteness.sourceDetailImages = detail.detailImages.length;
      detail.dataCompleteness.detailImagesDerived = false;
      detail.dataCompleteness.descriptionHtml = true;
    } else if (!detail.description || /^(?:视频描述|video description)$/i.test(detail.description)) {
      detail.description = '';
    }
    if (detail.mainImages.length < 4 || detail.attributes.length < 2) {
      throw new Error(`商品详情读取不完整：${base.title}（主图 ${detail.mainImages.length}，属性 ${detail.attributes.length}）`);
    }
    const sourcePriceTiers = parsePriceTiers(detail.priceText);
    const priceTiers = normalizePriceTiers(sourcePriceTiers, base.price, base.currencySymbol || '$');
    const skus = buildSkuCombinations(detail.variantGroups, base.price, base.stock || 100);
    return {
      ...sanitizeCollectedProduct({
      ...base,
      sourceOriginalTitle: detail.originalTitle,
      sourceLanguage: detail.documentLanguage || detail.metaLanguage || (/[㐀-鿿]/.test(`${detail.originalTitle} ${detail.renderTextSample}`) ? 'zh' : 'en'),
      sourceCaptureLocale: 'en-US',
      sourceLanguageEvidence: { documentLanguage: detail.documentLanguage, metaLanguage: detail.metaLanguage, renderTextSample: detail.renderTextSample },
      mainImage: detail.mainImages[0] || base.mainImage,
      images: detail.mainImages,
      mainImages: detail.mainImages,
      detailImages: detail.detailImages,
      attributes: detail.attributes,
      variantGroups: detail.variantGroups,
      skus,
      sourcePriceText: detail.priceText,
      sourcePriceTiers,
      priceTiers,
      deliveryTime: detail.leadTime,
      packaging: detail.packaging,
      subtitle: detail.subtitle,
      keywords: detail.keywords,
      salesUnit: detail.salesUnit,
      paymentMethod: detail.paymentMethod,
      shipping: detail.shippingText,
      services: detail.services,
      certificates: detail.certificates,
      descriptionHtml: detail.descriptionHtml,
      origin: detail.origin,
      model: detail.model,
      brand: detail.brand,
      productType: detail.productType,
      sourceCategoryPath: detail.categoryPath,
      description: detail.description,
      videoUrl: detail.videoUrl,
      dataCompleteness: detail.dataCompleteness,
      collectedDetailAt: new Date().toISOString()
      })
    };
  }

  async downloadImageSet(product, urls, prefix, limit = 6) {
    fs.mkdirSync(this.imageDir, { recursive: true });
    const selectedUrls = [...new Set(urls.filter(Boolean))].filter((url) => /\/kf\//i.test(url)).slice(0, limit);
    const paths = [];
    for (let index = 0; index < selectedUrls.length; index += 1) {
      try {
        const response = await fetch(selectedUrls[index], { headers: { referer: product.sourceUrl, 'user-agent': 'Mozilla/5.0' } });
        if (!response.ok) continue;
        const contentType = response.headers.get('content-type') || '';
        if (!/^image\/(?:jpeg|jpg|png)/i.test(contentType)) continue;
        let extension = contentType.includes('png') ? 'png' : 'jpg';
        let buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > 5 * 1024 * 1024) continue;
        if (prefix === 'detail') {
          const metadata = await sharp(buffer).metadata();
          if ((metadata.width || 0) > 960 || (metadata.height || 0) > 960) {
            buffer = await sharp(buffer)
              .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 90 })
              .toBuffer();
            extension = 'jpg';
          }
        }
        const safeId = String(product.sourceId || product.id || 'product').replace(/[^A-Za-z0-9]/g, '').slice(-16);
        const safePrefix = String(prefix || 'image').replace(/[^A-Za-z0-9]/g, '');
        const filePath = path.join(this.imageDir, `${safeId}${safePrefix}${index}.${extension}`);
        fs.writeFileSync(filePath, buffer);
        paths.push(filePath);
      } catch {}
    }
    return paths;
  }

  async uploadMainImages(page, product) {
    const urls = product.mainImages?.length ? product.mainImages : [product.mainImage, ...(product.images || [])];
    const images = await this.downloadImageSet(product, urls, 'main', 6);
    if (images.length < 4) throw new Error(`主图资料不足：仅下载到 ${images.length} 张，至少需要 4 张`);
    // Alibaba keeps the six main-image file inputs hidden inside each
    // `.image-upload-list-item`; Playwright can still assign files to these
    // controls directly. Looking only for visible file inputs caused the
    // browser file picker fallback to hit the photo-bank menu and left all
    // main-image slots empty.
    const mainInput = page.locator('.image-upload-list-item input[type="file"][accept*="image"], .image-upload-list-item input[type="file"]').first();
    if (await mainInput.count().catch(() => 0)) {
      await mainInput.setInputFiles(images);
      return await this.waitForMainImageUploads(page, images.length);
    }
    const directInput = page.locator('input[type="file"][accept*="image"], input[type="file"]').first();
    if (await directInput.count().catch(() => 0)) {
      await directInput.setInputFiles(images);
      return await this.waitForMainImageUploads(page, images.length);
    }
    const triggerSelectors = [
      '.image-upload-list-item #image-placeholder-span',
      '.image-upload-list-item #image-placeholder-icon',
      '.image-upload-list-item #image-placeholder-span',
      '.image-upload-list-item #image-placeholder-icon'
    ];
    let chooser = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const selector = triggerSelectors[attempt % triggerSelectors.length];
      const trigger = page.locator(selector).first();
      if (!await trigger.isVisible().catch(() => false)) continue;

      await trigger.hover().catch(() => {});
      await page.waitForTimeout(500);
      let popupFileInput = page.locator('input[type="file"][accept*="image"]');
      let popupFileInputCount = await popupFileInput.count().catch(() => 0);
      if (popupFileInputCount) {
        await popupFileInput.nth(popupFileInputCount - 1).setInputFiles(images);
        await page.waitForTimeout(1000);
        return await this.waitForMainImageUploads(page, images.length);
      }

      const chooserPromise = page.waitForEvent('filechooser', { timeout: 1800 }).catch(() => null);
      await trigger.click({ force: true }).catch(() => {});
      chooser = await chooserPromise;
      if (chooser) break;

      popupFileInput = page.locator('input[type="file"][accept*="image"]');
      const popupDeadline = Date.now() + 5000;
      while (Date.now() < popupDeadline && !await popupFileInput.count().catch(() => 0)) {
        await page.waitForTimeout(250);
      }
      popupFileInputCount = await popupFileInput.count().catch(() => 0);
      if (popupFileInputCount) {
        await popupFileInput.nth(popupFileInputCount - 1).setInputFiles(images);
        await page.waitForTimeout(1000);
        return await this.waitForMainImageUploads(page, images.length);
      }

      const localUpload = await firstVisibleByText(page, '本地上传', false);
      if (localUpload) {
        const localChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        const uploadControl = localUpload.locator('xpath=ancestor-or-self::*[@role="upload"][1]');
        if (await uploadControl.count().catch(() => 0)) await uploadControl.click({ force: true });
        else await localUpload.click();
        chooser = await localChooserPromise;
        if (chooser) break;
        const fileInputs = page.locator('input[type="file"]');
        const fileInputCount = await fileInputs.count().catch(() => 0);
        if (fileInputCount) {
          const input = fileInputs.nth(fileInputCount - 1);
          await input.setInputFiles(images);
          await page.waitForTimeout(5000);
          return images.length;
        }
      }
      await page.keyboard.press('Escape').catch(() => {});
      const close = page.getByRole('button', { name: /关闭|close/i }).last();
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
      await page.waitForTimeout(300);
    }
    if (!chooser) {
      const menuText = compactText(await page.locator('[class*="menu"], [class*="popup"], [class*="overlay"]').allInnerTexts().catch(() => []), 500);
      throw new Error(`国际站主图上传器未打开文件选择窗口${menuText ? `，当前弹层：${menuText}` : ''}`);
    }
    await chooser.setFiles(chooser.isMultiple() ? images : [images[0]]);
    await page.waitForTimeout(5000);
    if (!chooser.isMultiple()) {
      for (const image of images.slice(1)) {
        const nextTrigger = page.locator('.image-upload-list-item #image-placeholder-span').first();
        const nextChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
        await nextTrigger.click();
        const nextChooser = await nextChooserPromise;
        await nextChooser.setFiles([image]);
        await page.waitForTimeout(1200);
      }
    }
    return images.length;
  }

  async downloadProductVideo(product) {
    if (!product.videoUrl) return '';
    fs.mkdirSync(this.videoDir, { recursive: true });
    const response = await fetch(product.videoUrl, { headers: { referer: product.sourceUrl, 'user-agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`商品视频下载失败（HTTP ${response.status}）`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 100 * 1024 * 1024) throw new Error('商品视频超过国际站 100MB 限制');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('商品视频下载结果为空');
    if (buffer.length > 100 * 1024 * 1024) throw new Error('商品视频超过国际站 100MB 限制');
    const safeId = String(product.sourceId || product.id || 'product').replace(/[^A-Za-z0-9]/g, '').slice(-16);
    const filePath = path.join(this.videoDir, `${safeId}-main.mp4`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  async uploadMainVideo(page, product) {
    if (!product.videoUrl) return 0;
    const videoPath = await this.downloadProductVideo(product);
    const placeholder = await firstVisible(page, ['.video-upload-placeholder']);
    if (!placeholder) throw new Error('未识别到国际站主图视频上传入口');

    let videoInput = page.locator('input[type="file"][accept*="video"]');
    if (await videoInput.count().catch(() => 0)) {
      await videoInput.last().setInputFiles(videoPath);
    } else {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await placeholder.click({ force: true });
      let chooser = await chooserPromise;
      if (!chooser) {
        const localUpload = await firstVisibleByText(page, '本地上传', false);
        if (localUpload) {
          const localChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
          await localUpload.click({ force: true });
          chooser = await localChooserPromise;
        }
      }
      if (chooser) await chooser.setFiles(videoPath);
      else {
        videoInput = page.locator('input[type="file"][accept*="video"], input[type="file"][accept*="mp4"]');
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && !await videoInput.count().catch(() => 0)) await page.waitForTimeout(250);
        if (!await videoInput.count().catch(() => 0)) throw new Error('国际站主图视频上传器未打开文件选择窗口');
        await videoInput.last().setInputFiles(videoPath);
      }
    }

    const uploadDeadline = Date.now() + 120000;
    while (Date.now() < uploadDeadline) {
      const feedback = (await visibleFeedback(page)).join(' ');
      if (/视频.*失败|上传失败|格式不支持|超过.*(?:MB|M)|upload failed/i.test(feedback)) {
        throw new Error(`国际站主图视频上传失败：${compactText(feedback, 300)}`);
      }
      const stillEmpty = await page.locator('.uploader-video-not-select .video-upload-placeholder').isVisible().catch(() => false);
      if (!stillEmpty) return 1;
      await page.waitForTimeout(800);
    }
    throw new Error('国际站主图视频上传超过 120 秒仍未完成');
  }

  async waitForMainImageUploads(page, expectedCount) {
    const uploadDeadline = Date.now() + 60000;
    while (Date.now() < uploadDeadline) {
      const remainingSlots = await page.locator([
        '.image-upload-list-item #image-placeholder-span',
        '.image-upload-list-item #image-placeholder-icon',
        '.image-upload-list-item .image-upload-photobank-placeholder'
      ].join(', ')).count().catch(() => 6);
      const feedback = (await visibleFeedback(page)).join(' ');
      if (/上传失败|文件.*过大|图片.*不符合|upload failed/i.test(feedback)) {
        throw new Error(`国际站主图上传失败：${compactText(feedback, 300)}`);
      }
      if (remainingSlots <= Math.max(0, 6 - expectedCount)) return expectedCount;
      await page.waitForTimeout(500);
    }
    throw new Error('国际站主图上传超过 60 秒仍未完成');
  }

  async fillProductFields(page, product) {
    const categoryPath = sanitizeCategoryPath(product.sourceCategoryPath || product.categoryPath);
    const productTypeCandidate = [product.productType, ...categoryPath.slice().reverse()].find((value) => value && !isPromotionalText(value));
    const productType = englishSpecText(productTypeCandidate, 'Other');
    await fillChoice(page, await fieldByLabel(page, '产品类型'), productType || 'Other');
    await fillChoice(page, await fieldByLabel(page, '产地'), product.origin || 'China');
    await fillFirst(page, ['input[name="p-3"]'], product.model || attributeValue(product, '型号', 'Model Number'));
    await fillFirst(page, ['input[name="p-2"]'], product.brand || attributeValue(product, '品牌名称', 'Brand Name'));
    await fillFirst(page, ['input[name="p-373265001"]'], englishSpecText(attributeValue(product, '功能/特性', 'Feature')));
    await fillFirst(page, ['input[name="p-390873113"]'], englishSpecText(attributeValue(product, '材料', 'Material')));

    const reserved = /^(?:型号|model(?: number)?|品牌名称|brand(?: name)?|功能\/特性|feature|材料|material|颜色|colou?r|产地|place of origin|产品类型|product type)$/i;
    const mappedAttributes = [];
    const unmappedAttributes = [];
    for (const [index, item] of [...(product.attributes || []), ...(product.customAttributes || [])].entries()) {
      if (!item?.name || !item?.value || reserved.test(String(item.name).trim())) continue;
      const labels = [String(item.name).trim(), englishAttributeName(item.name, index)];
      const field = await fieldByAnyLabel(page, [...new Set(labels)]);
      if (!field) { unmappedAttributes.push(item.name); continue; }
      const value = englishSpecText(item.value, 'Other');
      const filled = await fillChoice(page, field, value).catch(() => false);
      if (filled) mappedAttributes.push(item.name);
      else unmappedAttributes.push(item.name);
    }

    const colorGroup = (product.variantGroups || []).find((group) => /颜色|colou?r/i.test(group.name));
    const colorValues = colorGroup?.options?.length ? colorGroup.options : ['Black'];
    await enableSpecImageUpload(
      page,
      product,
      colorGroup,
      (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit)
    );
    const variantResult = await fillVariantSpecs(page, product.variantGroups);
    const colorControlSelector = [
      '.posting-field-color-select input[role="colorCombobox"]',
      '.posting-feild-color-select input[role="colorCombobox"]',
      '.posting-feild-color-item input[role="colorCombobox"]',
      '.posting-feild-color-item-container input[role="colorCombobox"]',
      '.posting-field-color-select input[placeholder*="请输入"]',
      '.posting-feild-color-select input[placeholder*="请输入"]',
      '.posting-feild-color-item input[placeholder*="请输入"]',
      '.posting-feild-color-item-container input[placeholder*="请输入"]'
    ].join(', ');
    const colorControl = await firstVisible(page, [colorControlSelector]);
    // Color is optional at the source level and not every Alibaba category
    // exposes it as a target specification. Only require a successful add
    // when the selected target category actually renders a visible color
    // control; hidden template inputs must never block a publish job.
    const colorFilled = colorControl ? await fillColorSpec(page, colorValues) : true;
    if (colorControl && !colorFilled) {
      throw new Error('国际站颜色规格未成功添加，请检查颜色输入框和“添加”按钮');
    }

    const packaging = product.packaging || {};
    await fillFirst(page, ['input[name="pkgWeight"]'], packaging.weight);
    const packageFields = [
      ['长(CM/Piece)', packaging.length], ['宽(CM/Piece)', packaging.width], ['高(CM/Piece)', packaging.height]
    ];
    for (const [label, value] of packageFields) {
      const field = await fieldByLabel(page, label);
      if (field && value) await fillAndVerify(field, value, label);
    }

    await page.waitForTimeout(500);
    const deliveryTiers = parseDeliveryTiers(product.deliveryTime);
    const deliveryInputs = page.locator('#struct-ladderPeriod input:not([type="hidden"])');
    const deliveryCount = await deliveryInputs.count().catch(() => 0);
    // Alibaba renders each delivery row as two inputs: quantity upper bound
    // followed by lead-time days. Keep the source quantity ranges intact;
    // writing the day value into every input changes 1-50 into 1-14.
    for (let index = 0; index < deliveryTiers.length && index * 2 + 1 < deliveryCount; index += 1) {
      const tier = deliveryTiers[index];
      const quantityInput = deliveryInputs.nth(index * 2);
      const daysInput = deliveryInputs.nth(index * 2 + 1);
      if (tier.upperQuantity != null && await quantityInput.isVisible().catch(() => false)) {
        await fillAndVerify(quantityInput, tier.upperQuantity, '交期数量').catch(() => {});
      }
      if (tier.leadDays && await daysInput.isVisible().catch(() => false)) {
        await fillAndVerify(daysInput, tier.leadDays, '交期天数').catch(() => {});
      }
    }
    return { mappedAttributes, unmappedAttributes: [...unmappedAttributes, ...variantResult.unmapped] };
  }

  async fillPriceFields(page, product) {
    const validTiers = (product.priceTiers || [])
      .filter((tier) => numericValue(tier.price) > 0 && numericValue(tier.minQuantity) > 0)
      .sort((left, right) => numericValue(left.minQuantity) - numericValue(right.minQuantity));
    const tiers = validTiers.length ? validTiers : [{ price: product.price, minQuantity: product.moq || 1 }];
    let priceInputs = page.locator('[role="input-price"]');
    let quantityInputs = page.locator('[role="input-quantity"]');

    while (Math.min(await priceInputs.count().catch(() => 0), await quantityInputs.count().catch(() => 0)) < tiers.length) {
      const add = page.getByText(/新增价格区间|添加价格区间|Add price range/i).last();
      if (!await add.isVisible().catch(() => false)) break;
      await add.click({ force: true });
      await page.waitForTimeout(350);
      priceInputs = page.locator('[role="input-price"]');
      quantityInputs = page.locator('[role="input-quantity"]');
    }

    const rowCount = Math.min(
      tiers.length,
      await priceInputs.count().catch(() => 0),
      await quantityInputs.count().catch(() => 0)
    );
    if (!rowCount) {
      await fillFirst(page, ['input[placeholder*="价格"]', 'input[placeholder*="price" i]'], product.price);
      await fillFirst(page, ['input[placeholder*="起订"]', 'input[placeholder*="quantity" i]'], tiers[0].minQuantity);
      return;
    }
    for (let index = 0; index < rowCount; index += 1) {
      await fillAndVerify(quantityInputs.nth(index), tiers[index].minQuantity, `第 ${index + 1} 档起订量`);
      await fillAndVerify(priceInputs.nth(index), tiers[index].price, `第 ${index + 1} 档价格`);
      await commitControlledInput(quantityInputs.nth(index), tiers[index].minQuantity);
      await commitControlledInput(priceInputs.nth(index), tiers[index].price);
    }
    // The international form can retain a blank trailing range after adding
    // rows. Alibaba validates that row too, so remove empty ranges before the
    // submit/save action instead of letting it surface as a misleading MOQ
    // error.
    const rows = page.locator('tr[role="row"]:has([role="input-quantity"]):has([role="input-price"])');
    for (let index = (await rows.count().catch(() => 0)) - 1; index >= tiers.length; index -= 1) {
      const row = rows.nth(index);
      const quantity = String(await row.locator('[role="input-quantity"]').inputValue().catch(() => '')).trim();
      const price = String(await row.locator('[role="input-price"]').inputValue().catch(() => '')).trim();
      if (quantity || price) continue;
      const remove = row.locator('[role="remove"], button').last();
      if (await remove.isVisible().catch(() => false) && !await remove.isDisabled().catch(() => true)) {
        await remove.click({ force: true }).catch(() => {});
        await page.waitForTimeout(200);
      }
    }
    if (rowCount < tiers.length) throw new Error(`国际站价格表仅识别到 ${rowCount} 档，商品需要 ${tiers.length} 档`);
  }

  async fillLegacyDescription(page, product) {
    await switchToLegacyDetails(page);
    const html = buildLegacyDescriptionHtml(product);
    const editorDeadline = Date.now() + 15000;
    while (Date.now() < editorDeadline) {
      for (const frame of page.frames()) {
        const body = frame.locator('body.mce-content-body, body[contenteditable="true"]');
        if (!await body.isVisible().catch(() => false)) continue;
        await body.evaluate((node, value) => {
          node.innerHTML = value;
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          node.dispatchEvent(new Event('blur', { bubbles: true }));
        }, html);
        const synced = await page.evaluate((value) => {
          const editors = [...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])];
          const editor = editors.find((item) => item && !item.hidden);
          if (!editor) return false;
          editor.setContent(value);
          editor.save();
          editor.fire('input');
          editor.fire('change');
          editor.fire('blur');
          return true;
        }, html).catch(() => false);
        if (!synced) {
          const frameElement = await frame.frameElement().catch(() => null);
          const frameId = await frameElement?.getAttribute('id').catch(() => '');
          const editorId = String(frameId || '').replace(/_ifr$/, '');
          if (editorId) {
            await page.locator(`#${editorId}`).evaluate((node, value) => {
              node.value = value;
              node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            }, html).catch(() => {});
          }
        }
        await this.uploadLegacyDetailImages(page, product);
        return true;
      }
      await page.waitForTimeout(400);
    }
    const editable = await firstVisible(page, ['[contenteditable="true"]']);
    if (editable) {
      await editable.evaluate((node, value) => {
        node.innerHTML = value;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }, html);
      return true;
    }
    throw new Error('未识别到国际站商品详情编辑器');
  }

  async uploadLegacyDetailImages(page, product) {
    const imagePaths = await this.downloadImageSet(product, product.detailImages || [], 'detail', 15);
    if (!imagePaths.length) throw new Error('详情图下载失败，无法上传到国际站普通编辑器');
    let uploadButton = null;
    const toolbarDeadline = Date.now() + 15000;
    while (Date.now() < toolbarDeadline) {
      const candidate = page.locator('[role="button"][aria-label="从我的电脑选择图片"]').first();
      if (await candidate.isVisible().catch(() => false)) {
        uploadButton = candidate;
        break;
      }
      await page.waitForTimeout(350);
    }
    if (!uploadButton) {
      throw new Error('未识别到普通编辑器的本地图片上传按钮');
    }

    const uploadBatch = async (paths) => {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
      await uploadButton.click({ force: true });
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(chooser.isMultiple() ? paths : [paths[0]]);
        return chooser.isMultiple();
      }
      const inputs = page.locator('input[type="file"][accept*="image"]');
      const count = await inputs.count().catch(() => 0);
      if (count) {
        const input = inputs.nth(count - 1);
        const supportsMultiple = await input.getAttribute('multiple') !== null;
        await input.setInputFiles(supportsMultiple ? paths : [paths[0]]);
        return supportsMultiple;
      }

      const frameDeadline = Date.now() + 10000;
      let uploaderFrame = null;
      while (Date.now() < frameDeadline) {
        uploaderFrame = page.frames().find((frame) => /photobank\.alibaba\.com\/uploader\.htm/i.test(frame.url()));
        if (uploaderFrame) break;
        await page.waitForTimeout(250);
      }
      if (!uploaderFrame) throw new Error('普通编辑器图片上传弹窗未加载完成');
      const frameInputs = uploaderFrame.locator('input[type="file"]');
      const frameInputCount = await frameInputs.count().catch(() => 0);
      if (!frameInputCount) {
        const frameText = compactText(await uploaderFrame.locator('body').innerText().catch(() => ''), 500);
        throw new Error(`图片银行上传器没有文件输入框${frameText ? `：${frameText}` : ''}`);
      }
      const frameInput = frameInputs.nth(frameInputCount - 1);
      const supportsMultiple = await frameInput.getAttribute('multiple') !== null;
      await frameInput.setInputFiles(supportsMultiple ? paths : [paths[0]]);
      return supportsMultiple;
    };

    const multiple = await uploadBatch(imagePaths);
    if (!multiple) {
      for (const imagePath of imagePaths.slice(1)) {
        await page.waitForTimeout(600);
        await uploadBatch([imagePath]);
      }
    }

    const deadline = Date.now() + 90000;
    let uploaderAction = '';
    let uploaderActionAt = 0;
    while (Date.now() < deadline) {
      let editorImages = 0;
      for (const frame of page.frames()) {
        const body = frame.locator('body.mce-content-body');
        if (!await body.isVisible().catch(() => false)) continue;
        editorImages = await body.locator('img').count().catch(() => 0);
        if (editorImages >= imagePaths.length) {
          await page.evaluate(() => {
            const editor = (window.tinymce?.editors || []).find((item) => item && !item.hidden);
            editor?.save();
            editor?.fire('change');
          }).catch(() => {});
          await this.closeImageUploaderDialog(page);
          return editorImages;
        }
      }

      const uploaderFrame = page.frames().find((frame) => /photobank\.alibaba\.com\/uploader\.htm/i.test(frame.url()));
      if (uploaderFrame) {
        const uploaderText = await uploaderFrame.locator('body').innerText().catch(() => '');
        if (/图片银行空间已满/.test(uploaderText)) {
          const close = page.locator('.mce-window .mce-close').last();
          if (await close.isVisible().catch(() => false)) await close.click({ force: true }).catch(() => {});
          await page.waitForTimeout(500);
          const appended = await this.appendUploadedMainImagesToDescription(page, product);
          await this.closeImageUploaderDialog(page);
          return appended;
        }
        const actionNames = [
          { key: '确认上传', pattern: /^确认上传/ },
          { key: '开始上传', pattern: /^开始上传/ },
          { key: '上传', pattern: /^上传$/ },
          { key: '确定', pattern: /^确定$/ },
          { key: '完成', pattern: /^完成$/ },
          { key: '插入', pattern: /^插入$/ },
          { key: '确认', pattern: /^确认$/ }
        ];
        for (const { key, pattern } of actionNames) {
          const action = uploaderFrame.getByRole('button', { name: pattern }).last();
          const textAction = uploaderFrame.getByText(pattern).last();
          const target = await action.isVisible().catch(() => false) ? action : textAction;
          if (!await target.isVisible().catch(() => false)) continue;
          const disabled = await target.isDisabled().catch(() => false);
          if (disabled || (uploaderAction === key && Date.now() - uploaderActionAt < 2500)) continue;
          await target.click({ force: true }).catch(() => {});
          await target.evaluate((node) => node.click()).catch(() => {});
          uploaderAction = key;
          uploaderActionAt = Date.now();
          await page.waitForTimeout(1200);
          break;
        }
      }
      const feedback = (await visibleFeedback(page)).join(' ');
      if (/上传失败|图片.*失败|文件.*过大/i.test(feedback)) {
        throw new Error(`国际站详情图上传失败：${compactText(feedback, 300)}`);
      }
      await page.waitForTimeout(700);
    }
    const uploaderFrame = page.frames().find((frame) => /photobank\.alibaba\.com\/uploader\.htm/i.test(frame.url()));
    const buttons = uploaderFrame ? await uploaderFrame.locator('button, [role="button"], input[type="button"], input[type="submit"]').evaluateAll((nodes) => nodes.map((node) => ({
      text: String(node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
      visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
      className: String(node.className || '').slice(0, 120)
    })).filter((item) => item.visible)) : [];
    const uploaderText = uploaderFrame ? compactText(await uploaderFrame.locator('body').innerText().catch(() => ''), 1200) : '';
    throw new Error(`国际站详情图上传超过 90 秒仍未完成（共 ${imagePaths.length} 张；上传器按钮 ${JSON.stringify(buttons)}；${uploaderText}）`);
  }

  async closeImageUploaderDialog(page) {
    const close = page.locator('.mce-window .mce-close, [role="dialog"] [aria-label="关闭"], [role="dialog"] [aria-label="Close"]').last();
    if (await close.isVisible().catch(() => false)) await close.click({ force: true }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(350);
  }

  async appendUploadedMainImagesToDescription(page, product) {
    const urls = await page.locator('.image-upload-list img[src]').evaluateAll((nodes) => [...new Set(nodes
      .map((node) => node.currentSrc || node.src || '')
      .filter((url) => /^https?:\/\//i.test(url)))].slice(0, 6)).catch(() => []);
    if (!urls.length) return 0;
    const inserted = await page.evaluate(({ imageUrls, title }) => {
      const editor = (window.tinymce?.editors || []).find((item) => item && !item.hidden);
      if (!editor) return false;
      const images = imageUrls.map((url) => `<p><img src="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" style="max-width:100%;height:auto" alt="${title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></p>`).join('');
      editor.setContent(`${editor.getContent()}${images}`);
      editor.save();
      editor.fire('input');
      editor.fire('change');
      editor.fire('blur');
      return true;
    }, { imageUrls: urls, title: product.title }).catch(() => false);
    return inserted ? urls.length : 0;
  }

  async publishProduct(product, publishPageUrl, mode = 'draft', publishCategory = '') {
    if (!publishPageUrl) throw new Error('尚未绑定阿里巴巴国际站商品发布页面');
    if (!isProductPostingUrl(publishPageUrl)) throw new Error('绑定地址不是阿里巴巴国际站商品发布页');
    const mismatch = categoryMismatchMessage(product, publishCategory);
    if (mismatch) throw new Error(mismatch);
    const validationErrors = validateProductData(product);
    if (validationErrors.length) throw new Error(`商品资料未通过上架检查：${validationErrors.join('；')}`);
    const page = await this.currentSellerPage();
    await page.goto(publishPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settlePage(page);
    await waitForHumanVerification(page, { timeout: 300000 });
    if (/login|passport/i.test(page.url())) throw new Error('阿里巴巴国际站登录状态已失效，请重新登录');
    if (/\/product\/(?:easyListing|category)\.htm/i.test(new URL(page.url()).pathname)) {
      throw new Error('绑定的是商品类目选择页，不是商品填写表单。请先完成类目选择后重新绑定');
    }

    const titleInput = await waitForFirstVisible(page, TITLE_SELECTORS, 30000);
    if (!titleInput) throw new Error('等待 30 秒后仍未识别到标题输入框，请确认国际站表单已加载完成');
    await fillAndVerify(titleInput, product.title, '商品标题');

    if (product.subtitle) {
      const subtitleInput = await firstVisible(page, [
        'input[placeholder*="副标题"]', 'textarea[placeholder*="副标题"]',
        'input[placeholder*="subtitle" i]', 'textarea[placeholder*="subtitle" i]', 'input[name*="subTitle" i]'
      ]);
      if (subtitleInput) await fillAndVerify(subtitleInput, product.subtitle, '商品副标题').catch(() => {});
    }

    const keywordInput = await firstVisible(page, [
      'textarea[placeholder*="修饰词+产品中心词"]', 'textarea[role="input"]'
    ]);
    if (keywordInput) {
      const keywords = (product.keywords || []).length
        ? product.keywords.slice(0, 10).join('\n')
        : product.title.split(/\s+/).filter((word) => word.length > 2).slice(0, 8).join(' ');
      await fillAndVerify(keywordInput, keywords, '商品关键词').catch(() => {});
    }

    await this.fillPriceFields(page, product);
    await fillFirst(page, [
      'input[placeholder="输入数量"]',
      'input[placeholder*="库存"]', 'input[placeholder*="stock" i]', 'input[placeholder*="quantity" i]', 'input[name*="stock" i]',
      '[class*="stock"] input[type="text"]', '[class*="stock"] input[type="number"]'
    ], product.stock);
    const fieldMapping = await this.fillProductFields(page, product);
    if (mode === 'submit') {
      const unmappedRequiredVariant = fieldMapping.unmappedAttributes.find((item) => /^.+:\s*.+$/.test(String(item)));
      if (unmappedRequiredVariant) {
        throw new Error(`国际站目标类目没有与来源规格“${unmappedRequiredVariant}”一致的选项；为保证数据不被篡改，请先在发布页选择匹配类目或人工映射后再提交`);
      }
    }
    await this.uploadMainImages(page, product);
    let videoWarning = '';
    try {
      await this.uploadMainVideo(page, product);
    } catch (error) {
      videoWarning = `主图视频未进入视频银行，已保留在商品详情链接中：${error.message}`;
      await page.keyboard.press('Escape').catch(() => {});
      const close = page.locator('.next-dialog-close, .next-overlay-close, [aria-label="关闭"], [aria-label="close" i]').last();
      if (await close.isVisible().catch(() => false)) await close.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await this.fillLegacyDescription(page, product);

    const agreementText = page.getByText(/请再次检查并确认提交的信息真实、合法和有效/).last();
    if (await agreementText.isVisible().catch(() => false)) {
      const agreementContainer = agreementText.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]');
      const agreement = agreementContainer.locator('input[type="checkbox"]').first();
      if (await agreement.count().catch(() => 0) && !await agreement.isChecked().catch(() => false)) {
        await agreement.check({ force: true }).catch(() => agreementText.click().catch(() => {}));
      }
    }

    const buttonTexts = mode === 'submit'
      ? ['发布商品', '确认发布', '提交审核', '立即发布', '提交', 'Submit', 'Post Product', 'Publish']
      : ['保存草稿', '存为草稿', '暂存草稿', '保存', 'Save as Draft', 'Save Draft', 'Save'];
    let action = null;
    for (const text of buttonTexts) {
      const button = page.getByRole('button', { name: text, exact: false }).last();
      if (await button.isVisible().catch(() => false)) { action = button; break; }
    }
    if (!action) {
      await revealPage(page);
      this.visible = true;
      return { status: 'needs_review', message: '表单已填充，未识别到保存或发布按钮，请在浏览器中人工确认' };
    }
    const originalUrl = page.url();
    const verification = await waitForActionResult(page, action, mode, originalUrl);
    return {
      status: mode === 'submit' ? 'published' : 'drafted',
      message: `${mode === 'submit' ? '已提交发布' : '已保存草稿'}${videoWarning ? '（主图视频已降级为详情链接）' : ''}`,
      url: page.url(),
      verifiedBy: verification.verifiedBy,
      feedback: verification.feedback,
      fieldMapping,
      warnings: [videoWarning, fieldMapping.unmappedAttributes.length ? `${fieldMapping.unmappedAttributes.length} 个来源属性未在当前类目表单中找到对应字段` : ''].filter(Boolean)
    };
  }
}
