import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as waitForImageRetry } from 'node:timers/promises';
import { assertCollectionActive, trackCollectionPage } from './collection-control.js';
import { sanitizeTemplateHtml, templatePublishHtml, placeTemplateImages } from './description-templates.js';
import { readSellerReference } from './seller-reference.js';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { load } from 'cheerio';
import { hasExplicitHumanChallenge, hidePage, launchPersistent, revealPage, settlePage, syncAlibabaCookies, waitForHumanVerification } from './browser-runtime.js';
import { extractAlibabaDescription, extractAlibabaSourceData, parseAlibabaDetailDataScript, readAlibabaCategoryDocument, readAlibabaAvailabilityText, requireAlibabaSourceProduct } from './alibaba-source-data.js';
import { SOURCE_LANGUAGE_HEADERS, withSourceLocale } from './source-locale.js';
import { buildAlibabaPublishUrl, categoryIdFromUrl, normalizeCategoryId } from './category-routing.js';
import { REQUIRED_ATTRIBUTE_ALIASES, requiredAttributeKey } from './publish-reference.js';
import { attributeOptionMatchScore, attributeValueList, attributeTextValue } from './attribute-values.js';
export { attributeOptionMatchScore } from './attribute-values.js';
import { sourcePlatform, crossPlatformPublishErrors } from './source-platform.js';
import { MAIN_IMAGE_VALIDATION_TEXT, SPECIFICATION_IMAGE_REQUIRED_TEXT, submitWithRepairs } from './publish-recovery.js';
import { createAttributeAiSession } from './ai-publishing.js';
import { packagingParentConflict, packagingUseFromEvidence, postingAttributeSource } from './packaging-use-evidence.js';
import { readPostingLogistics, logisticsControlValue, missingLogisticsFields, fillLogisticsAttributes, sourceLogisticsAttributes, capturePostingLogistics, capturePostingDelivery, isLogisticsReadinessHint } from './posting-logistics.js';
import { applyStockPolicy, normalizeListingMode, packagingDisplayRows, freightTemplateForProduct, cartonModeForProduct, DEFAULT_FREIGHT_TEMPLATE } from './publish-policy.js';
import { readSellerGroups, applySellerGroup } from './seller-groups.js';
import { ImageDownloadQueue } from './image-download-queue.js';
import { ORIGIN_COUNTRIES, originCountry, isOriginAttribute, isOriginRegionAttribute, isCountryOnlyOrigin, productOrigin, productOriginText, originValueForField, isLiteralOriginField, sourceOriginRegion, synchronizeProductOrigin } from './origin-country.js';
import { uploadEditorDetailImages } from './description-image-upload.js';
import { descriptionImageSlots, descriptionContainsText, restoreDescriptionImages } from './description-layout.js';
import { prepareLegacyDescriptionText, recordLegacyDescriptionText, legacyDescriptionTextConversions } from './description-text-compatibility.js';
import { readPostingFieldFeedback } from './publish-diagnostics.js';
import { fillStructuredDescription, structuredHighlightText, acceptedStructuredHighlights, requireAcceptedNativeDescription, requireStructuredDescriptionReady } from './structured-description.js';
import { ensureSourceDescriptionMode, requireSourceDescriptionMode, descriptionCompatibility } from './description-mode.js';
import { compatibleLegacyDescriptionHtml, acceptCompatibleLegacyDescription, requireCompatibleLegacyDescription } from './description-compatibility.js';
import { currentDescriptionStructure, extractDescriptionStructure, descriptionSourceHash, nativeDescriptionImageUrls, syncStructuredDescriptionImages } from './description-structure.js';
import { alibabaKeywordText } from './product-keywords.js';
import { fillCustomAttributes, requireCustomAttributes } from './custom-attributes.js';
import { isPublicProductAttribute, planPublicAttributeTransfer, requirePublicAttributeValues } from './attribute-transfer.js';
export { alibabaKeywordText } from './product-keywords.js';
import { fillReferencedSkuRows, findSkuAttributeEntry, reconcileSkuMinimumOrder, selectSkuPricing, usesSkuPricing } from './sku-reference.js';
import { recoverDuplicateSkuDimensions } from './sku-dimensions.js';
import { recoverDuplicateSkuOptions } from './sku-options.js';
import { actionReceipt } from './posting-receipt.js';
import { fillSalesUnit, requireSalesUnit } from './posting-sales-unit.js';
import { findNormalDescriptionControl, findPostingTitle, requirePostingPageAvailable, revealDescriptionSection, waitForDescriptionEditor, waitForPostingTitle } from './posting-readiness.js';
import { readSourceDescriptionFrame, waitForSourceDetailVideos } from './source-description-frame.js';
import { collectSourceAttributeSections } from './source-attributes.js';
import { fillOptionalServices, fillRegionalPrices } from './posting-extras.js';
import { readPostingVideoState, videoUnavailableError, browserVideoResponse, productForVideoUpload, productVideoUploads, videoResourceKey, combineVideoAssociations, resolveCollectedVideos, requireSupportedVideoPlan, newlyAcceptedVideo, requireAcceptedInlineVideo } from './posting-video.js';
import { prepareBankVideo, completePublishedVideo } from './posting-video-bank.js';
import { fillCustomizationHotspot, uploadCustomizationImage } from './posting-customization-media.js';
import { categoryRequirementSchema, postingSchemaWithKnownLabels } from './category-readiness.js';
import { browserResourcePolicy } from './browser-resource-policy.js';
import { browserStep } from './browser-step.js';
import { choosePostingFile, clickPostingControl as performPostingClick, configurePostingInteractions, postingInteractionFailure } from './posting-interaction.js';
import { acknowledgePolicyWarning, acknowledgeSalesRules, isBlockingPolicyFeedback, POLICY_WARNING_TEXT, POLICY_RULE_CONFIRMATION_TEXT, policyAcknowledgements, policyWarningPublishingAllowed, requireNoPolicyWarning, withPostingPolicy } from './posting-policy.js';
import { attributeMenuForControl, closePostingAttributeMenus, POSTING_DIALOG, targetPopupContext, VISIBLE_ATTRIBUTE_MENU } from './posting-popups.js';
export { closePostingAttributeMenus } from './posting-popups.js';
import { isBrowserInteractionError, userFacingError } from './browser-error.js';
import { ensureSimplifiedChinese } from './posting-language.js';
import { attributeId, extractAlibabaAttributes, mergeSourceAttributes, packagingFromAttributes, readAlibabaAttributeRows, readPostingAttributeSchema, sourceAttributeForField, sourceSpecificationForField, SOURCE_ATTRIBUTE_SCHEMA_VERSION, bindSourceAttributesToPostingSchema } from './category-attributes.js';

const WORKBENCH_URL = 'https://i.alibaba.com/';
const imageDownloadContext = new AsyncLocalStorage();
const imageDownloadSignalIds = new WeakMap();
const SOURCE_DESCRIPTION_SELECTOR = '[data-module-name^="module_structure_descption_"], [data-module-name="module_description"], [data-testid="module-description"], [data-module-name="module_structure_description"], [data-testid="module-details-structure-description"]';

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
  let description = String(product.description || '').replace(/供应商的产品说明\s*报告可疑活动/gi, '').trim();
  const descriptionStructure = currentDescriptionStructure(product);
  const descriptionHtml = product.descriptionTemplate ? sanitizeTemplateHtml(product.descriptionHtml || '') : sanitizeSourceDescriptionHtml(product.descriptionHtml || '');
  if (/with\s*\(document\)|insertBefore\s*\(createElement\(['"]script/i.test(description)) {
    description = descriptionHtml ? load(descriptionHtml).text().replace(/\s+/g, ' ').trim() : '';
  }
  const sourceCategoryId = normalizeCategoryId(product.sourceCategoryId || product.categoryId);
  return {
    ...product,
    ...(categoryPath.length ? { sourceCategoryPath: categoryPath } : {}),
    ...(sourceCategoryId ? { sourceCategoryId, categoryId: product.categoryId || (sourcePlatform(product) === 'alibaba.com' ? sourceCategoryId : '') } : {}),
    productType, keywords, subtitle, description,
    ...(product.detailImages ? { detailImages: nativeDescriptionImageUrls(product, descriptionStructure) } : {}),
    ...(descriptionHtml ? { descriptionHtml } : {}),
    ...(descriptionStructure ? { structuredDescription: { ...descriptionStructure, sourceHtmlHash: descriptionSourceHash(descriptionHtml) } } : {})
  };
}

const CATEGORY_LEAF_ALIASES = new Map([
  ['drones accessories', 'drones accessories'], ['无人机配件', 'drones accessories'],
  ['camera photo accessories', 'camera photo accessories'], ['相机照片配件', 'camera photo accessories'],
  ['other consumer electronics', 'other consumer electronics'], ['其他消费电子产品', 'other consumer electronics'],
  ['rugged phone', 'rugged phone'], ['坚固型手机', 'rugged phone'],
  ['feature phone', 'feature phone'], ['功能机', 'feature phone'],
  ['motor controllers', 'motor controllers'], ['motor controller', 'motor controllers'], ['电机控制器', 'motor controllers'],
  ['microphones', 'microphones'], ['microphone', 'microphones'], ['麦克风', 'microphones'],
  ['motor drivers', 'motor drivers'], ['motor driver', 'motor drivers'], ['电机驱动器', 'motor drivers'],
  ['battery chargers', 'battery chargers'], ['battery charger', 'battery chargers'], ['电池充电器', 'battery chargers']
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
    const upperMatch = text.match(/(?:^|[-–])\s*([\d,]+)\s*$/);
    const upperQuantity = upperMatch ? Number(upperMatch[1].replace(/,/g, '')) : null;
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
  if (/\b(?:smartphone|(?:mobile|cell) phone|phone 1[0-9]|1[0-9]pro)\b/i.test(title)
    && /drones? accessories|无人机配件/i.test(category || '')) {
    return '手机商品不能使用无人机配件类目；引用模板的类目与商品不符，请恢复手机类目或选择同类目成功商品';
  }
  const targetPath = sanitizeCategoryPath(product?.categoryPath);
  const sourcePath = sanitizeCategoryPath(product?.sourceCategoryPath);
  const expectedPath = targetPath.length ? targetPath : sourcePlatform(product) === 'alibaba.com' ? sourcePath : [];
  const actualPath = String(category || '').split(/\s*(?:>>|>|\/|\\)\s*/).map((value) => value.trim()).filter(Boolean);
  if (expectedPath.length && actualPath.length) {
    const expectedLeaf = canonicalCategoryLeaf(expectedPath.at(-1));
    const actualLeaf = canonicalCategoryLeaf(actualPath.at(-1));
    if (expectedLeaf && actualLeaf && expectedLeaf !== actualLeaf) {
      return `当前发布类目“${category}”与商品目标类目“${expectedPath.join(' >> ')}”不一致，系统已停止本次提交，请重新采集类目 ID 后重试`;
    }
    // Alibaba's UI is localized; compare the full path only when leaves are
    // not covered by a known translation alias. A translated leaf match is
    // sufficient because the platform's catId is the authoritative route.
    if (expectedLeaf && actualLeaf && expectedLeaf === actualLeaf) return '';
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

export async function fillAndVerify(locator, value, fieldName) {
  const expected = String(value ?? '').trim();
  const matches = (actual) => {
    const normalized = String(actual ?? '').trim();
    if (normalized === expected) return true;
    const expectedNumber = Number(expected);
    const numericText = /^[-+]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
    const actualNumber = Number(normalized.replace(/,/g, ''));
    return expected !== '' && numericText.test(expected) && numericText.test(normalized)
      && Number.isFinite(expectedNumber) && Number.isFinite(actualNumber) && expectedNumber === actualNumber;
  };
  let actual = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt === 0) await locator.fill(expected).catch(() => {});
    else if (attempt === 1) {
      await locator.evaluate((node, nextValue) => {
        const prototype = node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        const previous = node.value;
        setter?.call(node, nextValue);
        node._valueTracker?.setValue?.(previous);
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }, expected).catch(() => {});
    } else {
      await locator.click({ force: true }).catch(() => {});
      await locator.press('Control+A').catch(() => {});
      await locator.pressSequentially(expected, { delay: 25 }).catch(() => {});
    }
    await locator.press('Tab').catch(() => {});
    await locator.page().waitForTimeout(250);
    actual = (await locator.inputValue().catch(() => '')).trim();
    if (matches(actual)) return;
  }
  if (!matches(actual)) {
    await locator.evaluate((node, nextValue) => {
      const prototype = node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      const previous = node.value;
      setter?.call(node, nextValue);
      node._valueTracker?.setValue?.(previous);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.blur();
    }, expected).catch(() => {});
    await locator.page().waitForTimeout(150);
    actual = (await locator.inputValue().catch(() => '')).trim();
  }
  if (!matches(actual)) throw Object.assign(new Error(`${fieldName}写入后未能确认保留，输入框可能正在刷新；已保留当前商品，可继续重试`),
    { code: 'PUBLISH_FIELD_NOT_READY', fieldName });
}

export async function fillProductKeywords(page, product) {
  if (!alibabaKeywordText(product)) return false;
  const selector = '.posting-field-keywords textarea, #struct-keywords textarea, '
    + 'textarea[placeholder*="修饰词+产品中心词"], textarea[placeholder*="keyword" i], '
    + 'textarea[name="keywords" i], input[name="keywords" i]';
  // Filter before first(): React can remove hidden clones while committing a
  // value. A stored nth(1) then points to nothing even though the field exists.
  const editable = page.locator(selector.split(',').map((part) => `${part.trim()}:not([disabled]):not([readonly])`).join(',')).filter({ visible: true }).first();
  if (!await editable.count()) return acceptedStructuredHighlights(page, product);
  await fillAndVerify(editable, alibabaKeywordText(product), '商品关键词');
  if (!await closePostingAttributeMenus(page)) {
    throw Object.assign(new Error('商品关键词填写尚未完成，已保留当前商品进度'),
      { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '商品关键词' });
  }
  await requireClearPostingOverlays(page);
  return true;
}

export async function fillProductSubtitle(page, product) {
  if (!String(product.subtitle || '').trim()) return false;
  const field = await firstVisible(page, [
    '#struct-productSubTitle input:not([disabled]):not([readonly])',
    '#struct-productSubTitle textarea:not([disabled]):not([readonly])',
    'input[placeholder*="副标题"]', 'textarea[placeholder*="副标题"]',
    'input[placeholder*="subtitle" i]', 'textarea[placeholder*="subtitle" i]', 'input[name*="subTitle" i]'
  ]);
  if (!field || !await field.isEditable()) return acceptedStructuredHighlights(page, product);
  await fillAndVerify(field, product.subtitle, '商品副标题');
  return true;
}

export async function gotoWithRetry(page, url, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 4));
  const navigationOptions = {
    waitUntil: options.waitUntil || 'domcontentloaded',
    timeout: options.timeout || 60000
  };
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' });
    try {
      return await page.goto(url, navigationOptions);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const navigationTimeout = /^page\.goto:\s*Timeout\s+\d+ms\s+exceeded/i.test(message);
      const navigationInterrupted = /^page\.goto:.*(?:interrupted by another navigation|net::ERR_ABORTED)/i.test(message);
      const transient = /ERR_(?:CONNECTION_(?:CLOSED|RESET|ABORTED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED|HTTP2_PROTOCOL_ERROR|SOCKET_NOT_CONNECTED)/i.test(message)
        || (options.retryTimeout && navigationTimeout)
        || (options.retryInterrupted && navigationInterrupted);
      if (options.signal?.aborted) throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED', cause: error });
      if (!transient || attempt === attempts - 1 || page.isClosed()) {
        if (options.retryInterrupted && navigationInterrupted && !page.isClosed()) {
          throw Object.assign(new Error('国际站打开新商品页面时发生跳转冲突，尚未填写或提交本商品；请重试该商品'), {
            code: 'PUBLISH_NAVIGATION_INTERRUPTED', cause: error,
            diagnostics: { navigationError: message, targetUrl: url, attempts: attempt + 1 },
          });
        }
        if (options.retryTimeout && navigationTimeout && !page.isClosed()) {
          throw Object.assign(new Error('国际站发布页加载超时，尚未填写或提交商品；请检查网络后重试'), {
            code: 'PUBLISH_NAVIGATION_TIMEOUT', cause: error,
            diagnostics: { navigationError: message, targetUrl: url, attempts: attempt + 1 },
          });
        }
        throw error;
      }
      options.onRetry?.({ attempt: attempt + 2, attempts, timeout: navigationTimeout,
        ...(navigationInterrupted ? { interrupted: true } : {}) });
      const backoff = [2000, 5000, 10000][attempt] || 10000;
      await page.waitForTimeout(backoff);
    }
  }
  throw lastError;
}

export function requireNewProductPage(url) {
  const current = new URL(url);
  // Only used before this attempt starts filling. Later auto-save may assign
  // an itemId legitimately; an old item's edit page must never be a baseline.
  if (['itemId', 'productId', 'primaryId'].some(key => current.searchParams.getAll(key).some(value => value.trim() && value !== '0'))) {
    throw Object.assign(new Error('国际站打开的是已有商品编辑页，已停止填写，避免覆盖已有商品；请重新打开新商品发布页后重试'), {
      code: 'PUBLISH_EXISTING_PRODUCT_PAGE', diagnostics: { currentUrl: url },
    });
  }
}

function isUsableImageUrl(value) {
  if (/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(String(value || ''))) return true;
  if (/^\/media\/[A-Za-z0-9._-]+$/i.test(String(value || ''))) return true;
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/i.test(url.protocol)
      && (/(?:^|\.)alicdn\.com$/i.test(url.hostname) || /(?:^|\.)alibaba\.com$/i.test(url.hostname))
      && (/(?:\/kf\/|\/ibank\/|\/img\/)/i.test(url.pathname) || /\.(?:jpe?g|png|webp)(?:$|[?_])/i.test(url.pathname));
  } catch { return false; }
}

async function commitControlledInput(locator, value) {
  const expected = String(value ?? '').trim();
  await locator.evaluate((node, nextValue) => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    const previous = node.value;
    setter?.call(node, nextValue);
    node._valueTracker?.setValue?.(previous);
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.blur();
  }, expected).catch(() => {});
}

function compactText(value, limit = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export async function visibleFeedback(page) {
  const selectors = [
    '.sell-error-message .msg-text', '.error-sell-info + .sell-error-message',
    '[role="alert"]', '[role="dialog"]', '[aria-modal="true"]', '.next-message', '.next-notice', '.next-feedback',
    '.next-balloon', '.next-dialog', '[class*="toast"]', '[class*="message"]',
    '[class*="error"]', '[class*="invalid"]', '[class*="feedback"]'
  ];
  return page.evaluate((patterns) => {
    const messages = new Map();
    const errors = '.sell-error-message, [role="alert"], .next-message-error, .next-notice-error, .next-feedback-error, .next-form-item-help, [aria-invalid="true"]';
    for (const pattern of patterns) {
      let count = 0;
      // Hidden validators precede the image section on many category forms.
      // Bound actual messages, not the hidden elements before them.
      for (const node of document.querySelectorAll(pattern)) {
        const style = getComputedStyle(node);
        if (!node.getClientRects().length || style.visibility === 'hidden' || style.display === 'none') continue;
        const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
        if (text) {
          const message = text.slice(0, 2000);
          messages.set(message, Boolean(messages.get(message) || node.closest(errors) || node.querySelector(errors)));
          if (++count >= 20) break;
        }
      }
    }
    return [...messages].map(([text, error]) => ({ text, error }));
  }, selectors).then((messages) => messages.filter((message) => message.error || !isLogisticsReadinessHint(message.text))
    .map((message) => message.text)).catch((error) => {
    // Navigation after a successful save can invalidate a read. The result
    // polling loop will read the new document; never repeat the submission.
    if (/Execution context was destroyed|Cannot find context|navigation/i.test(error.message)) return [];
    throw error;
  });
}

const SUBMIT_SUCCESS_TEXT = /(?:发布成功|提交成功|已提交发布|审核中|产品信息已经成功提交|产品已经进入审核流程|您的产品信息已经成功提交|您的产品已经进入审核流程|successfully\s+(?:submitted|published)|submitted successfully)/i;
const DRAFT_SUCCESS_TEXT = /(?:保存成功|草稿.*成功|已保存|successfully\s+saved|saved successfully)/i;
const ACCOUNT_LIMIT_TEXT = /(?:产品|商品)(?:总量|数量).{0,20}(?:超出|超过|上限)|product.{0,30}(?:quota|limit).{0,20}(?:exceed|reach)/i;
const INVALID_CHARACTER_FEEDBACK_TEXT = /请不要输入.{0,60}字符/;
const BLOCKING_FEEDBACK_TEXT = /(?:报错反馈|错误项|必填项.*不能为空|无效起订量|物流属性.*(?:请填写完整|不能为空)|重量、体积.*(?:请填写完整|不能为空)|logistics attribute.*(?:fill in completely|remove all)|请上传相关产品图片|请不要输入.{0,60}字符|required|invalid)/i;

export function classifyAlibabaActionResult({ mode = 'draft', url = '', originalUrl = '', feedback = [], bodyText = '', allowPolicyWarningPublish = false } = {}) {
  const messages = Array.isArray(feedback) ? feedback.filter(Boolean) : [];
  const feedbackText = messages.join(' ');
  const combinedText = `${feedbackText} ${String(bodyText || '')}`;
  if (ACCOUNT_LIMIT_TEXT.test(combinedText)) return { succeeded: false, verifiedBy: '', blockingFeedback: true };
  if (isBlockingPolicyFeedback(feedbackText, allowPolicyWarningPublish === true)) return { succeeded: false, verifiedBy: '', blockingFeedback: true };
  let currentUrl = null;
  let initialUrl = null;
  try { currentUrl = new URL(url); } catch {}
  try { initialUrl = new URL(originalUrl); } catch {}

  const explicitSuccessUrl = Boolean(
    currentUrl
    && /(^|\.)alibaba\.com$/i.test(currentUrl.hostname)
    && (
      /\/product\/success\.htm$/i.test(currentUrl.pathname)
      || currentUrl.searchParams.get('isSuccess')?.toLowerCase() === 'true'
    )
  );
  if (explicitSuccessUrl) {
    return { succeeded: true, verifiedBy: 'success-url', blockingFeedback: false };
  }

  const blockingFeedback = BLOCKING_FEEDBACK_TEXT.test(feedbackText) || SPECIFICATION_IMAGE_REQUIRED_TEXT.test(feedbackText);
  const successText = mode === 'submit' ? SUBMIT_SUCCESS_TEXT : DRAFT_SUCCESS_TEXT;
  if (successText.test(combinedText) && !(mode === 'submit' && blockingFeedback)) {
    return {
      succeeded: true,
      verifiedBy: successText.test(feedbackText) ? 'feedback' : 'page-content',
      blockingFeedback
    };
  }

  const navigatedAway = Boolean(
    currentUrl
    && initialUrl
    && currentUrl.href !== initialUrl.href
    && !/\/product\/publish\.htm$/i.test(currentUrl.pathname)
  );
  // Login, quota errors and category redirects are not publication receipts.
  if (navigatedAway) return { succeeded: false, verifiedBy: '', blockingFeedback };
  return { succeeded: false, verifiedBy: '', blockingFeedback };
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
    const saleSpecControls = [...document.querySelectorAll('.saleAttributesItems label.next-checkbox-wrapper')]
      .map((wrapper) => {
        const input = wrapper.querySelector('input[type="checkbox"]');
        const box = wrapper.getBoundingClientRect();
        return {
          visible: visible(wrapper), text: clean(wrapper.innerText || wrapper.textContent),
          left: box.left, top: box.top, width: box.width, height: box.height,
          wrapperClass: wrapper.className || '', wrapperAriaChecked: wrapper.getAttribute('aria-checked'),
          value: input?.value || '', checked: Boolean(input?.checked), disabled: Boolean(input?.disabled),
          inputAriaChecked: input?.getAttribute('aria-checked') || null,
          html: wrapper.outerHTML.slice(0, 5000)
        };
      });
    const colorValueControls = [...document.querySelectorAll('input[value="191288010"]')]
      .map((input) => {
        const wrapper = input.closest('label') || input.parentElement;
        const box = wrapper?.getBoundingClientRect() || input.getBoundingClientRect();
        return {
          visible: visible(wrapper), text: clean(wrapper?.innerText || wrapper?.textContent),
          left: box.left, top: box.top, width: box.width, height: box.height,
          checked: Boolean(input.checked), disabled: Boolean(input.disabled),
          inputAriaChecked: input.getAttribute('aria-checked'),
          ancestors: snapshot(input, 8)
        };
      });
    const visibleCheckboxControls = [...document.querySelectorAll('label.next-checkbox-wrapper')]
      .filter(visible).map((wrapper) => {
        const input = wrapper.querySelector('input[type="checkbox"]');
        const box = wrapper.getBoundingClientRect();
        return {
          text: clean(wrapper.innerText || wrapper.textContent), value: input?.value || '',
          left: box.left, top: box.top, width: box.width, height: box.height,
          checked: Boolean(input?.checked), disabled: Boolean(input?.disabled),
          inputAriaChecked: input?.getAttribute('aria-checked') || null,
          parentClass: wrapper.parentElement?.className || '',
          grandparentClass: wrapper.parentElement?.parentElement?.className || ''
        };
      }).sort((a, b) => a.top - b.top).slice(0, 120);
    const exactColorNodes = [...document.querySelectorAll('body *')]
      .filter((node) => visible(node) && /^(?:颜色|colou?r)$/i.test(clean(node.innerText || node.textContent)))
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          tag: node.tagName, className: String(node.className || ''),
          left: box.left, top: box.top + window.scrollY, width: box.width, height: box.height,
          ancestors: snapshot(node, 7)
        };
      }).sort((a, b) => a.top - b.top).slice(0, 30);
    const keySpecNodes = [...document.querySelectorAll('body *')]
      .filter((node) => visible(node) && /商品规格项|支持传图/.test(clean(node.innerText || node.textContent)))
      .filter((node) => ![...node.children].some((child) => /商品规格项|支持传图/.test(clean(child.innerText || child.textContent))))
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          tag: node.tagName, className: String(node.className || ''),
          text: clean(node.innerText || node.textContent),
          left: box.left, top: box.top + window.scrollY, width: box.width, height: box.height,
          ancestors: snapshot(node, 8)
        };
      }).sort((a, b) => a.top - b.top).slice(0, 30);
    const reactDetails = ['#p-191288010', '#p-210218404', '#p-200399262', '#saleAttributesItems', '#struct-saleAttributesItems', 'input[value="191288010"]']
      .flatMap((selector) => [...document.querySelectorAll(selector)].map((node, index) => {
        const own = Object.getOwnPropertyNames(node);
        const propKey = own.find((key) => key.startsWith('__reactProps'));
        const fiberKey = own.find((key) => key.startsWith('__reactFiber'));
        const summarizeValue = (value) => {
          if (typeof value === 'function') return `function:${String(value).slice(0, 1200)}`;
          if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
          if (Array.isArray(value)) {
            return {
              type: `array(${value.length})`,
              values: value.slice(0, 30).map((item) => {
                if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) return item;
                if (typeof item === 'function') return `function:${String(item).slice(0, 500)}`;
                return {
                  constructor: item?.constructor?.name || '',
                  keys: Object.keys(item || {}).slice(0, 50),
                  values: Object.fromEntries(Object.entries(item || {})
                    .filter(([, nested]) => nested == null || ['string', 'number', 'boolean'].includes(typeof nested))
                    .slice(0, 50))
                };
              })
            };
          }
          const entries = Object.entries(value || {}).slice(0, 80);
          return {
            constructor: value?.constructor?.name || '',
            keys: Object.keys(value || {}).slice(0, 100),
            values: Object.fromEntries(entries
              .filter(([, item]) => item == null || ['string', 'number', 'boolean', 'function'].includes(typeof item))
              .map(([key, item]) => [key, typeof item === 'function' ? `function:${String(item).slice(0, 800)}` : item]))
          };
        };
        const summarize = (object) => Object.fromEntries(Object.entries(object || {}).slice(0, 80)
          .map(([key, value]) => [key, summarizeValue(value)]));
        const fibers = [];
        let fiber = fiberKey ? node[fiberKey] : null;
        for (let depth = 0; fiber && depth < 10; depth += 1, fiber = fiber.return) {
          fibers.push({
            depth,
            elementType: typeof fiber.elementType === 'string' ? fiber.elementType : (fiber.elementType?.name || fiber.type?.name || ''),
            props: summarize(fiber.memoizedProps),
            stateNodeConstructor: fiber.stateNode?.constructor?.name || '',
            stateNodeKeys: Object.getOwnPropertyNames(fiber.stateNode || {}).slice(0, 100),
            stateNodeState: summarize(fiber.stateNode?.state),
            stateNodeProps: summarize(fiber.stateNode?.props),
            stateNodeMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(fiber.stateNode || {}) || {})
              .filter((key) => typeof fiber.stateNode?.[key] === 'function')
              .slice(0, 80)
          });
        }
        return { selector, index, tag: node.tagName, id: node.id || '', className: String(node.className || ''), props: summarize(propKey ? node[propKey] : null), fibers };
      }));
    const saleAttributeFiberTree = (() => {
      const root = document.querySelector('#saleAttributesItems');
      if (!root) return [];
      const summarizeTree = (object) => Object.fromEntries(Object.entries(object || {}).slice(0, 80).map(([key, value]) => {
        if (typeof value === 'function') return [key, `function:${String(value).slice(0, 1400)}`];
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return [key, value];
        if (Array.isArray(value)) return [key, {
          type: `array(${value.length})`,
          values: value.slice(0, 30).map((item) => item && typeof item === 'object'
            ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested == null || ['string', 'number', 'boolean'].includes(typeof nested)).slice(0, 40))
            : item)
        }];
        return [key, {
          constructor: value?.constructor?.name || '',
          values: Object.fromEntries(Object.entries(value || {})
            .filter(([, nested]) => nested == null || ['string', 'number', 'boolean', 'function'].includes(typeof nested))
            .slice(0, 50).map(([nestedKey, nested]) => [nestedKey, typeof nested === 'function' ? `function:${String(nested).slice(0, 1000)}` : nested]))
        }];
      }));
      const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
      let start = fiberKey ? root[fiberKey] : null;
      for (let depth = 0; start && depth < 10; depth += 1) {
        if (start.memoizedProps?.id === 'saleAttributesItems' && typeof start.elementType !== 'string') break;
        start = start.return;
      }
      const results = [];
      const visit = (fiber, path, depth) => {
        if (!fiber || depth > 16 || results.length >= 160) return;
        const props = fiber.memoizedProps || {};
        const stateNode = fiber.stateNode;
        const type = typeof fiber.elementType === 'string' ? fiber.elementType : (fiber.elementType?.name || fiber.type?.name || '');
        const hasRelevantProps = ['onChange', 'change', 'changeValue', 'value', 'dataSource', 'id']
          .some((key) => Object.prototype.hasOwnProperty.call(props, key));
        if (hasRelevantProps || stateNode?.constructor?.name && !/HTML.*Element/.test(stateNode.constructor.name)) {
          results.push({
            path, depth, type,
            stateNodeConstructor: stateNode?.constructor?.name || '',
             stateNodeKeys: Object.getOwnPropertyNames(stateNode || {}).slice(0, 80),
             stateNodeOwnFunctions: Object.fromEntries(Object.getOwnPropertyNames(stateNode || {})
               .filter((key) => typeof stateNode?.[key] === 'function')
               .slice(0, 30)
               .map((key) => [key, String(stateNode[key]).slice(0, 2400)])),
             stateNodeState: summarizeTree(stateNode?.state),
            props: summarizeTree(props),
            methods: Object.getOwnPropertyNames(Object.getPrototypeOf(stateNode || {}) || {})
              .filter((key) => typeof stateNode?.[key] === 'function').slice(0, 80)
          });
        }
        visit(fiber.child, `${path}.c`, depth + 1);
        visit(fiber.sibling, `${path}.s`, depth);
      };
      visit(start?.child, 'component.c', 0);
      return results;
    })();
    const formEngineDetails = (() => {
      const root = document.querySelector('#saleAttributesItems');
      if (!root) return {};
      const summarizeEngine = (object) => Object.fromEntries(Object.entries(object || {}).slice(0, 100).map(([key, value]) => {
        if (typeof value === 'function') return [key, `function:${String(value).slice(0, 1400)}`];
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return [key, value];
        if (Array.isArray(value)) return [key, { type: `array(${value.length})`, values: value.slice(0, 30).map((item) => item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested == null || ['string', 'number', 'boolean'].includes(typeof nested)).slice(0, 40)) : item) }];
        return [key, { constructor: value?.constructor?.name || '', keys: Object.keys(value || {}).slice(0, 80) }];
      }));
      const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
      let fiber = fiberKey ? root[fiberKey] : null;
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps || fiber.stateNode?.props;
        if (props?.id !== 'saleAttributesItems' || typeof props.getEngine !== 'function') continue;
        const engine = props.getEngine();
        const componentDetails = (id) => {
          const component = engine?.getComponent?.(id);
          const componentProps = component?.getProps?.() || {};
          return {
            id,
            constructor: component?.constructor?.name || '',
            keys: Object.getOwnPropertyNames(component || {}).slice(0, 120),
            methods: Object.getOwnPropertyNames(Object.getPrototypeOf(component || {}) || {})
              .filter((key) => typeof component?.[key] === 'function').slice(0, 100),
            methodSources: Object.fromEntries(Object.getOwnPropertyNames(component || {})
              .filter((key) => typeof component?.[key] === 'function')
              .map((key) => [key, String(component[key]).slice(0, 1600)])),
            props: summarizeEngine(componentProps)
          };
        };
        return {
          constructor: engine?.constructor?.name || '',
          keys: Object.getOwnPropertyNames(engine || {}).slice(0, 150),
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(engine || {}) || {})
            .filter((key) => typeof engine?.[key] === 'function').slice(0, 120),
          components: ['saleAttributesItems', 'imageMedia', 'p-3', 'p-191288010', 'p-210218404', 'p-200399262'].map(componentDetails)
        };
      }
      return {};
    })();
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
    const saleAttributesHtml = document.querySelector('#saleAttributesItems')?.outerHTML?.slice(0, 30000) || '';
    const structSaleAttributesHtml = document.querySelector('#struct-saleAttributesItems')?.outerHTML?.slice(0, 30000) || '';
    const variantRows = [...document.querySelectorAll('#struct-specification [id^="p-"]')]
      .filter(visible)
      .map((node) => ({ id: node.id || '', text: clean(node.innerText).slice(0, 3000), html: node.outerHTML.slice(0, 20000) }));
    return { colorInputs, colorSpecContainers, saleSpecControls, colorValueControls, visibleCheckboxControls, exactColorNodes, keySpecNodes, reactDetails, saleAttributeFiberTree, formEngineDetails, saleAttributesHtml, structSaleAttributesHtml, variantRows, textareas, iframes, fileInputs, overlays, ordinaryLabels, errors, editors };
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
  main.mainImageState = await mainImageFormState(page);
  main.mainImageHtml = await page.locator('.image-uploader').first().evaluate((node) => node.outerHTML.slice(0, 30000)).catch(() => '');
  return main;
}

export async function captureCategoryAttributes(page) {
  // Successful-reference snapshots must use the same committed values as
  // validation, including the custom brand entered after selecting Other.
  return (await page.evaluate(readPostingAttributeSchema)).filter((field) => field.values.length)
    .map((field) => ({ name: field.label, value: field.values.length > 1 ? field.values : field.values[0] }));
}

async function qualityScoreConfirmation(page) {
  const titles = page.getByText('质量分检测提示', { exact: true });
  for (let index = 0; index < await titles.count(); index += 1) {
    const title = titles.nth(index);
    if (!await title.isVisible()) continue;
    let container = title;
    for (let depth = 0; depth < 6; depth += 1) {
      if (await container.evaluate((node) => /^(?:BODY|HTML|FORM)$/.test(node.tagName))) break;
      const proceed = container.getByRole('button', { name: '继续提交', exact: true });
      const back = container.getByRole('button', { name: '返回修改', exact: true });
      if (await proceed.count() === 1 && await back.count() === 1
        && await proceed.isVisible() && await back.isVisible()) {
        const text = compactText(await container.innerText(), 1200);
        requireNoPolicyWarning([text]);
        return {
          text, proceed,
          recognized: !POLICY_WARNING_TEXT.test(text) && /商品信息质量分低于\s*4(?:\.0)?\s*分/.test(text) && /商品曝光/.test(text),
        };
      }
      container = container.locator('..');
    }
  }
  return null;
}

async function pendingPostingPrompts(page, mode) {
  const messages = await page.locator(`.next-dialog:visible, ${POSTING_DIALOG}:visible, [aria-modal="true"]:visible, .mce-window:visible`)
    .evaluateAll((nodes) => [...new Set(nodes.map((node) => String(node.innerText || node.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ').trim()).filter(Boolean))]).catch((error) => {
      if (/Execution context was destroyed|Cannot find context|navigation/i.test(error.message)) return [];
      throw error;
    });
  // An explicit success receipt can itself be a dialog. Keep confirmation
  // prompts pending even if their text mentions a successful submission.
  const successText = mode === 'submit' ? SUBMIT_SUCCESS_TEXT : DRAFT_SUCCESS_TEXT;
  return messages.filter((text) => !successText.test(text)
    || /继续提交|返回修改|确认(?:发布|提交|保存)|confirm\s+(?:publication|submission)|continue\s+(?:publishing|submission)/i.test(text));
}

function postingConfirmationError(message, code = 'PUBLISH_CONFIRMATION_PENDING') {
  return Object.assign(new Error(message), { code, diagnostics: { section: 'submission-confirmation' } });
}

export async function waitForActionResult(page, action, mode, originalUrl, { timeoutMs = 15000, busyGraceMs = 45000 } = {}) {
  const responses = [];
  const receipt = actionReceipt(page, mode === 'submit' ? SUBMIT_SUCCESS_TEXT : DRAFT_SUCCESS_TEXT);
  let actionDispatched = false;
  let qualityConfirmationAttempted = false;
  let qualityConfirmationFeedback = [];
  let policyConfirmationAttempted = false;
  let salesRulesResubmitted = false;
  const onResponse = (response) => {
    const request = response.request();
    if (!['POST', 'PUT', 'PATCH'].includes(request.method())) return;
    responses.push({ url: response.url(), status: response.status() });
  };
  page.on('response', onResponse);
  try {
    await requireClearPostingOverlays(page);
    if (mode === 'submit') await acknowledgeSalesRules(page);
    const requiredAttributes = await captureCategoryAttributes(page);
    const acceptedLogistics = await capturePostingLogistics(page);
    const fieldErrorKey = field => JSON.stringify([field.fieldId, field.label, field.message]);
    const initialFieldFeedback = await readPostingFieldFeedback(page).catch(() => null);
    const initialCharacterErrors = initialFieldFeedback && new Set(initialFieldFeedback.filter(field => INVALID_CHARACTER_FEEDBACK_TEXT.test(field.message)).map(fieldErrorKey));
    let previousCharacterErrors = '';
    try {
      await clickPostingControl(page, action, {
        beforeDispatch: () => receipt.arm(),
        beforeRetry: async () => {
          await requireClearPostingOverlays(page);
          if (mode === 'submit') await requireSpecificationImagesAccepted(page);
        },
      });
    } catch (error) {
      // The click may already have reached Alibaba. Read its result below;
      // never send another save/submit merely because transport timed out.
      if (error.code !== 'PUBLISH_CONTROL_RESULT_UNKNOWN') throw error;
    }
    actionDispatched = true;
    let deadline = Date.now() + timeoutMs;
    let busyGraceUsed = false;
    while (true) {
      if (Date.now() >= deadline) {
        // Native structured drafts may still be saving after the normal
        // receipt window. Extend once without dispatching another action.
        const busy = !busyGraceUsed && busyGraceMs > 0 && await action.evaluate(node => node.disabled || node.getAttribute('aria-busy') === 'true'
          || node.getAttribute('aria-disabled') === 'true' || node.classList.contains('next-btn-loading')
          || Boolean(node.querySelector('.next-loading, .next-icon-loading, [role="progressbar"]')), undefined, { timeout: 1000 }).catch(() => false);
        if (!busy) break;
        busyGraceUsed = true;
        deadline = Date.now() + busyGraceMs;
      }
      if (await waitForHumanVerification(page)) deadline = Date.now() + timeoutMs;
      await page.waitForTimeout(400);
      const url = page.url();
      const feedback = await visibleFeedback(page);
      requireNoPolicyWarning(feedback);
      // Retry only after an explicit validation rejection and a newly checked
      // rule field. A slow/unknown receipt must never cause another submission.
      if (mode === 'submit' && !salesRulesResubmitted && feedback.some(text => POLICY_RULE_CONFIRMATION_TEXT.test(text))) {
        const acknowledged = await acknowledgeSalesRules(page, { required: true });
        if (acknowledged) {
          salesRulesResubmitted = true;
          await requireClearPostingOverlays(page);
          await clickPostingControl(page, action, { beforeDispatch: () => receipt.arm() });
          deadline = Date.now() + timeoutMs;
          continue;
        }
      }
      const policyNotice = await acknowledgePolicyWarning(page, { submission: mode === 'submit' });
      if (policyNotice) {
        policyConfirmationAttempted = true;
        deadline = Date.now() + timeoutMs;
        continue;
      }
      const qualityNotice = await qualityScoreConfirmation(page);
      const pendingPrompts = await pendingPostingPrompts(page, mode);
      requireNoPolicyWarning(pendingPrompts);
      if (qualityNotice || pendingPrompts.length) {
        if (mode === 'submit' && qualityNotice?.recognized && !qualityConfirmationAttempted
          && !await qualityNotice.proceed.isDisabled()) {
          // This is the known, optional quality-score notice shown only after
          // submission. A confirmation is not a successful publication receipt.
          qualityConfirmationAttempted = true;
          qualityConfirmationFeedback = feedback;
          try { await clickPostingControl(page, qualityNotice.proceed, { timeout: 5000, beforeDispatch: () => receipt.arm() }); }
          catch (error) {
            postingInteractionFailure(error);
            throw postingConfirmationError('国际站质量分检测提示未能确认，请检查发布页面的“继续提交”按钮；已保留当前商品进度');
          }
          deadline = Date.now() + timeoutMs;
        }
        // Background readiness hints and old success text are not the result
        // while a confirmation is still open. Never click it repeatedly.
        continue;
      }
      const accountLimit = await page.locator('body').evaluate(node => node.innerText.match(/[^\n]*您发布的产品总量已超出限制[^\n]*/)?.[0] || '').catch(() => '');
      if (accountLimit) {
        const error = new Error(`国际站账号发布额度不足：${accountLimit.trim()}`);
        error.code = 'PUBLISH_ACCOUNT_LIMIT';
        throw error;
      }
      const result = classifyAlibabaActionResult({ mode, url, originalUrl, feedback, allowPolicyWarningPublish: policyWarningPublishingAllowed() });
      if (await receipt.accepts(result)) return { verifiedBy: result.verifiedBy, feedback, responses, requiredAttributes, acceptedLogistics };
      // A new field-scoped character rejection is a confirmed invalid value,
      // not a slow receipt. Require two stable reads and an idle action before
      // leaving the wait; stale validators and unknown saves still wait fully.
      let characterErrors = '';
      if (initialCharacterErrors && feedback.some(text => INVALID_CHARACTER_FEEDBACK_TEXT.test(text))) {
        const fresh = (await readPostingFieldFeedback(page).catch(() => [])).filter(field => INVALID_CHARACTER_FEEDBACK_TEXT.test(field.message))
          .map(fieldErrorKey).filter(key => !initialCharacterErrors.has(key)).sort();
        const idle = await action.evaluate(node => !node.disabled && node.getAttribute('aria-busy') !== 'true'
          && node.getAttribute('aria-disabled') !== 'true' && !node.classList.contains('next-btn-loading')
          && !node.querySelector('.next-loading, .next-icon-loading, [role="progressbar"]')).catch(() => false);
        if (fresh.length && idle) characterErrors = JSON.stringify(fresh);
      }
      if (characterErrors && characterErrors === previousCharacterErrors) break;
      previousCharacterErrors = characterErrors;
    }
    const feedback = await visibleFeedback(page);
    requireNoPolicyWarning(feedback);
    const qualityNotice = await qualityScoreConfirmation(page);
    const pendingPrompts = await pendingPostingPrompts(page, mode);
    requireNoPolicyWarning(pendingPrompts);
    if (qualityNotice || pendingPrompts.length) {
      const detail = qualityNotice?.text || pendingPrompts[0];
      throw postingConfirmationError(`国际站提交确认尚未完成：${compactText(detail, 700)}${qualityConfirmationAttempted ? '；已点击一次“继续提交”，未重复点击' : ''}`);
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    // The success page can render immediately after the polling deadline. The
    // final snapshot must be classified before it is used to build an error.
    const finalResult = classifyAlibabaActionResult({
      mode,
      url: page.url(),
      originalUrl,
      feedback,
      bodyText,
      allowPolicyWarningPublish: policyWarningPublishingAllowed(),
    });
    if (await receipt.accepts(finalResult)) {
      return { verifiedBy: finalResult.verifiedBy, feedback, responses, requiredAttributes, acceptedLogistics };
    }
    let validationFeedback = feedback;
    if (qualityConfirmationAttempted || policyConfirmationAttempted) {
      validationFeedback = feedback.filter((text) => !qualityConfirmationFeedback.includes(text))
        .filter((text) => BLOCKING_FEEDBACK_TEXT.test(text) || SPECIFICATION_IMAGE_REQUIRED_TEXT.test(text));
      if (!validationFeedback.length) {
        throw postingConfirmationError('已确认平台提示，但尚未收到国际站的明确发布结果；请先在商品管理中核对，避免重复发布', 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
      }
    }
    if (mode === 'submit' && !validationFeedback.some(text => INVALID_CHARACTER_FEEDBACK_TEXT.test(text))) await requireSpecificationImagesAccepted(page, validationFeedback);
    const relevant = validationFeedback
      .filter((text) => SPECIFICATION_IMAGE_REQUIRED_TEXT.test(text) || /必填|不能为空|请填写|请输入|无效|未填写|请上传|请不要输入|非英文|至少|错误|失败|error|required|invalid/i.test(text))
      .sort((left, right) => left.length - right.length);
    const errorPanel = bodyText.match(/(?:报错反馈|请发布前修改以下出错项)[\s\S]{0,1200}/)?.[0]
      ?.split(/商品质量助手|基本信息|当前商品类型/)[0]
      ?.replace(/\s+/g, ' ')
      ?.trim() || '';
    const detail = [...new Set(relevant)].slice(0, 8).join('；') || errorPanel;
    if (!detail) {
      throw postingConfirmationError(mode === 'submit'
        ? '已提交，等待国际站确认发布结果；请先在商品管理中核对，避免重复发布'
        : '保存操作已提交，等待国际站确认草稿结果；请先在草稿箱中核对，避免重复保存', 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
    }
    const error = new Error(`国际站提示：${detail}`);
    error.requiredFields = [...new Set([...await visibleEmptyAttributeLabels(page), ...requiredLabelsFromError(detail)])];
    if (INVALID_CHARACTER_FEEDBACK_TEXT.test(detail)) {
      const fields = await readPostingFieldFeedback(page).catch(() => []);
      const rejected = fields.filter(field => INVALID_CHARACTER_FEEDBACK_TEXT.test(field.message));
      error.code = 'PUBLISH_INVALID_CHARACTERS';
      const labels = [...new Set(rejected.map(field => field.label).filter(Boolean))];
      if (labels.length) error.message = `国际站${labels.join('、')}校验未通过：${detail}`;
      error.requiredFields = labels;
      error.diagnostics = { section: rejected.some(field => /supertext|商品详情|详情描述/i.test(field.fieldId + ' ' + field.label)) ? 'description' : 'form-validation',
        fieldFeedback: rejected, feedback: relevant.slice(0, 8),
        descriptionTextConversions: legacyDescriptionTextConversions(page) };
    }
    else if (MAIN_IMAGE_VALIDATION_TEXT.test(detail)) {
      error.code = 'PUBLISH_MAIN_IMAGE_VALIDATION';
      error.diagnostics = { section: 'main-images', state: await mainImageFormState(page), files: await mainImageUploadRecords(page) };
    }
    throw error;
  } catch (error) {
    if (actionDispatched && isBrowserInteractionError(error)) {
      const uncertain = postingConfirmationError(mode === 'submit'
        ? '提交操作后无法读取国际站结果，页面或连接可能已关闭；请先在商品管理中核对，避免重复发布'
        : '保存操作后无法读取国际站结果，页面或连接可能已关闭；请先在草稿箱中核对，避免重复保存', 'PUBLISH_SUBMIT_RESULT_UNKNOWN');
      uncertain.diagnostics = { ...uncertain.diagnostics, reason: 'receipt-unavailable',
        browserError: compactText(error.message, 700), responses };
      throw uncertain;
    }
    throw error;
  } finally {
    page.off('response', onResponse);
    await receipt.dispose();
  }
}

export async function requireSpecificationImagesAccepted(page, feedback = null) {
  const messages = feedback || await visibleFeedback(page);
  // Alibaba also labels its required specification-image field “商品图片项”.
  // The wording alone cannot distinguish this from a missing main image.
  const specificationErrors = await page.locator('#struct-specification')
    .locator('.sell-error-message, .next-form-item-help, .next-message-error, .next-feedback-error, [role="alert"]')
    .evaluateAll((nodes) => [...new Set(nodes.filter((node) => node.getClientRects().length)
      .map((node) => String(node.innerText || '').trim()).filter(Boolean))]).catch(() => []);
  const scopedImageError = specificationErrors.find((text) => MAIN_IMAGE_VALIDATION_TEXT.test(text)
    && /必填|不能为空|缺少|失败|请上传|required|missing|empty|failed/i.test(text));
  if (!scopedImageError && !messages.some((text) => SPECIFICATION_IMAGE_REQUIRED_TEXT.test(text))) return;
  const error = new Error('国际站商品规格缺少图片：请选择一个规格上传图片；请在商品编辑的“产品规格”中，选择支持传图的规格（如颜色或型号），填写真实规格值并绑定对应图片');
  error.code = 'PUBLISH_SPEC_IMAGE_REQUIRED';
  error.diagnostics = { section: 'specifications', reason: 'image-required', ...(scopedImageError ? { platformMessage: scopedImageError } : {}) };
  throw error;
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
  '功能': 'Function',
  '端口': 'Port',
  '接口': 'Port',
  '输入': 'Input',
  '输出': 'Output',
  '产地': 'Place of Origin',
  '型号': 'Model Number',
  '定制包装': 'Custom Packaging MOQ',
  '销售单位': 'Selling Unit',
  '单个包装尺寸': 'Single Package Size',
  '单个产品毛重': 'Single Gross Weight',
  '颜色': 'Color',
  '运行内存': 'RAM',
  '存储容量': 'Storage Capacity'
  , 'screen size': 'Screen Size'
  , 'battery capacity': 'Battery Capacity'
  , 'processor brand': 'Processor Brand'
  , 'operation system': 'Operating System'
  , 'display refresh rate': 'Display Refresh Rate'
  , 'cellular band': 'Cellular Band'
  , 'cellular': 'Cellular Network'
  , 'selling units': 'Selling Unit'
  , 'single package size': 'Single Package Size'
  , 'single gross weight': 'Single Gross Weight'
  , 'product type': 'Product Type'
  , 'compatible model': 'Compatible Model'
}));

const SOURCE_ATTRIBUTE_LABEL_ALIASES = new Map([
  ['private mold', ['私模']],
  ['material', ['材质']],
  ['feature', ['特性', '功能/特性']],
  ['features', ['特性', '功能/特性']],
  ['brand name', ['品牌名称']],
  ['place of origin', ['产地']],
  ['model number', ['型号']],
  ['output power', ['输出功率']],
  ['multi function integrated', ['多功能一体化']],
  ['multi-function integrated', ['多功能一体化']],
  ['function', ['功能', 'Function']],
  ['port', ['端口', '接口', 'Port']],
  ['input', ['输入', 'Input']],
  ['output', ['输出', 'Output']],
  ['protection level', ['防护等级', 'Protection Level']],
  ['use', ['用途', 'Use']]
  , ['screen size', ['屏幕', '屏幕尺寸', 'Screen Size', 'Display']]
  , ['battery capacity', ['电池容量', 'Battery Capacity', 'Battery']]
  , ['processor brand', ['处理器品牌', 'Processor Brand']]
  , ['operation system', ['操作系统', 'Operation System', 'Operating System', 'OS']]
  , ['display refresh rate', ['屏幕刷新率', 'Display Refresh Rate']]
  , ['cellular band', ['蜂窝频段', 'Cellular Band', 'Frequency Band']]
  , ['cellular', ['蜂窝网络', 'Cellular', 'Cellular Network']]
  , ['compatible model', ['适用型号', 'Compatible Model', 'Model Compatibility']]
  , ['screen', ['屏幕', '屏幕尺寸', 'Screen', 'Screen Size', 'Display']]
  , ['battery', ['电池容量', 'Battery', 'Battery Capacity']]
  , ['brand', ['品牌名称', 'Brand', 'Brand Name']]
]);

const TEXT_TRANSLATIONS = [
  ['英国', 'UK'], ['美国', 'US'], ['澳大利亚', 'AU'],
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

const DESCRIPTION_EMAIL_PATTERN = /(?:mailto\s*:\s*)?[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+\s*@\s*[A-Z0-9-]+(?:\s*\.\s*[A-Z0-9-]+)+/gi;

export function stripDescriptionEmail(value) {
  return String(value || '')
    .replace(DESCRIPTION_EMAIL_PATTERN, '')
    .replace(/(?:e-?mail|邮箱|电子邮件)\s*[:：]\s*(?=$|[;；,，\n])/gi, '')
    .trim();
}

function removeDescriptionHtmlEmails($) {
  const segments = [];
  let text = '';
  const walk = (node) => {
    if (node.type === 'text') {
      segments.push({ node, start: text.length, end: text.length + node.data.length });
      text += node.data;
      return;
    }
    const block = /^(?:p|div|li|td|th|tr|table|h[1-6]|br)$/i.test(node.name || '');
    if (block) text += '\n';
    for (const child of node.children || []) walk(child);
    if (block) text += '\n';
  };
  walk($.root()[0]);
  const matches = [...text.matchAll(DESCRIPTION_EMAIL_PATTERN)];
  for (const { node, start, end } of segments) {
    // Delete only matching characters, preserving table cells and inline
    // markup even when an email is split across several source elements.
    for (const match of matches.toReversed()) {
      const from = Math.max(start, match.index);
      const to = Math.min(end, match.index + match[0].length);
      if (from < to) node.data = node.data.slice(0, from - start) + node.data.slice(to - start);
    }
  }
  $('*').each((_, node) => {
    for (const [name, value] of Object.entries(node.attribs || {})) {
      if (stripDescriptionEmail(value) !== value.trim()) $(node).removeAttr(name);
    }
  });
}

function englishDescriptionText(value) {
  const source = stripDescriptionEmail(value);
  if (!source || /^(?:供应商的产品说明|产品描述|商品描述|supplier product description)$/i.test(source)) return '';
  // Plain-text descriptions are content too: retain paragraph boundaries and
  // supplied language instead of running the lossy specification normalizer.
  return source;
}

export function sanitizeSourceDescriptionHtml(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const $ = load(`<body>${source}</body>`, null, false);
  $('script,style,form,input,button,iframe,object,embed,noscript').remove();
  removeDescriptionHtmlEmails($);
  // Capture identities before classes are stripped, including nested spans.
  // These headings classify native galleries; removing "company profile"
  // breaks the next parse after a legitimate description edit.
  const nativeHeadings = new Set($('[data-testid="product-detail-title"], .comp-navigation-sib, .comp-companyintroduction-title')
    .find('*').addBack().toArray());
  const nativeFaqText = new Set($('[data-testid="product-detail-qa"], .comp-faq-question, .comp-faq-answer')
    .find('*').addBack().toArray());
  $('*').each((_, node) => {
    const element = $(node);
    for (const name of Object.keys(node.attribs || {})) {
      if (/^on/i.test(name) || ['id', 'class', 'data-spm', 'contenteditable'].includes(name)) element.removeAttr(name);
    }
    const ownText = element.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    if ((!nativeFaqText.has(node) && /\bcontact us\b/i.test(ownText))
      || (!nativeHeadings.has(node) && !nativeFaqText.has(node) && /\b(?:company profile|company information|about us|our factory|supplier information)\b/i.test(ownText))
      || /\b(?:tel(?:ephone)?|phone)\b\s*[:：]?\s*\+?\d[\d ()-]{5,}\d\b/i.test(ownText)
      || /\b(?:whats?app|wechat|skype)\b\s*(?:[:：]|(?:id|account|number)\s*[:：]?)\s*[+\w@.-]{4,}/i.test(ownText)) {
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
  // Videos are transferred through the native media controls and bank roles.
  // A source link or an external video tag is not a successful media transfer.
  const withoutEmbeddedVideo = html => {
    const $ = load(html || '', null, false);
    $('video, source, track, iframe, embed, object').remove();
    return $.root().html() || '';
  };
  if (product.descriptionTemplate) return withoutEmbeddedVideo(templatePublishHtml(product));
  const sourceHtml = withoutEmbeddedVideo(sanitizeSourceDescriptionHtml(product.descriptionHtml));
  // A collected/edited rich description is the seller's layout. Attribute
  // transfer belongs to the property form, not an appended fallback table.
  if (sourceHtml.trim()) return descriptionImageSlots(sourceHtml, distinctAlibabaImageUrls(product.detailImages || []));
  const description = englishDescriptionText(product.description);
  const title = englishSpecText(product.title, 'Product Description');
  const html = [
    `<h2>${escapeHtml(title)}</h2>`,
    description && !descriptionContainsText(sourceHtml, description) ? `<p>${escapeHtml(description).replace(/\n/g, '<br>')}</p>` : '',
    descriptionImageSlots(sourceHtml, distinctAlibabaImageUrls(product.detailImages || []))
  ].filter(Boolean).join('');
  // Contact text may also come from attributes, SKU labels or split HTML nodes.
  const $ = load(html, null, false);
  removeDescriptionHtmlEmails($);
  return $.root().html() || '';
}

export function sourceDetailHasBrokenImages(value) {
  const html = String(value || '');
  const $ = load(html, null, false);
  return $('img').toArray().some(node => {
    const sources = ['src', 'data-src', 'data-original', 'data-lazy-src']
      .map(name => String($(node).attr(name) || '').trim()).filter(Boolean);
    // Supplier warranty/FAQ text (e.g. "used or broken, no guarantee") is
    // not evidence of a failed image. Inspect the image itself, and accept
    // a real lazy source even when its initial src is a loading placeholder.
    return !sources.length || sources.every(source => /^(?:about:blank|data:image\/gif;base64,R0lGODlhAQABA)/i.test(source));
  });
}

function attributeValue(product, ...names) {
  const normalize = (name) => String(name || '').toLowerCase().replace(/[\s_\-/]+/g, ' ').trim();
  const canonical = (name) => {
    const value = normalize(name);
    return requiredAttributeKey(({
      screen: 'screen size', display: 'screen size', 'screen size': 'screen size',
      屏幕: 'screen size', 屏幕尺寸: 'screen size',
      battery: 'battery capacity', 'battery capacity': 'battery capacity', 电池: 'battery capacity', 电池容量: 'battery capacity',
      cellular: 'cellular network', 'cellular network': 'cellular network', 蜂窝网络: 'cellular network',
      'processor brand': 'processor brand', 处理器品牌: 'processor brand',
      'compatible model': 'compatible model', 适用型号: 'compatible model',
      type: 'type', 'product type': 'type', 类型: 'type', 产品类型: 'type'
    })[value] || value);
  };
  const wanted = new Set(names.map(canonical));
  const direct = [...(product.attributes || []), ...(product.customAttributes || [])]
    .find((item) => wanted.has(canonical(item.name)) && item.value != null && String(item.value).trim());
  if (direct) return direct.value;
  const group = (product.variantGroups || []).find((item) => wanted.has(canonical(item.name))
    && Array.isArray(item.options) && item.options.length);
  // Older collectors set productType to the category leaf. A concrete sale
  // specification must take precedence over that generic classification.
  if (wanted.has(canonical('type')) && group?.options?.length) return group.options[0];
  const topLevel = [
    ['screen size', product.screenSize || product.screen],
    ['battery capacity', product.batteryCapacity || product.battery],
    ['processor brand', product.processorBrand], ['operation system', product.operationSystem],
    ['compatible model', product.compatibleModel], ['type', product.type || product.productType]
  ].find(([name, value]) => wanted.has(canonical(name)) && value != null && String(value).trim());
  if (topLevel) return topLevel[1];
  return group?.options?.[0] || '';
}

// Source captures are not consistent: some categories expose a value as an
// attribute, some only put it in the title, and older captures keep it in a
// SKU group. Resolve the common required fields from all three locations.
export function inferRequiredAttributeValue(product = {}, ...names) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[\s_\-/]+/g, ' ').trim();
  const wanted = new Set(names.map(normalize));
  if (names.some(isOriginRegionAttribute)) return names.map(name => sourceOriginRegion(product, name)).find(Boolean) || '';
  if (names.some((name) => requiredAttributeKey(name) === requiredAttributeKey('产地'))) return originCountry(product.origin || attributeValue(product, ...names));
  const value = attributeValue(product, ...names);
  if (value) return value;
  const text = [product.title, product.subtitle, product.description, product.descriptionHtml]
    .filter(Boolean).join(' ');
  if (wanted.has('屏幕') || wanted.has('屏幕尺寸') || wanted.has('screen') || wanted.has('screen size') || wanted.has('display')) {
    const match = text.match(/(?:^|\s)(\d{1,2}(?:\.\d+)?)\s*(?:["”]|inch(?:es)?|英寸)/i);
    if (match && /smartphone|mobile phone|phone|tablet|screen|display|monitor|屏幕|手机|平板/i.test(product.title || '')) return `${match[1]} inch`;
  }
  if (wanted.has('电池容量') || wanted.has('battery') || wanted.has('battery capacity')) {
    const match = text.match(/(?:^|\s)(\d{3,5})\s*(?:mah|毫安时)/i);
    if (match) return `${match[1]}mAh`;
  }
  if (wanted.has('处理器品牌') || wanted.has('processor brand')) {
    const match = text.match(/\b(?:snapdragon|exynos|kirin|dimensity|mediatek|mtk|apple\s+a\d+)\b(?:\s+[\w-]+){0,3}/i);
    if (match) return match[0];
  }
  if (wanted.has('适用型号') || wanted.has('compatible model')) {
    const group = (product.variantGroups || []).find((item) => /适用型号|compatible\s*model|model\s*compatibility/i.test(String(item.name || '')));
    if (group?.options?.length) return group.options[0];
    return product.model || '';
  }
  if (wanted.has('类型') || wanted.has('type') || wanted.has('product type') || wanted.has('产品类型')) {
    return product.productType || product.type || product.categoryPath?.at(-1) || product.sourceCategoryPath?.at(-1) || '';
  }
  if (wanted.has('品牌名称') || wanted.has('brand') || wanted.has('brand name')) return product.brand || product.brandName || '';
  return '';
}

export function hasCompleteSourceData(product) {
  return (product.mainImages || product.images || []).length >= 4
    && (product.detailImages || []).length >= 1
    && (product.attributes || []).length >= 2
    && Boolean(product.origin)
    && Boolean(String(product.description || product.descriptionHtml || '').trim());
}

export function validateProductData(product, { mode = 'submit' } = {}) {
  const errors = crossPlatformPublishErrors(product);
  const mainImages = product.mainImages || product.images || [];
  if (!String(product.title || '').trim()) errors.push('缺少商品标题');
  if (numericValue(product.price) <= 0) errors.push('销售价格无效');
  if (mainImages.length < 4) errors.push(`主图不足 4 张（当前 ${mainImages.length} 张）`);
  if (!(product.detailImages || []).length && !product.descriptionTemplate) errors.push('缺少详情图片');
  if (sourceDetailHasBrokenImages(product.descriptionHtml)) errors.push('详情描述包含失效图片，请先清理后再发布');
  // Attribute and logistics requirements belong to the selected category's
  // actual form. Do not reject all categories with a fixed attribute count or
  // an optional packaging weight before the form is even opened.
  if ((product.variantGroups || []).length && !(product.skus || []).length) errors.push('存在产品规格但缺少 SKU 明细');
  const sourceRange = product.sourcePriceRange || {};
  const hasSourceRange = numericValue(sourceRange.minPrice) > 0
    && numericValue(sourceRange.maxPrice) >= numericValue(sourceRange.minPrice);
  if ((product.skus || []).some((sku) => sku.price != null && sku.price !== '' && numericValue(sku.price) <= 0)) errors.push('SKU 价格无效');
  if ((product.skus || []).some((sku) => sku.stock != null && numericValue(sku.stock) < 0)) errors.push('SKU 库存无效');
  if ((product.variantGroups || []).length && (product.skus || []).some((sku) => sku.enabled !== false && numericValue(sku.stock) <= 0)) errors.push('启用的 SKU 库存必须大于 0');
  if (!hasSourceRange && (product.skus || []).some((sku) => sku.price == null || sku.price === '')) errors.push('SKU 缺少价格');
  if (!String(product.description || product.descriptionHtml || '').trim()) errors.push('缺少商品详情');
  const tiers = canonicalizePriceTiers(product.priceTiers || []);
  if (product.priceTiers) product.priceTiers = tiers;
  const minimumOrder = numericValue(tiers[0]?.minQuantity || product.minOrder || product.moq);
  const enabledSkus = (product.skus || []).filter((sku) => sku.enabled !== false);
  // The SKU matrix receives each enabled combination's stock for both collected
  // and referenced products. A stale summary stock must not override that total.
  const stockValues = product.variantGroups?.length && enabledSkus.length
    ? enabledSkus.map((sku) => sku.stock) : [product.stock];
  if (mode === 'submit' && minimumOrder > 0 && stockValues.every((stock) => stock != null && String(stock).trim() !== '' && Number.isFinite(Number(stock)))) {
    const total = stockValues.reduce((sum, stock) => sum + Number(stock), 0);
    if (total < minimumOrder) errors.push(`可售数量 ${total} 小于最小起订量 ${minimumOrder}，请核实库存或起订量`);
  }
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

// Convert collected data into a deterministic payload before touching the
// Alibaba form. The editor may display a value while its controlled state is
// empty; materializing every SKU value here gives the browser layer a complete
// set of values to commit and verify.
export function preparePublishProduct(product, options = {}) {
  product = recoverDuplicateSkuDimensions(product, { strict: true });
  product = recoverDuplicateSkuOptions(product, { strict: true, normalizeValue: englishSpecText });
  // Repair old collected poster rows even when video upload is switched off.
  product = { ...product, detailImages: nativeDescriptionImageUrls(product) };
  product = productForVideoUpload(product, options);
  product = applyStockPolicy(product, options);
  const next = { ...product };
  let descriptionStructure = currentDescriptionStructure(product);
  if (product.imageEdits?.detail && descriptionStructure) {
    // Older image edits saved the selected list but left native gallery URLs
    // untouched. Explicit edit provenance makes that list authoritative. Repair
    // only the detached publish copy; never restore deleted source images.
    descriptionStructure = syncStructuredDescriptionImages(product, {
      beforeImages: descriptionStructure.modules.filter(module => module.type === 'gallery')
        .flatMap(module => module.images.map(image => image.url)),
      detailImages: product.detailImages || [], html: product.descriptionHtml || '',
    });
  }
  next.videoUrl = productVideoUploads(product, options).find(video => video.role === 'main')?.url || '';
  const collectedAttributes = [...(product.attributes || []), ...(product.customAttributes || [])];
  next.origin = productOrigin(product) || productOriginText(product);
  next.logisticsAttributes = sourceLogisticsAttributes(product);
  if (next.origin) Object.assign(next, synchronizeProductOrigin(product, { origin: next.origin }));
  const packaging = packagingFromAttributes(collectedAttributes);
  next.packaging = { ...(product.packaging || {}) };
  for (const [name, value] of Object.entries(packaging)) {
    if (next.packaging[name] == null || next.packaging[name] === '') next.packaging[name] = value;
  }
  const usable = (url) => /^https?:\/\//i.test(String(url)) || isUsableImageUrl(url);
  next.mainImages = distinctAlibabaImageUrls((product.mainImages || product.images || []).filter(usable));
  next.images = next.mainImages;
  next.detailImages = [...new Set((product.detailImages || []).filter(usable))];
  if (descriptionStructure && !product.imageEdits?.detail) {
    // Older collectors capped product + company images at 30 together. The
    // saved native modules retain their separate scopes and full image list.
    // Repair that truncated working list without reviving manual removals.
    const nativeImages = descriptionStructure.modules.filter(module => module.type === 'gallery')
      .flatMap(module => module.images.map(image => image.url)).filter(usable);
    next.detailImages = [...new Set([...next.detailImages, ...nativeImages])];
  }
  next.descriptionHtml = product.descriptionTemplate ? sanitizeTemplateHtml(product.descriptionHtml || '') : sanitizeSourceDescriptionHtml(product.descriptionHtml || '');
  if (descriptionStructure) next.structuredDescription = { ...descriptionStructure, sourceHtmlHash: descriptionSourceHash(next.descriptionHtml) };
  if (!product.imageEdits?.detail && !next.detailImages.length && (next.descriptionHtml || product.structuredDescription?.html)) {
    const $ = load(next.descriptionHtml || sanitizeSourceDescriptionHtml(product.structuredDescription.html));
    next.detailImages = [...new Set($('img').toArray().map((node) => {
      const url = $(node).attr('data-src') || $(node).attr('data-original') || $(node).attr('src') || '';
      return url.startsWith('//') ? `https:${url}` : url;
    }).filter(usable))];
  }
  if (!next.description && next.descriptionHtml) next.description = load(next.descriptionHtml).text().replace(/\s+/g, ' ').trim();
  const fallbackPrice = numericValue(product.price) || numericValue(product.sourcePriceRange?.minPrice) || 1;
  const fallbackStock = product.stock != null && product.stock !== '' ? Number(product.stock) : 100;
  const groups = Array.isArray(product.variantGroups) ? product.variantGroups : [];
  // The editor can store an image on the SKU or the color/model map while
  // the collected group has no optionImages. Preserve explicit associations;
  // never choose between conflicting images for the same option.
  next.variantGroups = groups.map((group) => {
    const optionImages = { ...(group.optionImages || {}) };
    if (!/颜色|colou?r|^(?:model(?: number)?|型号)$/i.test(group.name) && group.type !== 'IMAGE') {
      return { ...group, optionImages };
    }
    const key = requiredAttributeKey(group.name);
    const imageMap = isColorVariantGroup(group) ? product.colorImages
      : /^(?:model(?: number)?|型号)$/i.test(group.name) ? product.modelImages : null;
    for (const value of group.options || []) {
      if (optionImages[value]) continue;
      if (imageMap?.[value]) { optionImages[value] = imageMap[value]; continue; }
      const matchingImages = [...new Set((product.skus || []).filter((sku) => sku.image
        && Object.entries(sku.attributes || {}).some(([name, option]) => requiredAttributeKey(name) === key
          && String(option).trim() === String(value).trim())).map((sku) => sku.image))];
      if (matchingImages.length === 1) optionImages[value] = matchingImages[0];
    }
    return { ...group, optionImages };
  });
  if (groups.length && Array.isArray(product.skus)) {
    next.skus = product.skus.map((sku, index) => ({
      ...sku,
      price: numericValue(sku.price) > 0 ? numericValue(sku.price).toFixed(2) : usesSkuPricing(product) ? '' : fallbackPrice.toFixed(2),
      stock: product.categoryReference && sku.stock != null && sku.stock !== '' ? Number(sku.stock)
        : sku.stock != null && sku.stock !== '' ? Number(sku.stock) : fallbackStock,
      code: String(sku.code || sku.skuCode || (product.categoryReference ? '' : `${product.sourceId || product.id || 'SKU'}-${index + 1}`)).trim()
    }));
  }
  next.priceTiers = canonicalizePriceTiers(product.priceTiers || []);
  if (usesSkuPricing(product)) next.priceMode = 'sku';
  return next;
}

export function isRequiredAttributeError(message) {
  return /(?:必填项?不能为空|属性值不能为空|不能为空|required(?: field| attribute)?[^\\n]{0,40}(?:empty|blank|missing)|attribute[^\\n]{0,40}(?:empty|required))/i.test(String(message || ''));
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

export function numericValue(value) {
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
    const clean = (value) => String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/^[*＊]\s*/, '')
      .replace(/[：:]\s*$/, '')
      .replace(/\s*(?:必填项?|required)\s*$/i, '')
      .trim()
      .toLowerCase();
    const wanted = clean(labelText);
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const requiredSpecRow = (node) => {
      const row = node.closest('#struct-specification [id^="p-"]');
      return row && [...row.querySelectorAll('label.required, .label.required')].some((heading) => clean(heading.textContent) === wanted) ? row : null;
    };
    const allowed = (node) => !node.closest('#saleAttributesItems, [class*="customizedServices"]')
      && (!node.closest('#struct-specification') || requiredSpecRow(node));
    const labels = [...document.querySelectorAll('label,div,span,h3,h4')]
      .filter((node) => visible(node) && clean(node.textContent) === wanted && allowed(node));
    for (const labelNode of labels) {
      let container = labelNode;
      const boundary = labelNode.closest('.sell-catProp-item, .next-form-item, [id^="p-"], [id^="struct-"]');
      for (let level = 0; container && level < 7; level += 1, container = container.parentElement) {
        const input = [...container.querySelectorAll('input:not([type="hidden"]),textarea,select,[contenteditable="true"]')]
          .find((node) => visible(node) && allowed(node));
        if (!input) { if (container === boundary) break; continue; }
        const stableRow = requiredSpecRow(input) || input.closest('.sell-catProp-item[id]');
        if (stableRow) {
          const controls = [...stableRow.querySelectorAll('input:not([type="hidden"]),textarea,select,[contenteditable="true"]')];
          return { rowId: stableRow.id, index: controls.indexOf(input) };
        }
        input.setAttribute('data-codex-field', marker);
        return true;
      }
    }
    return false;
  }, { labelText: label, marker: token });
  if (found?.rowId) return page.locator(`[id="${found.rowId.replace(/["\\]/g, '')}"]`)
    .locator('input:not([type="hidden"]),textarea,select,[contenteditable="true"]').nth(found.index);
  return found ? page.locator(`[data-codex-field="${token}"]`) : null;
}

async function fieldByAnyLabel(page, labels) {
  for (const label of labels.filter(Boolean)) {
    const field = await fieldByLabel(page, label);
    if (field) return field;
  }
  return null;
}

export function mainImageSlotsComplete(initialSlotCount, remainingSlotCount, expectedCount) {
  const initial = Math.max(0, Number(initialSlotCount) || 0);
  const remaining = Math.max(0, Number(remainingSlotCount) || 0);
  const expected = Math.max(0, Number(expectedCount) || 0);
  return remaining <= Math.max(0, initial - expected);
}

function mainImageControlPending(cause) {
  return Object.assign(new Error('国际站主图上传入口暂未就绪，自动恢复后仍未能选择图片；已保留当前商品进度，请稍后继续', { cause }), {
    code: 'MAIN_IMAGE_CONTROL_NOT_READY', diagnostics: { section: 'main-images' },
  });
}

async function revealMainImageControl(page, locator) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Scroll the current slot directly: an inline upload label can animate
      // or be replaced during scrolling and never pass a stability check.
      await locator.evaluate((node) => (node.closest('.image-upload-list-item') || node)
        .scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), undefined, { timeout: 2000 });
      if (await locator.isVisible()) return;
    } catch (error) {
      lastError = error;
      if (!isBrowserInteractionError(error)) throw error;
    }
    await page.waitForTimeout(200);
  }
  throw mainImageControlPending(lastError);
}

async function hoverMainImageControl(page, trigger) {
  await page.mouse.move(0, 0);
  try { await trigger.hover({ timeout: 1200 }); }
  catch (error) {
    if (!isBrowserInteractionError(error)) throw error;
    // Moving the pointer opens a hover menu even while the label animates.
    // Hit-test its current position; never force a click through a notice.
    const point = await trigger.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (left >= right || top >= bottom) return null;
      const x = (left + right) / 2, y = (top + bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === node || node.contains(hit)) ? { x, y } : null;
    }, undefined, { timeout: 1500 }).catch(() => null);
    if (point) await page.mouse.move(point.x, point.y);
  }
}

export async function mainImageUploadRecords(page, removeNames = []) {
  return page.locator('.image-uploader .image-upload-list-item').evaluateAll(async (slots, removeNames) => {
    const records = [];
    for (const [index, slot] of slots.entries()) {
      if (!slot.getClientRects().length) continue;
      const key = Object.getOwnPropertyNames(slot).find((key) => key.startsWith('__reactFiber'));
      let fiber = key && slot[key];
      let file;
      let remove;
      for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!file && props?.file) file = props.file;
        if (file && Array.isArray(props?.fileList) && props.fileList.some((item) => item === file || item.uid === file.uid) && typeof props.onRemove === 'function') {
          remove = props.onRemove;
          break;
        }
      }
      if (!file) continue;
      const name = String(file.fileName || file.name || '');
      const status = String(file.status || '');
      const remote = /^(?:https?:)?\/\//i.test(file.fileURL || '');
      const error = file.error || {};
      const message = [error.message, error.msg, error.errorMessage, file.errorMessage, typeof file.error === 'string' ? file.error : '']
        .find(value => typeof value === 'string' && value.trim())?.replace(/\s+/g, ' ').trim().slice(0, 300) || '';
      const code = Number(error.code);
      const retryable = status === 'error' && (error.isRequestError === true || [408, 429].includes(code) || code >= 500)
        && ![401, 403].includes(code);
      let removed = false;
      if (retryable && removeNames.includes(name) && remove) {
        await remove(file);
        removed = true;
      }
      records.push({ index: index + 1, name, status, remote, retryable, removed, message, code: Number.isFinite(code) ? code : null });
    }
    return records;
  }, removeNames).catch(() => []);
}

function mainImageUploadFailure(records) {
  const failed = records.filter(file => file.status === 'error');
  if (!failed.length) return null;
  const details = failed.map(file => `第 ${file.index} 张${file.name ? `（${file.name}）` : ''}：${file.message || (file.code != null ? `错误码 ${file.code}` : '平台未接收')}`);
  return Object.assign(new Error(`国际站主图上传失败：${details.join('；')}`), {
    code: failed.every(file => file.retryable) ? 'MAIN_IMAGE_UPLOAD_RETRYABLE' : 'MAIN_IMAGE_UPLOAD_FAILED',
    diagnostics: { section: 'main-images', failedImages: failed.map(({ index, name, code, message, retryable }) => ({ index, name, code, message, retryable })) },
  });
}

export async function mainImageUploadFeedback(page) {
  // Unrelated field errors and onboarding notices must not be concatenated
  // into an apparent image failure (for example “图片 ... 不符合” across rows).
  return page.evaluate(() => {
    const selectors = '.sell-error-message, .next-message-error, .next-feedback-error, [role="alert"], [class*="toast"]';
    const messages = [];
    for (const node of document.querySelectorAll(selectors)) {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') continue;
      const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
      const scoped = Boolean(node.closest('#scImages, #struct-scImages, .image-uploader'));
      if (!scoped && node.closest('[id^="struct-"], #detailImage, #companyImage, #companyFaqDesc, #textDesc')) continue;
      if (!scoped && !/(?:主图|产品图片|商品图片|image|photo).{0,80}(?:失败|过大|不符合|fail|invalid|too large)/i.test(text)) continue;
      if (/(?:上传失败|文件.{0,40}过大|图片.{0,40}不符合|upload failed|invalid image|too large)/i.test(text)) messages.push(text.slice(0, 300));
    }
    return [...new Set(messages)];
  });
}

export async function restoreMainImageOrder(page, filenames) {
  const changed = await page.locator('.image-uploader .image-upload-list-item').evaluateAll((slots, filenames) => {
    for (const slot of slots) {
      const key = Object.getOwnPropertyNames(slot).find((key) => key.startsWith('__reactFiber'));
      let fiber = key && slot[key];
      for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!Array.isArray(props?.fileList) || typeof props.onSort !== 'function') continue;
        const files = props.fileList;
        const name = (file) => String(file.fileName || file.name || '');
        if (files.length !== filenames.length || files.some((file) => !filenames.includes(name(file)))) return false;
        const sorted = filenames.map((filename) => files.find((file) => name(file) === filename));
        if (sorted.every((file, index) => file === files[index])) return true;
        props.onSort(sorted);
        return true;
      }
    }
    return false;
  }, filenames);
  if (!changed) return false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const records = await mainImageUploadRecords(page);
    if (JSON.stringify(records.map((file) => file.name)) === JSON.stringify(filenames)) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

export async function mainImageFormState(page) {
  return page.locator('.image-uploader .image-upload-list-item').evaluateAll((nodes) => {
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const slots = nodes.filter(visible);
    const empty = slots.filter((slot) => visible(slot.querySelector('#image-placeholder-span'))).length;
    let uploading = slots.filter((slot) => /uploading|loading|progress/i.test(String(slot.className || ''))
      || [...slot.querySelectorAll('[class*="uploading"], [class*="loading"], [class*="progress"]')].some(visible)).length;
    const previewUrls = slots.map((slot) => [...slot.querySelectorAll('img[src], img[data-src]')].map((image) => String(
      image.getAttribute('data-src') || image.currentSrc || image.src || ''
    )).find((source) => /^(?:(?:https?:)?\/\/|blob:|data:image)/i.test(source)) || [...slot.querySelectorAll('[style*="background-image"]')]
      .map((node) => String(node.style.backgroundImage || '').match(/url\(["']?(.+?)["']?\)/i)?.[1] || '')
      .find((source) => /^(?:(?:https?:)?\/\/|blob:|data:image)/i.test(source)) || '');
    const previews = slots.filter((slot, index) => Boolean(previewUrls[index]) && [...slot.querySelectorAll('img[src], img[data-src]')].some((image) => {
      if (!visible(image)) return false;
      const source = String(image.getAttribute('data-src') || image.currentSrc || image.src || '');
      return /^(?:(?:https?:)?\/\/|blob:|data:image)/i.test(source)
        && ((image.naturalWidth || image.width || 0) >= 32 || (image.naturalHeight || image.height || 0) >= 32);
    }) || [...slot.querySelectorAll('[style*="background-image"]')].some((node) => visible(node) && /url\(/i.test(node.style.backgroundImage || ''))).length;
    const remotePreviews = previewUrls.filter((source) => /^(?:https?:)?\/\//i.test(source) && !/loading|progress|placeholder/i.test(source)).length;
    // A retained preview can outlive Alibaba's controlled file list after a
    // specification change. Prefer that list when exposed by the uploader.
    let files = null;
    for (const node of [...slots, document.querySelector('.image-uploader')].filter(Boolean)) {
      const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith('__reactFiber'));
      let fiber = key && node[key];
      for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (Array.isArray(props?.fileList) && (typeof props.onRemove === 'function' || typeof props.onSort === 'function')) {
          files = props.fileList;
          break;
        }
      }
      if (files !== null) break;
    }
    const accepted = files?.filter((file) => file.status === 'done' && /^(?:https?:)?\/\//i.test(file.fileURL || '')).length;
    if (files) uploading = Math.max(uploading, files.filter((file) => !['done', 'error'].includes(file.status)).length);
    return {
      total: slots.length,
      empty,
      uploading,
      failed: files?.filter(file => file.status === 'error').length || 0,
      occupied: accepted ?? remotePreviews,
      modelKnown: files !== null,
      previews,
      remotePreviews,
      previewSchemes: previewUrls.map((source) => source.startsWith('//') ? 'protocol-relative' : source.split(':')[0] || '').filter(Boolean)
    };
  }).catch(() => ({ total: 0, empty: 0, uploading: 0, occupied: 0, previews: 0 }));
}

async function clearMainImagesForRetry(page) {
  const deleteAll = page.getByRole('button', { name: /删除全部图片|清空.*图片|delete all images/i }).last();
  if (await deleteAll.isVisible().catch(() => false)) {
    await deleteAll.click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
    for (const pattern of [/^确定$/, /^确认$/, /^删除$/, /确认删除|confirm|delete/i]) {
      const confirm = page.getByRole('button', { name: pattern }).last();
      if (!await confirm.isVisible().catch(() => false)) continue;
      await confirm.click({ force: true }).catch(() => {});
      break;
    }
  } else {
    // Some seller form builds do not render the "delete all" action. Remove
    // each occupied slot through its accessible delete control instead of
    // treating the visible previews as a permanent upload failure.
    await page.evaluate(() => {
      const root = document.querySelector('.image-uploader');
      if (!root) return;
      const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
      const controls = [...root.querySelectorAll('button,[role="button"],[aria-label],[title]')]
        .filter(visible)
        .filter((node) => /删除|移除|remove|delete/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.textContent || ''}`));
      for (const control of controls) control.click();
    }).catch(() => {});
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await mainImageFormState(page);
    if (!state.uploading && state.occupied === 0 && state.empty >= 4) return true;
    await page.waitForTimeout(250);
  }
  const finalState = await mainImageFormState(page);
  return finalState.occupied === 0 && finalState.empty >= 4;
}

export function distinctAlibabaImageUrls(urls = []) {
  const seen = new Set();
  const result = [];
  for (const value of urls.filter(Boolean)) {
    let key = String(value).trim();
    try {
      const parsed = new URL(value);
      // CDN derivatives append transformations after the original extension,
      // for example Hxxx.jpg_960x960q80.jpg. They are the same source asset.
      if (/(?:^|\.)alicdn\.com$/i.test(parsed.hostname) && /\/(?:kf|ibank)\//i.test(parsed.pathname)) {
        key = `alicdn:${parsed.pathname.replace(/^\/@[^/]+(?=\/(?:kf|ibank)\/)/i, '').replace(/\.(?:jpe?g|png|webp)_[^/]+$/i, (match) => match.split('_')[0])}`;
      } else {
        parsed.hash = '';
        key = parsed.href;
      }
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function isColorVariantGroup(group) {
  // Light Color, Lens Color and Color Temperature are independent properties.
  // Only the ordinary Color dimension belongs to the legacy color writer.
  return requiredAttributeKey(group?.name) === requiredAttributeKey('Color');
}

export function isRequiredTargetVariantGroup(group) {
  if (!group?.name || isColorVariantGroup(group)) return false;
  // Alibaba treats compatible model as a category attribute on the affected
  // phone/drone forms, not as a sale SKU dimension. Filling it through the
  // required-attribute path avoids the false "source specification does not
  // exist in target category" rejection.
  if (/^(?:compatible\s+model|model\s+compatibility|适用型号)$/i.test(String(group.name).trim())) return false;
  const options = [...new Set((group.options || []).map((value) => englishSpecText(value)).filter(Boolean))];
  if (options.length > 1) return true;
  const imageBacked = Object.values(group.optionImages || {}).some(Boolean);
  const normalizedName = String(group.name || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Single constants can be descriptive on another category. The target's
  // exposed dimensions are added in fillVariantSpecs, regardless of type.
  return imageBacked && /^(?:model(?: number)?|型号)$/.test(normalizedName);
}

export function buildFlattenedVariantGroup(product, targetId, targetName = 'Specification') {
  const groups = (product?.variantGroups || []).filter((group) => {
    const options = [...new Set((group?.options || []).map((value) => englishSpecText(value)).filter(Boolean))];
    return options.length > 1;
  });
  if (groups.length < 2 || !targetId) return null;
  const optionImages = {};
  const options = [];
  for (const sku of product?.skus || []) {
    const attributes = sku?.attributes || {};
    const values = groups.map((group) => {
      const entry = findSkuAttributeEntry(attributes, group.name);
      return englishSpecText(entry?.[1]);
    });
    if (values.some((value) => !value)) continue;
    const option = values.join(' / ');
    if (!options.includes(option)) options.push(option);
    if (sku?.image) optionImages[option] = sku.image;
  }
  if (!options.length) return null;
  return {
    id: String(targetId),
    name: targetName,
    type: Object.keys(optionImages).length ? 'IMAGE' : 'TEXT',
    options,
    optionImages,
    sourceGroups: groups.map((group) => group.name)
  };
}

export function findBlockingUnmappedVariant(product, unmappedAttributes = []) {
  const required = new Set();
  for (const group of product?.variantGroups || []) {
    if (!isRequiredTargetVariantGroup(group)) continue;
    // A few detail pages duplicate a single SKU option while building their
    // client-side matrix. It is descriptive data, not a publishable variant,
    // when every source SKU carries the same value for this group.
    if (Array.isArray(product?.skus) && product.skus.length) {
      const groupName = String(group.name || '').trim().toLowerCase();
      const skuValues = new Set(product.skus.map((sku) => {
        const attrs = sku?.attributes || {};
        const entry = Object.entries(attrs).find(([name]) => String(name).trim().toLowerCase() === groupName);
        return String(entry?.[1] || '').trim().toLowerCase();
      }).filter(Boolean));
      if (skuValues.size < 2) continue;
    }
    const options = [...new Set((group.options || []).map((value) => englishSpecText(value)).filter(Boolean))];
    for (const option of options) required.add(`${group.name}: ${option}`.toLowerCase());
  }
  return (unmappedAttributes || []).find((item) => required.has(String(item || '').trim().toLowerCase())) || '';
}

export function needsColorSaleSpecification(colorGroup) {
  const values = [...new Set((colorGroup?.options || [])
    .map((value) => englishSpecText(value))
    .filter(Boolean))];
  // Alibaba's target category treats Color as a required sales specification
  // even when the source has one SKU. Keep the source's single value instead
  // of clearing the control and triggering the generic required-field error.
  return values.length > 0;
}

export function shouldUseColorSaleSpecification(colorGroup, targetSupportsColor) {
  return Boolean(targetSupportsColor) && needsColorSaleSpecification(colorGroup);
}

export async function forceClearLogisticsSection(page) {
  // Kept for explicit user clearing, never used to conceal publish failures.
  const fields = await page.evaluate(readPostingLogistics);
  for (const field of fields) {
    const input = page.locator('[data-posting-logistics="' + field.index + '"]');
    await input.fill('');
    await input.press('Tab');
  }
}

async function postingLogisticsState(page, product, { complete = false, allowPartial = false } = {}) {
  const fields = await page.evaluate(readPostingLogistics);
  const accepted = await capturePostingLogistics(page);
  const sourceAttributes = sourceLogisticsAttributes(product);
  const controls = await page.evaluate(() => {
    const visible = (node) => Boolean(node?.getClientRects().length);
    const inspect = (selector) => {
      const root = [...document.querySelectorAll(selector)].find(visible);
      const input = root?.matches('input, select') ? root : root?.querySelector('input, select');
      return { present: Boolean(root), value: input?.value || '', required: Boolean(root && (root.matches('[required], [aria-required="true"], .required')
        || root.querySelector('[required], [aria-required="true"], .required'))) };
    };
    return { attributes: inspect('#logisticsProperty'), freight: inspect('#shippingTemplateId') };
  });
  const missing = missingLogisticsFields(fields, product.packaging || {}, { complete, allowPartial });
  if (complete && !fields.length && packagingDisplayRows(product.packaging).length) {
    missing.push({ field: 'packaging', label: '包装重量和尺寸输入项', reason: 'unavailable' });
  }
  const active = complete || (!allowPartial && fields.some((field) => Number(field.value) > 0));
  const selected = accepted.logisticsAttributes;
  const normalized = (value) => String(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const attributesMatch = selected.some((value) => value.trim())
    && sourceAttributes.every((value) => selected.some((item) => normalized(item) === normalized(value)));
  if (controls.attributes.present && (active || controls.attributes.required || sourceAttributes.length) && !attributesMatch) {
    missing.push({ label: '物流属性', reason: sourceAttributes.length ? 'not_committed' : 'missing_source' });
  }
  const expectedFreight = freightTemplateForProduct(product, accepted.freightTemplate);
  const freight = accepted.freightTemplate;
  const freightMatches = String(freight || '').trim() && (!expectedFreight
    || normalized(expectedFreight) === normalized(freight)
    || expectedFreight === controls.freight.value);
  const explicitFreight = String(product.freightTemplate || '').trim();
  const customFreight = explicitFreight && explicitFreight !== DEFAULT_FREIGHT_TEMPLATE;
  if (controls.freight.present && (active || controls.freight.required || customFreight) && !freightMatches) {
    missing.push({ label: '运费模板', reason: 'not_committed' });
  }
  return { fields, missing, required: fields.some((field) => field.required) || controls.attributes.required || controls.freight.required };
}

export async function applyPostingLogistics(page, product, options = {}) {
  const requested = normalizeListingMode(options.listingMode);
  const section = page.locator('#logistics-card').first();
  if (await section.isVisible().catch(() => false)) {
    await section.scrollIntoViewIfNeeded();
    // Some form components mount only when the logistics section is visible.
    if (!(await page.evaluate(readPostingLogistics)).length) await page.waitForTimeout(800);
  }
  await fillCartonMode(page, product);
  let effective = requested;
  let state;
  let opportunity = false;
  if (requested === 'auto' || requested === 'inquiry') {
    const body = await page.locator('body').innerText();
    opportunity = /(?:当前商品类型\s*[：:]\s*商机品|Current\s+Item\s+Type\s*[：:]\s*Business\s+opportunity\s+product)/i.test(body);
    if (requested === 'inquiry' && !opportunity) {
      throw Object.assign(new Error('当前发布页未确认是商机品，不能按询盘展示发布；请切换销售方式后继续'), { code: 'PUBLISH_SALES_MODE_MISMATCH' });
    }
  }
  // Decide from committed controls, not the values we hoped to select. A
  // disabled default freight option must not turn an opportunity listing into
  // a falsely complete transaction configuration.
  const filled = await fillLogisticsFields(page, product.packaging || {});
  await fillLogisticsAttributes(page, product);
  await fillFreightTemplate(page, product);
  if (requested === 'auto' || requested === 'inquiry') {
    state = await postingLogisticsState(page, product, { complete: true });
  }
  if (requested === 'auto') {
    effective = (state.missing.length || !state.fields.length) && opportunity && !state.required ? 'inquiry' : 'complete-logistics';
    const decision = { requested, effective, missingFields: [...new Set(state.missing.map((field) => field.label))],
      ...(!state.fields.length ? { packagingControls: 'unavailable' } : {}) };
    if (JSON.stringify(options.logisticsDecision) !== JSON.stringify(decision)) {
      options.onLogisticsDecision?.(effective === 'inquiry'
        ? (state.fields.length ? `物流资料缺少${decision.missingFields.join('、')}，按商机品发布，已有包装资料填写到可用控件并核对`
          : '当前发布页未提供包装重量和尺寸输入项，按商机品发布，包装资料保留在本地商品中')
        : '按完整物流资料填写并核对');
    }
    options.logisticsDecision = decision;
  }
  options.effectiveListingMode = effective;
  options.logisticsWarnings = effective === 'inquiry' && packagingDisplayRows(product.packaging).length
    ? [!state.fields.length ? '当前发布页未提供包装重量和尺寸输入项，包装数据保留在本地商品中，未写入平台 Packaging and delivery 栏'
      : '已填写来源包装数据；当前按询盘展示发布，物流资料不完整时平台可能不在公开 Packaging and delivery 栏展示，需以发布后页面为准'] : [];
  if (effective !== 'inquiry') return filled;
  // Native opportunity listings accept packaging independently of RTS
  // eligibility. Preserve supplied facts without inventing cargo or clearing
  // existing values just because freight/cargo information is incomplete.
  if (state.required) {
    throw Object.assign(new Error('当前类目要求完整运输资料，不能使用询盘展示省略物流信息'), { code: 'PUBLISH_SALES_MODE_MISMATCH' });
  }
  return filled;
}

export async function fillLogisticsFields(page, packaging = {}) {
  const fields = await page.evaluate(readPostingLogistics);
  for (const field of fields) {
    const value = logisticsControlValue(packaging, field);
    // Missing source values must not erase a seller's existing valid values.
    if (value == null) continue;
    const input = page.locator('[data-posting-logistics="' + field.index + '"]');
    await fillAndVerify(input, value, '包装' + field.key);
  }
  const verified = await page.evaluate(readPostingLogistics);
  return ['weight', 'length', 'width', 'height'].every((key) => verified.some((field) => field.key === key)
    && verified.filter((field) => field.key === key).every((field) => Number(field.value) > 0));
}

export async function fillDeliveryFields(page, deliveryTime) {
  const tiers = parseDeliveryTiers(deliveryTime);
  if (!tiers.some((tier) => tier.leadDays)) return;
  const expected = tiers.filter(tier => tier.leadDays);
  const rejected = (reason) => Object.assign(new Error(`来源发货期${reason}；已保留全部数量区间和交期`), {
    code: 'PUBLISH_DELIVERY_REJECTED', fieldName: '发货期', requiredFields: ['发货期'],
  });
  if (expected.length > 3) throw rejected('超过平台允许的 3 个区间');
  if (expected.some(tier => !(tier.upperQuantity > 0) || !(Number(tier.leadDays) > 0))) throw rejected('存在不能直接写入的数量或天数');
  const section = page.locator('#struct-ladderPeriod:visible').first();
  if (!await section.count()) return;
  await section.scrollIntoViewIfNeeded({ timeout: 3000 });
  const inputs = section.locator('input:not([type="hidden"]):visible');
  await inputs.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
    throw Object.assign(new Error('国际站发货期控件尚未加载，已保留来源交期和商品进度'), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '发货期' });
  });
  // Lead time is independent of package dimensions. Preserve the source's
  // complete schedule. A newly opened form has only one row; silently stopping
  // there loses later tiers and can leave the real MOQ outside the schedule.
  while (await inputs.count() < expected.length * 2) {
    const previousCount = await inputs.count();
    const add = section.locator('button[role="btn-add"], button').filter({ hasText: /增加数量区间|add.*(?:range|quantity)/i }).first();
    if (!await add.count() || !await add.isEnabled()) throw rejected('的新增区间控件未就绪');
    await clickPostingControl(page, add, { timeout: 3000 });
    await inputs.nth(previousCount).waitFor({ state: 'visible', timeout: 5000 });
  }
  while (await inputs.count() > expected.length * 2) {
    const previousCount = await inputs.count();
    const remove = section.locator('button[role="remove"]:enabled').last();
    if (!await remove.count()) throw rejected('含有无法移除的旧交期区间');
    await clickPostingControl(page, remove, { timeout: 3000 });
    await page.waitForFunction(count => [...document.querySelectorAll('#struct-ladderPeriod input:not([type="hidden"])')]
      .filter(node => node.getClientRects().length).length < count, previousCount, { timeout: 5000 });
  }
  for (let index = 0; index < expected.length; index++) {
    const tier = expected[index];
    const quantity = inputs.nth(index * 2);
    const days = inputs.nth(index * 2 + 1);
    await fillAndVerify(quantity, tier.upperQuantity, '交期数量');
    await quantity.press('Tab');
    await fillAndVerify(days, tier.leadDays, '交期天数');
    await days.press('Tab');
  }
  const actual = await inputs.evaluateAll(nodes => nodes.map(node => Number(node.value)));
  if (expected.some((tier, i) => actual[i * 2] !== tier.upperQuantity || actual[i * 2 + 1] !== Number(tier.leadDays))) {
    throw rejected('写入后发生变化');
  }
  return expected;
}

export async function repairPostingLogistics(page, product, options = {}) {
  const before = { logistics: await capturePostingLogistics(page), delivery: await capturePostingDelivery(page) };
  await applyPostingLogistics(page, product, options);
  await fillDeliveryFields(page, product.deliveryTime);
  await requireLogisticsReady(page, product, options);
  const after = { logistics: await capturePostingLogistics(page), delivery: await capturePostingDelivery(page) };
  // Only retry a confirmed field repair. Unchanged or absent source facts
  // cannot justify another submission, including a missing lead-time table.
  return JSON.stringify(before) !== JSON.stringify(after);
}

export async function requireLogisticsReady(page, product, options = {}) {
  const listingMode = normalizeListingMode(options.effectiveListingMode || options.listingMode);
  const { missing } = await postingLogisticsState(page, product, {
    complete: listingMode !== 'inquiry', allowPartial: listingMode === 'inquiry',
  });
  if (!missing.length) return;
  const labels = [...new Set(missing.map((item) => item.label))];
  throw Object.assign(new Error('完整物流资料待补充：' + labels.join('、') + '；可补齐后重试，或选择自动判断/询盘展示（保留包装资料）'), {
    code: 'PUBLISH_REQUIRED_DATA_MISSING', requiredFields: missing.map((item) => item.label),
    listingMode, diagnostics: { section: 'logistics', missing },
    missingSourceFields: missing.filter((item) => item.reason === 'missing_source').map((item) => item.label),
    unmatchedSourceFields: missing.filter((item) => item.reason !== 'missing_source').map((item) => item.label),
  });
}

export async function fillCartonMode(page, product) {
  const expected = cartonModeForProduct(product);
  const radio = page.getByRole('radio', { name: expected, exact: true }).first();
  if (await radio.isVisible().catch(() => false) && !await radio.isDisabled()) {
    if (!await radio.isChecked()) await clickPostingControl(page, radio, { timeout: 3000 });
    if (await radio.isChecked()) return true;
    throw Object.assign(new Error('箱规选项尚未生效，已保留当前商品进度，请稍后继续'), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '箱规' });
  }
  const labelled = page.getByRole('combobox', { name: /^(?:箱规|装箱方式)/ }).first();
  const field = await labelled.isVisible().catch(() => false) ? labelled : await fieldByAnyLabel(page, ['箱规', '装箱方式']);
  if (!field || await field.isDisabled()) return false;
  return fillChoice(page, field, expected, { minimumScore: 100 });
}

async function fillFreightTemplate(page, product) {
  const accepted = await capturePostingLogistics(page);
  const expected = freightTemplateForProduct(product, accepted.freightTemplate);
  if (accepted.freightTemplate === expected) return true;
  const field = await firstVisible(page, ['#shippingTemplateId input', '#shippingTemplateId select', 'input[name="shippingTemplateId"]', 'select[name="shippingTemplateId"]'])
    || await fieldByAnyLabel(page, ['运费模板', '物流提供方式', 'Shipping template', 'Freight template']);
  if (!field || await field.isDisabled()) return false;
  if (await field.evaluate((node) => node.readOnly && !node.closest('.next-select, [role="combobox"]') && node.getAttribute('role') !== 'combobox')) return false;
  if (!await fillChoice(page, field, expected, { minimumScore: 100 })) return false;
  return (await capturePostingLogistics(page)).freightTemplate === expected;
}

export async function fillOriginCountry(page, value) {
  const literalFields = (await page.evaluate(readPostingAttributeSchema))
    .filter(field => requiredAttributeKey(field.label) === '产地'
      && (isLiteralOriginField(field) || (!originCountry(value) && originValueForField({ origin: value }, field)))
      && !(field.allowsCustomValue && isCountryOnlyOrigin(value)));
  if (literalFields.length === 1 && String(value ?? '').trim()) {
    const descriptor = literalFields[0];
    const input = categoryFieldLocator(page, descriptor);
    // Older country pickers look like plain inputs until their popup opens.
    // Probe before accepting arbitrary text as a committed literal value.
    await clickPostingControl(page, input);
    await page.waitForTimeout(200);
    const options = page.locator('.sell-o-select-options:visible, .next-select-dropdown:visible, [role="listbox"]:visible');
    if (descriptor.allowsCustomValue || !isLiteralOriginField(descriptor) || !await options.count()) {
      if (!await fillChoice(page, input, value)) return false;
      let since = 0;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const current = (await page.evaluate(readPostingAttributeSchema)).find(field => field.rowId === descriptor.rowId && field.rowIndex === descriptor.rowIndex);
        if (current && attributeFieldMatchesValue(current, value)) {
          since ||= Date.now();
          if (Date.now() - since >= 650) return true;
        } else since = 0;
        await page.waitForTimeout(100);
      }
      return false;
    }
  }
  const country = originCountry(value);
  if (!country) return false;
  const labels = ['原产地', '产地', 'Place of Origin', 'Country of Origin', 'Origin'];
  const diagnostics = { section: 'origin-country', field: '产地', attempts: 0, step: 'find-control' };
  let field;
  let seenField = false;
  let lastError;
  // Do not persist exception text: browser call logs can contain form data.
  // Structured reasons and control state are sufficient to locate this step.
  const retryable = (error) => !error.code && isBrowserInteractionError(error)
    && /timeout|not attached|Execution context was destroyed|Cannot find context/i.test(error.message)
    && !/Target.*closed|browser has been closed/i.test(error.message);
  const readCurrent = async (clicked = false) => {
    field = await fieldByAnyLabel(page, labels);
    diagnostics.control = { present: Boolean(field) };
    if (!field) return false;
    seenField = true;
    const state = await field.evaluate((node, wasClicked) => {
      const row = node.closest('.sell-catProp-item, .next-form-item') || node.parentElement;
      const values = [...row.querySelectorAll('.next-select-values, .next-tag-body, [class*="selected-value"]')].map((item) => item.textContent);
      // Alibaba also renders origin as an editable AutoComplete without a
      // combobox role or selected chip. Read this property's committed model,
      // not the input/search buffer, and never borrow another property's value.
      let modelValues = null;
      const propertyName = row.id?.replace(/^struct-/, '');
      const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      let fiber = row[fiberKey];
      let root = fiber;
      while (root?.return) root = root.return;
      if (root?.stateNode?.current && root.stateNode.current !== root && fiber?.alternate) fiber = fiber.alternate;
      for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props?.id !== 'icbuCatProp' || !propertyName || props.name !== propertyName) continue;
        modelValues = [];
        const selected = props.value;
        if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
          const option = props.dataSource?.find?.(item => String(item.value) === String(selected.value));
          modelValues.push(selected.text, option?.text || option?.label);
        } else if (typeof selected === 'string') modelValues.push(selected);
        break;
      }
      if (node.tagName === 'SELECT') values.push(...[...node.selectedOptions].flatMap((option) => [option.value, option.textContent]));
      else if (node.readOnly || (wasClicked && node.getAttribute('role') !== 'combobox')) values.push(node.value);
      return { values, modelValues, tag: node.tagName, role: node.getAttribute('role') || '', readOnly: Boolean(node.readOnly), disabled: Boolean(node.disabled) };
    }, clicked, { timeout: 1000 });
    const { values, modelValues, ...control } = state;
    diagnostics.control = { present: true, ...control, hasValue: (modelValues ?? values).some((item) => String(item || '').trim()) };
    if (modelValues !== null) {
      const countries = [...new Set(modelValues.filter(item => String(item || '').trim()).map(originCountry))];
      return countries.length === 1 && countries[0] === country;
    }
    return values.some((item) => originCountry(item) === country);
  };
  const waitForCommit = async () => {
    diagnostics.step = 'verify-selection';
    const deadline = Date.now() + 1800;
    do {
      if (await readCurrent(true)) return true;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    return false;
  };
  const select = async () => {
    diagnostics.step = 'find-control';
    if (await readCurrent()) return true;
    if (!field) { diagnostics.reason = 'control-missing'; return false; }
    if (diagnostics.control.disabled) { diagnostics.reason = 'control-disabled'; return false; }
    if (diagnostics.control.tag === 'SELECT') {
      diagnostics.step = 'select-option';
      const options = await field.locator('option:not(:disabled)').evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, label: node.textContent })));
      const match = options.find((option) => option.value && (originCountry(option.label) === country || originCountry(option.value) === country));
      if (!match) { diagnostics.reason = 'option-unmatched'; return false; }
      await field.selectOption(match.value, { timeout: 4000 });
      diagnostics.reason = 'selection-uncommitted';
      return waitForCommit();
    }
    diagnostics.step = 'open-menu';
    await clickPostingControl(page, field);
    await page.locator(VISIBLE_ATTRIBUTE_MENU).first().waitFor({ state: 'visible', timeout: 4000 });
    const definition = ORIGIN_COUNTRIES.find((item) => item.name === country);
    // Inspect the unfiltered list first: English searches can hide Chinese options.
    for (const query of [null, country, definition?.label, definition?.code].filter((item) => item !== undefined)) {
      await readCurrent();
      if (!field) { diagnostics.reason = 'control-missing'; return false; }
      let menu = await attributeMenuForControl(page, field);
      if (!menu) { diagnostics.reason = 'menu-unavailable'; return false; }
      if (query !== null) {
        diagnostics.step = 'search-option';
        const search = menu.locator('input:not([readonly]):not([type="hidden"])').first();
        if (await search.isVisible()) await search.fill(query, { timeout: 2000 });
        else if (!diagnostics.control.readOnly && !diagnostics.control.disabled) await field.fill(query, { timeout: 2000 });
        else break;
      }
      diagnostics.step = 'read-options';
      const deadline = Date.now() + 1200;
      do {
        // Both the input and portal can be replaced while options are loading.
        await readCurrent();
        if (!field) { diagnostics.reason = 'control-missing'; return false; }
        menu = await attributeMenuForControl(page, field);
        if (!menu) { diagnostics.reason = 'menu-unavailable'; return false; }
        const options = menu.locator('.options-item:visible, [role="option"]:visible, .next-menu-item:visible');
        const entries = await options.evaluateAll((nodes) => nodes.map((node) => ({
          label: node.textContent, value: node.getAttribute('data-value') || node.getAttribute('value'),
          disabled: node.getAttribute('aria-disabled') === 'true' || node.classList.contains('disabled') || node.classList.contains('next-disabled'),
        })));
        const index = entries.findIndex((item) => !item.disabled && (originCountry(item.label) === country || originCountry(item.value) === country));
        if (index >= 0) {
          diagnostics.step = 'select-option';
          await clickPostingControl(page, options.nth(index));
          diagnostics.reason = 'selection-uncommitted';
          return waitForCommit();
        }
        await page.waitForTimeout(100);
      } while (Date.now() < deadline);
    }
    diagnostics.reason = 'option-unmatched';
    return false;
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    diagnostics.attempts = attempt + 1;
    delete diagnostics.reason;
    delete diagnostics.browserOperation;
    lastError = null;
    let accepted = false;
    try {
      accepted = await select();
    } catch (error) {
      if (!retryable(error) || page.isClosed()) {
        error.diagnostics = { ...diagnostics, ...(error.diagnostics || {}) };
        throw error;
      }
      lastError = error;
      diagnostics.reason = 'browser-control-changed';
      diagnostics.browserOperation = error.message.match(/(?:locator|page|frame)\.[a-zA-Z]+(?=:)/)?.[0] || 'read-control';
    }
    // Policy, cancellation and closed-page errors above propagate immediately.
    // Only retry this field; never reload the form or repeat save/submit.
    try {
      if (seenField && !await closePostingAttributeMenus(page) && diagnostics.reason !== 'option-unmatched') {
        accepted = false;
        diagnostics.step = 'close-menu';
        diagnostics.reason = 'menu-still-open';
        await requireClearPostingOverlays(page);
      }
      if (accepted) {
        diagnostics.step = 'verify-selection';
        accepted = await readCurrent(true);
        if (!accepted) diagnostics.reason = 'selection-uncommitted';
      }
    } catch (error) {
      if (!retryable(error) || page.isClosed()) {
        error.diagnostics = { ...diagnostics, ...(error.diagnostics || {}) };
        throw error;
      }
      accepted = false;
      lastError ||= error;
      diagnostics.step = 'close-menu';
      diagnostics.reason = 'browser-control-changed';
    }
    if (accepted) return true;
    if (attempt < 2) await page.waitForTimeout(250 * (attempt + 1));
  }
  if (lastError || ['menu-unavailable', 'menu-still-open', 'control-disabled'].includes(diagnostics.reason)
    || (seenField && diagnostics.reason === 'control-missing')) {
    throw Object.assign(new Error('国际站产地控件在重试 3 次后仍未就绪，已保留当前商品进度，请稍后继续', { cause: lastError }), {
      code: 'PUBLISH_FIELD_NOT_READY', fieldName: '产地', diagnostics,
    });
  }
  return false;
}

// Prefer stable IDs, then a unique semantic match. A stale ID must not suppress
// a valid label; equally plausible ranges must not silently select the first.
export function chooseAttributeOption(options, value, valueId, minimumScore = 70) {
  const available = options.map((option, index) => ({ ...option, index })).filter((option) => !option.disabled);
  if (valueId != null) {
    const exact = available.filter((option) => String(option.value) === String(valueId));
    if (exact.length === 1) return exact[0];
  }
  const ranked = available.map((option) => ({ ...option, score: attributeOptionMatchScore(value, option.label) }))
    .filter((option) => option.score >= minimumScore).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1]?.score === ranked[0].score
    && (ranked[1].value !== ranked[0].value || ranked[1].label !== ranked[0].label))) return null;
  return ranked[0];
}

const isOtherOption = (value) => /^(?:other|others|其他|其它|自定义)$/i.test(String(value || '').trim());
const ATTRIBUTE_MENU_SEARCH = 'input:not([readonly]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]):not([type="button"]):not([type="submit"]):visible';
function otherAttributeOption(options) {
  const candidates = options.map((option, index) => ({ ...option, index })).filter((option) => !option.disabled && isOtherOption(option.label));
  return candidates.length === 1 ? candidates[0] : null;
}

async function fillOtherAttributeText(locator, value) {
  const row = locator.locator('xpath=ancestor::*[@data-posting-attribute-row or starts-with(@id,"p-") or starts-with(@id,"struct-p-") or contains(concat(" ", normalize-space(@class), " "), " sell-catProp-item ")][1]');
  const input = row.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([readonly]):not([disabled]):not([role="combobox"]):visible, textarea:not([readonly]):not([disabled]):visible');
  if (!await input.first().waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false) || await input.count() !== 1) return false;
  await input.fill(String(value), { timeout: 2000 });
  await input.press('Tab');
  return (await input.inputValue().catch(() => '')).trim() === String(value).trim();
}

// OE codes are free-form values on some Alibaba category forms. Those forms
// still expose an ARIA combobox, but do not provide a selectable option or a
// maxcustomitems flag. Treat the editable control as a committed custom value
// after firing the same input/change events a user action would fire.
async function fillCustomComboboxValue(page, locator, value) {
  const metadata = await locator.evaluate((node) => ({
    tag: node.tagName,
    readOnly: node.readOnly,
    disabled: node.disabled,
    role: node.getAttribute('role'),
  })).catch(() => null);
  if (!metadata || metadata.disabled || metadata.readOnly || !['INPUT', 'TEXTAREA'].includes(metadata.tag)
    || (metadata.role !== 'combobox' && metadata.role !== null)) return null;
  const values = attributeValueList(value, { multiple: true });
  if (!values.length) return false;
  const row = locator.locator('xpath=ancestor::*[@data-posting-attribute-row or starts-with(@id,"p-") or starts-with(@id,"struct-p-") or contains(concat(" ", normalize-space(@class), " "), " sell-catProp-item ")][1]');
  const committedValues = () => row.evaluate((node) => {
    const values = [...node.querySelectorAll('input, textarea, .next-tag-body, .next-select-values em, [class*="selected-value"]')]
      .filter((item) => item.getClientRects().length)
      .map((item) => String(item.value ?? item.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return values;
  }).catch(() => []);
  for (const candidate of values) {
    const current = await committedValues();
    if (current.some((item) => attributeOptionMatchScore(candidate, item) >= 100)) continue;
    await clickPostingControl(page, locator).catch(postingInteractionFailure);
    await locator.fill(String(candidate), { timeout: 3000 });
    await locator.press('Enter').catch(() => {});
    await locator.press('Tab').catch(() => {});
    await locator.evaluate((node) => {
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.blur();
    }).catch(() => {});
    const deadline = Date.now() + 2500;
    let committed = false;
    while (Date.now() < deadline) {
      const actual = await committedValues();
      committed = actual.some((item) => attributeOptionMatchScore(candidate, item) >= 100);
      if (committed) break;
      await page.waitForTimeout(100);
    }
    if (!committed) return false;
  }
  await row.evaluate((node) => node.setAttribute('data-kua-yipu-custom-committed', 'true')).catch(() => {});
  return true;
}

export async function fillChoice(page, locator, value, { valueIds = {}, minimumScore = 70, labels = {}, multiple, allowCustomCombo = false, onValueCommitted = () => {} } = {}) {
  if (!locator || value == null || value === '') return false;
  if (!await locator.count().catch(() => 0)) return false;
  const expected = attributeTextValue(value);
  const kind = await locator.evaluate((node) => ({ tag: node.tagName, type: node.type,
    role: node.getAttribute('role'), hasReadonlyAttribute: node.hasAttribute('readonly') })).catch(() => null);
  if (!kind) return false;
  if (kind.tag === 'SELECT') {
    // These reads precede every action; capture one current control snapshot
    // while keeping selection, rollback and committed-value checks separate.
    const { options, multiple, previous } = await locator.evaluate((node) => ({
      options: [...node.querySelectorAll('option')].map((option) => ({ value: option.value, label: option.textContent,
        disabled: option.disabled || option.parentElement?.disabled || !option.value })),
      multiple: node.multiple,
      previous: [...node.selectedOptions].map((option) => option.value),
    }));
    // A DOM capture joins multi-select labels into one string; keep a literal
    // comma when that complete label is itself an available option.
    const values = attributeValueList(value, { multiple, options, valueIds });
    const targets = values.map((item) => chooseAttributeOption(options, item, valueIds[item], minimumScore) || otherAttributeOption(options));
    if (targets.some((item) => !item) || (targets.length > 1 && !multiple)) return false;
    const custom = targets.flatMap((option, index) => isOtherOption(option.label) && !isOtherOption(values[index]) ? [values[index]] : []);
    if (custom.length > 1) return false;
    await locator.selectOption(targets.map((item) => item.value), { timeout: 4000 });
    if (custom.length && !await fillOtherAttributeText(locator, custom[0])) {
      await locator.selectOption(previous, { timeout: 2000 }).catch(() => {});
      return false;
    }
    const committed = await locator.evaluate((node, expected) => node.selectedOptions.length === new Set(expected).size
      && expected.every((value) => [...node.selectedOptions].some((option) => option.value === value)), targets.map((item) => item.value));
    if (committed) targets.forEach((option, index) => { if (valueIds[values[index]] != null) onValueCommitted(String(valueIds[values[index]]), isOtherOption(option.label) && custom.length ? custom[0] : option.label); });
    return committed;
  }
  if (['checkbox', 'radio'].includes(kind.type)) {
    const row = locator.locator('xpath=ancestor::*[@data-posting-attribute-row or starts-with(@id,"p-") or contains(concat(" ", normalize-space(@class), " "), " sell-catProp-item ")][1]');
    const checkboxLabels = row.locator('label').filter({ has: page.locator('input[type="checkbox"], input[type="radio"]') });
    const initialOptions = await checkboxLabels.evaluateAll((nodes) => nodes.map((node) => ({ label: node.textContent })));
    const values = attributeValueList(value, { multiple: kind.type === 'checkbox', options: initialOptions, valueIds });
    if (values.length > 1 && kind.type === 'radio') return false;
    const findOption = async (candidate, allowOther = true) => {
      const options = await checkboxLabels.evaluateAll((nodes) => nodes.map((node) => ({ value: node.querySelector('input')?.value,
        label: node.textContent, disabled: node.querySelector('input')?.disabled })));
      return chooseAttributeOption(options, candidate, valueIds[candidate], minimumScore) || (allowOther ? otherAttributeOption(options) : null);
    };
    for (const candidate of values) {
      if (await findOption(candidate, false)) continue;
      // A category may offer both Other and Add more. Preserve each custom
      // SKU value through Add more before considering the generic Other
      // fallback; otherwise one custom value rolls back the whole group.
      const add = row.locator('.sell-sequential-combocheckbox button.add-button:visible').last();
      if (!await add.isVisible().catch(() => false) || await add.isDisabled()) {
        if (await findOption(candidate)) continue;
        return false;
      }
      await clickPostingControl(page, add);
      const custom = row.locator('.sell-sequential-combobox-custom-wrap input:visible').last();
      if (!await custom.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) return false;
      await custom.fill(String(candidate));
      await custom.press('Tab');
      const deadline = Date.now() + 2000;
      while (!await findOption(candidate, false) && Date.now() < deadline) await page.waitForTimeout(100);
      if (!await findOption(candidate, false)) return false;
    }
    // Resolve every value before replacing a stale/default selection. All
    // actions stay inside this one attribute row, including read-back.
    const targets = await Promise.all(values.map(findOption));
    if (targets.some((target) => !target)) return false;
    const custom = targets.flatMap((target, index) => isOtherOption(target.label) && !isOtherOption(values[index]) ? [values[index]] : []);
    if (custom.length > 1) return false;
    const previous = await checkboxLabels.evaluateAll((nodes) => nodes.map((node) => node.querySelector('input')?.checked));
    const indexes = new Set(targets.map((target) => target.index));
    for (let index = 0; index < await checkboxLabels.count(); index++) {
      const label = checkboxLabels.nth(index), input = label.locator('input').first();
      const desired = indexes.has(index);
      if (kind.type === 'radio' && !desired) continue;
      if (await input.isChecked() !== desired) await clickPostingControl(page, label, {
        confirmResult: () => input.isChecked().then(checked => checked === desired),
      });
    }
    if (custom.length && !await fillOtherAttributeText(locator, custom[0])) {
      for (let index = 0; index < previous.length; index++) {
        const label = checkboxLabels.nth(index);
        if (await label.locator('input').first().isChecked() !== previous[index]) await clickPostingControl(page, label, { timeout: 1000 }).catch(postingInteractionFailure);
      }
      return false;
    }
    const deadline = Date.now() + 2000;
    do {
      const checks = await checkboxLabels.evaluateAll((nodes) => nodes.map((node) => node.querySelector('input')?.checked));
      if (checks.every((checked, index) => checked === indexes.has(index))) {
        targets.forEach((target, index) => { if (valueIds[values[index]] != null) onValueCommitted(String(valueIds[values[index]]), isOtherOption(target.label) && custom.length ? custom[0] : target.label); });
        return true;
      }
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    return false;
  }
  const selectedValues = () => locator.evaluate((node) => {
    const root = node.closest('.next-select, [data-posting-attribute-row], .sell-catProp-item');
    const values = [...(root?.querySelectorAll('.next-select-values em, .next-tag-body, [class*="selected-value"]') || [])]
      .map((item) => item.textContent).concat(node.readOnly && node.value ? [node.value] : []);
    if (!values.some((value) => /^(?:other|others|其他|其它|自定义)$/i.test(value.trim()))) return values;
    const row = node.closest('[data-posting-attribute-row], .sell-catProp-item');
    const custom = [...(row?.querySelectorAll('input:not([readonly]):not([disabled]):not([role="combobox"]), textarea') || [])]
      .filter((input) => !['checkbox', 'radio', 'hidden', 'file', 'button', 'submit'].includes(input.type) && input.getClientRects().length)
      .map((input) => input.value.trim()).filter(Boolean);
    return custom.length ? values.filter((value) => !/^(?:other|others|其他|其它|自定义)$/i.test(value.trim())).concat(custom) : values;
  }, undefined, { timeout: 1000 }).catch(() => []);
  const openChoice = () => clickPostingControl(page, locator, { confirmResult: async () => {
    if (await locator.getAttribute('aria-expanded', { timeout: 1000 }) !== 'true') return false;
    return Boolean(await attributeMenuForControl(page, locator));
  } });
  let chosenLabel = '';
  const chooseVisibleOption = async (candidate, allowOther = false) => {
    // On slow desktops the trigger expands before the portal/search input
    // mounts. Wait for the actual popup before binding its options and search.
    if (!await page.locator(VISIBLE_ATTRIBUTE_MENU).first()
      .waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) return false;
    const menu = await attributeMenuForControl(page, locator);
    if (!menu) return false;
    const options = menu.locator('.options-item:visible, [role="option"]:visible, .next-menu-item:visible, .next-select-menu-item:visible');
    // Alibaba's search can return no results for a complete option label
    // containing parentheses. Select an already loaded exact value first.
    const chooseLoaded = async () => {
      const available = await options.evaluateAll((nodes) => nodes.map((node) => {
        let value = node.getAttribute('data-value') ?? node.getAttribute('value');
        if (value == null) {
          const key = Object.getOwnPropertyNames(node).find((key) => key.startsWith('__reactFiber'));
          let fiber = key && node[key];
          for (let depth = 0; fiber && depth < 5; depth++, fiber = fiber.return) {
            const id = fiber.memoizedProps?.value;
            if (typeof id === 'string' || typeof id === 'number') { value = String(id); break; }
          }
        }
        return { value, label: node.textContent, disabled: node.getAttribute('aria-disabled') === 'true'
          || node.classList.contains('disabled') || node.classList.contains('next-disabled') };
      }));
      const match = chooseAttributeOption(available, candidate, valueIds[candidate], minimumScore) || (allowOther ? otherAttributeOption(available) : null);
      if (!match) return false;
      chosenLabel = match.label;
      return clickPostingControl(page, options.nth(match.index), { confirmResult: async () =>
        (await selectedValues()).some(text => attributeOptionMatchScore(match.label, text) >= 100),
      }).then(() => true, postingInteractionFailure);
    };
    if (await chooseLoaded()) return true;
    // The menu virtualizes its options. Search reveals values outside the
    // first nine rows, including 6.6-inch screens and 6000-6999mAh batteries.
    let search = menu.locator(ATTRIBUTE_MENU_SEARCH).first();
    if (!await search.count() && await locator.getAttribute('readonly') !== null) {
      await search.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
    }
    if (!await search.count()) search = locator;
    const searchable = await search.evaluateAll((nodes) => Boolean(nodes[0] && !nodes[0].readOnly && !nodes[0].disabled));
    if (searchable && await search.isVisible().catch(() => false)) {
      // A tag search creates the prospective custom value from this exact
      // text. Numeric-only filtering would turn 2.4A or Model 12 into a
      // different value; reserve it for fixed-option searchable menus.
      const createsCustom = await locator.evaluateAll((nodes) => Number(nodes[0]?.getAttribute('maxcustomitems')) > 0);
      await search.fill(createsCustom ? candidate : candidate.match(/\d+(?:\.\d+)?/)?.[0] || candidate);
      await page.waitForTimeout(300);
    }
    const deadline = Date.now() + 5000;
    do {
      if (await chooseLoaded()) return true;
      await page.waitForTimeout(200);
    } while (Date.now() < deadline);
    return false;
  };
  const isCombo = kind.role === 'combobox' || kind.hasReadonlyAttribute;
  if (isCombo) {
    if (allowCustomCombo) {
      const customResult = await fillCustomComboboxValue(page, locator, value);
      if (customResult !== null) return customResult;
    }
    const declaredMultiple = multiple ?? await locator.evaluate((node) => {
      const root = node.closest('.next-select') || node;
      const flag = node.getAttribute('aria-multiselectable') ?? root.getAttribute('aria-multiselectable');
      return flag != null ? flag === 'true' : root.classList.contains('next-select-single') ? false : undefined;
    });
    let visibleOptions = [];
    // Inspect complete labels before splitting a joined source value. This is
    // shared by all categories, including literal comma-bearing fabric names.
    if (declaredMultiple !== false && /[,;，；\s]/.test(expected)) {
      await openChoice().catch(postingInteractionFailure);
      if (!await locator.count().catch(() => 0)) return false;
      await page.locator(VISIBLE_ATTRIBUTE_MENU).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const popup = await attributeMenuForControl(page, locator);
      if (popup) {
        visibleOptions = await popup.locator('.options-item, [role="option"], .next-menu-item, .next-select-menu-item')
          .evaluateAll((nodes) => nodes.map((node) => ({ label: node.textContent })));
      }
      await closePostingAttributeMenus(page);
    }
    const candidates = attributeValueList(value, { multiple: declaredMultiple !== false, options: visibleOptions, valueIds });
    if (declaredMultiple === false && candidates.length > 1) return false;
    let selected = true;
    const wantedLabels = candidates.map((candidate) => labels[valueIds[candidate]] || candidate);
    const unexpected = (await selectedValues()).some((text) => !wantedLabels.some((candidate) => attributeOptionMatchScore(candidate, text) >= minimumScore));
    if (unexpected) {
      // Clear removable chips through their own controls. Do not manipulate
      // React state or clear another property in a shared row.
      const selectRoot = locator.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " next-select ")][1]');
      const remove = selectRoot.locator('.next-tag-close-btn:visible, .next-select-values .next-icon-close:visible, [data-selected-value] [aria-label="Remove"]:visible');
      for (let attempt = 0; attempt < 24 && await remove.count(); attempt++) {
        const before = JSON.stringify(await selectedValues());
        if (!await clickPostingControl(page, remove.first(), { timeout: 1000 }).then(() => true, postingInteractionFailure)) break;
        const deadline = Date.now() + 1000;
        while (JSON.stringify(await selectedValues()) === before && Date.now() < deadline) await page.waitForTimeout(50);
        if (JSON.stringify(await selectedValues()) === before) break;
      }
    }
    const committed = [];
    for (const candidate of candidates) {
      chosenLabel = '';
      const selectedTexts = await selectedValues();
      const knownLabel = labels[valueIds[candidate]] || candidate;
      if (selectedTexts.some((text) => attributeOptionMatchScore(knownLabel, text) >= minimumScore)) { committed.push(knownLabel); continue; }
      if (await locator.getAttribute('aria-expanded').catch(() => '') !== 'true') {
        await openChoice().catch(postingInteractionFailure);
      }
      await page.waitForTimeout(180);
      // Opening an option menu can replace its input during a category rerender.
      // An absent input is not a custom-value control and must not abort the item.
      if (!await locator.count().catch(() => 0)) return false;
      const acceptsCustom = Number(await locator.getAttribute('maxcustomitems', { timeout: 1000 }).catch(() => null)) > 0;
      // Read the existing options first. Searching a tag control creates a
      // custom option even when a built-in label differs only by whitespace
      // (observed for " Li-ion" and "Universal\u00a0"). Pre-filling here
      // makes that unambiguous built-in choice look like two different IDs.
      let chose = await chooseVisibleOption(candidate);
      if (!chose && acceptsCustom) await locator.fill('').catch(() => {});
      if (!chose) {
        // Search may have hidden Other. Restore the unfiltered menu before
        // looking for its genuine custom-value entry.
        const popup = await attributeMenuForControl(page, locator);
        const search = popup?.locator(ATTRIBUTE_MENU_SEARCH).first();
        if (search && await search.count()) { await search.fill(''); await page.waitForTimeout(200); }
        chose = await chooseVisibleOption(candidate, true);
      }
      if (chose && isOtherOption(chosenLabel) && !isOtherOption(candidate)) {
        chose = await fillOtherAttributeText(locator, candidate);
        if (chose) chosenLabel = candidate;
        else { await closePostingAttributeMenus(page); return false; }
      }
      // The click can return before React commits the selection, especially
      // on remote/low-memory desktops. Read the actual value before closing
      // the menu or starting the next selection; a fixed 180ms is not enough.
      const wanted = chosenLabel || candidate;
      const deadline = Date.now() + 5000;
      do {
        chose = (await selectedValues()).some((text) => attributeOptionMatchScore(wanted, text) >= minimumScore);
        if (chose) break;
        await page.waitForTimeout(100);
      } while (Date.now() < deadline);
      await closePostingAttributeMenus(page);
      if (chose) {
        committed.push(wanted);
        if (chosenLabel && valueIds[candidate] != null) onValueCommitted(String(valueIds[candidate]), chosenLabel);
      }
      selected &&= chose;
    }
    await locator.evaluate((node) => node.blur()).catch(() => {});
    const finalValues = await selectedValues();
    return selected && committed.every((candidate) => finalValues.some((text) => attributeOptionMatchScore(candidate, text) >= minimumScore))
      && finalValues.every((text) => committed.some((candidate) => attributeOptionMatchScore(candidate, text) >= minimumScore));
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A stale or category-specific control must fail quickly. The outer
    // publish stage has a long timeout for network work, but a single missing
    // field should never consume that entire timeout.
    await locator.fill(expected, { timeout: 2000 }).catch(() => {});
    if (!await locator.count().catch(() => 0)) return false;
    await page.waitForTimeout(350);
    if (!await locator.count().catch(() => 0)) return false;
    const popup = await attributeMenuForControl(page, locator);
    const exactOption = popup?.locator('[role="option"]:visible, .next-menu-item:visible')
      .filter({ hasText: new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if (exactOption && await exactOption.count() === 1) await clickPostingControl(page, exactOption).catch(postingInteractionFailure);
    // Editable model rows cancel and remove themselves on Escape while
    // focused. Blur first to commit the value, then close any suggestion menu.
    await locator.evaluateAll((nodes) => {
      const node = nodes[0];
      if (!node) return;
      node.blur();
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await closePostingAttributeMenus(page);
    await page.waitForTimeout(300);
    const committed = await locator.evaluateAll((nodes, expectedValue) => {
      const node = nodes[0];
      if (!node) return false;
      const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const expectedText = clean(expectedValue);
      if (clean(node.value) === expectedText) return true;
      let parent = node;
      for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
        const text = clean(parent.innerText || parent.textContent);
        if (text.includes(expectedText)) return true;
        if (parent.querySelector?.('[aria-selected="true"], [data-selected="true"], .next-tag-body, [class*="selected-value"]')) {
          const selected = clean(parent.querySelector('[aria-selected="true"], [data-selected="true"], .next-tag-body, [class*="selected-value"]')?.textContent);
          if (selected.includes(expectedText)) return true;
        }
      }
      return false;
    }, expected).catch(() => false);
    if (committed) return true;
  }
  return false;
}

export async function fillModelNumber(page, value) {
  const row = page.locator('#struct-p-3');
  if (await row.isVisible().catch(() => false)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let input = await firstVisible(page, ['#struct-p-3 input:not([type="hidden"])']);
      if (!input) {
        const add = row.locator('.posting-field-multi-text button.add-button').last();
        if (!await add.isVisible().catch(() => false)) return false;
        await clickPostingControl(page, add, { timeout: 3000 });
        input = await waitForFirstVisible(page, ['#struct-p-3 input:not([type="hidden"])'], 3000);
      }
      if (await fillChoice(page, input, value)) return true;
    }
    return false;
  }
  return fillChoice(page, await fieldByAnyLabel(page, ['型号', 'Model Number']), value);
}

export async function fillColorSpec(page, values, onProgress = () => {}) {
  const colors = [...new Set((values || []).map((value) => englishSpecText(value)).filter(Boolean))];
  if (!colors.length) return false;
  const colorRow = await visibleColorSpecRow(page);
  if (!colorRow) return false;
  // Do not fall back to generic "please enter or select" inputs here. The
  // publish form contains hidden autocomplete templates and unrelated
  // attribute inputs with the same placeholder; treating those as color
  // controls caused valid products in categories without a color field to
  // fail before submission.
  const colorInputSelector = [
    'input[role="colorCombobox"]',
    '.posting-field-color-select input[role="colorCombobox"]',
    '.posting-feild-color-select input[role="colorCombobox"]',
    '.posting-feild-color-item input[role="colorCombobox"]',
    '.posting-feild-color-item-container input[role="colorCombobox"]',
    '.posting-field-color-select input[placeholder*="请输入"]',
    '.posting-feild-color-select input[placeholder*="请输入"]',
    '.posting-feild-color-item input[placeholder*="请输入"]',
    '.posting-feild-color-item-container input[placeholder*="请输入"]'
  ].join(', ');
  const selectedColors = async () => {
    const row = await visibleColorSpecRow(page);
    if (!row) return [];
    return row.locator('input[role="colorCombobox"], [data-value], .next-tag-body, [class*="tag-body"], [class*="selected-value"]').evaluateAll((nodes) => [...new Set(nodes
      .flatMap((node) => [node.value, node.getAttribute?.('data-value'), node.getAttribute?.('title'), node.textContent])
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))]).catch(() => []);
  };
  const clickAddColor = async () => {
    const row = await visibleColorSpecRow(page);
    if (!row) return false;
    const beforeCount = await row.locator(colorInputSelector).evaluateAll((nodes) => nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return Boolean(rect.width && rect.height);
    }).length).catch(() => 0);
    // An open autocomplete overlay consumes the first click on "+ 添加".
    // Close it and commit the current custom value before creating a new row.
    const activeInput = row.locator('input:focus').last();
    if (await activeInput.count().catch(() => 0)) {
      await activeInput.press('Escape').catch(() => {});
      await activeInput.press('Tab').catch(() => {});
      await activeInput.dispatchEvent('change').catch(() => {});
      await activeInput.dispatchEvent('blur').catch(() => {});
      await page.waitForTimeout(250);
    }
    const controls = row.locator('[role="btn-add"], .add-color-btn')
      .or(row.getByText(/^\+?\s*(?:添加(?:颜色)?|Add(?: Color)?)$/i, { exact: true }));
    for (let index = await controls.count().catch(() => 0) - 1; index >= 0; index -= 1) {
      const control = controls.nth(index);
      if (!await control.isVisible().catch(() => false)) continue;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await closePostingAttributeMenus(page);
        await clickPostingControl(page, control).catch(postingInteractionFailure);
        const deadline = Date.now() + 1800;
        while (Date.now() < deadline) {
          const refreshed = await visibleColorSpecRow(page);
          const inputs = refreshed?.locator(colorInputSelector);
          const inputState = await inputs?.evaluateAll((nodes) => {
            const visible = nodes.filter((node) => {
              const rect = node.getBoundingClientRect();
              return Boolean(rect.width && rect.height);
            });
            return { count: visible.length, hasEmpty: visible.some((node) => !String(node.value || '').trim()) };
          }).catch(() => null);
          const hasEmpty = inputState && inputState.count > beforeCount && inputState.hasEmpty;
          if (hasEmpty) return true;
          await page.waitForTimeout(120);
        }
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    return false;
  };
  const colorInput = colorRow.locator(colorInputSelector).filter({ visible: true }).first();
  // Re-enabling a cleared dimension can render only "+ Add". Create its
  // first row through the native control before searching for a combobox.
  if (!await colorInput.count() && !await clickAddColor()) return false;
  const existingColors = await selectedColors();
  const editing = await colorRow.locator(colorInputSelector).evaluateAll((nodes) => nodes.some((node) => node === document.activeElement));
  if (!editing && colors.every((color) => existingColors.some((item) => item.toLowerCase() === color.toLowerCase()))) return true;
  for (const color of colors) {
    const inputs = colorRow.locator(colorInputSelector);
    let input = null;
    let emptyInput = null;
    for (let inputIndex = 0; inputIndex < await inputs.count().catch(() => 0); inputIndex += 1) {
      const candidate = inputs.nth(inputIndex);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const currentValue = String(await candidate.inputValue().catch(() => '')).trim();
      if (currentValue.toLowerCase() === color.toLowerCase()) { input = candidate; break; }
      if (!currentValue && !emptyInput) emptyInput = candidate;
    }
    input ||= emptyInput;
    if (!input && await clickAddColor()) {
      const refreshedInputs = colorRow.locator(colorInputSelector);
      for (let inputIndex = 0; inputIndex < await refreshedInputs.count().catch(() => 0); inputIndex += 1) {
        const candidate = refreshedInputs.nth(inputIndex);
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (!String(await candidate.inputValue().catch(() => '')).trim()) { input = candidate; break; }
      }
    }
    if (!input) break;
    const existingValue = String(await input.inputValue().catch(() => '')).trim();
    if (existingValue.toLowerCase() !== color.toLowerCase()) {
      await clickPostingControl(page, input);
      await input.fill(color);
      await page.waitForTimeout(500);
    }
    // The international form renders the suggestion as a plain list item on
    // some categories (without role="option"). Prefer the last visible exact
    // match so we commit the suggestion instead of leaving raw text in the
    // combobox, which later produces “颜色规格未成功添加”.
    let committed = false;
    const colorMenu = await attributeMenuForControl(page, input);
    const option = (colorMenu || colorRow).getByRole('option', { name: color, exact: true });
    if (await option.count() === 1 && await option.isVisible().catch(() => false)) {
      committed = await clickPostingControl(page, option).then(() => true, postingInteractionFailure);
    } else {
      const suggestions = (colorMenu || colorRow).locator('li:visible, [class*="menu-item"]:visible, [class*="option-item"]:visible, [class*="select-option"]:visible')
        .filter({ hasText: new RegExp(`^${color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      if (await suggestions.count() === 1) committed = await clickPostingControl(page, suggestions).then(() => true, postingInteractionFailure);
    }
    if (!committed) {
      await input.press('ArrowDown').catch(() => {});
      await input.press('Enter').catch(() => {});
    }
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
    // A custom color value is not committed while the autocomplete remains
    // open. Explicitly blur it so Alibaba writes the value into form state and
    // the next "+ 添加" click creates a new specification row.
    await input.press('Escape').catch(() => {});
    await input.press('Tab').catch(() => {});
    await input.dispatchEvent('change').catch(() => {});
    await input.dispatchEvent('blur').catch(() => {});
    await page.waitForTimeout(300);
    if (!(await selectedColors()).some((item) => item.toLowerCase() === color.toLowerCase())) {
      await clickAddColor();
    }
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if ((await selectedColors()).some((item) => item.toLowerCase() === color.toLowerCase())) break;
      await page.waitForTimeout(150);
    }
    // Large color sets can take several minutes. Reset the stall timer only
    // after a source value is retained, never on a polling heartbeat.
    if ((await selectedColors()).some((item) => item.toLowerCase() === color.toLowerCase())) {
      onProgress(`已填写颜色 ${colors.indexOf(color) + 1}/${colors.length}：${color}`);
    }
  }
  const selected = await selectedColors();
  // The final empty .posting-feild-color-item is Alibaba's built-in template
  // row for another value, not a validation failure. Only committed source
  // values are authoritative here.
  return colors.every((color) => selected.some((item) => item.trim().toLowerCase() === color.toLowerCase()));
}

async function removeEmptyColorSpecRows(page, expectedColors = []) {
  const row = await visibleColorSpecRow(page);
  if (!row) return;
  const expected = new Set(expectedColors.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  // In the current editor "+ 添加" creates another blank color row. Remove
  // only blank rows and never touch a populated source value.
  for (let pass = 0; pass < 4; pass += 1) {
    const items = row.locator('.posting-feild-color-item, .posting-field-color-item, .posting-feild-color-item-container');
    let removed = false;
    for (let index = await items.count().catch(() => 0) - 1; index >= 0; index -= 1) {
      const item = items.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      const input = item.locator('input[role="colorCombobox"], input[placeholder*="输入"], input[placeholder*="select" i]').first();
      if (!await input.count().catch(() => 0)) continue;
      const value = String(await input.inputValue().catch(() => '')).trim();
      if (value || expected.has(value.toLowerCase())) continue;
      const remove = item.locator('button, [role="button"], .next-icon-delete, [class*="delete"], [class*="remove"]').last();
      if (!await remove.count().catch(() => 0) || !await remove.isVisible().catch(() => false)) continue;
      await remove.click({ force: true }).catch(() => {});
      await page.waitForTimeout(180);
      removed = true;
      break;
    }
    if (!removed) break;
  }
}

export async function ensureColorSpecImageSwitch(page, row) {
  const hasUploadSurface = async () => row.locator([
    '.custom-upload-image',
    '.value-preview',
    '.posting-feild-color-item input[type="file"]',
    '.posting-field-color-item input[type="file"]'
  ].join(', ')).evaluateAll((nodes) => nodes.some((node) => Boolean(
    node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length)
  ))).catch(() => false);
  if (await hasUploadSurface()) return true;

  const requireNoImageDimensionConflict = async () => {
    const dialogs = page.locator?.('.next-dialog:visible, [role="dialog"]:visible');
    if (!dialogs) return;
    const conflict = await dialogs.evaluateAll(nodes => nodes.map(node => String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      .find(text => /仅支持(?:一组|一个)规格项添加图片/.test(text) && /图片将被清空/.test(text))).catch(() => '');
    if (conflict) throw Object.assign(new Error('当前类目仅支持一组规格图片，另一组已启用；未清除已有图片，请核对来源图片关联'), {
      code: 'PUBLISH_SPECIFICATION_IMAGE_DIMENSION_CONFLICT', diagnostics: { section: 'specification-images', feedback: conflict },
    });
  };

  const switchIsOn = async (control) => {
    if (!control || !await control.count().catch(() => 0)) return false;
    if (await control.getAttribute('aria-checked').catch(() => '') === 'true') return true;
    if (await control.getAttribute('aria-pressed').catch(() => '') === 'true') return true;
    if (await control.isChecked().catch(() => false)) return true;
    return /next-switch-on|is-checked|(?:^|\s)(?:on|opened|checked|active)(?:\s|$)/i.test(await control.getAttribute('class').catch(() => '') || '');
  };
  const resolveTarget = async () => {
    // Current Alibaba markup puts the exact switch inside this wrapper. Use
    // it before proximity matching so a hidden/portal label cannot resolve
    // to an unrelated switch in the specification card.
    const direct = row.locator('.upload-image-switch [role="switch"], .upload-image-switch .next-switch').last();
    if (await direct.count().catch(() => 0) && await direct.isVisible().catch(() => false)) return direct;
    const labels = row.getByText(/添加规格图|规格图|specification image|spec image/i);
    let label = null;
    for (let index = await labels.count().catch(() => 0) - 1; index >= 0; index -= 1) {
      const candidate = labels.nth(index);
      if (await candidate.isVisible().catch(() => false)) { label = candidate; break; }
    }
    if (!label) {
      // Some category forms omit the image-switch label and wrapper. Only a
      // unique switch inside this specification row is an unambiguous target.
      const switches = row.locator('.next-switch:visible, [role="switch"]:visible');
      return await switches.count().catch(() => 0) === 1 ? switches.first() : null;
    }
    const labelBox = await label.boundingBox().catch(() => null);
    const controls = row.locator('.next-switch, [role="switch"]');
    const candidates = [];
    for (let index = 0; index < await controls.count().catch(() => 0); index += 1) {
      const control = controls.nth(index);
      if (!await control.isVisible().catch(() => false)) continue;
      const box = await control.boundingBox().catch(() => null);
      const distance = labelBox && box
        ? Math.hypot((box.x + box.width / 2) - labelBox.x, (box.y + box.height / 2) - (labelBox.y + labelBox.height / 2))
        : index * 1000;
      candidates.push({ control, distance });
    }
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0]?.control || label;
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await requireNoImageDimensionConflict();
    const control = await resolveTarget();
    if (!control) return false;
    if (!await switchIsOn(control)) {
      await control.scrollIntoViewIfNeeded().catch(() => {});
      // The controlled switch updates asynchronously. Clicking and immediately
      // pressing Space can toggle it back off before the uploader is mounted.
      await clickPostingControl(page, control).catch(postingInteractionFailure);
    }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (await hasUploadSurface()) return true;
      await requireNoImageDimensionConflict();
      const refreshed = await resolveTarget();
      if (await switchIsOn(refreshed)) {
        await page.waitForTimeout(300);
        if (await hasUploadSurface()) return true;
      }
      await page.waitForTimeout(150);
    }
  }
  return false;
}

export function committedSpecificationValues(field, values, { valueIds = {}, labels = {} } = {}) {
  const selected = [...new Set(field?.values || [])];
  const resolved = [];
  for (const value of values) {
    // The field writer may verify a translated label by the option's stable
    // ID. Otherwise require exact semantic equality, never a containing range.
    const expected = labels[valueIds[value]] || value;
    const matches = selected.filter(label => attributeOptionMatchScore(expected, label) === 100);
    if (matches.length !== 1 || resolved.includes(matches[0])) return null;
    resolved.push(matches[0]);
  }
  return resolved.length === selected.length ? resolved : null;
}

export async function fillVariantSpecs(page, product, onProgress = () => {}) {
  const variantGroups = structuredClone(product?.variantGroups || []);
  // A single image-backed source SKU can satisfy categories that require one
  // sales specification and must keep the source specification image.
  let groups = variantGroups.filter(isRequiredTargetVariantGroup);
  const unmapped = [];
  const blockingUnmapped = [];
  const imageSourceGroup = variantGroups.find((group) => Object.values(group?.optionImages || {}).some(Boolean));
  let preferredImageId = '';
  if (imageSourceGroup?.id) {
    preferredImageId = await page.evaluate((expectedId) => {
      const root = document.querySelector('#saleAttributesItems');
      const input = root?.querySelector(`input[value="${CSS.escape(String(expectedId))}"]`);
      if (!input) return '';
      const item = input.closest('.items, .option-wrap, label')?.parentElement || input.closest('label');
      return /支持传图|support(?:s|ed)?\s+(?:image|photo)/i.test(String(item?.innerText || item?.textContent || ''))
        ? String(expectedId)
        : '';
    }, imageSourceGroup.id).catch(() => '');
    if (preferredImageId && !await saleAttributeIsSelected(page, preferredImageId)) {
      const selectedIds = await page.locator('#saleAttributesItems input[type="checkbox"]').evaluateAll((nodes) => nodes
        .filter((node) => node.checked || node.getAttribute('aria-checked') === 'true'
          || node.closest('.checked, .is-checked, [aria-checked="true"]'))
        .map((node) => String(node.value || ''))
        .filter(Boolean)).catch(() => []);
      for (const selectedId of selectedIds) {
        if (selectedId !== preferredImageId) await ensureSaleAttributeCleared(page, selectedId);
      }
      const deadline = Date.now() + 6000;
      while (!await saleAttributeIsAvailable(page, preferredImageId) && Date.now() < deadline) {
        await page.waitForTimeout(200);
      }
      await ensureSaleAttributeSelected(page, preferredImageId);
    }
  }
  const normalizeSaleAttributeName = (value) => String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[＊*]/g, '')
    .replace(/[()（）[\]{}<>:：]/g, ' ')
    .replace(/[_/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const saleAttributeLabel = (value) => String(value || '')
    .replace(/(?:支持传图|supports?\s+(?:image|photo)(?:\s+upload)?|image\s+upload\s+supported)\s*$/i, '').trim();
  const saleAttributeAliasesFor = (name) => {
    const normalized = normalizeSaleAttributeName(name);
    if (/^(?:spec(?:ification)?s?|product specification|商品规格|规格|款式|style)$/.test(normalized)) {
      return ['specification', 'specifications', 'product specification', '商品规格', '规格', '款式', 'style'];
    }
    if (/^(?:model(?: number)?|型号)$/.test(normalized)) {
      // Some international-site categories expose the model dimension as
      // the generic "规格" sale attribute. Prefer an exact model control,
      // then use that controlled fallback when the category has no model row.
      return ['model', 'model number', '型号', 'specification', '商品规格', '规格', '款式', 'style'];
    }
    if (/^(?:position|location|位置)$/.test(normalized)) return ['position', 'location', '位置'];
    if (/^(?:颜色|colou?r|colour)$/.test(normalized)) return ['颜色', 'color', 'colour'];
    return requiredLabelAliases(name);
  };
  const availableSaleAttributes = await page.evaluate(() => {
    const root = document.querySelector('#saleAttributesItems');
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const controls = [...(root?.querySelectorAll('input[type="checkbox"], input[type="radio"], [role="checkbox"]') || [])];
    const attributes = controls.map((control) => {
      const id = control.value || control.getAttribute('data-value') || control.getAttribute('data-id') || '';
      const owner = control.closest('label')
        || control.closest('.items, .option-wrap, [data-attribute-id], [data-property-id]')
        || control.parentElement;
      return {
        id: String(id),
        label: String(owner?.innerText || owner?.textContent || '').replace(/\s+/g, ' ').trim(),
        visible: visible(control) && visible(owner)
      };
    }).filter((item) => item.id && item.visible);
    // Some categories render mandatory dimensions directly and leave the
    // specification selector empty. Their visible rows are authoritative.
    for (const row of document.querySelectorAll('#struct-specification [id^="p-"]')) {
      if (!visible(row) || attributes.some((item) => item.id === row.id.slice(2))) continue;
      const label = row.querySelector('.sell-o-addon-label, .label, label, legend')?.cloneNode(true);
      label?.querySelectorAll('.upload-image-switch, .labelSubtitle, i, [role="tooltip"]').forEach((node) => node.remove());
      attributes.push({ id: row.id.slice(2), label: String(label?.textContent || '').replace(/\s+/g, ' ').trim(), visible: true });
    }
    return attributes;
  }).catch(() => []);
  const candidateIdsFor = (group) => {
    const sourceLabel = group?.sourceName || group?.name;
    const normalized = normalizeSaleAttributeName(sourceLabel);
    const ids = [group?.id].filter(Boolean).map(String);
    if (isColorVariantGroup(group)) ids.push('191288010');
    if (/^(?:socket standard|socket type|plug type|connector type|connector)$/i.test(normalized)) ids.push('400050816');
    const aliases = saleAttributeAliasesFor(sourceLabel).map(normalizeSaleAttributeName);
    const labelMatches = availableSaleAttributes
      .map((item) => ({ ...item, normalized: normalizeSaleAttributeName(saleAttributeLabel(item.label)) }))
      // Substring matching makes Color select Light Color and Size select
      // Screen Size. Only IDs or complete known aliases identify a dimension.
      .filter((item) => aliases.includes(item.normalized))
      .sort((left, right) => aliases.indexOf(left.normalized) - aliases.indexOf(right.normalized));
    ids.push(...labelMatches.map((item) => item.id));
    return [...new Set(ids)];
  };
  const targetIds = new Map();
  for (const group of variantGroups) {
    for (const candidateId of candidateIdsFor(group)) {
      if (!await saleAttributeIsAvailable(page, candidateId)) continue;
      targetIds.set(group, candidateId);
      break;
    }
  }
  const multiGroups = variantGroups.filter((group) => new Set(
    (group.options || []).map((value) => englishSpecText(value)).filter(Boolean)
  ).size > 1);
  const availableIds = [...new Set(multiGroups.map((group) => targetIds.get(group)).filter(Boolean))];
  for (const group of variantGroups) {
    if (!isColorVariantGroup(group) && targetIds.has(group) && !groups.includes(group)) groups.push(group);
  }
  if (multiGroups.length > 1 && availableIds.length === 1) {
    const targetId = availableIds[0];
    const targetControl = page.locator(`input[value="${targetId.replace(/["\\]/g, '')}"]`).first();
    const targetName = String(await targetControl.locator('xpath=ancestor::label[1]').innerText().catch(() => '')).trim()
      || 'Specification';
    const flattened = buildFlattenedVariantGroup(product, targetId, targetName);
    if (flattened) {
      groups = [flattened];
      await ensureSaleAttributeSelected(page, targetId);
    }
  }
  const aliasesFor = (name) => {
    const normalized = String(name || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(?:compatible\s+model|model\s+compatibility|适用型号)$/i.test(normalized)) return ['适用型号', 'compatible model'];
    if (/^(?:type|类型)$/i.test(normalized)) return ['类型', 'type'];
    if (/^(?:model(?: number)?|型号)$/i.test(normalized)) return ['型号', 'model number', 'model'];
    if (/^(?:socket standard|socket type|plug type|connector type|connector)$/i.test(normalized)) {
      return ['插座标准', '插头类型', '输出插头', '连接器类型', 'socket standard', 'socket type', 'plug type', 'output plug', 'connector type', 'connector'];
    }
    return requiredLabelAliases(name);
  };
  const rowFor = async (aliases) => {
    const rows = page.locator('#struct-specification [id^="p-"]');
    const expected = aliases.map((item) => String(item).toLowerCase());
    const count = await rows.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!await row.isVisible().catch(() => false)) continue;
      const matches = await row.evaluate((node, values) => {
        const normalize = (text) => String(text || '').replace(/\s+/g, ' ').replace(/^[*＊]\s*/, '').trim().toLowerCase();
        return [...node.querySelectorAll('label, legend, h1, h2, h3, span, div, p')]
          .some((child) => values.includes(normalize(child.textContent)));
      }, expected).catch(() => false);
      if (matches) return row;
    }
    return null;
  };
  const selectExactValue = async (row, value) => {
    const existingValue = await row.evaluate((node, expected) => {
      const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = normalize(expected);
      const menu = '[role="option"], [role="listbox"], .next-menu, .next-overlay-inner';
      for (const input of node.querySelectorAll('input, textarea')) {
        if (!input.getClientRects().length || input.closest(menu) || document.activeElement === input) continue;
        if (normalize(input.value) !== target) continue;
        if (!['checkbox', 'radio'].includes(String(input.type || '').toLowerCase()) || input.checked) return true;
      }
      return [...node.querySelectorAll('label, [class*="tag"], [class*="value"], [class*="item"]')]
        .some((item) => item.getClientRects().length && !item.closest(menu) && normalize(item.textContent) === target
          && (!item.querySelector('input[type="checkbox"], input[type="radio"]')
            || item.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')));
    }, value).catch(() => false);
    if (existingValue) return true;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const labels = row.locator('label').filter({ hasText: new RegExp(`^${escaped}$`, 'i') });
    const count = await labels.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      if (!await label.isVisible().catch(() => false)) continue;
      const input = label.locator('input[type="checkbox"], input[type="radio"]').first();
      if (!await input.count().catch(() => 0)) continue;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await input.isChecked().catch(() => false)) return true;
        if (await input.isDisabled().catch(() => false)) break;
        await clickPostingControl(page, label).catch(postingInteractionFailure);
        await page.waitForTimeout(250);
      }
      if (await input.isChecked().catch(() => false)) return true;
    }
    return false;
  };
  const addCustomVariantValue = async (row, value) => {
    const sequentialAdd = row.locator('.sell-sequential-combocheckbox button.add-button:visible').last();
    if (await sequentialAdd.isVisible().catch(() => false)) {
      if (!await sequentialAdd.isDisabled()) await clickPostingControl(page, sequentialAdd);
      const custom = row.locator('.sell-sequential-combobox-custom-wrap input:visible').last();
      if (await custom.isVisible().catch(() => false)) {
        await custom.fill(value);
        await custom.press('Tab');
        await page.waitForTimeout(300);
        return selectExactValue(row, value);
      }
    }
    // The first specification value uses the ready blank combobox. After it
    // has a value, Alibaba requires "+ Add" to create another controlled row.
    // Re-resolve the inputs after that click because the component rerenders.
    let inputs = row.locator('input[role="colorCombobox"], input[placeholder*="输入"], input[placeholder*="enter" i]');
    let inputCount = await inputs.count().catch(() => 0);
    let customInput = null;
    for (let index = inputCount - 1; index >= 0; index -= 1) {
      const input = inputs.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      const current = String(await input.inputValue().catch(() => '')).trim();
      if (!current || current.toLowerCase() === value.toLowerCase()) { customInput = input; break; }
    }
    if (!customInput) {
      const add = row.locator('[role="btn-add"], .add-color-btn, button.add-button').last();
      if (!await add.isVisible().catch(() => false)) return false;
      await closePostingAttributeMenus(page);
      await clickPostingControl(page, add).catch(postingInteractionFailure);
      await page.waitForTimeout(300);
      inputs = row.locator('input[role="colorCombobox"], input[placeholder*="输入"], input[placeholder*="enter" i]');
      inputCount = await inputs.count().catch(() => 0);
      for (let index = inputCount - 1; index >= 0; index -= 1) {
        const input = inputs.nth(index);
        if (!await input.isVisible().catch(() => false)) continue;
        if (!String(await input.inputValue().catch(() => '')).trim()) { customInput = input; break; }
      }
    }
    if (!customInput) return false;
    const committedValue = () => row.evaluate((node, expected) => {
      const normalize = (text) => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = normalize(expected);
      const visible = (entry) => Boolean(entry.getClientRects().length);
      const menu = '[role="option"], [role="listbox"], .next-menu, .next-overlay-inner';
      for (const input of node.querySelectorAll('input, textarea')) {
        if (!visible(input) || input.closest(menu) || normalize(input.value) !== target) continue;
        if (['checkbox', 'radio'].includes(input.type)) { if (input.checked) return true; }
        else if (input.type !== 'hidden' && document.activeElement !== input) return true;
      }
      return [...node.querySelectorAll('[class*="tag"], .next-select-values em')]
        .some((tag) => visible(tag) && !tag.closest(menu) && normalize(tag.textContent) === target);
    }, value).catch(() => false);
    // A specification editor can replace its input with a committed tag on
    // blur. Checking only inputValue then retries an already accepted value
    // and reports a false failure. Read the whole owning specification row
    // after the commit, including exact selected options and tags.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!await customInput.isVisible().catch(() => false)) return committedValue();
      if (attempt === 0) await customInput.fill(value);
      else if (attempt === 1) {
        await clickPostingControl(page, customInput);
        await commitControlledInput(customInput, value);
      } else {
        await clickPostingControl(page, customInput);
        await customInput.press('Control+A');
        await customInput.pressSequentially(value, { delay: 25 });
      }
      await page.waitForTimeout(200);
      if (await customInput.isVisible().catch(() => false)) {
        const popup = await attributeMenuForControl(page, customInput);
        const exactOption = (popup || row).getByRole('option', { name: value, exact: true });
        if (await exactOption.count() === 1 && await exactOption.isVisible().catch(() => false)) {
          await clickPostingControl(page, exactOption);
        }
        if (await customInput.isVisible().catch(() => false)) await customInput.press('Tab');
      }
      const deadline = Date.now() + 1500;
      let consecutive = 0;
      do {
        await page.waitForTimeout(150);
        consecutive = await committedValue() ? consecutive + 1 : 0;
        if (consecutive >= 2) return true;
      } while (Date.now() < deadline);
    }
    return false;
  };
  const targetValueCandidates = (group, value) => {
    const normalizedName = String(group?.name || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
    const normalizedValue = String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
    if (/socket|plug|connector|插口|插座|插头/.test(normalizedName)) {
      if (/\beu\b|e\.u\./.test(normalizedValue)) return ['EU', 'For E.U.', value];
      if (/\bus\b/.test(normalizedValue)) return ['US', value];
      if (/\buk\b/.test(normalizedValue)) return ['UK', value];
      if (/\bau\b|australia|new zealand/.test(normalizedValue)) return ['AU', 'For Australia/New Zealand', value];
      if (/\bcn\b|china/.test(normalizedValue)) return ['CN', value];
    }
    return [value];
  };
  const sourceIds = new Map(groups.map((group) => [group, String(group.id || '')]));
  for (const group of groups) {
    group.appliedValues = {};
    const sourceId = String(group.id || '');
    const targetId = targetIds.get(group)
      || candidateIdsFor(group).find((candidateId) => availableIds.includes(candidateId))
      || String(group.id || '');
    const targetHasSourceId = targetId && await saleAttributeIsAvailable(page, targetId);
    const existingRow = targetId ? page.locator(`[id="p-${targetId.replace(/["\\]/g, '')}"]:visible`).first() : null;
    const rowAlreadyVisible = Boolean(existingRow && await existingRow.isVisible().catch(() => false));
    if (targetHasSourceId && !rowAlreadyVisible && !await ensureSaleAttributeSelected(page, targetId)) {
      for (const rawValue of [...new Set(group.options || [])]) {
        const value = englishSpecText(rawValue);
        if (value) unmapped.push(`${group.name}: ${value}`);
      }
      continue;
    }
    if (targetHasSourceId && targetId !== String(group.id || '')) group.id = targetId;
    const directRow = rowAlreadyVisible ? existingRow : targetHasSourceId ? page.locator(`#struct-specification [id="p-${targetId.replace(/["\\]/g, '')}"]`).first() : null;
    let row = directRow && await directRow.isVisible().catch(() => false)
      ? directRow
      : await rowFor(aliasesFor(group.name));
    const rowDeadline = Date.now() + 6000;
    while (!row && Date.now() < rowDeadline) {
      await page.waitForTimeout(200);
      row = directRow && await directRow.isVisible().catch(() => false)
        ? directRow
        : await rowFor(aliasesFor(group.name));
    }
    if (row) {
      const rowId = await row.getAttribute('id');
      if (rowId?.startsWith('p-')) group.id = rowId.slice(2);
      const targetLabel = availableSaleAttributes.find((item) => item.id === group.id)?.label;
      if (targetLabel) group.targetName = saleAttributeLabel(targetLabel).replace(/^[*＊]\s*/, '').trim();
    }
    // Reuse the category control adapters for non-image specification rows.
    // Fill the entire set at once so a single select/radio cannot silently
    // retain only the last SKU, and stale checkbox selections are removed.
    const imageInputs = row && await row.locator('input[role="colorCombobox"]').count();
    const field = row && !imageInputs && (await page.evaluate(readPostingAttributeSchema))
      .find((entry) => entry.saleSpecification && entry.id === String(group.id));
    if (field && field.inputIndex >= 0 && !field.disabled) {
      const rawValues = [...new Set(group.options || [])].filter(Boolean);
      const values = rawValues.map((raw) => {
        const value = englishSpecText(raw);
        return targetValueCandidates(group, value).find((candidate) =>
          field.options?.some((option) => attributeOptionMatchScore(candidate, option.label) === 100)) || value;
      });
      const valueIds = sourceId === String(group.id) ? Object.fromEntries(rawValues.map((raw, index) =>
        [values[index], group.optionIds?.[raw]]).filter(([, id]) => id != null && Number(id) > 0)) : {};
      const labels = {};
      const options = { multiple: field.multiple, minimumScore: 100, valueIds, labels,
        onValueCommitted: (id, label) => { labels[id] = label; } };
      // A plain field represents one SKU option; combining several values in
      // that field would discard the original variants.
      const scalar = ['text', 'textarea', 'number', 'select', 'radio'].includes(field.controlType);
      const filled = !(scalar && values.length > 1) && (field.controlType === 'multiText'
        ? await fillRepeatableCategoryText(page, field, values)
        : await fillChoice(page, categoryFieldLocator(page, field), values, options));
      const actual = (await page.evaluate(readPostingAttributeSchema)).find((entry) => entry.id === field.id && entry.saleSpecification);
      const committed = filled && actual && attributeFieldMatchesValue(actual, values, options)
        ? committedSpecificationValues(actual, values, options) : null;
      if (committed) {
        // Record the labels actually committed by this native field. A custom
        // source value such as 120w can select the standard option 120 W even
        // without a positive source option ID. The SKU matrix uses that label.
        rawValues.forEach((raw, index) => { group.appliedValues[raw] = committed[index]; });
        onProgress(`已填写规格 ${group.name}：${rawValues.length}/${rawValues.length}`);
      } else {
        rawValues.forEach((raw) => unmapped.push(`${group.name}: ${englishSpecText(raw)}`));
      }
      continue;
    }
    for (const rawValue of [...new Set(group.options || [])]) {
      let value = englishSpecText(rawValue);
      if (!value) continue;
      if (!row) {
        unmapped.push(`${group.name}: ${value}`);
        continue;
      }
      const sourceOptionId = group.optionIds?.[rawValue];
      if (sourceId === String(group.id) && sourceOptionId && Number(sourceOptionId) > 0) {
        const targetText = await row.evaluate((node, optionId) => {
          const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith('__reactFiber'));
          let fiber = key && node[key];
          for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
            const options = fiber.memoizedProps?.dataSource;
            if (!Array.isArray(options)) continue;
            const match = options.find((item) => String(item.value) === String(optionId));
            if (match) return match.text || match.label || '';
          }
          return '';
        }, sourceOptionId).catch(() => '');
        if (targetText) value = targetText;
      }
      let selected = false;
      for (const candidate of targetValueCandidates(group, value)) {
        if (await selectExactValue(row, candidate)) { selected = true; value = candidate; break; }
      }
      if (!selected) {
        const added = await addCustomVariantValue(row, value);
        if (!added) {
          unmapped.push(`${group.name}: ${value}`);
          if (group.sourceGroups?.length) blockingUnmapped.push(`${group.name}: ${value}`);
        }
        selected = added;
      }
      if (selected) {
        group.appliedValues[rawValue] = value;
        onProgress(`已填写规格 ${group.name}：${Object.keys(group.appliedValues).length}/${new Set(group.options || []).size}`);
      }
    }
  }
  const failures = [];
  if (unmapped.length) {
    const schema = await page.evaluate(readPostingAttributeSchema);
    for (const group of groups) {
      const values = [...new Set(group.options || [])].map((value) => englishSpecText(value))
        .filter((value) => unmapped.includes(`${group.name}: ${value}`));
      if (!values.length) continue;
      const field = schema.find((entry) => entry.saleSpecification && entry.id === String(group.id));
      const row = field ? (field.rowId ? page.locator(`[id="${field.rowId.replace(/["\\]/g, '')}"]`)
        : page.locator(`[data-posting-attribute-row="${field.rowIndex}"]`)) : null;
      const customAvailable = row && await row.evaluate((node) => {
        const visible = (item) => item.getClientRects().length && !item.disabled;
        return [...node.querySelectorAll('button.add-button, [role="btn-add"], .add-color-btn, input[maxcustomitems]')]
          .some((item) => visible(item) && (item.tagName !== 'INPUT' || Number(item.getAttribute('maxcustomitems')) > 0));
      }, undefined, { timeout: 1500 }).catch(() => false);
      const options = field?.options || [];
      const valueIds = sourceIds.get(group) === field?.id ? Object.fromEntries((group.options || [])
        .filter((raw) => Number(group.optionIds?.[raw]) > 0)
        .map((raw) => [englishSpecText(raw), group.optionIds[raw]])) : {};
      const fixedChoices = field && ['checkbox', 'radio', 'select', 'multiSelect'].includes(field.controlType);
      const unavailable = fixedChoices && options.length > 0 && !customAvailable
        && !options.some((option) => isOtherOption(option.label))
        && values.some((value) => !chooseAttributeOption(options, value, valueIds[value], 100));
      const reason = !field ? 'field-missing' : field.disabled ? 'control-disabled'
        : unavailable ? 'option-unavailable' : 'control-rejected';
      failures.push({ name: group.name, targetId: field?.id || String(group.id || ''),
        targetLabel: field?.label || group.targetName || group.name, values, reason,
        controlType: field?.controlType || '', availableOptions: options.map((option) => option.label).slice(0, 120),
        committedValues: field?.values || [] });
    }
  }
  return { unmapped, blockingUnmapped, groups, failures };
}

export function variantTransferFailure(failure) {
  const reasons = {
    'field-missing': '当前发布页未提供对应规格字段',
    'control-disabled': '当前发布页的规格控件不可用',
    'option-unavailable': '当前发布页没有匹配选项或自定义入口',
    'control-rejected': '规格控件未完整保留输入值',
  };
  return Object.assign(new Error(`来源规格“${failure.name}：${failure.values.join('、')}”未被接收：${reasons[failure.reason]}；请核对类目及平台可选值，原始资料已保留`), {
    code: `PUBLISH_SPECIFICATION_${failure.reason.replaceAll('-', '_').toUpperCase()}`,
    requiredFields: [failure.targetLabel], diagnostics: { specification: failure },
  });
}

async function colorSaleAttributeId(page) {
  const control = await visibleColorSpecControl(page);
  return String(await control?.input.getAttribute('value').catch(() => '') || '191288010');
}

async function visibleColorSpecControl(page) {
  // Alibaba has used several different container class names for this area.
  // Resolve the first visible color checkbox in document order and explicitly
  // reject the later light/deep-customization sections. Newer form builds
  // expose the attribute id on the input instead of rendering a text-only
  // label, so check that stable id before falling back to label matching.
  const directInputs = page.locator([
    'input[value="191288010"]',
    '[data-attribute-id="191288010"] input[type="checkbox"]',
    '[data-id="191288010"] input[type="checkbox"]'
  ].join(', '));
  const directCount = await directInputs.count().catch(() => 0);
  for (let index = 0; index < directCount; index += 1) {
    const input = directInputs.nth(index);
    if (!await input.isVisible().catch(() => false)) continue;
    const wrapper = input.locator('xpath=ancestor::label[1]');
    const candidate = await wrapper.count().catch(() => 0) ? wrapper : input;
    const excluded = await candidate.evaluate((node) => Boolean(
      node.closest('[class*="customizedServices"], [class*="CustomizedServices"]')
    )).catch(() => true);
    if (!excluded) {
      return {
        wrapper: candidate,
        input,
        top: await input.evaluate((node) => node.getBoundingClientRect().top + window.scrollY).catch(() => 0)
      };
    }
  }

  const wrappers = page.locator('label, [role="checkbox"]')
    .filter({ hasText: /颜色|colou?r/i });
  const count = await wrappers.count().catch(() => 0);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const wrapper = wrappers.nth(index);
    if (!await wrapper.isVisible().catch(() => false)) continue;
    const metadata = await wrapper.evaluate((node) => ({
      text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(),
      excluded: Boolean(node.closest('[class*="customizedServices"], [class*="CustomizedServices"]')),
      top: node.getBoundingClientRect().top + window.scrollY
    })).catch(() => null);
    if (!metadata || metadata.excluded || !/^[*＊]?\s*(?:颜色|colou?r)\s*[:：]?(?:\s*(?:支持传图|支持上传图片|(?:supports?\s+)?image\s+upload))?\s*$/i.test(metadata.text)) continue;
    const input = wrapper.locator('input[type="checkbox"]').first();
    if (!await input.count().catch(() => 0)) continue;
    candidates.push({ wrapper, input, top: metadata.top });
  }
  candidates.sort((left, right) => left.top - right.top);
  return candidates[0] || null;
}

async function visibleColorSpecRow(page) {
  const colorId = await colorSaleAttributeId(page);
  const rows = page.locator(`[id="p-${colorId}"], [id="struct-p-${colorId}"], [data-attribute-id="${colorId}"], [data-id="${colorId}"], [data-attribute-id="color"], [data-spec-id="${colorId}"]`);
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (await row.isVisible().catch(() => false)
      && !await row.evaluate((node) => Boolean(node.closest('[class*="customizedServices"], [class*="CustomizedServices"]'))).catch(() => true)
      && await row.locator([
        'input[role="colorCombobox"]',
        '.posting-field-color-select input[placeholder*="请输入"]',
        '.posting-feild-color-select input[placeholder*="请输入"]',
        '.posting-field-color-item input[placeholder*="请输入"]',
        '.posting-feild-color-item input[placeholder*="请输入"]',
        '.posting-feild-color-item-container input[placeholder*="请输入"]',
        '.posting-field-color .add-color-btn',
        '.posting-feild-color .add-color-btn'
      ].join(', ')).count().catch(() => 0)) return row;
  }
  // Fallback for the newer form build where the stable p-191288010 wrapper is
  // absent. Mark the closest visible container around a color combobox so the
  // remaining upload code can use the same row-scoped selectors.
  const marker = `codex-color-row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const found = await page.evaluate((value) => {
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const inputs = [...document.querySelectorAll('input[role="colorCombobox"], input[placeholder*="请输入"]')].filter(visible);
    for (const input of inputs) {
      if (input.closest('[class*="customizedServices"], [class*="CustomizedServices"]')) continue;
      let node = input;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        if (/^(?:BODY|HTML|FORM)$/.test(node.tagName) || node.id === 'struct-specification') break;
        if (/^p-/.test(node.id) && node.id !== 'p-191288010') break;
        const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^[*＊]?\s*(?:颜色|colou?r)(?:\s|[:：]|$)/i.test(text) || /customizedServices|CustomizedServices/i.test(String(node.className || ''))) continue;
        node.setAttribute('data-codex-color-row', value);
        return true;
      }
    }
    return false;
  }, marker).catch(() => false);
  if (found) return page.locator(`[data-codex-color-row="${marker}"]`).first();
  return null;
}

export async function ensureColorSpecificationReady(page, timeout = 10000) {
  await revealSaleAttributeControls(page);
  // Viewport observers may mount the choices after scrolling has completed.
  // Both selection and the dependent editor must be ready before returning.
  const deadline = Date.now() + timeout;
  do {
    const colorId = await colorSaleAttributeId(page);
    if (await ensureSaleAttributeSelected(page, colorId)) {
      const row = await visibleColorSpecRow(page);
      if (row && await saleAttributeIsSelected(page, colorId)) return row;
    }
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  return null;
}

async function saleAttributeIsSelected(page, value) {
  return page.evaluate((expectedValue) => {
    const root = document.querySelector('#saleAttributesItems');
    const selector = `input[value="${CSS.escape(String(expectedValue))}"]`;
    const selectionControl = root?.querySelector(selector);
    const fixedRow = document.querySelector(`#struct-specification [id="p-${CSS.escape(String(expectedValue))}"]`);
    if (!selectionControl && fixedRow && (fixedRow.offsetWidth || fixedRow.offsetHeight || fixedRow.getClientRects().length)) return true;
    if (!root) {
      const input = document.querySelector(`input[value="${CSS.escape(String(expectedValue))}"]`);
      return Boolean(input && (input.checked || input.getAttribute('aria-checked') === 'true'
        || input.closest('[aria-checked="true"], .checked, .is-checked')));
    }
    const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems' || !Array.isArray(props.dataSource)) continue;
      if ((props.value || []).some((item) => String(item?.value) === String(expectedValue))) return true;
      break;
    }
    const input = root.querySelector(`input[value="${CSS.escape(String(expectedValue))}"]`);
    return Boolean(input && (input.checked || input.getAttribute('aria-checked') === 'true'
      || input.closest('[aria-checked="true"], .checked, .is-checked')));
  }, value).catch(() => false);
}

async function saleAttributeIsAvailable(page, value) {
  // Alibaba locks some required/selected sale attributes after selection. A
  // disabled-but-checked control is still active and its rendered row is fully
  // usable; treating it as unavailable can incorrectly collapse two source
  // dimensions into the remaining unlocked attribute.
  if (await saleAttributeIsSelected(page, value)) return true;
  const available = await page.evaluate((expectedValue) => {
    const root = document.querySelector('#saleAttributesItems');
    if (!root) return false;
    const input = root.querySelector(`input[value="${CSS.escape(String(expectedValue))}"]`);
    if (input) return !input.disabled && input.getAttribute('aria-disabled') !== 'true';
    const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems' || !Array.isArray(props.dataSource)) continue;
      return props.dataSource.some((item) => String(item?.value) === String(expectedValue) && !item?.disabled);
    }
    return false;
  }, value).catch(() => false);
  if (available) return true;
  // Newer seller forms omit #saleAttributesItems and render the same control
  // as a plain checkbox/label. Use the visible control as the authoritative
  // fallback so a customer machine with the newer UI does not report that
  // color is unavailable and then fail the product unnecessarily.
  if (String(value) === '191288010') {
    const control = await visibleColorSpecControl(page);
    return Boolean(control && !await control.input.isDisabled().catch(() => true));
  }
  const input = page.locator(`input[value="${String(value).replace(/["\\]/g, '')}"]`).first();
  return Boolean(await input.isVisible().catch(() => false) && !await input.isDisabled().catch(() => true));
}

async function ensureSaleAttributeSelected(page, value) {
  if (await saleAttributeIsSelected(page, value)) return true;
  const committed = await page.evaluate((expectedValue) => {
    const root = document.querySelector('#saleAttributesItems');
    if (!root) return { ok: false, reason: 'missing-root' };
    const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    let componentFiber = null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems' || !Array.isArray(props.value)) continue;
      componentFiber = fiber;
      const dataSource = Array.isArray(props.dataSource) ? props.dataSource : [];
      const current = Array.isArray(props.value) ? props.value : [];
      if (current.some((item) => String(item?.value) === String(expectedValue))) return { ok: true, already: true };
      const option = dataSource.find((item) => String(item?.value) === String(expectedValue));
      if (!option) return { ok: false, reason: 'missing-option', options: dataSource.map((item) => item?.value) };
      if (current.length >= Number(props.maxItem || 4)) return { ok: false, reason: 'max-items' };
      if (option.disabled) return { ok: false, reason: 'disabled-option' };
      // The native handler filters dataSource with strict equality. Preserve
      // its number/string identity and every already-selected dimension.
      const selectedIds = [...current.map((item) => dataSource.find((candidate) => String(candidate.value) === String(item?.value))?.value ?? item?.value), option.value];
      const seen = new Set();
      const visit = (candidate, depth = 0) => {
        if (!candidate || depth > 18 || seen.has(candidate)) return null;
        seen.add(candidate);
        const instance = candidate.stateNode;
        if (instance?.constructor?.name === 'SaleAttributesItems' && typeof instance.onChange === 'function') return instance;
        return visit(candidate.child, depth + 1) || visit(candidate.sibling, depth);
      };
      const instance = visit(componentFiber.child);
      if (instance) {
        instance.onChange(selectedIds);
        return { ok: true, method: 'SaleAttributesItems.onChange', selectedIds };
      }
      const next = [...current, { ...option }];
      if (typeof props.changeValue === 'function') {
        props.changeValue.call(props, next);
        return { ok: true, method: 'changeValue' };
      }
      if (typeof props.change === 'function') {
        props.change(props.id, { props: { value: next } });
        return { ok: true, method: 'change' };
      }
      return { ok: false, reason: 'missing-change-handler' };
    }
    return { ok: false, reason: 'missing-component' };
  }, value).catch((error) => ({ ok: false, reason: error.message }));
  const tryDomFallback = async () => {
    const control = await visibleColorSpecControl(page);
    if (control && String(await control.input.getAttribute('value')) === String(value)) {
      if (await control.input.isDisabled().catch(() => true)) return false;
      return ensureSpecControlChecked(page, async () => {
        const current = await visibleColorSpecControl(page);
        return current && String(await current.input.getAttribute('value')) === String(value) ? current : null;
      });
    }
    const input = page.locator(`#saleAttributesItems input[value="${String(value).replace(/["\\]/g, '')}"]`).first();
    if (!await input.isVisible().catch(() => false) || await input.isDisabled().catch(() => true)) return false;
    const wrapper = input.locator('xpath=ancestor::label[1]');
    if (await wrapper.count().catch(() => 0)) await wrapper.click({ force: true }).catch(() => {});
    else await input.click({ force: true }).catch(() => {});
    await page.waitForTimeout(350);
    return saleAttributeIsSelected(page, value);
  };
  if (!committed?.ok) return tryDomFallback();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await saleAttributeIsSelected(page, value)) return true;
    await page.waitForTimeout(200);
  }
  return tryDomFallback();
}

async function ensureSaleAttributeCleared(page, value) {
  if (!await saleAttributeIsSelected(page, value)) return true;
  const committed = await page.evaluate((expectedValue) => {
    const root = document.querySelector('#saleAttributesItems');
    if (!root) return { ok: false, reason: 'missing-root' };
    const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems' || !Array.isArray(props.value)) continue;
      if (props.dataSource?.some((item) => String(item.value) === String(expectedValue) && item.must)) return { ok: false, reason: 'required' };
      if (!props.value.some((item) => String(item?.value) === String(expectedValue))) {
        return { ok: true, already: true };
      }
      const selectedIds = props.value
        .filter((item) => String(item?.value) !== String(expectedValue))
        .map((item) => props.dataSource?.find((candidate) => String(candidate.value) === String(item?.value))?.value ?? item?.value);
      const seen = new Set();
      const visit = (candidate, level = 0) => {
        if (!candidate || level > 18 || seen.has(candidate)) return null;
        seen.add(candidate);
        const instance = candidate.stateNode;
        if (instance?.constructor?.name === 'SaleAttributesItems' && typeof instance.onChange === 'function') return instance;
        return visit(candidate.child, level + 1) || visit(candidate.sibling, level);
      };
      const instance = visit(fiber.child);
      if (instance) {
        instance.onChange(selectedIds);
        return { ok: true, method: 'SaleAttributesItems.onChange' };
      }
      const next = props.value.filter((item) => String(item?.value) !== String(expectedValue));
      if (typeof props.changeValue === 'function') {
        props.changeValue.call(props, next);
        return { ok: true, method: 'changeValue' };
      }
      if (typeof props.change === 'function') {
        props.change(props.id, { props: { value: next } });
        return { ok: true, method: 'change' };
      }
      return { ok: false, reason: 'missing-change-handler' };
    }
    return { ok: false, reason: 'missing-component' };
  }, value).catch((error) => ({ ok: false, reason: error.message }));
  if (!committed?.ok) return false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!await saleAttributeIsSelected(page, value)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function revealSaleAttributeControls(page) {
  const root = page.locator('#saleAttributesItems').first();
  if (!await root.isVisible().catch(() => false)) return;
  // This component mounts its checkbox group only after entering the viewport.
  // Resetting offscreen selections otherwise leaves no usable selection control.
  await root.scrollIntoViewIfNeeded({ timeout: 3000 });
}

// A category can arrive with sale-attribute options preselected from the
// previous browser session. Those defaults are not part of the source product
// and image-type defaults make Alibaba reject the form with
// “商品图片项必填项不能为空”. Clear only removable defaults. Existing listings
// can render fixed specification rows with an empty option list; firing a
// reset there destroys values that the form cannot add again.
export async function clearSaleAttributeSelections(page) {
  await revealSaleAttributeControls(page);
  const result = await page.evaluate(() => {
    const root = document.querySelector('#saleAttributesItems');
    if (!root) return { ok: false, reason: 'missing-root' };
    const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems' || !Array.isArray(props.value)) continue;
      const dataSource = Array.isArray(props.dataSource) ? props.dataSource : [];
      const optionById = new Map(dataSource.map((item) => [String(item.value), item]));
      const retained = props.value.filter((item) => {
        const option = optionById.get(String(item.value));
        const input = root.querySelector(`input[value="${CSS.escape(String(item.value))}"]`);
        return !option || item.must || option.must || option.disabled || input?.disabled;
      });
      for (const item of dataSource) {
        if (item.must && !retained.some((current) => String(current.value) === String(item.value))) retained.push(item);
      }
      const retainedIds = retained.map((item) => String(item.value));
      if (props.value.length === retained.length && props.value.every((item) => retainedIds.includes(String(item.value)))) {
        return { ok: true, unchanged: true, retainedIds };
      }
      const visit = (candidate, level = 0, seen = new Set()) => {
        if (!candidate || level > 18 || seen.has(candidate)) return null;
        seen.add(candidate);
        const instance = candidate.stateNode;
        if (instance?.constructor?.name === 'SaleAttributesItems' && typeof instance.onChange === 'function') return instance;
        return visit(candidate.child, level + 1, seen) || visit(candidate.sibling, level, seen);
      };
      const instance = visit(fiber.child);
      // The native onChange filters through dataSource and drops fixed items
      // missing from that list. Its valueChange event preserves their metadata.
      if (instance && retained.every((item) => optionById.has(String(item.value)))) {
        instance.onChange(retained.map((item) => optionById.get(String(item.value)).value));
        return { ok: true, method: 'SaleAttributesItems.onChange', retainedIds };
      }
      const eventProps = typeof instance?.props?.fireEvent === 'function' ? instance.props : props;
      if (typeof eventProps.fireEvent === 'function') {
        eventProps.fireEvent(eventProps.id, 'valueChange', retained);
        return { ok: true, method: 'valueChange', retainedIds };
      }
      if (typeof props.changeValue === 'function') {
        props.changeValue.call(props, retained);
        return { ok: true, method: 'changeValue', retainedIds };
      }
      if (typeof props.change === 'function') {
        props.change(props.id, { props: { value: retained } });
        return { ok: true, method: 'change', retainedIds };
      }
      return { ok: false, reason: 'missing-change-handler' };
    }
    return { ok: false, reason: 'missing-component' };
  }).catch((error) => ({ ok: false, reason: error.message }));
  if (!result?.ok) return false;
  if (result.unchanged) return true;
  await page.waitForTimeout(500);
  return page.evaluate((expectedIds) => {
    const root = document.querySelector('#saleAttributesItems');
    const fiberKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id === 'saleAttributesItems' && Array.isArray(props.value)) {
        const actualIds = props.value.map((item) => String(item.value));
        return actualIds.length === expectedIds.length && expectedIds.every((id) => actualIds.includes(id));
      }
    }
    return false;
  }, result.retainedIds).catch(() => false);
}

async function clearEmptySaleAttributeSelections(page) {
  const selectedIds = await page.evaluate(() => {
    const root = document.querySelector('#saleAttributesItems');
    if (!root) return [];
    const ids = new Set([...root.querySelectorAll('input[type="checkbox"]:checked')]
      .filter((input) => !input.disabled)
      .map((input) => String(input.value || '').trim())
      .filter(Boolean));
    const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems' || !Array.isArray(props.value)) continue;
      for (const item of props.value) {
        const id = String(item?.value || '').trim();
        if (id) ids.add(id);
      }
      break;
    }
    return [...ids];
  }).catch(() => []);
  const cleared = [];
  for (const id of selectedIds) {
    const row = await visibleSaleSpecRow(page, id);
    const hasValue = row ? await row.evaluate((node) => {
      const visible = (item) => Boolean(item && (item.offsetWidth || item.offsetHeight || item.getClientRects().length));
      const editable = [...node.querySelectorAll('input, textarea, select')].filter((item) => {
        const type = String(item.type || '').toLowerCase();
        return visible(item) && !['hidden', 'file', 'button', 'submit', 'reset'].includes(type);
      });
      if (editable.some((item) => ['checkbox', 'radio'].includes(String(item.type || '').toLowerCase())
        ? item.checked : String(item.value || '').trim())) return true;
      return [...node.querySelectorAll('[data-value], .next-tag-body, [class*="tag-body"], [class*="selected-value"]')]
        .some((item) => visible(item) && String(item.getAttribute?.('data-value') || item.textContent || '').trim());
    }).catch(() => false) : false;
    if (hasValue) continue;
    if (await ensureSaleAttributeCleared(page, id)) cleared.push(id);
  }
  return cleared;
}

export async function visibleEmptyAttributeLabels(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').replace(/^[*＊]\s*/, '').trim();
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const labels = [];
    for (const error of document.querySelectorAll('[class*="error"], [class*="invalid"], [aria-invalid="true"]')) {
      if (!visible(error) || !/属性值不能为空|必填项不能为空|required|不能为空/i.test(clean(error.textContent) + ' ' + (error.getAttribute?.('itemmessage') || ''))) continue;
      const fieldRows = '.sell-catProp-item, .next-form-item, [id^="p-"]';
      const fieldRow = error.closest(fieldRows);
      // Aggregate error panels can contain several fields. Never borrow the
      // first label from their section when only a later field is invalid.
      if (!fieldRow && error.querySelector(fieldRows)) continue;
      let row = fieldRow || error;
      for (let level = 0; row && level < 7; level += 1, row = row.parentElement) {
        const rowLabels = [...new Set([...row.querySelectorAll('label, legend, [class*="label"]')]
          .map((node) => clean(node.textContent)).filter((text) => text && text.length <= 80 && !/属性值不能为空|必填项不能为空|required|不能为空/i.test(text)))];
        if (rowLabels.length > 1) break;
        if (rowLabels.length === 1 && row.querySelector('input, select, textarea, [role="combobox"]')) {
          labels.push(rowLabels[0]);
          break;
        }
        if (fieldRow || row.querySelector(fieldRows)) break;
      }
    }
    return [...new Set(labels)].slice(0, 8);
  }).catch(() => []);
}

function cleanRequiredLabel(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[*＊]\s*/, '')
    .replace(/[：:]\s*$/, '')
    .replace(/(?:必填项?|属性值|required(?: field)?)?不能为空.*$/i, '')
    .trim();
}

function requiredLabelAliases(label) {
  const cleaned = cleanRequiredLabel(label);
  const normalized = requiredAttributeKey(cleaned);
  const group = REQUIRED_ATTRIBUTE_ALIASES.find((items) => requiredAttributeKey(items[0]) === normalized);
  return [...new Set([cleaned, ...(group || [])].filter(Boolean))];
}

const CATEGORY_INPUTS = 'input:not([type="hidden"]):not([type="file"]):not([type="button"]):not([type="submit"]), textarea, select';
function categoryFieldRow(page, field) {
  // Category changes can retain a hidden copy of the old row with the same
  // property ID. Resolve the visible row read by the schema before indexing
  // its controls; inputIndex includes inactive controls within that row.
  return (field.rowId ? page.locator(`[id="${field.rowId.replace(/["\\]/g, '')}"]`)
    : page.locator(`[data-posting-attribute-row="${field.rowIndex}"]`)).filter({ visible: true });
}

function categoryFieldLocator(page, field) {
  const row = categoryFieldRow(page, field);
  return row.locator(CATEGORY_INPUTS).nth(field.inputIndex);
}

async function ensureCategoryFieldControl(page, field) {
  if (field.inputIndex >= 0) return field;
  const row = categoryFieldRow(page, field);
  const add = row.locator('.posting-field-multi-text button.add-button:visible').last();
  if (!await add.isVisible().catch(() => false) || await add.isDisabled()) return null;
  await clickPostingControl(page, add, { timeout: 3000 });
  if (!await row.locator(CATEGORY_INPUTS).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) return null;
  return (await page.evaluate(readPostingAttributeSchema)).find((entry) => field.id ? entry.id === field.id : entry.rowIndex === field.rowIndex);
}

async function fillRepeatableCategoryText(page, field, value) {
  const values = attributeValueList(value, { multiple: true });
  if (!values.length || values.length > 100) return false;
  const row = categoryFieldRow(page, field);
  const inputs = row.locator('.posting-field-multi-text input:not([type="hidden"]):not([disabled]):visible, .posting-field-multi-text textarea:not([disabled]):visible');
  // Clear obsolete entries from the end: committing an empty entry can remove
  // its row. Never retain a previous product's extra codes on the posting page.
  for (let index = await inputs.count() - 1; index >= values.length; index--) {
    const input = inputs.nth(index);
    await input.fill('');
    await input.evaluate((node) => { node.blur(); node.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  for (let index = 0; index < values.length; index++) {
    if (index >= await inputs.count()) {
      const add = row.locator('.posting-field-multi-text button.add-button:visible').last();
      if (!await add.isVisible().catch(() => false) || await add.isDisabled()) return false;
      await clickPostingControl(page, add, { timeout: 3000 });
      if (!await inputs.nth(index).waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) return false;
    }
    const input = inputs.nth(index);
    const limit = Number(await input.getAttribute('maxlength'));
    if (limit > 0 && values[index].length > limit) return false;
    if (!await fillChoice(page, input, values[index])) return false;
  }
  return true;
}

// Learn display labels only after an exact option-ID click was verified.
// The cache never substitutes for reading current chips and is scoped to the
// live page and property ID, so translated labels survive subsequent passes.
const committedOptionLabels = new WeakMap();
function optionLabels(page, field) {
  let fields = committedOptionLabels.get(page);
  if (!fields) { fields = new Map(); committedOptionLabels.set(page, fields); }
  const key = field.id || field.rowId || field.label;
  if (!fields.has(key)) fields.set(key, {});
  return fields.get(key);
}

const WEIGHT_UNIT_EXPONENTS = { kg: 0, g: -3, mg: -6 };
function weightUnit(value) {
  const unit = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (/^(?:kg|kgs|kilograms?|公斤|千克)$/.test(unit)) return 'kg';
  if (/^(?:g|grams?|克)$/.test(unit)) return 'g';
  if (/^(?:mg|milligrams?|毫克)$/.test(unit)) return 'mg';
  return '';
}

function weightLabelUnit(label) {
  const match = String(label ?? '').normalize('NFKC').trim().match(
    /^(?:(?:product|item|net|gross)\s+)?weight\s*\(([^()]+)\)$|^(?:产品重量|商品重量|重量|净重|毛重)\s*\(([^()]+)\)$/i);
  return match ? weightUnit(match[1] || match[2]) : '';
}

function categoryWeightUnit(field) {
  if (field.saleSpecification || field.multiple || !['text', 'textarea', 'number'].includes(field.controlType)) return '';
  const units = [...new Set((field.labels || [field.label]).map(weightLabelUnit).filter(Boolean))];
  return units.length === 1 ? units[0] : '';
}

function exactWeightText(value, targetUnit, defaultUnit = targetUnit) {
  // The platform's unit is already printed beside the input. Move only the
  // decimal point and remove insignificant zeroes; binary floats and rounding
  // can silently change a supplier's precise measurement.
  if (Array.isArray(value) || value == null || !targetUnit) return null;
  const text = String(value).normalize('NFKC').trim();
  if (text.length > 200) return null;
  const match = text.match(/^\+?(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d{1,3}))?\s*([a-zA-Z]+|公斤|千克|毫克|克)?$/);
  if (!match) return null;
  const unit = match[3] ? weightUnit(match[3]) : defaultUnit;
  if (!unit) return null;
  const exponent = Number(match[2] || 0);
  if (Math.abs(exponent) > 100) return null;
  const [whole, fraction = ''] = match[1].split('.');
  const digits = (whole + fraction).replace(/^0+/, '') || '0';
  const scale = fraction.length - exponent - WEIGHT_UNIT_EXPONENTS[unit] + WEIGHT_UNIT_EXPONENTS[targetUnit];
  const padded = scale > 0 ? digits.padStart(scale + 1, '0') : digits + '0'.repeat(-scale);
  const decimal = scale > 0 ? `${padded.slice(0, -scale)}.${padded.slice(-scale)}` : padded;
  return decimal.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^0+(?=\d)/, '');
}

function categoryWeightValue(field, value, source) {
  const targetUnit = categoryWeightUnit(field);
  if (!targetUnit) return null;
  // An explicit source unit takes precedence over the target's label when a
  // verified property ID maps a grams-labelled source to a kilograms input.
  if (source?.unit && !weightUnit(source.unit)) return null;
  const sourceUnit = weightUnit(source?.unit) || weightLabelUnit(source?.name) || targetUnit;
  return exactWeightText(value, targetUnit, sourceUnit);
}

export function attributeFieldMatchesValue(field, value, { valueIds = {}, labels = {}, source } = {}) {
  const values = field.values || [];
  const weight = categoryWeightValue(field, value, source);
  if (weight != null) return values.length === 1 && categoryWeightValue(field, values[0]) === weight;
  if (field.controlType === 'multiText') {
    const expected = attributeValueList(value, { multiple: true });
    const key = (item) => String(item).normalize('NFKC').trim().toLowerCase();
    return expected.length > 0 && expected.every((item) => values.some((selected) => key(item) === key(selected)))
      && values.every((selected) => expected.some((item) => key(item) === key(selected)));
  }
  // A plain text control stores the full source array as one string. Compare
  // that same representation, not each array item against the joined text.
  // Selects and multi-select chips must still match every individual option.
  if (Array.isArray(value) && ['text', 'textarea'].includes(field.controlType) && values.length === 1
    && attributeOptionMatchScore(attributeTextValue(value), values[0]) === 100) return true;
  const minimumScore = ['Age', 'Age Range'].some((name) => requiredAttributeKey(field.label) === requiredAttributeKey(name)) ? 90 : 70;
  const candidates = attributeValueList(value, {
    multiple: field.multiple ?? ['combobox', 'multiSelect', 'checkbox'].includes(field.controlType),
    options: values, valueIds,
  });
  if (requiredAttributeKey(field.label) === requiredAttributeKey('产地') && !isLiteralOriginField(field) && originCountry(value)) {
    return values.some((selected) => originCountry(selected) && originCountry(selected) === originCountry(value));
  }
  return candidates.length > 0 && candidates.every((item) => values.some((selected) => attributeOptionMatchScore(labels[valueIds[item]] || item, selected) >= minimumScore))
    && values.every((selected) => candidates.some((item) => attributeOptionMatchScore(labels[valueIds[item]] || item, selected) >= minimumScore));
}

function categoryAttributeValue(product, field, source) {
  if (requiredAttributeKey(field.label) === '产地') return originValueForField(product, field);
  if (isOriginRegionAttribute(field.label)) return sourceOriginRegion(product, source?.name || field.label);
  const specification = sourceSpecificationForField(product, field);
  if (specification) return specification.options;
  // Attribute lookup above already rejected nonmatching property IDs. Limit
  // fallback to top-level metadata, SKU groups and supported title inference.
  const value = source?.value ?? inferRequiredAttributeValue({ ...product, attributes: [], customAttributes: [] }, ...(field.labels || [field.label]));
  return categoryWeightValue(field, value, source) ?? value;
}

function hasSourceSpecification(product, field) {
  return Boolean(sourceSpecificationForField(product, field));
}

async function waitForCategoryAttributeSettlement(page) {
  const deadline = performance.now() + 6000;
  let previous = '', stableSince = performance.now();
  while (performance.now() < deadline) {
    const fields = await page.evaluate(readPostingAttributeSchema);
    const fingerprint = JSON.stringify(fields.map(({ id, label, controlType, disabled, values, options, required, inputIndex }) =>
      ({ id, label, controlType, disabled, values, options, required, inputIndex })));
    const busy = await page.locator('.sell-catProp-item [aria-busy="true"]:visible, .sell-catProp-item .next-loading.next-open:visible').count();
    if (fingerprint !== previous || busy) { previous = fingerprint; stableSince = performance.now(); }
    // A parent can commit immediately while its dependent option request and
    // replacement row arrive later. Observe the entire attribute schema once
    // per changed pass, then verify the committed values again on the next pass.
    if (performance.now() - stableSince >= 1600) return;
    await page.waitForTimeout(150);
  }
  throw Object.assign(new Error('国际站类目属性仍在加载或联动刷新，已保留商品，尚未提交'), {
    code: 'PUBLISH_FORM_NOT_READY', diagnostics: { reason: 'category-attribute-settlement' },
  });
}

export async function fillCategoryAttributes(page, product, onProgress = () => {}) {
  const mapped = new Set();
  // Selecting one field can mount dependent fields or replace entire rows.
  // Refresh descriptors after every edit, and bound cascading passes.
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    let pending = 0;
    const fields = await page.evaluate(readPostingAttributeSchema);
    for (const initial of fields) {
      // Feature notices can arrive after the form has loaded or after an
      // earlier field changes. Clear them before resolving the next control.
      if (await page.locator(POSTING_BLOCKERS).count()) await requireClearPostingOverlays(page);
      const current = await page.evaluate(readPostingAttributeSchema);
      let field = current.find((entry) => initial.id ? entry.id === initial.id : entry.label === initial.label);
      if (!field || field.disabled || (field.saleSpecification && !field.required)
        || hasSourceSpecification(product, field)) continue;
      const source = postingAttributeSource(product, field, current);
      if (source?.conflict) continue;
      const value = categoryAttributeValue(product, field, source);
      if (value == null || value === '') continue;
      onProgress(`填写类目属性：${field.label}`);
      await closePostingAttributeMenus(page);
      field = await ensureCategoryFieldControl(page, field);
      if (!field || field.inputIndex < 0) continue;
      if (['text', 'textarea'].includes(field.controlType)) {
        const limit = Number(await categoryFieldLocator(page, field).getAttribute('maxlength'));
        const length = attributeTextValue(value).length;
        if (limit > 0 && length > limit) throw Object.assign(new Error(
          `类目属性“${field.label}”原值为 ${length} 个字符，超过发布页 ${limit} 个字符限制；请在商品编辑中缩短该属性，原始采集资料已保留`
        ), { code: 'PUBLISH_ATTRIBUTE_VALUE_TOO_LONG', requiredFields: [field.label], diagnostics: { fieldId: field.id, limit, length } });
      }
      const choiceOptions = { valueIds: source?.matchedById ? source.valueIds : {}, labels: optionLabels(page, field), multiple: field.multiple };
      if (field.hasValue && attributeFieldMatchesValue(field, value, choiceOptions)) {
        mapped.add(source?.name || field.label); continue;
      }
      pending++;
      let filled;
      try {
        filled = requiredAttributeKey(field.label) === requiredAttributeKey('产地')
          ? await fillOriginCountry(page, value)
          : field.controlType === 'multiText' ? await fillRepeatableCategoryText(page, field, value)
          : await fillChoice(page, categoryFieldLocator(page, field), value, {
          ...choiceOptions,
          allowCustomCombo: requiredAttributeKey(field.label) === 'OE代码',
          onValueCommitted: (id, label) => { choiceOptions.labels[id] = label; },
          minimumScore: ['Age', 'Age Range'].some((name) => requiredAttributeKey(field.label) === requiredAttributeKey(name)) ? 90 : 70,
        }).catch(postingInteractionFailure);
      } catch (error) {
        if (!await page.locator(POSTING_BLOCKERS).count()) throw error;
        await requireClearPostingOverlays(page);
        changed = true;
        continue;
      }
      if (filled) { mapped.add(source?.name || field.label); changed = true; }
    }
    if (!pending) break;
    // One field may reset an earlier field or mount a dependent field after
    // its event returns. Verify all values on the next pass, not merely that
    // the control has any value. Give an initially empty option list a retry.
    if (!changed && pass >= 1) break;
    if (changed) await waitForCategoryAttributeSettlement(page);
    else await page.waitForTimeout(350);
  }
  return [...mapped];
}

export async function requireCategoryAttributes(page, product) {
  const schema = await page.evaluate(readPostingAttributeSchema);
  const incomplete = schema.filter((field) => {
    if (field.disabled || field.saleSpecification) return false;
    const source = postingAttributeSource(product, field, schema);
    // Supplied optional values also need read-back: a dependent field can
    // clear them after they were filled successfully earlier in the pass.
    const suppliedRegion = isOriginRegionAttribute(field.label) && sourceOriginRegion(product, field.label);
    if (!field.required && !source && !suppliedRegion) return false;
    if (!field.hasValue) return true;
    if (source?.conflict) return true;
    const value = categoryAttributeValue(product, field, source);
    // An unsupported literal origin must not be replaced by a preselected
    // country. A nonempty platform default is not evidence of source transfer.
    if (isOriginAttribute(field.label) && productOriginText(product) && !value) return true;
    return value != null && value !== '' && !attributeFieldMatchesValue(field, value, {
      valueIds: source?.matchedById ? source.valueIds : {}, labels: optionLabels(page, field),
    });
  });
  if (!incomplete.length) return;
  const error = await requiredAttributeFailure(page, product, incomplete.map((field) => field.label));
  error.diagnostics = { ...error.diagnostics, fields: incomplete.map((field) => ({ id: field.id, label: field.label, values: field.values, controlType: field.controlType })) };
  throw error;
}

export async function requirePublicAttributeTransfer(page, product) {
  const schema = await page.evaluate(readPostingAttributeSchema);
  const plan = planPublicAttributeTransfer(product, schema);
  await requireCustomAttributes(page, plan.product);
  const verified = requirePublicAttributeValues(plan, (field, source) => attributeFieldMatchesValue(field, source.value, {
    valueIds: sourceAttributeForField({ attributes: [source] }, field)?.matchedById ? source.valueIds : {}, labels: optionLabels(page, field), source,
  }));
  for (const field of schema) {
    if (sourceAttributeForField(product, field)) continue;
    const source = packagingUseFromEvidence(product, field, schema);
    if (!source) continue;
    if (!field.hasValue || !attributeFieldMatchesValue(field, source.value, { valueIds: source.valueIds, labels: optionLabels(page, field) })) {
      throw await requiredAttributeFailure(page, product, [field.label]);
    }
    verified.push({ name: source.name, value: source.value, source: source.source, propertyId: field.id,
      targetId: field.id, targetLabel: field.label, destination: 'standard-attribute', committedValues: field.values,
      evidence: source.ruleEvidence });
  }
  return verified;
}

export function requiredLabelsFromError(message) {
  const labels = [];
  for (const match of String(message || '').matchAll(/(?:商品属性|属性)\s*[:：]?\s*[\[【]([^\]】\r\n]{1,60})[\]】]\s*(?:必须填写|必填|不能为空|is required)/gi)) {
    const label = cleanRequiredLabel(match[1]);
    if (label) labels.push(label);
  }
  for (const match of String(message || '').matchAll(/(?:^|[；;，,：:\s])\s*([^；;，,：:\s]{1,48}?)(?:必填项)?不能为空/gi)) {
    const label = cleanRequiredLabel(match[1]);
    if (label && !/^(?:属性值|商品图片项?|图片|image)$/i.test(label)) labels.push(label);
  }
  for (const match of String(message || '').matchAll(/(?:^|[；;\n])\s*([A-Za-z][A-Za-z /_-]{1,60}?)\s+(?:(?:is\s+)?required|(?:cannot|must not)\s+be\s+(?:empty|blank))/gi)) {
    labels.push(match[1].trim());
  }
  return [...new Set(labels)].slice(0, 12);
}

export async function recoverRequiredAttributes(page, product, labels, onProgress = () => {}) {
  const items = [...(product.attributes || []), ...(product.customAttributes || [])]
    .filter((item) => item?.name && item.value != null && item.value !== '');
  const normalized = (value) => String(value || '').toLowerCase().replace(/[\s_\-/]+/g, ' ').trim();
  const recovered = [];
  const schema = await page.evaluate(readPostingAttributeSchema);
  for (const rawLabel of labels) {
    const aliases = requiredLabelAliases(rawLabel);
    if (aliases.some(isOriginRegionAttribute) && !aliases.some(name => sourceOriginRegion(product, name))) continue;
    if (!aliases.length) continue;
    let descriptor = schema.find((field) => field.labels.some((label) => requiredAttributeKey(label) === requiredAttributeKey(rawLabel)));
    // The specification writer owns values and images together. A descriptive
    // Color attribute must not create an extra, image-less SKU color.
    if (descriptor?.saleSpecification && (!descriptor.required || hasSourceSpecification(product, descriptor))) continue;
    const source = descriptor && postingAttributeSource(product, descriptor, schema);
    if (source?.conflict) continue;
    if (descriptor && source?.value != null && source.value !== '') descriptor = await ensureCategoryFieldControl(page, descriptor);
    const field = descriptor ? (descriptor.inputIndex < 0 ? null : categoryFieldLocator(page, descriptor)) : await fieldByAnyLabel(page, aliases);
    if (!field) continue;
    onProgress(`补填必填属性：${aliases[0]}`);
    const wanted = new Set(aliases.map(normalized));
    let value = descriptor ? categoryAttributeValue(product, descriptor, source)
      : items.find((item) => wanted.has(normalized(item.name)))?.value ?? '';
    if (!descriptor && (value == null || value === '')) value = inferRequiredAttributeValue(product, ...aliases);
    if (aliases.some((label) => requiredAttributeKey(label) === requiredAttributeKey('产地')) && !isLiteralOriginField(descriptor) && originCountry(value)) {
      if (await fillOriginCountry(page, product.origin || value)) recovered.push(aliases[0]);
      continue;
    }

    let filled = false;
    if (descriptor?.controlType === 'multiText' && value) {
      if (await fillRepeatableCategoryText(page, descriptor, value)) recovered.push(aliases[0]);
      continue;
    }
    for (const candidate of [value].filter((item) => item != null && item !== '')) {
      if (await fillChoice(page, field, candidate, {
        valueIds: source?.matchedById ? source.valueIds : {},
        multiple: descriptor?.multiple,
        labels: descriptor ? optionLabels(page, descriptor) : {},
        onValueCommitted: (id, label) => { if (descriptor) optionLabels(page, descriptor)[id] = label; },
        minimumScore: ['Age', 'Age Range'].some((name) => requiredAttributeKey(rawLabel) === requiredAttributeKey(name)) ? 90 : 70,
      }).catch(postingInteractionFailure)) {
        filled = true;
        break;
      }
    }
    if (!filled && value) {
      const type = String(await field.getAttribute('type').catch(() => '')).toLowerCase();
      const isChoice = await field.getAttribute('role').catch(() => '') === 'combobox'
        || await field.getAttribute('readonly').catch(() => null) !== null
        || await field.evaluate((node) => node.tagName === 'SELECT').catch(() => false);
      if (!isChoice && !['checkbox', 'radio'].includes(type)) {
        filled = await fillAndVerify(field, value, aliases[0]).then(() => true).catch(() => false);
      }
    }
    if (filled) recovered.push(aliases[0]);
  }
  return recovered;
}

export async function setImageUploadFiles(input, files, options = {}) {
  const expected = files.map((file) => ({ name: path.basename(file), size: fs.statSync(file).size }));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await input.setInputFiles(files, { timeout: options.timeout ?? 30000 });
      return;
    } catch (error) {
      if (!/timeout|detached|not attached/i.test(String(error?.message || error))) throw error;
      // A slow change handler can time out after the files were accepted.
      // Inspect the queue and FileList before dispatching another upload.
      if (options.hasStarted && await options.hasStarted().catch(() => false)) return;
      const selected = await input.evaluate((node) => [...(node.files || [])]
        .map((file) => ({ name: file.name, size: file.size }))).catch(() => []);
      if (JSON.stringify(selected) === JSON.stringify(expected)) return;
      if (attempt === 1) {
        const failure = new Error('国际站图片上传控件响应超时，自动重试后仍未接收图片，请重试该商品', { cause: error });
        failure.code = 'IMAGE_UPLOAD_TIMEOUT';
        throw failure;
      }
    }
  }
}

export async function emptyRequiredSpecificationLabels(page, includeCategory = false) {
  const fields = await page.evaluate(readPostingAttributeSchema);
  return fields.filter((field) => !field.disabled && (includeCategory || field.saleSpecification) && field.required && !field.hasValue).map((field) => field.label);
}

export async function requiredAttributeFailure(page, product, labels) {
  const schema = await page.evaluate(readPostingAttributeSchema);
  const missing = [], unmatched = [], conflicts = [];
  const dependencies = [];
  for (const label of labels) {
    const field = schema.find((field) => field.label === label) || { label };
    const source = postingAttributeSource(product, field, schema);
    if (source?.conflict) { conflicts.push(label); continue; }
    const value = categoryAttributeValue(product, field, source);
    const absent = value == null || value === '' || (Array.isArray(value) && !value.length);
    (absent ? missing : unmatched).push(label);
    if (absent && /^19421-\d+$/.test(field.id)) {
      const parent = schema.find(item => item.id === '19421');
      const conflict = packagingParentConflict(product, schema);
      if (parent?.hasValue) dependencies.push({ fieldId: field.id, label, parentId: parent.id,
        parentLabel: parent.label, parentValues: parent.values,
        ...(conflict ? { conflict } : {}), reason: conflict ? 'source-parent-conflict' : 'source-dependent-value-missing' });
    }
  }
  const reasons = [];
  if (conflicts.length) reasons.push(`同一属性存在冲突值，请确认：${conflicts.join('、')}`);
  const ordinaryMissing = missing.filter(label => !dependencies.some(item => item.label === label));
  if (ordinaryMissing.length) reasons.push(`来源缺少必填资料：${ordinaryMissing.join('、')}；请补充这些字段或重新采集`);
  for (const item of dependencies) reasons.push(item.conflict
    ? `来源标准“${item.parentLabel}”为 ${item.parentValues.join('、')}，与供应商自定义行业 ${item.conflict.conflictingValues.join('、')} 不一致，无法确认当前分支的“${item.label}”；请在商品编辑中确认正确行业和具体用途后重试`
    : `来源的“${item.parentLabel}”为 ${item.parentValues.join('、')}，已保存的商品属性和正文中未找到可匹配当前选项的“${item.label}”；请在商品编辑中补充真实的${item.label}后重试`);
  if (unmatched.length) reasons.push(`已采集但发布页未接受：${unmatched.join('、')}；请检查对应选项或控件是否加载完成`);
  return Object.assign(new Error(reasons.join('；')), {
    code: 'PUBLISH_REQUIRED_DATA_MISSING', requiredFields: labels, missingSourceFields: missing, unmatchedSourceFields: unmatched, conflictingSourceFields: conflicts,
    ...(dependencies.length ? { diagnostics: { dependencies } } : {}),
  });
}

async function specControlIsChecked(control) {
  if (!control) return false;
  const { wrapper, input } = control;
  if (await input.isChecked().catch(() => false)) return true;
  if (await input.getAttribute('aria-checked').catch(() => '') === 'true') return true;
  if (await wrapper.getAttribute('aria-checked').catch(() => '') === 'true') return true;
  const className = await wrapper.getAttribute('class').catch(() => '');
  return /(?:^|\s)(?:checked|is-checked)(?:\s|$)/i.test(className || '');
}

async function ensureSpecControlChecked(page, resolveControl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const control = await resolveControl();
    if (!control) return false;
    if (await specControlIsChecked(control)) return true;
    await control.wrapper.click({ force: true }).catch(() => {});
    await page.waitForTimeout(350);
    const refreshed = await resolveControl();
    if (await specControlIsChecked(refreshed)) return true;
    // A checked DOM property alone does not update React's dependent values.
    // Retry the current native control rather than manufacturing acceptance.
    if (refreshed && await refreshed.input.isVisible().catch(() => false)) {
      await refreshed.input.setChecked(true, { timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(350);
    }
  }
  return specControlIsChecked(await resolveControl());
}

export function preferredSpecificationImageGroup(product, group) {
  // Older collected data can repeat the SKU image on a TEXT model dimension.
  // Prefer the actual IMAGE dimension only when every option-image relation
  // is equivalent; matching image sets alone would swap images between SKUs.
  if (!group || String(group.type || '').toUpperCase() === 'IMAGE' || group.sourceGroups?.length) return null;
  const sameGroup = (left, right) => left.id && right.id ? String(left.id) === String(right.id)
    : Boolean(left.name && right.name && left.name.normalize('NFKC').trim().toLowerCase() === right.name.normalize('NFKC').trim().toLowerCase());
  const imageFor = (item, value) => item.optionImages?.[value] || item.optionImages?.[englishSpecText(value)];
  const sameImage = (left, right) => Boolean(left && right && distinctAlibabaImageUrls([left, right]).length === 1);
  const groupOptions = [...new Set(group.options || [])];
  if (!groupOptions.length || groupOptions.some(value => !imageFor(group, value))) return null;
  const candidates = (product?.variantGroups || []).filter(primary => !sameGroup(primary, group)
    && String(primary.type || '').toUpperCase() === 'IMAGE' && primary.options?.length
    && primary.options.every(value => imageFor(primary, value)));
  const covered = candidates.filter(primary => {
    const images = [...groupOptions.map(value => imageFor(group, value)), ...primary.options.map(value => imageFor(primary, value))];
    const skus = product.skus || [];
    if (distinctAlibabaImageUrls(images).length === 1) return skus.every(sku => !sku.image || sameImage(sku.image, images[0]));
    const optionFor = (sku, item) => Object.hasOwn(sku.attributes || {}, String(item.id || ''))
      ? sku.attributes[String(item.id)] : findSkuAttributeEntry(sku.attributes, item.name)?.[1];
    return skus.length > 0 && skus.every(sku => {
      const image = imageFor(group, optionFor(sku, group));
      return sameImage(image, imageFor(primary, optionFor(sku, primary))) && (!sku.image || sameImage(image, sku.image));
    }) && groupOptions.every(value => skus.some(sku => String(optionFor(sku, group) ?? '').trim() === String(value).trim()));
  });
  return covered.length === 1 ? covered[0] : null;
}

async function uploadPreferredSpecificationImages(page, product, group, groups, downloadImages, onProgress) {
  const primary = preferredSpecificationImageGroup(product, group);
  if (!primary) return null;
  if (isColorVariantGroup(primary)) {
    if (!await visibleColorSpecRow(page)) return null;
    return enableSpecImageUpload(page, product, primary, downloadImages, onProgress);
  }
  const byId = (groups || []).filter(item => String(item.id) === String(primary.id));
  const nameKey = name => String(name || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  // Applied groups retain the source name when their target ID changes.
  // An alias can identify another source dimension, including this text group.
  const candidates = byId.length ? byId : (groups || []).filter(item => nameKey(item.name) === nameKey(primary.name));
  if (candidates.length > 1) return null;
  const target = candidates[0] || primary;
  // Delegate only to the actual image dimension, so the recursive uploader
  // terminates and a rejected match leaves this group's own images available.
  if (String(target.id) === String(group.id) || String(target.type || '').toUpperCase() !== 'IMAGE'
    || target.sourceGroups?.length) return null;
  if (!await visibleSaleSpecRow(page, target.id)) return null;
  return enableImageBackedVariantSpecs(page, product, [target], downloadImages, onProgress);
}

export async function enableSpecImageUpload(page, product, colorGroup, downloadImages, onProgress = () => {}) {
  const colorId = await colorSaleAttributeId(page);
  const options = [...new Set(colorGroup?.options || [])].map((rawValue) => ({
    value: englishSpecText(rawValue),
    imageUrl: colorGroup.optionImages?.[rawValue] || colorGroup.optionImages?.[englishSpecText(rawValue)],
  })).filter((option) => option.value);
  if (!options.some((option) => option.imageUrl)) return false;
  if (!await ensureColorSpecificationReady(page)) return false;
  if (!await fillColorSpec(page, options.map((option) => option.value))) return false;
  const preferred = await uploadPreferredSpecificationImages(page, product, colorGroup, [], downloadImages, onProgress);
  if (preferred !== null) return preferred;

  const deadline = Date.now() + 10000;
  let row = await visibleColorSpecRow(page);
  while (!row && Date.now() < deadline) {
    await page.waitForTimeout(200);
    row = await visibleColorSpecRow(page);
  }
  if (!row) return false;
  await removeEmptyColorSpecRows(page, options.map((option) => option.value));
  row = await visibleColorSpecRow(page) || row;
  if (!await ensureColorSpecImageSwitch(page, row)) {
    const state = await row.evaluate((node) => ({
      rowClass: String(node.className || ''),
      switches: [...node.querySelectorAll('[role="switch"], .next-switch')].map((item) => ({
        className: String(item.className || ''),
        ariaChecked: item.getAttribute('aria-checked'),
      })),
      colorValues: [...node.querySelectorAll('input[role="colorCombobox"]')].map((item) => item.value),
    })).catch(() => null);
    throw new Error(`国际站颜色规格图片开关未能打开（${JSON.stringify(state || {})}）`);
  }

  // A previously uploaded first color does not imply that the other options
  // have images. Check every source option, including on submission retries.
  for (const [index, option] of options.entries()) {
    onProgress(`复核颜色规格图片 ${index + 1}/${options.length}`);
    row = await visibleColorSpecRow(page) || row;
    let item = await specValueUploadContainer(row, option.value);
    if (!item && await fillColorSpec(page, options.map((entry) => entry.value))) {
      row = await visibleColorSpecRow(page) || row;
      item = await specValueUploadContainer(row, option.value);
    }
    if (!item) return false;
    if (await specImageIsUploaded(item)) continue;
    if (!option.imageUrl) return false;
    const files = await downloadImages([option.imageUrl], `spec-color-${index}`, 1);
    if (!files.length || !await uploadSpecFile(page, item, files[0])) return false;
  }
  if (!await ensureSaleAttributeSelected(page, colorId)) return false;
  row = await visibleColorSpecRow(page);
  if (!row) return false;
  for (const option of options) {
    const item = await specValueUploadContainer(row, option.value);
    if (!item || !await specImageIsUploaded(item)) return false;
  }
  return true;
}

async function visibleSaleSpecRow(page, attributeId) {
  const rows = page.locator(`#struct-specification [id="p-${attributeId}"], #struct-specification [data-attribute-id="${attributeId}"], #struct-specification [data-id="${attributeId}"]`);
  for (let index = 0; index < await rows.count().catch(() => 0); index += 1) {
    const row = rows.nth(index);
    if (await row.isVisible().catch(() => false)) return row;
  }
  return null;
}

async function specValueUploadContainer(row, value) {
  const expected = String(value || '').trim().toLowerCase();
  const labels = row.locator('label, [role="checkbox"], [role="radio"]');
  for (let index = 0; index < await labels.count().catch(() => 0); index += 1) {
    let candidate = labels.nth(index);
    const text = String(await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().toLowerCase();
    const inputValue = await candidate.locator('input').evaluateAll((inputs) => String(inputs[0]?.value || '').trim().toLowerCase()).catch(() => '');
    if (text !== expected && inputValue !== expected) continue;
    for (let level = 0; level < 7; level += 1) {
      const hasUpload = await candidate.locator('.custom-upload-image, .value-preview, [class*="upload-image"], [class*="upload-trigger"], input[type="file"]').count().catch(() => 0);
      if (hasUpload) return candidate;
      candidate = candidate.locator('..');
    }
  }

  const items = row.locator('.posting-feild-color-item, .posting-field-color-item, .posting-feild-color-item-container, [class*="value-item"], [class*="spec-item"]');
  for (let index = 0; index < await items.count().catch(() => 0); index += 1) {
    const item = items.nth(index);
    const values = await item.locator('input').evaluateAll((nodes) => nodes.map((node) => String(node.value || '').trim().toLowerCase())).catch(() => []);
    const text = String(await item.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().toLowerCase();
    if (values.includes(expected) || text === expected || text.startsWith(`${expected} `)) return item;
  }
  return null;
}

export async function specImageIsUploaded(item) {
  return item.locator([
    '.value-preview.uploaded img[src]',
    '.value-preview.uploaded [style*="background-image"]',
    '.custom-upload-image.uploaded img[src]',
    '.custom-upload-image [data-role="preview"] img[src]'
  ].join(', ')).evaluateAll((nodes) => nodes.some((node) => {
    if (node.closest('.value-preview.uploading, .value-preview.loading, .value-preview.error, .custom-upload-image.uploading, .custom-upload-image.loading, .custom-upload-image.error')) return false;
    const source = node.getAttribute('src') || String(node.style.backgroundImage || '').match(/url\(["']?(.+?)["']?\)/i)?.[1] || '';
    return /^(?:https?:)?\/\//i.test(source) && !/loading|placeholder/i.test(source);
  })).catch(() => false);
}

async function uploadSpecFile(page, item, file) {
  if (await specImageIsUploaded(item)) return true;

  const trigger = item.locator('.custom-upload-image, [class*="upload-image"], [class*="upload-trigger"], .value-preview').first();
  let input = item.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
  if (await input.count().catch(() => 0)) {
    await setImageUploadFiles(input, [file], { hasStarted: () => specImageIsUploaded(item) });
  } else {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.hover({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
    input = item.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (await input.count().catch(() => 0)) {
      await setImageUploadFiles(input, [file], { hasStarted: () => specImageIsUploaded(item) });
    } else {
      const localButton = item.getByRole('button', { name: /本地选取|本地上传|local/i }).last();
      const action = await localButton.isVisible().catch(() => false) ? localButton : trigger;
      let chooser = await choosePostingFile(page, action, { recover: (target) => recoverPostingClick(page, target) });
      if (!chooser) {
        const portal = page.getByText(/^(?:本地上传|本地选取)$/).last();
        if (await portal.isVisible().catch(() => false)) {
          chooser = await choosePostingFile(page, portal, { recover: (target) => recoverPostingClick(page, target) });
        }
      }
      if (!chooser) return false;
      await chooser.setFiles(file, { timeout: 30000 });
    }
  }

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await specImageIsUploaded(item)) return true;
    const feedback = (await visibleFeedback(page)).join(' ');
    if (/上传失败|图片.*不符合|upload failed/i.test(feedback)) return false;
    await page.waitForTimeout(350);
  }
  return false;
}

export async function enableImageBackedVariantSpecs(page, product, groups, downloadImages, onProgress = () => {}) {
  const imageGroups = (groups || []).filter((group) => group?.id
    && Object.values(group.optionImages || {}).some(Boolean));
  for (const group of imageGroups) {
    if (!await ensureSaleAttributeSelected(page, group.id)) return false;
    const preferred = await uploadPreferredSpecificationImages(page, product, group, groups, downloadImages, onProgress);
    if (preferred !== null) {
      if (!preferred) return false;
      continue;
    }
    const sourceOptions = [...new Set(group.options || [])].filter(Boolean);
    // Preserve source specification images even for a single model. Alibaba's
    // direct-submit validator can require this image although the switch looks
    // optional in the UI; the retained custom value now gives the uploader a
    // stable row to target.
    let row = await visibleSaleSpecRow(page, group.id);
    const rowDeadline = Date.now() + 10000;
    while (!row && Date.now() < rowDeadline) {
      await page.waitForTimeout(200);
      row = await visibleSaleSpecRow(page, group.id);
    }
    if (!row || !await ensureColorSpecImageSwitch(page, row)) return false;

    for (const [index, rawValue] of sourceOptions.entries()) {
      onProgress(`复核${group.name || '商品'}规格图片 ${index + 1}/${sourceOptions.length}`);
      const value = group.appliedValues?.[rawValue] || englishSpecText(rawValue);
      if (!value) return false;
      row = await visibleSaleSpecRow(page, group.id) || row;
      const item = await specValueUploadContainer(row, value);
      if (!item) throw new Error(`国际站${group.name || '商品'}规格图片上传失败：未找到“${value}”的上传位置`);
      if (await specImageIsUploaded(item)) continue;
      const imageUrl = group.optionImages?.[rawValue] || group.optionImages?.[value];
      if (!imageUrl) throw new Error(`国际站${group.name || '商品'}规格图片缺失：“${value}”没有来源图片`);
      const files = await downloadImages([imageUrl], `spec-${group.id}-${index}`, 1);
      if (!files.length) throw new Error(`国际站${group.name || '商品'}规格图片下载失败：“${value}”`);
      // Portal menus and filechooser events belong to the page, not the SKU.
      // Finish one upload before another option can change the active target.
      if (!await uploadSpecFile(page, item, files[0])) throw new Error(`国际站${group.name || '商品'}规格图片上传失败：“${value}”未被表单接收`);
    }
    if (!await ensureSaleAttributeSelected(page, group.id)) return false;
    row = await visibleSaleSpecRow(page, group.id);
    if (!row) return false;
    for (const rawValue of sourceOptions) {
      const item = await specValueUploadContainer(row, group.appliedValues?.[rawValue] || englishSpecText(rawValue));
      if (!item || !await specImageIsUploaded(item)) return false;
    }
  }
  return true;
}

// TinyMCE gives its non-modal table toolbar role="dialog". It can remain
// visible after editing without blocking the form; actual editor windows
// and modal backdrops must still be handled as blockers.
const POSTING_GUIDE = '.next-balloon[role="tooltip"]:is(:has(.next-balloon-close),:has(.balloon-close))';
const POSTING_BLOCKERS = `.next-overlay-backdrop:visible, .next-dialog:visible, ${POSTING_DIALOG}:visible, .mce-window:visible, #mce-modal-block:visible, ${POSTING_GUIDE}:visible`;

export async function recoverPostingClick(page, target) {
  requireNoPolicyWarning(await visibleFeedback(page));
  // Keep the popup/dialog being operated on open. Closing it would discard
  // a logistics selection or remove the option the next click must select.
  const context = await targetPopupContext(target);
  if (context.inMenu || context.inDialog) {
    await dismissPostingNotice(page, target);
    if (context.inDialog && !context.inMenu) await closePostingAttributeMenus(page, target);
  }
  else await requireClearPostingOverlays(page);
}

export function clickPostingControl(page, target, options = {}) {
  return performPostingClick(page, target, { recover: (control) => recoverPostingClick(page, control), ...options });
}

async function dismissPostingNotice(page, protectedTarget) {
  const handle = protectedTarget ? await protectedTarget.elementHandle({ timeout: 1000 }).catch(() => null) : null;
  if (protectedTarget && !handle) return false;
  const harmlessActions = [
    /^(?:暂不接受|Not now|Decline)$/i,
    /^(?:我知道了|知道了|关闭|取消|稍后再说|暂不|以后再说|Got it|Close|Cancel)$/i
  ];
  try {
    const overlays = page.locator(`.next-dialog:visible, ${POSTING_DIALOG}:visible, .mce-window:visible, ${POSTING_GUIDE}:visible`);
    for (let index = (await overlays.count().catch(() => 0)) - 1; index >= 0; index -= 1) {
      const overlay = overlays.nth(index);
      if (!await overlay.isVisible().catch(() => false)) continue;
      if (handle && await overlay.evaluate((node, target) => node.contains(target) || target.contains(node), handle).catch(() => true)) continue;
      if (await overlay.evaluate((node, selector) => node.matches(selector), POSTING_GUIDE)) {
        const close = overlay.locator('.next-balloon-close, .balloon-close').last();
        if (await close.click({ timeout: 1500 }).then(() => true, () => false)) return true;
        continue;
      }
      for (const pattern of harmlessActions) {
        const action = overlay.getByRole('button', { name: pattern }).last();
        if (!await action.isVisible().catch(() => false)) continue;
        if (await action.click({ timeout: 1500 }).then(() => true).catch(() => false)) return true;
      }
      const close = overlay.locator('.next-dialog-close, .next-overlay-close, .mce-close, [aria-label="关闭"], [aria-label="close" i]').last();
      if (await close.isVisible().catch(() => false)) {
        if (await close.click({ timeout: 1500 }).then(() => true).catch(() => false)) return true;
      }
    }
    return false;
  } finally { await handle?.dispose(); }
}

export async function dismissPostingOverlays(page) {
  requireNoPolicyWarning(await visibleFeedback(page));
  await acknowledgePolicyWarning(page);
  await closePostingAttributeMenus(page);
  // Alibaba can open one optional image-service notice for each uploaded
  // image. Drain the already visible stack while keeping retries bounded.
  const passes = Math.min(16, Math.max(4, await page.locator(POSTING_BLOCKERS).count() + 2));
  for (let pass = 0; pass < passes; pass += 1) {
    if (!await page.locator(POSTING_BLOCKERS).count()) return true;
    const acted = await dismissPostingNotice(page);
    if (!acted) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
      const blockingBackdrop = page.locator('.next-overlay-backdrop:visible');
      if (!await page.locator(POSTING_BLOCKERS).count().catch(() => 0)) return true;
      // Some versions render a warning as a backdrop-only overlay. A normal
      // Escape is ignored in that state, but clicking the backdrop is the
      // same user action as dismissing the warning and releases the form.
      if (await blockingBackdrop.count().catch(() => 0)) {
        await blockingBackdrop.last().click({ position: { x: 4, y: 4 }, timeout: 1500 }).catch(() => {});
      }
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(300);
  }
  return !await page.locator(POSTING_BLOCKERS).count().catch(() => 0);
}

async function requireClearPostingOverlays(page) {
  if (await dismissPostingOverlays(page)) return;
  const overlays = await page.locator(POSTING_BLOCKERS).evaluateAll((nodes) => nodes.slice(0, 6).map((node) => ({
    role: node.getAttribute('role') || '', className: node.className || '',
    text: String(node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  }))).catch(() => []);
  const prompt = overlays.find((overlay) => overlay.text)?.text;
  const error = new Error(`国际站有待处理的页面提示${prompt ? `：${prompt}` : ''}；已保留当前商品进度，请处理后继续`);
  error.code = 'PUBLISH_OVERLAY_BLOCKED';
  error.diagnostics = { section: 'overlays', overlays };
  throw error;
}

export async function enterPostingForm(page, publishPageUrl, expectedCategoryId = '') {
  const isCategoryPage = () => /\/product\/(?:easyListing|category)\.htm/i.test(page.url());
  if (!isCategoryPage()) return true;

  const categoryId = String(expectedCategoryId || '').trim();
  const clickFirstVisible = async (locators) => {
    for (const locator of locators) {
      if (await locator.isVisible().catch(() => false) && !await locator.isDisabled().catch(() => false)) {
        await locator.click({ force: true }).catch(() => locator.evaluate((node) => node.click()).catch(() => {}));
        return true;
      }
    }
    return false;
  };

  // New category pages expose a native/select-like control; selecting by ID
  // avoids localized path text and works for both Chinese and English pages.
  if (categoryId) {
    const selected = await page.evaluate((id) => {
      const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
      for (const select of document.querySelectorAll('select')) {
        if (!visible(select)) continue;
        const option = [...select.options].find((item) => String(item.value || '') === id);
        if (!option) continue;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(select, option.value);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const candidate = [...document.querySelectorAll('[data-category-id], [data-cat-id], [value]')]
        .find((node) => visible(node) && String(node.getAttribute('data-category-id') || node.getAttribute('data-cat-id') || node.getAttribute('value') || '') === id);
      if (candidate) { candidate.click(); return true; }
      const link = [...document.querySelectorAll('a[href*="catId"], a[href*="categoryId"]')]
        .find((node) => { const url = new URL(node.href); return visible(node) && (url.searchParams.get('catId') || url.searchParams.get('categoryId')) === id; });
      if (link) { link.click(); return true; }
      return false;
    }, categoryId).catch(() => false);
    if (!selected) return false;
    await page.waitForTimeout(600);
  }

  await dismissPostingOverlays(page);
  await clickFirstVisible([
    page.getByRole('button', { name: /^(?:我已阅读.*发布|发布产品|下一步|确认发布|继续|Next|Continue|Publish product|Post product|I have read.*(?:publish|post).*)$/i }).last(),
    page.getByText(/^(?:我已阅读.*发布|发布产品|下一步|继续|Next|Continue|Publish product|Post product)$/i).last()
  ]);
  await page.waitForTimeout(900);

  // A category page may redirect back to the supplied URL after selection.
  // Only navigate again when it is still on the chooser; this preserves the
  // form state on Alibaba builds that transition without a full navigation.
  if (isCategoryPage() && publishPageUrl && page.url() !== publishPageUrl) {
    await gotoWithRetry(page, publishPageUrl, { timeout: 30000, attempts: 2 }).catch(() => {});
    await settlePage(page);
  }
  return !isCategoryPage();
}

const editorSwitchControls = new WeakMap();

async function activateEditorControl(page, control, key) {
  if (!await control.isVisible().catch(() => false) || await control.isDisabled().catch(() => true)) return false;
  const state = editorSwitchControls.get(page) || new Map();
  editorSwitchControls.set(page, state);
  const previous = state.get(key);
  // Re-clicking a slow editor tab can restart its iframe initialization forever.
  // Retain element identity, so a genuinely rebuilt page can be activated again.
  const sameControl = previous && await control.evaluate((node, old) => node === old, previous.handle).catch(() => false);
  const selected = await control.evaluate((node) => {
    const radio = (node.closest('.icbuRadio-item') || node.closest('label') || node).querySelector('input[type="radio"]');
    if (radio) return radio.checked || radio.getAttribute('aria-checked') === 'true';
    for (const name of ['aria-selected', 'aria-pressed', 'aria-checked']) {
      const value = node.getAttribute(name); if (value !== null) return value === 'true';
    }
    return null;
  }).catch(() => null);
  if (sameControl && (selected !== false || previous.attempts >= 2)) return false;
  if (selected === true) return false;
  const handle = await control.elementHandle().catch(() => null);
  if (!handle) return false;
  try {
    // Keep the identity handle only for repeat-click prevention. Click through
    // a locator so layout shifts and replaced nodes are retried by Playwright.
    // Centering also avoids sticky headers/footers on small remote desktops.
    await control.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })).catch(() => {});
    await clickPostingControl(page, control, { timeout: 5000 });
    const clickedHandle = await control.count().then((count) => count ? control.elementHandle() : null).catch(() => null);
    await previous?.handle.dispose().catch(() => {});
    if (clickedHandle) await handle.dispose().catch(() => {});
    state.set(key, { handle: clickedHandle || handle, attempts: sameControl ? previous.attempts + 1 : 1 });
    return true;
  } catch (error) {
    await handle.dispose().catch(() => {});
    if (/outside of the viewport|not stable|not attached|Timeout/i.test(error.message || '')) {
      throw Object.assign(new Error('国际站详情编辑器切换按钮尚未稳定或被遮挡；已保留任务进度，可继续重试'), {
        code: 'PUBLISH_EDITOR_NOT_READY', diagnostics: { section: 'editor-mode', control: key },
      });
    }
    throw error;
  }
}

export async function prepareDescriptionEditor(page) {
  await requireClearPostingOverlays(page);
  const sectionRevealed = await revealDescriptionSection(page);
  // Changing the detail generation replaces the platform's content model.
  // Never use a downgrade as a shortcut to obtaining a TinyMCE iframe.
  const newer = page.locator('#textDesc, #detailImage').filter({ visible: true });
  const downgrade = page.getByRole('button', { name: /^(?:返回老版|返回旧版|Switch to (?:the )?(?:old|classic|legacy) (?:version|editor)|Back to (?:the )?(?:old|classic|legacy) (?:version|editor))$/i }).filter({ visible: true });
  if (await newer.count() || await downgrade.count()) {
    throw Object.assign(new Error('当前发布页使用新版详情，尚未确认其图文写入方式；已保留内容和进度，不会自动切回旧版，请在发布页核对详情后继续'), {
      code: 'PUBLISH_EDITOR_NOT_READY', diagnostics: { reason: 'new-description-editor', automaticDowngrade: false },
    });
  }
  await requireClearPostingOverlays(page);
  const normalEditor = await findNormalDescriptionControl(page);
  if (normalEditor && !sectionRevealed) await normalEditor.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
  if (normalEditor && await activateEditorControl(page, normalEditor, 'normal')) await page.waitForTimeout(600);
  await revealDescriptionSection(page);
}

// Retain the diagnostic helper's import name; it no longer downgrades details.
export const switchToLegacyDetails = prepareDescriptionEditor;

export class SellerPublisher {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.profileDir = path.join(dataDir, 'seller-profile');
    this.sourceProfileDir = path.join(dataDir, 'source-profile');
    this.imageDir = path.join(dataDir, 'publish-images');
    this.videoDir = path.join(dataDir, 'publish-videos');
    this.context = null;
    this.sourceContext = null;
    this.page = null;
    this.visible = false;
    this.publishingVisible = false;
    this.backgroundPublishing = false;
    this.publishStops = new Map();
    this.imageDownloads = new ImageDownloadQueue(browserResourcePolicy().imageConcurrency);
    this.mainImageExpectedCounts = new WeakMap();
  }

  async sourceBrowser() {
    // Source/detail collection always uses the dedicated headless context.
    // Reusing the headed seller context here makes a plain Alibaba login
    // redirect look like a human-verification page and leaves refresh-detail
    // requests waiting for the full verification timeout. The latest Electron
    // session cookies are imported into this context instead.
    if (!this.sourceContext) {
      this.sourceContext = await launchPersistent(this.sourceProfileDir, {
        // Normal detail collection must not create a taskbar window. A real
        // headed context is created only by completeSourceVerification when a
        // human challenge actually needs to be shown.
        headless: true,
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      const openedContext = this.sourceContext;
      openedContext.on('close', () => { if (this.sourceContext === openedContext) this.sourceContext = null; });
    }
    await globalThis.__KUA_YIPU_SELLER_BRIDGE?.sync?.().catch(() => false);
    await syncAlibabaCookies(this.sourceContext);
    return this.sourceContext;
  }

  async completeSourceVerification(url) {
    assertCollectionActive();
    const previous = this.sourceContext;
    this.sourceContext = null;
    await previous?.close().catch(() => {});
    const context = await launchPersistent(this.sourceProfileDir, {
      headless: false,
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    this.sourceContext = context;
    context.on('close', () => { if (this.sourceContext === context) this.sourceContext = null; });
    const page = trackCollectionPage(await context.newPage());
    try {
      await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Keep the headed fallback off-screen unless a real challenge is
      // visible. Reuse this verified browser if a cross-engine handoff failed.
      if (await hasExplicitHumanChallenge(page)) {
        await revealPage(page);
        await waitForHumanVerification(page);
      }
      await hidePage(page);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async open(options = {}) {
    if (options.reveal && globalThis.__KUA_YIPU_SELLER_BRIDGE?.open) {
      return globalThis.__KUA_YIPU_SELLER_BRIDGE.open();
    }
    const progress = options.onProgress || (() => {});
    const step = (label, action, timeoutMs = 15000, onLateResolve) => {
      progress(label);
      return browserStep(action, { label, timeoutMs, signal: options.signal, onLateResolve });
    };
    const resources = browserResourcePolicy();
    await step('同步卖家登录状态', () => globalThis.__KUA_YIPU_SELLER_BRIDGE?.sync?.(), 10000).catch((error) => {
      if (error.code === 'PUBLISH_PAUSED') throw error;
      progress('卖家窗口同步暂不可用，使用已保存会话连接');
    });
    if (((options.showPublishing || options.reveal) && !this.publishingVisible)
      || (options.backgroundPublishing && (!this.backgroundPublishing || this.publishingVisible))) {
      const previous = this.context;
      this.context = null;
      this.page = null;
      await step(options.backgroundPublishing ? '准备后台发布会话' : '打开发布检查窗口', () => previous?.close());
      this.publishingVisible = !options.backgroundPublishing;
      this.backgroundPublishing = Boolean(options.backgroundPublishing);
    }
    if (!this.context) {
      const opened = await step('启动内置发布浏览器', () => launchPersistent(this.profileDir, {
        headless: !this.publishingVisible, visible: this.publishingVisible,
        backgroundPublishing: this.backgroundPublishing, timeout: resources.navigationTimeoutMs
      }), resources.navigationTimeoutMs + 5000, (context) => context?.close());
      this.context = opened;
      opened.on('close', () => { if (this.context === opened) { this.context = null; this.page = null; } });
    }
    await step('导入已保存的卖家会话', () => syncAlibabaCookies(this.context));
    const pages = this.context.pages();
    this.page = pages.find((item) => !item.isClosed() && isAlibabaInternationalUrl(item.url())) || pages.find((item) => !item.isClosed())
      || await step('创建商品发布页面', () => this.context.newPage(), 15000, (page) => page?.close());
    if (!options.skipNavigation && (this.page.url() === 'about:blank' || !isAlibabaInternationalUrl(this.page.url()))) {
      await step('打开国际站卖家页面', () => gotoWithRetry(this.page, options.startUrl || WORKBENCH_URL,
        { timeout: resources.navigationTimeoutMs, attempts: 1 }), resources.navigationTimeoutMs + 1000);
    }
    if (options.reveal || this.publishingVisible) {
      const shown = await step('显示并最大化发布浏览器', () => revealPage(this.page));
      if (this.publishingVisible && !shown) throw Object.assign(new Error('未能显示发布浏览器，已保留当前商品和任务进度'), { code: 'PUBLISH_BROWSER_NOT_READY' });
      this.visible = true;
    }
    else { await step('准备发布页面', () => hidePage(this.page)); this.visible = false; }
    return this.status();
  }

  status() {
    if (globalThis.__KUA_YIPU_SELLER_BRIDGE?.status) {
      return globalThis.__KUA_YIPU_SELLER_BRIDGE.status();
    }
    return {
      browserOpen: Boolean(this.context),
      visible: this.visible,
      currentUrl: this.page?.url() || '',
      onAlibabaInternational: Boolean(isAlibabaInternationalUrl(this.page?.url() || ''))
    };
  }

  async shutdown() {
    this.publishPageSnapshot = null;
    this.publishingPage = null;
    const contexts = [...new Set([this.context, this.sourceContext].filter(Boolean))];
    this.context = null;
    this.sourceContext = null;
    this.page = null;
    this.visible = false;
    this.publishingVisible = false;
    this.backgroundPublishing = false;
    await Promise.allSettled(contexts.map((context) => context.close()));
  }

  requestPublishStop(jobId) {
    const stop = this.publishStops.get(String(jobId || ''));
    if (!stop) return false;
    stop();
    return true;
  }

  clearPublishStop(jobId) {
    const key = String(jobId || '');
    this.publishStops.get(key)?.dispose?.();
    this.publishStops.delete(key);
  }

  async capturePublishPage(jobId, productId) {
    this.publishPageSnapshot = null;
    const current = this.publishingPage;
    if (!current || current.jobId !== String(jobId) || current.productId !== String(productId)
      || current.page !== this.page || current.page.isClosed()) return false;
    try {
      const image = await current.page.screenshot({ type: 'jpeg', quality: 75, timeout: 3000,
        mask: [current.page.locator('input[type="password"]')] });
      if (this.publishingPage !== current || current.page !== this.page || current.page.isClosed()) return false;
      this.publishPageSnapshot = { jobId: current.jobId, productId: current.productId,
        capturedAt: new Date().toISOString(), image: `data:image/jpeg;base64,${image.toString('base64')}` };
      return true;
    } catch { return false; }
  }

  readPublishPageSnapshot(jobId, productId) {
    const snapshot = this.publishPageSnapshot;
    return snapshot?.jobId === String(jobId) && snapshot.productId === String(productId) ? snapshot : null;
  }

  async hide() {
    if (this.page) await hidePage(this.page);
    this.visible = false;
  }

  async retryPublishedVideo(video) {
    const page = await this.currentSellerPage('', { backgroundPublishing: true });
    const items = Array.isArray(video.items) ? video.items : [video];
    if (!items.length || items.some(item => item.productId !== video.productId)) throw new Error('视频关联商品编号不一致');
    const completed = [];
    for (const item of items) completed.push(item.associated ? item
      : await completePublishedVideo(page, item, `https://post.alibaba.com/product/success.htm?primaryId=${video.productId}`));
    const result = combineVideoAssociations(completed);
    if (!result.associated) throw Object.assign(new Error(result.warning), { code: 'PUBLISH_VIDEO_BANK_PENDING', videoAssociation: result });
    return result;
  }

  async currentSellerPage(startUrl = '', options = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.open({ ...options, ...(startUrl ? { startUrl } : {}) });
        const pages = this.context.pages();
        const current = [...pages].reverse().find((item) => !item.isClosed() && isAlibabaInternationalUrl(item.url()));
        if (current && current !== this.page) {
          this.page = current;
          if (this.publishingVisible) await browserStep(() => revealPage(current), { signal: options.signal, label: '显示发布页面' });
        }
        return this.page;
      } catch (error) {
        const message = String(error?.message || '');
        const closed = /browser.*退出|browser has been closed|target page, context or browser has been closed|Failed to open a new tab|采集浏览器已关闭/i.test(message);
        if (!closed || attempt > 0) {
          if (error.code === 'PUBLISH_PAUSED') throw error;
          const unavailable = this.context;
          this.context = null;
          this.page = null;
          await browserStep(() => unavailable?.close(), { timeoutMs: 5000 }).catch(() => {});
          if (error.code === 'PUBLISH_BROWSER_NOT_READY') throw error;
          throw Object.assign(new Error(`连接国际站发布浏览器未完成：${userFacingError(error)}；已保留当前商品，请稍后继续`), { code: 'PUBLISH_BROWSER_NOT_READY' });
        }
        await browserStep(() => this.context?.close(), { timeoutMs: 5000, signal: options.signal }).catch(() => {});
        this.context = null;
        this.page = null;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error('卖家浏览器启动失败，请重试');
  }

  async createProductPage(startUrl, options = {}) {
    await this.currentSellerPage(startUrl, { ...options, skipNavigation: true, backgroundPublishing: true });
    const previous = this.publishingPage?.page;
    // Keep cookies and the browser, but not the previous document's timers,
    // pending draft redirects or form model. Never reuse a user-opened tab.
    const page = await browserStep(() => this.context.newPage(), {
      label: '创建独立商品发布页', timeoutMs: 15000, signal: options.signal,
      onLateResolve: latePage => latePage?.close(),
    });
    this.page = page;
    if (previous && previous !== page && !previous.isClosed()) {
      await browserStep(() => previous.close(), { label: '清理上一件商品页面', timeoutMs: 5000 }).catch(() => {});
    }
    return page;
  }

  async findPostingFormPage(options = {}) {
    await this.open(options);
    const candidates = [...this.context.pages()].reverse().filter((page) => isProductPostingUrl(page.url()));
    for (const page of candidates) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      if (await findPostingTitle(page)) {
        this.page = page;
        return page;
      }
    }
    if (candidates[0]) this.page = candidates[0];
    return this.page;
  }

  async captureCurrentReference() {
    if (globalThis.__KUA_YIPU_SELLER_BRIDGE?.captureReference) return globalThis.__KUA_YIPU_SELLER_BRIDGE.captureReference();
    const page = await this.findPostingFormPage({ reveal: true });
    if (!page || !isProductPostingUrl(page.url()) || !isAlibabaInternationalUrl(page.url())) throw new Error('请先在卖家窗口打开已有商品的编辑表单');
    const url = new URL(page.url());
    const productId = url.searchParams.get('productId') || url.searchParams.get('itemId') || '';
    const categoryId = categoryIdFromUrl(page.url()) || await page.locator('input[name="catId"], input[name="categoryId"]').first().inputValue().catch(() => '');
    const titleField = await findPostingTitle(page);
    const title = titleField ? await titleField.inputValue() : '';
    return readSellerReference(page, { productId, categoryId, title });
  }

  async bindCurrentPage() {
    if (globalThis.__KUA_YIPU_SELLER_BRIDGE?.bind) {
      return globalThis.__KUA_YIPU_SELLER_BRIDGE.bind();
    }
    let page;
    try {
      page = await this.findPostingFormPage({ reveal: true });
      const url = page.url();
      if (!isAlibabaInternationalUrl(url) || /login|passport/i.test(url)) {
        throw new Error('请先登录 My Alibaba，再进入国际站商品发布页面');
      }
      if (!isProductPostingUrl(url)) {
        throw new Error('当前不是国际站商品发布页，请进入 Products → Post Products，选好类目并打开发布表单');
      }
      await settlePage(page);
      const titleField = await findPostingTitle(page);
      if (/\/product\/(?:easyListing|category)\.htm/i.test(new URL(url).pathname) && !titleField) {
        throw new Error('当前仍是商品类目选择页。请先选择完整类目并点击“我已阅读如上规则，现在发布产品”，进入商品填写表单后再绑定');
      }
      if (!titleField) {
        throw new Error('当前页面不是商品填写表单，尚未找到商品标题输入框');
      }
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const category = bodyText.match(/当前类目：\s*([^\n]+)/)?.[1]?.trim() || '';
      return { url, title: await page.title(), category, categoryId: categoryIdFromUrl(url) };
    } finally {
      // Binding is complete (or rejected); never leave the seller browser
      // visible while the workbench is idle.
      await hidePage(page || this.page).catch(() => {});
      this.visible = false;
    }
  }

  async inspectPublishPage(publishPageUrl, query = '', detailMode = '') {
    if (!isProductPostingUrl(publishPageUrl)) throw new Error('尚未绑定有效的国际站商品发布页');
    const page = await this.currentSellerPage(publishPageUrl);
    if (page.url() !== publishPageUrl) await gotoWithRetry(page, publishPageUrl, { timeout: 60000 });
    await settlePage(page);
    if (detailMode === 'old') {
      const oldMode = page.getByRole('button', { name: '返回老版', exact: true }).first();
      if (await oldMode.isVisible().catch(() => false)) {
        await oldMode.click({ force: true });
        await page.waitForTimeout(400);
        const confirmOldMode = page.getByRole('button', { name: '继续返回旧版', exact: true }).first();
        if (await confirmOldMode.isVisible().catch(() => false)) await confirmOldMode.click({ force: true });
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
    assertCollectionActive();
    // Source collection must not depend on the seller workbench being
    // reachable. The source profile can read public product pages directly;
    // opening i.alibaba here made a fresh server fail before collection even
    // started when the seller session was logged out or the workbench was
    // temporarily unavailable.
    const context = await this.sourceBrowser();
    const page = trackCollectionPage(await context.newPage());
    const enriched = [];
    try {
      await hidePage(page);
      await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
      for (let index = 0; index < products.length; index += 1) {
        if (typeof options.shouldStop === 'function' && options.shouldStop()) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        let enrichedProduct;
        try {
          enrichedProduct = await withSourceLocale(context, async () => {
            for (let attempt = 0; ; attempt++) {
              if (options.shouldStop?.()) throw Object.assign(new Error('采集已暂停，已保留进度'), { code: 'COLLECT_PAUSED' });
              try { return await this.readSourceProduct(page, products[index], 0, options); }
              catch (error) {
                // Public pages can navigate while lazy attributes are read.
                // Retry the complete source read once, before any persistence;
                // do not convert CAPTCHA, missing data or closed pages to data.
                if (attempt || error.code || page.isClosed()
                  || !/Execution context was destroyed|Cannot find context with specified id/i.test(error.message || '')) throw error;
              }
            }
          }, options);
        } catch (error) {
          assertCollectionActive();
          if (error?.code === 'HUMAN_VERIFICATION_REQUIRED') {
            if (Number(options.verificationRecoveries || 0) >= 2) throw Object.assign(new Error('验证后页面仍未恢复，任务已暂停并保留断点，请稍后继续'), { code: 'COLLECT_PAUSED' });
            await this.completeSourceVerification(error.verificationUrl || products[index].sourceUrl);
            return this.enrichSourceProducts(products.slice(index), onProgress, { ...options, verificationRecoveries: Number(options.verificationRecoveries || 0) + 1 })
              .then((remaining) => [...enriched, ...remaining]);
          }
          if (error?.code === 'COLLECT_PAUSED') throw error;
          if (error?.code === 'SOURCE_PRODUCT_UNAVAILABLE' && error.canSkipProduct === true && typeof options.onSkipped === 'function') {
            if (options.shouldStop?.()) throw Object.assign(new Error('COLLECT_PAUSED'), { code: 'COLLECT_PAUSED' });
            const keepGoing = options.onSkipped(products[index], error);
            if (keepGoing === false || options.shouldStop?.()) throw Object.assign(new Error('COLLECT_PAUSED'), { code: 'COLLECT_PAUSED' });
            if (index + 1 < products.length && Number(options.delaySeconds || 0) > 0) await page.waitForTimeout(Number(options.delaySeconds) * 1000);
            continue;
          }
          // Do not turn a CAPTCHA, empty shell, or parser failure into a
          // seemingly successful product that contains only a title/thumb.
          // The job must stop so the user can fix authentication and retry.
          throw Object.assign(new Error(`第 ${index + 1} 件商品详情读取失败：${String(error?.message || '未获得有效详情数据')}`, { cause: error }), { code: error?.code });
        }
        if (options.prepareDetailProduct) enrichedProduct = await options.prepareDetailProduct(enrichedProduct);
        assertCollectionActive();
        enriched.push(enrichedProduct);
        const keepGoing = onProgress(index + 1, products.length, enrichedProduct);
        if (keepGoing === false) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        if (index + 1 < products.length && Number(options.delaySeconds || 0) > 0) await page.waitForTimeout(Number(options.delaySeconds) * 1000);
      }
      return enriched;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async readSourceProduct(page, base, retry = 0, options = {}) {
    page.setDefaultTimeout(5000);
    await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
    const response = !retry ? await page.goto(base.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }) : null;
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
    await waitForHumanVerification(page);
    if (!/login|passport/i.test(page.url())) {
      requireAlibabaSourceProduct(page.url(), base.sourceId, await page.evaluate(readAlibabaAvailabilityText), { status: response?.status() ?? 200 });
    }
    await page.waitForTimeout(250);
    // Product attributes and the rich description are lazy-rendered on many
    // Alibaba templates. Trigger the section and allow the DOM a short,
    // bounded window to populate before extracting it. This replaces the old
    // unconditional iframe wait that added 8 seconds even when no iframe
    // existed.
    for (const selector of [SOURCE_DESCRIPTION_SELECTOR,
      '[data-testid="module-attribute-row"], [data-module-name*="attribute" i], [data-module-name*="specification" i], table',
      '[data-module-name="module_product_specification"] iframe, iframe[src*="descIframe"]']) {
      const section = page.locator(selector).first();
      if (await section.count()) await section.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    }
    await page.waitForTimeout(450);
    if (/login|passport/i.test(page.url())) {
      throw Object.assign(new Error('阿里巴巴要求登录，请登录后继续采集，当前商品尚未完成'), { code: 'SOURCE_LOGIN_REQUIRED' });
    }
    const detailIframe = page.locator('iframe[src*="descIframe"]');
    if (await detailIframe.count().catch(() => 0)) {
      await detailIframe.first().waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(350);
    await waitForHumanVerification(page);
    const sourceAttributes = await collectSourceAttributeSections(page, {
      verify: () => waitForHumanVerification(page), shouldStop: options.shouldStop,
    });
    requireAlibabaSourceProduct(page.url(), base.sourceId, await page.evaluate(readAlibabaAvailabilityText));
    const detailDataScript = await page.evaluate(() => [...document.scripts]
      .map((script) => script.textContent || '')
      .find((text) => /(?:window\.)?detailData\s*=\s*\{/.test(text)) || '').catch(() => '');
    const detailData = parseAlibabaDetailDataScript(detailDataScript);
    const structuredSource = extractAlibabaSourceData(detailData);
    const structuredDescription = extractAlibabaDescription(detailData);
    const frameSelector = ['iframe[src*="descIframe"]', ...SOURCE_DESCRIPTION_SELECTOR.split(',').map((selector) => `${selector.trim()} iframe`), '[data-module-name="module_product_specification"] iframe'].join(', ');
    const inlineDetail = await page.locator(SOURCE_DESCRIPTION_SELECTOR).evaluateAll(nodes => nodes.some(node => {
      const content = node.cloneNode(true);
      content.querySelectorAll('[data-module-name="module_risk_control_tips"], [data-module-name="module_shopping_ads"], [data-module-name="module_shop_marking"], [data-module-name="module_report"], [data-module-name*="recommend"], script, style')
        .forEach(child => child.remove());
      return content.querySelector('img') || (content.textContent || '').trim().length > 120;
    })).catch(() => false);
    const legacyDetailPlaceholder = await page.locator('[data-module-name="module_product_specification"]').count() > 0;
    const iframeDetail = await readSourceDescriptionFrame(page, {
      selector: frameSelector,
      timeoutMs: browserResourcePolicy().sourceFrameTimeoutMs,
      waitForFrame: !inlineDetail && !structuredDescription.html
        && (legacyDetailPlaceholder || /ssr/i.test(detailData?.nodeMap?.module_description?.renderType || '')),
      verify: () => waitForHumanVerification(page)
    });
    const collectedAttributes = mergeSourceAttributes(extractAlibabaAttributes(detailData), sourceAttributes.attributes,
      await page.evaluate(readAlibabaAttributeRows), iframeDetail?.attributes || []);
    const categoryDocument = await page.evaluate(readAlibabaCategoryDocument);
    const detailVideoCapture = await waitForSourceDetailVideos(page, { shouldStop: options.shouldStop });
    const detail = await page.evaluate(({ descriptionSelector, categoryDocument, collectedAttributes }) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const absolute = (value) => {
        if (!String(value || '').trim()) return '';
        try { return new URL(String(value || '').startsWith('//') ? `https:${value}` : value, location.href).href; }
        catch { return ''; }
      };
      const unique = (values) => [...new Set(values.map(absolute).filter(Boolean))];
      const textOf = (node) => clean(node?.textContent || '');
      const bodyText = document.body?.innerText || '';
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
      let mainImages = unique([
        ...jsonObjects.filter((item) => item['@type'] === 'ImageObject').map((item) => item.contentUrl),
        ...[...document.querySelectorAll('img[src*="/kf/"]')]
          .filter((image) => /_960x960|_720x720/.test(image.currentSrc || image.src))
          .map((image) => image.currentSrc || image.src)
      ]).slice(0, 6);
      // Modern Alibaba product pages may render the supplier's structured
      // description as sibling modules (highlights, company info, FAQ, etc.)
      // rather than one `module_description` container. Capture every native
      // section in page order; cloning only the first one silently drops the
      // company gallery and FAQ, then publishing flattens the remaining text.
      const nativeDescriptionSections = [...document.querySelectorAll('[data-module-name^="module_structure_descption_"]')];
      const descriptionNodes = nativeDescriptionSections.length
        ? nativeDescriptionSections
        : [document.querySelector(descriptionSelector)].filter(Boolean);
      const descriptionModule = descriptionNodes.length ? document.createElement('div') : null;
      for (const node of descriptionNodes) descriptionModule.append(node.cloneNode(true));
      descriptionModule?.querySelectorAll('script, style, link, noscript, svg, button, [data-module-name="module_report"], [data-module-name*="recommend"], [data-module-name="module_risk_control_tips"], [data-module-name="module_shopping_ads"], [data-module-name="module_shop_marking"]')
        .forEach((node) => node.remove());
      descriptionModule?.querySelectorAll('img').forEach((image) => {
        const url = absolute(image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src'));
        if (url) image.setAttribute('src', url);
      });
      // Alibaba changes gallery markup frequently. When the size suffix or
      // JSON-LD gallery is absent, use loaded product images outside the rich
      // text module as a conservative fallback instead of returning zero
      // source images.
      if (mainImages.length < 4) {
        const galleryImages = [...document.querySelectorAll('img')]
          .map((image) => ({
            url: image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-original') || '',
            width: image.naturalWidth || Number(image.getAttribute('width') || 0),
            insideDescription: Boolean(image.closest(descriptionSelector))
          }))
          .filter((item) => item.url && /\/kf\//i.test(item.url) && !item.insideDescription && item.width >= 120)
          .map((item) => item.url);
        mainImages = [...new Set([...mainImages, ...unique(galleryImages)])].slice(0, 6);
      }
      const sourceDetailImages = unique([...(descriptionModule?.querySelectorAll('img') || [])]
        .map((image) => image.src).filter((url) => /\/(?:kf|ibank|img)\/|\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(url)));
      // Do not silently turn main images into detail images. A product with
      // no real detail-image module must remain incomplete so the publisher
      // can stop and ask for review instead of inventing source data.
      const detailImages = sourceDetailImages;
      const attributes = collectedAttributes;
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
      const sourceField = (...names) => {
        const matches = attributes.filter((item) => names.includes(item.name.toLowerCase()));
        return (matches.find((item) => !/^description-/.test(item.source || '')) || matches[0])?.value || '';
      };
      const video = jsonObjects.find((item) => item['@type'] === 'VideoObject');
      const videos = [...document.querySelectorAll('video')].flatMap((node) => {
        if (node.closest('[data-module-name*="recommend" i], [data-module-name*="related" i], [class*="recommend" i]')) return [];
        const url = [node.currentSrc, node.getAttribute('src'), node.querySelector('source')?.getAttribute('src')]
          .filter(Boolean).map(absolute).find((url) => /^https?:\/\//i.test(url));
        if (!url) return [];
        const role = node.closest(`${descriptionSelector}, [data-module-name="module_detail_video"]`) ? 'detail'
          : node.closest('[data-module-name*="gallery" i], [data-testid*="gallery" i], [class*="product-gallery" i], [data-testid="main-image-media-frame"]') ? 'main' : 'unclassified';
        return [{ role, url, poster: absolute(node.getAttribute('poster')), source: 'dom' }];
      });
      const jsonVideoUrl = absolute(video?.contentUrl || '');
      if (/^https?:\/\//i.test(jsonVideoUrl) && !videos.some((item) => item.url === jsonVideoUrl)) {
        videos.push({ role: 'main', url: jsonVideoUrl, source: 'json-ld' });
      }
      const productJson = jsonObjects.find((item) => item['@type'] === 'Product');
      const priceText = clean([
        document.querySelector('[data-module-name="module_price"]')?.textContent,
        document.querySelector('[data-testid*="price"]')?.textContent,
        productJson?.offers?.price,
        bodyText.match(/(?:¥|￥|\$)\s*[\d,.]+\s*(?:\d+\s*[-–]\s*\d+|≥\s*[\d,]+)?/g)?.join(' ')
      ].filter(Boolean).join(' '));
      const categoryPath = categoryDocument.path;
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
        : [certificateAttribute?.value || ''].flat().flatMap((value) => String(value).split(/[,，、;/]+/)).map((name) => clean(name)).filter(Boolean).map((name) => ({ name, number: '', verified: null, source: 'attribute' }));
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
        packaging: {},
        origin: sourceField('产地', '原产地', 'place of origin', 'country/region of manufacture'),
        model: sourceField('型号', 'model number'),
        brand: sourceField('品牌名称', '品牌', 'brand name', 'brand'),
        productType: categoryPath.at(-1) || '', categoryPath, categoryId: categoryDocument.id, priceText, subtitle, keywords,
        salesUnit, paymentMethod, shippingText, services: { sourceTexts: sourceServices, customizations }, certificates,
        descriptionHtml,
        description: highlights.join('\n') || clean(descriptionModule?.textContent).slice(0, 12000),
        videoUrl: (videos.find((item) => item.role === 'main' && item.source === 'json-ld') || videos.find((item) => item.role === 'main'))?.url || '', videos,
        dataCompleteness: {
          mainImages: mainImages.length, detailImages: detailImages.length,
          sourceDetailImages: sourceDetailImages.length, detailImagesDerived: !sourceDetailImages.length,
          attributes: attributes.length, variantGroups: variantGroups.length,
          priceText: Boolean(priceText), descriptionHtml: Boolean(descriptionHtml), shipping: Boolean(shippingText), services: sourceServices.length,
          certificates: certificates.length, customizations: customizations.length
        },
        documentLanguage: document.documentElement?.lang || '',
        metaLanguage: document.querySelector('meta[http-equiv="content-language"], meta[name="language"]')?.content || '',
        renderTextSample: clean(bodyText).slice(0, 3000)
      };
    }, { descriptionSelector: SOURCE_DESCRIPTION_SELECTOR, categoryDocument, collectedAttributes });
    requireAlibabaSourceProduct(page.url(), base.sourceId);
    detail.packaging = packagingFromAttributes(collectedAttributes);
    detail.videos = [...new Map([...detail.videos, ...(structuredDescription.videos || []), ...(iframeDetail?.videos || [])]
      .map((item) => [`${item.role}:${item.url}`, item])).values()];
    Object.assign(detail, resolveCollectedVideos(detail.videos));
    detail.origin = productOrigin({ attributes: collectedAttributes }) || productOriginText({ attributes: collectedAttributes });
    // Alibaba defers attributes/description until the corresponding section
    // enters the viewport. If the first snapshot contains only the gallery,
    // trigger lazy modules and retry once before persisting an incomplete
    // product. This keeps transient rendering races from becoming permanent
    // "资料阻断" records while avoiding an unbounded slowdown.
    const needsLazyRetry = retry < 1 && detail.mainImages.length > 0
      && detail.attributes.length === 0 && detail.detailImages.length === 0
      && !detail.descriptionHtml && !detail.description;
    if (needsLazyRetry) {
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })).catch(() => {});
      await page.waitForTimeout(1400);
      return this.readSourceProduct(page, base, retry + 1, options);
    }
    const domDescriptionStructure = extractDescriptionStructure(detail.descriptionHtml);
    if (structuredDescription.html && (!detail.descriptionHtml || (!detail.detailImages.length && !domDescriptionStructure))) {
      detail.descriptionHtml = structuredDescription.html.slice(0, 90000);
      detail.description = structuredDescription.text.slice(0, 12000);
      detail.detailImages = structuredDescription.images;
      Object.assign(detail.dataCompleteness, {
        detailImages: detail.detailImages.length, sourceDetailImages: detail.detailImages.length,
        detailImagesDerived: false, descriptionHtml: true, descriptionSource: 'detailData.module_description'
      });
    }
    if (iframeDetail?.html && iframeDetail.html.length > 80) {
      detail.descriptionHtml = iframeDetail.html.slice(0, 90000);
      detail.description = iframeDetail.text.slice(0, 12000);
      const iframeImages = iframeDetail.images.map((image) => image.src).filter(Boolean);
      detail.detailImages = [...new Set([...detail.detailImages, ...iframeImages])];
      detail.dataCompleteness.detailImages = detail.detailImages.length;
      detail.dataCompleteness.sourceDetailImages = detail.detailImages.length;
      detail.dataCompleteness.detailImagesDerived = false;
      detail.dataCompleteness.descriptionHtml = true;
      detail.dataCompleteness.descriptionSource = 'description-iframe';
    } else if (!detail.description || /^(?:视频描述|video description)$/i.test(detail.description)) {
      detail.description = '';
    }
    // A listing thumbnail alone is not a successful detail read. Requiring at
    // least one real detail module prevents CAPTCHA/empty shells from being
    // persisted as products with attributes, SKUs and descriptions all set to
    // zero.
    const hasUsableDetail = detail.detailImages.length > 0
      || detail.attributes.length >= 2
      || detail.variantGroups.length > 0
      || Boolean(detail.descriptionHtml || detail.description || detail.priceText || structuredSource);
    if (!hasUsableDetail) {
      throw new Error(`商品详情读取不完整：${base.title}（主图 ${detail.mainImages.length}，属性 ${detail.attributes.length}）`);
    }
    const sourcePriceTiers = structuredSource
      ? structuredSource.sourcePriceTiers
      : parsePriceTiers(detail.priceText);
    const priceTiers = normalizePriceTiers(sourcePriceTiers, base.price, base.currencySymbol || '$');
    const variantGroups = structuredSource?.variantGroups?.length ? structuredSource.variantGroups : detail.variantGroups;
    const skus = structuredSource?.skus?.length
      ? structuredSource.skus
      : buildSkuCombinations(variantGroups, base.price, base.stock || 100);
    const sourcePriceRange = structuredSource?.sourcePriceRange || null;
    const stock = structuredSource
      ? (structuredSource.sourceTradeAvailability?.exactSkuStockPublished
          ? skus.reduce((total, sku) => total + Number(sku.stock || 0), 0)
          : null)
      : base.stock;
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
      sourceAttributeSchemaVersion: SOURCE_ATTRIBUTE_SCHEMA_VERSION,
      sourceAttributeCapture: sourceAttributes.evidence,
      variantGroups,
      skus,
      price: structuredSource?.price ?? base.price,
      sourcePrice: structuredSource?.price ?? base.sourcePrice ?? base.price,
      maxPrice: structuredSource?.maxPrice ?? base.maxPrice ?? null,
      stock,
      currencySymbol: structuredSource?.currencySymbol || base.currencySymbol || '$',
      sourcePriceText: structuredSource?.sourcePriceText || detail.priceText,
      sourcePriceRange,
      sourcePriceTiers,
      priceTiers,
      minOrder: sourcePriceTiers[0]?.minQuantity ?? base.minOrder ?? base.moq ?? null,
      priceMode: structuredSource?.priceMode || (priceTiers.length ? 'quantity-tier' : base.priceMode || ''),
      sourceTradeAvailability: structuredSource?.sourceTradeAvailability || null,
      sourceStructuredEvidence: structuredSource?.evidence || null,
      deliveryTime: detail.leadTime,
      packaging: detail.packaging,
      subtitle: detail.subtitle,
      keywords: detail.keywords,
      salesUnit: structuredSource?.salesUnit || detail.salesUnit,
      paymentMethod: detail.paymentMethod,
      shipping: detail.shippingText,
      services: detail.services,
      certificates: detail.certificates,
      descriptionHtml: detail.descriptionHtml,
      structuredDescription: extractDescriptionStructure(detail.descriptionHtml),
      origin: detail.origin,
      model: detail.model,
      brand: detail.brand,
      productType: detail.productType,
      sourceCategoryPath: detail.categoryPath,
      sourceCategoryId: structuredSource?.sourceCategoryId || detail.categoryId || base.sourceCategoryId || base.categoryId || '',
      categoryId: base.categoryId || structuredSource?.sourceCategoryId || detail.categoryId || base.sourceCategoryId || '',
      description: detail.description,
      videoUrl: detail.videoUrl,
      videos: detail.videos,
      dataCompleteness: {
        ...detail.dataCompleteness,
        detailVideoCapture,
        structuredDetailData: Boolean(structuredSource),
        structuredPriceRange: Boolean(sourcePriceRange),
        structuredVariantGroups: structuredSource?.variantGroups?.length || 0,
        structuredSkus: structuredSource?.skus?.length || 0,
        exactSkuPricesPublished: structuredSource?.sourceTradeAvailability?.exactSkuPricesPublished ?? null,
        exactSkuStockPublished: structuredSource?.sourceTradeAvailability?.exactSkuStockPublished ?? null
      },
      collectedDetailAt: new Date().toISOString()
      })
    };
  }

  async downloadImageSet(product, urls, prefix, limit = 6, { signal = imageDownloadContext.getStore()?.signal } = {}) {
    signal?.throwIfAborted();
    if (signal && !imageDownloadSignalIds.has(signal)) imageDownloadSignalIds.set(signal, crypto.randomUUID());
    fs.mkdirSync(this.imageDir, { recursive: true });
    const requiredDetails = ['detail', 'structured-detail'].includes(prefix);
    const candidates = distinctAlibabaImageUrls(urls);
    const selectedUrls = (requiredDetails ? candidates : candidates.filter(isUsableImageUrl)).slice(0, Math.max(limit, 24));
    const failures = [];
    const downloadOne = async (url, index) => {
      let stage = 'input', attempts = 0;
      try {
        signal?.throwIfAborted();
        if (!isUsableImageUrl(url)) throw new Error('图片地址无效或不受支持');
        const safeId = String(product.sourceId || product.id || 'product').replace(/[^A-Za-z0-9]/g, '').slice(-16);
        const safePrefix = `${String(prefix || 'image').replace(/[^A-Za-z0-9]/g, '')}${prefix === 'detail' ? '-tall2' : ''}-white1-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
        const cached = ['jpg', 'png'].map((extension) => path.join(this.imageDir, `${safeId}${safePrefix}${index}.${extension}`))
          .find((candidate) => {
            try { return fs.statSync(candidate).size > 1024; } catch { return false; }
          });
        if (cached) {
          try {
            const metadata = await sharp(cached, { limitInputPixels: 40000000 }).metadata();
            signal?.throwIfAborted();
            if (['jpeg', 'png'].includes(metadata.format) && fs.statSync(cached).size <= 5 * 1024 * 1024) return { path: cached };
          } catch { signal?.throwIfAborted(); /* Re-download incomplete files left by an interrupted run. */ }
        }
        let contentType = '';
        let buffer;
        if (/^data:image\//i.test(url)) {
          const match = String(url).match(/^data:(image\/[^;]+);base64,(.+)$/i);
          if (!match) throw new Error('内嵌图片数据格式无效');
          contentType = match[1];
          buffer = Buffer.from(match[2], 'base64');
        } else if (/^\/media\//i.test(url)) {
          stage = 'local-file';
          const localPath = path.join(this.dataDir, 'media', path.basename(url));
          if (!fs.existsSync(localPath)) throw Object.assign(new Error('本地图片文件不存在，请恢复原图或重新上传'), { code: 'ENOENT' });
          contentType = `image/${path.extname(localPath).slice(1).toLowerCase() === 'png' ? 'png' : 'jpeg'}`;
          buffer = fs.readFileSync(localPath);
        } else {
          stage = 'transport';
          // Each queued image needs its own bounded transport attempts. A set
          // deadline starting at the first image can expire before later files
          // receive a single request, even while earlier downloads succeed.
          let lastError;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              signal?.throwIfAborted();
              attempts += 1;
              const response = await fetch(url, {
                headers: {
                  accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                  referer: product.sourceUrl,
                  'user-agent': 'Mozilla/5.0'
                },
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)
              });
              if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), {
                status: response.status,
                retryable: response.status >= 500 || [408, 429].includes(response.status)
              });
              contentType = response.headers.get('content-type') || '';
              buffer = Buffer.from(await response.arrayBuffer());
              break;
            } catch (error) {
              signal?.throwIfAborted();
              lastError = error;
              if (error.retryable === false) break;
              if (attempt < 2) await waitForImageRetry([500, 1500][attempt], undefined, { signal });
            }
          }
          if (!buffer) throw lastError || new Error('图片下载失败');
        }
        stage = 'image-data';
        if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new Error('图片为空或超过 25 MB 下载限制');
        // CDN responses can be octet-stream; inspect the actual image instead
        // of silently discarding valid bytes based only on a response header.
        const metadata = await sharp(buffer, { animated: false, limitInputPixels: 40000000 }).metadata();
        let extension = metadata.format === 'png' ? 'png' : 'jpg';
        // The platform may convert even a small PNG to JPEG with a black alpha
        // background. Preserve its appearance on the white product page before
        // upload, leaving the source/media bytes untouched. Version the cache
        // above so older opaque conversions cannot bypass this preparation.
        if (metadata.hasAlpha) {
          buffer = await sharp(buffer, { animated: false, limitInputPixels: 40000000 })
            .rotate().flatten({ background: '#fff' }).png().toBuffer();
          extension = 'png';
        }
        if (!['jpeg', 'png'].includes(metadata.format) || buffer.length > 5 * 1024 * 1024) {
          let pipeline = sharp(buffer, { animated: false, limitInputPixels: 40000000 }).rotate();
          if (buffer.length > 5 * 1024 * 1024 && prefix !== 'structured-detail') pipeline = pipeline.resize({ width: prefix === 'detail' ? 960 : 2560, height: prefix === 'detail' ? 16000 : 2560, fit: 'inside', withoutEnlargement: true });
          buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
          extension = 'jpg';
        }
        if (buffer.length > 5 * 1024 * 1024 && prefix !== 'structured-detail') throw new Error('图片转换后仍超过 5 MB 上传限制');
        if (prefix === 'detail') {
          if ((metadata.width || 0) > 960 || (metadata.height || 0) > 960 || buffer.length > 3 * 1024 * 1024) {
            buffer = await sharp(buffer)
              .resize({ width: 960, height: 16000, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: buffer.length > 3 * 1024 * 1024 ? 82 : 90 })
              .toBuffer();
            extension = 'jpg';
          }
        }
        if (buffer.length > 5 * 1024 * 1024 && prefix !== 'structured-detail') throw new Error('图片转换后仍超过 5 MB 上传限制');
        const filePath = path.join(this.imageDir, `${safeId}${safePrefix}${index}.${extension}`);
        signal?.throwIfAborted();
        stage = 'cache-write';
        fs.writeFileSync(filePath, buffer);
        return { path: filePath };
      } catch (error) {
        signal?.throwIfAborted();
        const causeCode = error.cause?.code || error.code || error.name || '';
        return { path: '', failure: { index: index + 1, stage, attempts,
          status: error.status || null, code: causeCode, message: error.message,
          imageId: crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16) } };
      }
    };
    // AliCDN occasionally resets a burst of six parallel TLS connections.
    // Three workers retain good throughput while each file still gets its own
    // retry budget, avoiding false "only two images" failures.
    const paths = new Array(selectedUrls.length).fill('');
    let nextIndex = 0;
    while (nextIndex < selectedUrls.length && paths.filter(Boolean).length < limit) {
      // Try later source images when a selected URL fails, without downloading
      // an entire gallery or changing the order of successfully selected images.
      const end = Math.min(selectedUrls.length, nextIndex + limit - paths.filter(Boolean).length);
      const indices = Array.from({ length: end - nextIndex }, (_, offset) => nextIndex + offset);
      nextIndex = end;
      await Promise.all(indices.map(async (index) => {
        const key = JSON.stringify([product.sourceId || product.id, prefix, index, selectedUrls[index], signal ? imageDownloadSignalIds.get(signal) : '']);
        const result = await this.imageDownloads.run(key, () => downloadOne(selectedUrls[index], index), { signal });
        paths[index] = result.path;
        if (result.failure) failures.push(result.failure);
      }));
    }
    failures.sort((left, right) => left.index - right.index);
    const diagnostics = { reason: 'image-download', prefix, expected: Math.min(limit, selectedUrls.length),
      downloaded: paths.filter(Boolean).length, failures };
    const failureSummary = failures.slice(0, 3).map(item => `第 ${item.index} 张：${item.message}${item.code && !['Error', 'TypeError'].includes(item.code) ? `（${item.code}）` : ''}`).join('；');
    if (requiredDetails && paths.filter(Boolean).length < Math.min(limit, selectedUrls.length)) {
      throw Object.assign(new Error(`详情图片未全部下载成功（应有 ${diagnostics.expected} 张，成功 ${diagnostics.downloaded} 张）；${failureSummary || '来源图片无法读取'}。已停止提交，请处理失败图片后重试`),
        { code: 'DETAIL_IMAGE_DOWNLOAD_FAILED', diagnostics });
    }
    if (String(prefix).startsWith('spec-') && selectedUrls.length && paths.filter(Boolean).length < Math.min(limit, selectedUrls.length)) {
      throw Object.assign(new Error(`来源规格图片下载失败：${failureSummary || '图片为空、格式不支持或超过大小限制'}。当前商品未提交，可稍后重试`), { code: 'SPEC_IMAGE_DOWNLOAD_FAILED', diagnostics });
    }
    if (prefix === 'main' && selectedUrls.length >= 4 && paths.filter(Boolean).length < 4) {
      throw Object.assign(new Error(`主图下载失败：${selectedUrls.length} 张来源主图仅下载成功 ${paths.filter(Boolean).length} 张；${failureSummary || '来源图片无法读取'}。当前商品未提交，可稍后重试`), { code: 'MAIN_IMAGE_DOWNLOAD_FAILED', diagnostics });
    }
    return paths.filter(Boolean).slice(0, limit);
  }

  async uploadMainImages(page, product, onProgress = () => {}) {
    const urls = product.mainImages?.length ? product.mainImages : [product.mainImage, ...(product.images || [])];
    const downloaded = await this.downloadImageSet(product, urls, 'main', 6);
    if (downloaded.length < 4) throw new Error(`主图资料不足：仅下载到 ${downloaded.length} 张，至少需要 4 张`);
    this.mainImageExpectedCounts.set(page, downloaded.length);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) onProgress(`重新定位主图上传入口并补传（第 ${attempt} 次恢复）`);
      try {
        const result = await this.uploadMainImageBatch(page, downloaded);
        if (attempt && !await restoreMainImageOrder(page, downloaded.map((file) => path.basename(file)))) {
          throw new Error('主图补传成功，但图片顺序未能恢复，请重试当前商品');
        }
        return result;
      }
      catch (error) {
        if (['IMAGE_UPLOAD_TIMEOUT', 'MAIN_IMAGE_CONTROL_NOT_READY', 'MAIN_IMAGE_UPLOAD_PENDING'].includes(error.code) || isBrowserInteractionError(error)) {
          // A form rerender can hide/remove the portal after its input was
          // located. Resolve the current slot again; the next batch retains
          // accepted server records and waits for in-flight uploads.
          if (attempt === 2 || page.isClosed()) throw error.code === 'MAIN_IMAGE_UPLOAD_PENDING' ? error : mainImageControlPending(error);
          await requireClearPostingOverlays(page);
          await page.waitForTimeout(300 * (attempt + 1));
          continue;
        }
        if (error.code !== 'MAIN_IMAGE_UPLOAD_RETRYABLE' || attempt === 2) throw error;
        // Remove only confirmed failed files through the uploader's own
        // handler. Accepted files retain their server IDs and are not resent.
        const filenames = downloaded.map((file) => path.basename(file));
        let removed = false;
        for (let cleanup = 0; cleanup < filenames.length; cleanup++) {
          const records = await mainImageUploadRecords(page, filenames);
          if (!records.some((file) => file.removed)) break;
          removed = true;
          // Removing a file can remount the remaining slots. Read fresh
          // component records before removing another failed file.
          await page.waitForTimeout(150);
        }
        const remaining = await mainImageUploadRecords(page);
        if (!removed || remaining.some((file) => file.status === 'error' && filenames.includes(file.name))) throw error;
        await page.waitForTimeout(500 * (attempt + 1));
      }
    }
  }

  async reconcileMainImages(page, product, onProgress = () => {}) {
    const state = await mainImageFormState(page);
    const expected = this.mainImageExpectedCounts.get(page) || 4;
    // Four accepted images do not make a six-image upload complete. A late
    // error record also blocks Alibaba's validator even beside valid previews.
    if (state.occupied >= expected && !state.uploading && !state.failed) return;
    if (state.modelKnown && state.remotePreviews > state.occupied && !state.uploading && !state.failed) {
      if (!await clearMainImagesForRetry(page)) throw new Error('国际站主图预览与表单记录不一致，未能重新打开上传槽位；当前商品未提交');
    }
    await this.uploadMainImages(page, product, onProgress);
    const confirmed = await mainImageFormState(page);
    const required = this.mainImageExpectedCounts.get(page) || expected;
    if (confirmed.occupied < required || confirmed.uploading || confirmed.failed) throw new Error(`国际站主图提交前复核失败：应确认 ${required} 张，已确认 ${confirmed.occupied} 张；请重试该商品`);
  }

  async uploadMainImageBatch(page, downloaded) {
    await requireClearPostingOverlays(page);
    await revealMainImageControl(page, page.locator('.image-uploader:visible').first());
    const records = await mainImageUploadRecords(page);
    const pendingDeadline = Date.now() + 60000;
    let pending = records.some((file) => file.status === 'uploading');
    while (pending && Date.now() < pendingDeadline) {
      await page.waitForTimeout(400);
      pending = (await mainImageUploadRecords(page)).some((file) => file.status === 'uploading');
    }
    if (pending) throw Object.assign(new Error('国际站主图仍在上传，已保留已接收的图片和当前商品进度，请稍后继续'), { code: 'MAIN_IMAGE_UPLOAD_PENDING' });
    const currentRecords = await mainImageUploadRecords(page);
    const failure = mainImageUploadFailure(currentRecords);
    if (failure) throw failure;
    const confirmedNames = new Set(currentRecords.filter((file) => file.remote && file.status === 'done').map((file) => file.name));
    const placeholders = () => page.locator('.image-uploader .image-upload-list-item #image-placeholder-span:visible');
    const initialSlotCount = await placeholders().count().catch(() => 0);
    const initialState = await mainImageFormState(page);
    const initialOccupied = initialState.occupied;
    if (!initialSlotCount && initialOccupied >= 4) return 0;
    // A draft form may already contain one or more images. Upload every valid
    // empty slot up to Alibaba's six-image limit, while never treating occupied
    // slots as missing capacity or reporting a false required-image error.
    const desiredTotal = Math.min(6, downloaded.length);
    const uploadCount = Math.min(initialSlotCount, Math.max(0, desiredTotal - initialOccupied));
    const images = downloaded.filter((file) => !confirmedNames.has(path.basename(file))).slice(0, uploadCount);
    if (initialOccupied + images.length < 4) {
      const error = mainImageControlPending();
      error.diagnostics = { ...error.diagnostics, occupied: initialOccupied, empty: initialSlotCount };
      throw error;
    }
    const finishBatchUpload = async () => {
      const result = await this.waitForMainImageUploads(page, images.length, initialSlotCount);
      const finalState = await mainImageFormState(page);
      if (finalState.uploading || finalState.occupied < initialOccupied + images.length || finalState.occupied < 4) {
        throw Object.assign(new Error(`国际站主图尚未完成接收（已确认 ${finalState.occupied} 张），已保留当前商品进度，请稍后继续`), {
          code: 'MAIN_IMAGE_UPLOAD_PENDING', diagnostics: { section: 'main-images', occupied: finalState.occupied, uploading: finalState.uploading },
        });
      }
      return result;
    };
    if (!images.length) return finishBatchUpload();
    const assignFiles = async (input, files) => {
      const before = await mainImageFormState(page);
      await setImageUploadFiles(input, files, { hasStarted: async () => {
        const current = await mainImageFormState(page);
        return current.uploading > before.uploading || current.occupied > before.occupied;
      } });
    };
    const firstTrigger = placeholders().first();
    const firstSlot = firstTrigger.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " image-upload-list-item ")][1]');
    const firstInput = firstSlot.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (await firstInput.count().catch(() => 0) && await firstInput.getAttribute('multiple') !== null) {
      await assignFiles(firstInput, images);
      return finishBatchUpload();
    }
    // Alibaba renders several unrelated "本地上传" labels (the AI assistant,
    // image bank and the active slot menu) in the same document. Resolve the
    // menu item closest to the slot that was just opened instead of using a
    // page-wide text locator, which could click an unrelated overlay.
    const findUploadTarget = async (trigger, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const triggerBox = await trigger.boundingBox().catch(() => null);
        // The dedicated image portal can mount its file input before its
        // button label. Keep it scoped to the portal beside the active slot.
        const portals = page.locator('.sc-images-upload-dropdown:visible');
        const inputs = [];
        for (let index = 0; triggerBox && index < await portals.count(); index++) {
          const portal = portals.nth(index);
          const box = await portal.boundingBox().catch(() => null);
          if (!box || Math.abs(box.x - triggerBox.x) > 600 || Math.abs(box.y - triggerBox.y) > 600) continue;
          const input = portal.locator('input[type="file"]:not([accept]), input[type="file"][accept=""], input[type="file"][accept*="image" i], input[type="file"][accept*=".jpg" i], input[type="file"][accept*=".jpeg" i], input[type="file"][accept*=".png" i]').first();
          if (await input.count()) inputs.push({ input, distance: Math.hypot(box.x - triggerBox.x, box.y - triggerBox.y) });
        }
        inputs.sort((left, right) => left.distance - right.distance);
        if (inputs.length) return { input: inputs[0].input };
        const candidates = page.getByText('本地上传', { exact: true });
        const scored = [];
        for (let candidateIndex = 0; candidateIndex < await candidates.count().catch(() => 0); candidateIndex += 1) {
          const candidate = candidates.nth(candidateIndex);
          if (!await candidate.isVisible().catch(() => false)) continue;
          const box = await candidate.boundingBox().catch(() => null);
          const meta = await candidate.evaluate((node) => {
            const ancestor = node.closest('[role="menu"], [role="listbox"], [class*="menu"], [class*="popup"], [class*="overlay"], [class*="dropdown"]');
            return {
              context: String(ancestor?.className || ancestor?.getAttribute?.('role') || '').slice(0, 180),
              text: String(ancestor?.textContent || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220)
            };
          }).catch(() => ({ context: '', text: '' }));
          if (/__kua_yipu_entry_bar|(?:^|[-_])ai[-_]?assistant|business-assistant/i.test(meta.context)) continue;
          const distance = triggerBox && box
            ? Math.hypot((box.x + box.width / 2) - (triggerBox.x + triggerBox.width / 2), (box.y + box.height / 2) - (triggerBox.y + triggerBox.height / 2))
            : 100000;
          const popupBias = /menu|popup|overlay|dropdown|listbox/i.test(meta.context) ? -1000 : 0;
          if (distance > 650) continue;
          scored.push({ candidate, score: distance + popupBias });
        }
        scored.sort((left, right) => left.score - right.score);
        if (scored[0]) return { button: scored[0].candidate };
        await page.waitForTimeout(250);
      }
      return null;
    };
    for (const [index, image] of images.entries()) {
      const before = await placeholders().count().catch(() => 0);
      const trigger = placeholders().first();
      if (!before || !await trigger.isVisible().catch(() => false)) {
        throw mainImageControlPending();
      }
      const slot = trigger.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " image-upload-list-item ")][1]');
      let slotInput = slot.locator('input[type="file"][accept*="image" i], input[type="file"]');
      let assignedDirectly = false;
      if (await slotInput.count().catch(() => 0)) {
        await assignFiles(slotInput.last(), [image]);
        assignedDirectly = true;
      }
      if (!assignedDirectly) {
        // A page-wide file input may belong to SKU images or the editor.
        // Bind portal uploads to the chooser opened by this main-image slot.
        // Scrolling from logistics can remount the placeholder and discard the
        // first hover. Clicking it opens the image bank on some form builds.
        // Re-enter the settled slot instead of changing the upload operation.
        await revealMainImageControl(page, trigger);
        let target = null;
        for (let attempt = 0; !target && attempt < 3; attempt++) {
          await hoverMainImageControl(page, trigger);
          target = await findUploadTarget(trigger, 2500);
          if (!target) {
            await requireClearPostingOverlays(page);
            await revealMainImageControl(page, trigger);
          }
        }
        if (!target) {
          const menuText = compactText((await page.locator('[class*="menu"], [class*="popup"], [class*="overlay"]').evaluateAll((nodes) => nodes
            .filter((node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length))
            .map((node) => String(node.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-4).join(' ')).catch(() => '')), 500);
          const error = mainImageControlPending();
          error.diagnostics = { ...error.diagnostics, slot: index + 1, menuText };
          throw error;
        }

        if (target.input) {
          if (index === 0 && await target.input.getAttribute('multiple') !== null) {
            await assignFiles(target.input, images);
            return finishBatchUpload();
          }
          await assignFiles(target.input, [image]);
        } else {
          const localUpload = target.button;
          const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
          const clicked = await localUpload.click({ timeout: 2500 }).then(() => true).catch(() => false);
          const chooser = await chooserPromise;
          if (chooser) {
            if (index === 0 && chooser.isMultiple()) {
              await chooser.setFiles(images, { timeout: 30000 });
              return finishBatchUpload();
            }
            await chooser.setFiles([image], { timeout: 30000 });
          } else {
            const uploadHost = localUpload.locator('xpath=ancestor-or-self::*[@role="menu" or contains(@class,"popup") or contains(@class,"overlay")][1]');
            let scopedInput = uploadHost.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
            if (!await scopedInput.count().catch(() => 0)) {
              slotInput = slot.locator('input[type="file"][accept*="image" i], input[type="file"]');
              if (await slotInput.count().catch(() => 0)) scopedInput = slotInput.last();
            }
            if (!await scopedInput.count().catch(() => 0)) {
              const error = mainImageControlPending();
              error.diagnostics = { ...error.diagnostics, slot: index + 1, chooserOpened: false, clicked };
              throw error;
            }
            if (index === 0 && await scopedInput.getAttribute('multiple') !== null) {
              await assignFiles(scopedInput, images);
              return finishBatchUpload();
            }
            await assignFiles(scopedInput, [image]);
          }
        }
      }

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const remaining = await placeholders().count().catch(() => before);
        const feedback = (await mainImageUploadFeedback(page)).join('；');
        if (feedback) {
          throw new Error(`国际站主图第 ${index + 1} 张上传失败：${compactText(feedback, 300)}`);
        }
        if (remaining < before) break;
        await page.waitForTimeout(400);
      }
      const remainingAfter = await placeholders().count().catch(() => before);
      if (remainingAfter >= before) {
        throw Object.assign(new Error(`国际站主图第 ${index + 1} 张尚未完成接收，已保留当前商品进度，请稍后继续`), {
          code: 'MAIN_IMAGE_UPLOAD_PENDING', diagnostics: { section: 'main-images', slot: index + 1 },
        });
      }
    }
    return finishBatchUpload();
  }

  async downloadProductVideo(product, page = this.page) {
    if (!product.videoUrl) return '';
    if (/^\/media\/[a-zA-Z0-9-]+\.mp4$/.test(product.videoUrl)) {
      const file = path.join(this.dataDir, 'media', path.basename(product.videoUrl));
      if (!fs.existsSync(file)) throw new Error('本地商品视频不存在，请重新选择');
      const size = fs.statSync(file).size;
      if (!size || size > 100 * 1024 * 1024) throw new Error('本地商品视频大小无效或超过 100MB');
      return file;
    }
    fs.mkdirSync(this.videoDir, { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const filePath = path.join(this.videoDir, `${crypto.randomUUID()}-main.mp4`);
    let file;
    let response;
    try {
      try {
        response = await fetch(product.videoUrl, { signal: controller.signal, headers: { referer: product.sourceUrl, 'user-agent': 'Mozilla/5.0' } });
      } catch (error) {
        if (controller.signal.aborted || !page) throw error;
        response = await browserVideoResponse(page, product.videoUrl, { signal: controller.signal });
      }
      if (!response.ok) throw new Error(`商品视频下载失败（HTTP ${response.status}）`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > 100 * 1024 * 1024) throw new Error('商品视频超过国际站 100MB 限制');
      if (/^(?:text\/|application\/(?:json|xml))/i.test(response.headers.get('content-type') || '')) throw new Error('商品视频下载返回了网页或错误信息');
      file = await fs.promises.open(filePath, 'wx');
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > 100 * 1024 * 1024) throw new Error('商品视频超过国际站 100MB 限制');
        await file.writeFile(chunk);
      }
      if (!received) throw new Error('商品视频下载结果为空');
      if (contentLength > 0 && received !== contentLength) throw new Error('商品视频下载不完整，请重试');
      await file.close(); file = null;
      return filePath;
    } catch (error) {
      await file?.close().catch(() => {});
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); await response?.dispose?.(); controller.abort(); }
  }

  async uploadMainVideo(page, product, options = {}) {
    if (options.uploadProductVideos === false) return 0;
    const main = productVideoUploads(product, options).find(video => video.role === 'main');
    if (!main) return 0;
    product = { ...product, videoUrl: main.url };
    const initialState = await page.evaluate(readPostingVideoState);
    // The bank returns a stable video identity and supports exact role readback
    // after publication. A hidden inline uploader does not disable the bank:
    // follow the form's advertised entry and verify the actual bank response.
    if (initialState.config?.url) {
      const videoPath = await this.downloadProductVideo(product, page);
      return { bank: await prepareBankVideo(page, videoPath, path.join(this.dataDir, 'video-bank-receipts'), initialState.config.url) };
    }
    if (initialState.available === false) throw videoUnavailableError(initialState);
    const placeholder = await firstVisible(page, ['.video-upload-placeholder']);
    if (!placeholder) throw videoUnavailableError(initialState);
    const videoPath = await this.downloadProductVideo(product, page);

    const media = placeholder.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " posting-field-media ") or @id="imageMedia"][1]');
    let videoInput = media.locator('input[type="file"][accept*="video"], input[type="file"][accept*="mp4"]');
    if (await videoInput.count().catch(() => 0) === 1) {
      await videoInput.setInputFiles(videoPath);
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
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && !await videoInput.count().catch(() => 0)) await page.waitForTimeout(250);
        if (await videoInput.count().catch(() => 0) !== 1) throw new Error('国际站主图视频上传器未提供唯一的主图文件入口');
        await videoInput.setInputFiles(videoPath);
      }
    }

    const uploadDeadline = Date.now() + 120000;
    while (Date.now() < uploadDeadline) {
      const feedback = (await visibleFeedback(page)).join(' ');
      if (/视频.*失败|上传失败|格式不支持|超过.*(?:MB|M)|upload failed/i.test(feedback)) {
        throw new Error(`国际站主图视频上传失败：${compactText(feedback, 300)}`);
      }
      const state = await page.evaluate(readPostingVideoState);
      const accepted = newlyAcceptedVideo(initialState, state);
      if (accepted) return { inline: accepted };
      await page.waitForTimeout(800);
    }
    throw new Error('国际站主图视频上传超过 120 秒仍未完成');
  }

  async uploadDetailVideos(page, product, mainResult, options = {}) {
    const planned = requireSupportedVideoPlan(product, options).filter(video => video.role === 'detail');
    if (!planned.length) return [];
    const records = [], reusable = new Map();
    if (mainResult?.bank && product.videoUrl) reusable.set(videoResourceKey(product.videoUrl), mainResult.bank);
    for (const video of planned.slice(0, 1)) {
      options.onProgress?.('处理商品视频');
      try {
        const key = videoResourceKey(video.url);
        let bank = reusable.get(key);
        if (!bank) {
          const state = await page.evaluate(readPostingVideoState);
          if (!state.config?.url) throw videoUnavailableError(state);
          const file = await this.downloadProductVideo({ ...product, videoUrl: video.url }, page);
          bank = await prepareBankVideo(page, file, path.join(this.dataDir, 'video-bank-receipts'), state.config.url);
          reusable.set(key, bank);
        }
        records.push({ bank: { ...bank, role: 'detail' }, sourceUrl: video.url });
      } catch (error) {
        throw Object.assign(new Error(`详情视频上传未完成：${error.message}；当前商品尚未提交，请重试或在商品编辑中调整视频`), { code: error.code || 'PUBLISH_VIDEO_UPLOAD_FAILED', diagnostics: error.diagnostics });
      }
    }
    return records;
  }

  async uploadProductVideos(page, product, options = {}) {
    const planned = requireSupportedVideoPlan(product, options);
    if (!planned.length) return { main: null, details: [] };
    options.onProgress?.('处理商品视频');
    let main;
    try { main = await this.uploadMainVideo(page, product, options); }
    catch (error) {
      throw Object.assign(new Error(`主图视频上传未完成：${error.message}；当前商品尚未提交，请重试或在商品编辑中调整视频`), { code: error.code || 'PUBLISH_VIDEO_UPLOAD_FAILED', diagnostics: error.diagnostics });
    }
    const details = await this.uploadDetailVideos(page, product, main, options);
    return { main, details };
  }

  async waitForMainImageUploads(page, expectedCount, initialSlotCount = 6, { timeoutMs = 60000 } = {}) {
    const uploadDeadline = Date.now() + timeoutMs;
    while (Date.now() < uploadDeadline) {
      // Count one canonical marker per empty slot. The icon and photobank
      // trigger are children of that same slot; counting all three inflated a
      // single empty slot into multiple entries and falsely timed out after
      // every per-image upload had already succeeded.
      const remainingSlots = await page.locator('.image-uploader .image-upload-list-item #image-placeholder-span:visible')
        .count().catch(() => initialSlotCount);
      const records = await mainImageUploadRecords(page);
      const failure = mainImageUploadFailure(records);
      if (failure) throw failure;
      const feedback = (await mainImageUploadFeedback(page)).join('；');
      if (feedback) {
        throw new Error(`国际站主图上传失败：${compactText(feedback, 300)}`);
      }
      const state = await mainImageFormState(page);
      if (!state.uploading && state.occupied >= 4 && mainImageSlotsComplete(initialSlotCount, remainingSlots, expectedCount)) return expectedCount;
      await page.waitForTimeout(500);
    }
    const remainingSlots = await page.locator('.image-uploader .image-upload-list-item #image-placeholder-span:visible')
      .count().catch(() => initialSlotCount);
    const state = await mainImageFormState(page);
    throw Object.assign(new Error(`国际站主图尚未完成接收（已确认 ${state.occupied} 张），已保留当前商品进度，请稍后继续`), {
      code: 'MAIN_IMAGE_UPLOAD_PENDING', diagnostics: { section: 'main-images', occupied: state.occupied, expectedCount, remainingSlots },
    });
  }

  async fillProductFields(page, product, onProgress = () => {}, options = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const originalUrl = page.url();
      let result;
      try {
        result = await this.fillStableProductFields(page, product, onProgress, options);
        if (page.url() === originalUrl) return result;
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context|navigation/i.test(error.message) || page.isClosed()) throw error;
      }
      // Alibaba auto-saves new products and reloads the draft during editing.
      // Refill once on the loaded form before uploading the final media.
      if (!/\/product\/publish\.htm(?:\?|$)/i.test(page.url())) throw new Error('国际站发布页已离开，当前商品尚未提交');
      if (attempt) throw new Error('国际站表单反复刷新，当前商品尚未提交，请重试该商品');
      onProgress('国际站已刷新草稿，正在恢复商品属性');
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await page.locator('.sell-catProp-item').first().waitFor({ state: 'visible', timeout: 15000 });
    }
  }

  async fillStableProductFields(page, product, onProgress = () => {}, options = {}) {
    // References and manual category edits update the working category while
    // sourceCategory* remains immutable traceability data. Publishing must
    // therefore use the working category first.
    const categoryPath = sanitizeCategoryPath(product.categoryPath || product.sourceCategoryPath);
    const productTypeCandidate = [product.productType, ...categoryPath.slice().reverse()].find((value) => value && !isPromotionalText(value));
    const productType = englishSpecText(productTypeCandidate, 'Other');
    const normalizedName = requiredAttributeKey;
    // Preserve all source rows until the field resolver compares their values.
    // Deduplicating by property name/ID here discarded core counts and ranges.
    const attributeItems = [...(product.attributes || []), ...(product.customAttributes || [])]
      .filter((item) => item?.name && item.value != null && item.value !== '' && normalizedName(item.name) !== normalizedName(item.value));
    // Some detail pages expose required category values only inside the SKU
    // matrix (for example compatible model/type). Keep the matrix intact, but
    // expose its first value to the corresponding required attribute control.
    const knownAttributeNames = new Set(attributeItems.map((item) => normalizedName(item.name)));
    const addInferredAttribute = (name, value) => {
      if (!value || knownAttributeNames.has(normalizedName(name))) return;
      attributeItems.push({ name, value, source: 'inferred-publish-value' });
      knownAttributeNames.add(normalizedName(name));
    };
    addInferredAttribute('屏幕', inferRequiredAttributeValue(product, '屏幕', '屏幕尺寸', 'screen size', 'screen'));
    addInferredAttribute('电池容量', inferRequiredAttributeValue(product, '电池容量', 'battery capacity', 'battery'));
    addInferredAttribute('处理器品牌', inferRequiredAttributeValue(product, '处理器品牌', 'processor brand'));
    addInferredAttribute('适用型号', inferRequiredAttributeValue(product, '适用型号', 'compatible model'));
    addInferredAttribute('类型', inferRequiredAttributeValue(product, '类型', 'product type'));
    for (const group of product.variantGroups || []) {
      const name = String(group?.name || '').trim();
      const value = Array.isArray(group?.options) ? group.options.find(Boolean) : '';
      if (!name || !value || isColorVariantGroup(group) || knownAttributeNames.has(normalizedName(name))) continue;
      attributeItems.push({ name, value });
      knownAttributeNames.add(normalizedName(name));
    }
    const mappedAttributes = new Set();
    const unmappedAttributes = new Set();
    const sourceItemsByName = (...names) => {
      const wanted = new Set(names.map(normalizedName));
      return attributeItems.filter((item) => wanted.has(normalizedName(item.name)));
    };
    const markSourceAttributes = (names, filled) => {
      for (const item of sourceItemsByName(...names)) {
        (filled ? mappedAttributes : unmappedAttributes).add(item.name);
        if (filled) unmappedAttributes.delete(item.name);
      }
    };

    const fillRequiredChoice = async (labels, value, fallback = []) => {
      const field = await fieldByAnyLabel(page, labels);
      if (!field) return false;
      if (value && await fillChoice(page, field, value).catch(postingInteractionFailure)) return true;
      for (const candidate of fallback) {
        if (await fillChoice(page, field, candidate).catch(postingInteractionFailure)) return true;
      }
      const type = String(await field.getAttribute('type').catch(() => '')).toLowerCase();
      if (type !== 'checkbox' && type !== 'radio' && value) {
        return await fillAndVerify(field, value, labels[0]).then(() => true).catch(() => false);
      }
      return false;
    };

    onProgress('初始化类目属性');
    await clearSaleAttributeSelections(page);
    onProgress('填写产品类型');

    const productTypeField = await fieldByAnyLabel(page, ['产品类型', '类型', 'Product Type', 'Type']);
    let productTypeFilled = false;
    const explicitTypes = attributeValue(product, '产品类型', '类型', 'product type', 'type');
    const explicitType = Array.isArray(explicitTypes) ? explicitTypes[0] : explicitTypes;
    const productTypeCandidates = [...new Set([
      explicitType || productType,
      (explicitType || productType).replace(/ies$/i, 'y').replace(/s$/i, '')
    ].filter(Boolean))];
    for (const candidate of productTypeCandidates) {
      if (await fillChoice(page, productTypeField, candidate)) {
        productTypeFilled = true;
        break;
      }
    }
    markSourceAttributes(['产品类型', 'product type', '类型', 'type'], productTypeFilled);

    const sourceOrigin = product.origin || attributeValue(product, '产地', 'Place of Origin');
    onProgress('填写产地');
    const originFilled = await fillOriginCountry(page, sourceOrigin);
    markSourceAttributes(['产地', 'place of origin'], originFilled);

    onProgress('填写型号和品牌');
    const modelValue = product.model || attributeValue(product, '型号', 'Model Number') || 'General';
    const modelFilled = await fillModelNumber(page, modelValue);
    markSourceAttributes(['型号', 'model', 'model number'], modelFilled);

    onProgress('填写品牌');
    const brandValue = product.brand || attributeValue(product, '品牌名称', 'Brand Name') || 'Other';
    const brandFilled = await fillFirst(page, ['input[name="p-2"]'], brandValue)
      || await fillChoice(page, await fieldByAnyLabel(page, ['品牌名称', 'Brand Name']), brandValue);
    markSourceAttributes(['品牌名称', 'brand', 'brand name'], brandFilled);

    // Feature and Function are independent category properties. The schema
    // writer below owns them; a legacy label fallback can overwrite either.
    onProgress('填写接口');
    const portValue = attributeValue(product, '端口', '接口', 'Port', 'port');
    const portFilled = portValue && await fillRequiredChoice(['端口', '接口', 'Port'], portValue);
    markSourceAttributes(['端口', '接口', 'Port', 'port'], portFilled);

    onProgress('填写材质');
    const materialValue = attributeValue(product, '材料', '材质', 'Material');
    const materialFilled = materialValue && (await fillFirst(page, ['input[name="p-390873113"]'], materialValue)
      || await fillChoice(page, await fieldByAnyLabel(page, ['材料', '材质', 'Material']), materialValue));
    markSourceAttributes(['材料', '材质', 'material'], materialFilled);

    const categoryMapped = await fillCategoryAttributes(page, { ...product, attributes: attributeItems }, onProgress);
    for (const name of categoryMapped) { mappedAttributes.add(name); unmappedAttributes.delete(name); }
    onProgress('填写颜色和商品规格');
    const colorGroup = (product.variantGroups || []).find(isColorVariantGroup);
    const colorValues = colorGroup?.options?.length ? colorGroup.options : [];
    const colorId = await colorSaleAttributeId(page);
    const targetSupportsColor = await saleAttributeIsAvailable(page, colorId);
    const useColorSaleSpec = shouldUseColorSaleSpecification(colorGroup, targetSupportsColor);
    const sourceHasSpecImage = useColorSaleSpec && Boolean(
      colorGroup?.options?.some((value) => colorGroup.optionImages?.[value])
    );
    const colorIsRequired = colorValues.length > 0;
    const colorSpecRow = useColorSaleSpec ? await ensureColorSpecificationReady(page) : null;
    if (useColorSaleSpec && !colorSpecRow && colorIsRequired) {
      throw new Error('国际站商品规格区的颜色规格未能启用');
    }
    const variantResult = await fillVariantSpecs(page, product, onProgress);
    const hasImageBackedVariant = variantResult.groups.some((group) => Object.values(group.optionImages || {}).some(Boolean));
    let variantImageWarning = '';
    const flattenedVariantWarning = variantResult.groups.some((group) => group.sourceGroups?.length)
      ? '目标类目只开放一个规格槽；多维来源规格已展开为完整组合，来源图片保留在主图和详情图中'
      : '';
    if (hasImageBackedVariant && !await enableImageBackedVariantSpecs(
      page,
      product,
      variantResult.groups,
      (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit),
      onProgress
    )) {
      variantImageWarning = '当前类目未开放规格图开关；规格组合已保留，来源图片继续保留在商品主图和详情图中';
    }
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
    const colorControl = colorSpecRow?.locator(colorControlSelector).filter({ visible: true }).first();
    // Color is optional at the source level and not every Alibaba category
    // exposes it as a target specification. Only require a successful value
    // when the selected target category actually renders a visible control.
    const colorFilled = colorControl ? await fillColorSpec(page, colorValues, onProgress) : true;
    if (colorControl && !colorFilled && colorIsRequired) {
      throw new Error('国际站颜色规格未成功添加，请检查颜色输入框和“添加”按钮');
    }
    if (colorControl && colorGroup?.options?.length) {
      const specImageUploaded = await enableSpecImageUpload(
        page,
        product,
        colorGroup,
        (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit),
        onProgress
      );
      if (sourceHasSpecImage && !specImageUploaded && colorIsRequired) {
        throw new Error('国际站颜色规格图片未能上传，已停止提交以避免生成缺图商品');
      }
    }
    markSourceAttributes(['颜色', 'color', 'colour'], Boolean(colorValues.length) && colorFilled);

    // Specification controls are created when their groups are enabled. Plan
    // custom fallbacks only after those native fields exist, otherwise Color
    // and Model Number can incorrectly consume an extra custom slot.
    const attributePlan = planPublicAttributeTransfer(product, await page.evaluate(readPostingAttributeSchema));
    onProgress('填写并复核自定义属性');
    const customAttributes = await fillCustomAttributes(page, attributePlan.product, fillAndVerify);
    for (const item of customAttributes) { mappedAttributes.add(item.name); unmappedAttributes.delete(item.name); }
    for (const { source, fields } of attributePlan.standard) {
      // A same-value supplier duplicate may deliberately have no custom row
      // because the native property already holds it. Confirm that native
      // value before reporting the source spelling (e.g. Output/output) mapped.
      for (const item of (product.attributes || []).filter(isPublicProductAttribute)) {
        if (normalizedName(item.name) !== normalizedName(source.name)) continue;
        if (fields.some(field => field.hasValue && attributeFieldMatchesValue(field, item.value, { source: item }))) {
          mappedAttributes.add(item.name); unmappedAttributes.delete(item.name);
        }
      }
    }
    for (const item of (product.attributes || []).filter(isPublicProductAttribute)) {
      if (!mappedAttributes.has(item.name) && !isOriginRegionAttribute(item.name)) unmappedAttributes.add(item.name);
    }

    onProgress('填写包装和物流属性');
    const logisticsFilled = await applyPostingLogistics(page, product, options);
    markSourceAttributes(['单个产品毛重', 'single gross weight'], logisticsFilled);
    markSourceAttributes(['单个包装尺寸', 'single package size'], logisticsFilled);

    const sellingUnitItems = sourceItemsByName('销售单位', 'selling unit', 'selling units');
    if (sellingUnitItems.length) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const sourceUnit = String(sellingUnitItems[0].value || '');
      const sellingUnitFilled = /single\s*item/i.test(sourceUnit)
        && /(?:按件卖|Piece\/Pieces|Single item)/i.test(bodyText);
      markSourceAttributes(['销售单位', 'selling unit', 'selling units'], sellingUnitFilled);
    }

    await page.waitForTimeout(500);
    await fillDeliveryFields(page, product.deliveryTime);
    const publicNames = new Set((product.attributes || []).filter(isPublicProductAttribute).map(item => item.name));
    return {
      mappedAttributes: [...mappedAttributes],
      customAttributes,
      unmappedAttributes: [...new Set([...unmappedAttributes].filter(name => publicNames.has(name)).concat(variantResult.unmapped))],
      blockingUnmapped: variantResult.blockingUnmapped,
      variantFailures: variantResult.failures,
      warnings: [flattenedVariantWarning, variantImageWarning].filter(Boolean)
    };
  }

  async fillPriceFields(page, product, { timeoutMs = browserResourcePolicy().constrained ? 20000 : 10000, onProgress = () => {} } = {}) {
    // Unit changes can rebuild prices and MOQ. Commit the source unit first,
    // then fill the dependent controls; never leave a default Piece for Set.
    await fillSalesUnit(page, product, { timeoutMs });
    if (usesSkuPricing(product)) {
      onProgress('选择按规格定价，保留每个 SKU 的价格');
      return selectSkuPricing(page, product, fillAndVerify, { timeoutMs });
    }
    const fob = product.fobPrice && typeof product.fobPrice === 'object' ? product.fobPrice : {};
    const sourceTiers = product.priceMode === 'fob-tier' && Array.isArray(fob.tiers) ? fob.tiers : (product.priceTiers || []);
    const validTiers = sourceTiers
      .filter((tier) => numericValue(tier.price) > 0 && numericValue(tier.minQuantity) > 0)
      .sort((left, right) => numericValue(left.minQuantity) - numericValue(right.minQuantity));
    const fallbackPrice = product.priceMode === 'fob-range' && numericValue(fob.minPrice) > 0 ? fob.minPrice : product.price;
    const tiers = (validTiers.length
      ? validTiers
      : [{ price: fallbackPrice, minQuantity: product.minOrder || product.moq || 1 }])
      .map((tier) => ({
        ...tier,
        price: numericValue(tier.price),
        minQuantity: numericValue(tier.minQuantity)
      }))
      .filter((tier) => tier.price > 0 && tier.minQuantity > 0);
    if (!tiers.length) throw new Error('缺少有效的价格和起订量');
    const priceSelector = '[role="input-price"]:visible';
    const quantitySelector = '[role="input-quantity"]:visible';
    const ladders = page.locator('.posting-field-ladder:visible').filter({ has: page.locator('[role="input-price"]') });
    const root = await ladders.count() ? ladders.first() : page;
    const priceInputs = root.locator(priceSelector);
    const quantityInputs = root.locator(quantitySelector);
    const rowCount = async () => Math.min(await priceInputs.count(), await quantityInputs.count());
    const notReady = async (reason) => {
      const observedTiers = await rowCount();
      return Object.assign(new Error(`国际站价格阶梯未就绪：${reason}（当前 ${observedTiers} 档，需要 ${tiers.length} 档）；已保留商品和任务进度，未提交当前商品`),
        { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '价格阶梯', diagnostics: { requestedTiers: tiers.length, observedTiers } });
    };
    const waitUntil = async (ready, reason) => {
      const deadline = performance.now() + timeoutMs;
      while (!await ready()) {
        if (performance.now() >= deadline) throw await notReady(reason);
        await page.waitForTimeout(150);
      }
    };
    const changeRows = async (control, expectedCount, clickFailure, pendingReason) => {
      let uncertainClick;
      try {
        await clickPostingControl(page, control, { timeout: Math.min(timeoutMs, 4000) });
      } catch (error) {
        // A dispatched click may succeed even if its acknowledgement times out.
        // Observe its exact row change; never send that add/remove click again.
        if (error.code === 'PUBLISH_CONTROL_RESULT_UNKNOWN') uncertainClick = error;
        else { postingInteractionFailure(error); throw await notReady(clickFailure); }
      }
      try {
        await waitUntil(async () => await rowCount() === expectedCount, pendingReason);
      } catch (error) {
        if (uncertainClick && error.code === 'PUBLISH_FIELD_NOT_READY') throw uncertainClick;
        throw error;
      }
    };
    if (!await rowCount() && tiers.length === 1) {
      const price = page.locator('input[placeholder*="价格"], input[placeholder*="price" i]').filter({ visible: true }).first();
      const quantity = page.locator('input[placeholder*="起订"], input[placeholder*="quantity" i]').filter({ visible: true }).first();
      if (await price.isEditable().catch(() => false) && await quantity.isEditable().catch(() => false)) {
        await fillAndVerify(quantity, tiers[0].minQuantity, '起订量');
        await fillAndVerify(price, tiers[0].price, '商品价格');
        return;
      }
    }
    await fillFreightTemplate(page, product);
    await waitUntil(async () => await rowCount() > 0, '尚未找到完整的价格和起订量输入框');
    const commitRow = async (index) => {
      for (const [inputs, expected, label] of [[quantityInputs, tiers[index].minQuantity, '起订量'], [priceInputs, tiers[index].price, '价格']]) {
        const input = inputs.nth(index);
        if (numericValue(await input.inputValue().catch(() => '')) !== expected) {
          await fillAndVerify(input, expected, `第 ${index + 1} 档${label}`);
        }
      }
    };
    for (let index = 0; index < tiers.length; index++) {
      onProgress(`填写价格阶梯 ${index + 1}/${tiers.length}`);
      if (await rowCount() <= index) {
        // A new row can be gated on existing values and can rebuild previous
        // inputs. Commit the rows first, then wait for the actual next row.
        for (let previous = 0; previous < index; previous++) await commitRow(previous);
        const namedAdd = root.locator('button, a, [role="button"]').filter({ hasText: /新增价格区间|添加价格区间|Add (?:a |another |new )?price (?:range|tier)/i }).filter({ visible: true });
        const add = root !== page && await root.locator('[role="btn-add"]:visible').count()
          ? root.locator('[role="btn-add"]:visible').first() : namedAdd.first();
        await waitUntil(async () => await add.isVisible().catch(() => false) && await add.isEnabled().catch(() => false), '新增价格区间按钮暂不可用');
        await changeRows(add, index + 1, '未能新增价格区间', '新增价格区间后尚未生成完整输入行');
      }
      await commitRow(index);
    }
    const rows = root.locator('tr[role="row"]:visible:has([role="input-quantity"]):has([role="input-price"])');
    while (await rowCount() > tiers.length) {
      const previousCount = await rowCount();
      const remove = rows.last().locator('[role="remove"], button').filter({ visible: true }).last();
      await waitUntil(async () => await remove.isVisible().catch(() => false) && await remove.isEnabled().catch(() => false), '多余价格区间暂无法移除');
      await changeRows(remove, previousCount - 1, '未能移除多余价格区间', '多余价格区间尚未移除');
    }
    for (let index = 0; index < tiers.length; index++) await commitRow(index);
    const quantities = await quantityInputs.evaluateAll(nodes => nodes.map(node => node.value));
    const prices = await priceInputs.evaluateAll(nodes => nodes.map(node => node.value));
    if (prices.length !== tiers.length || quantities.length !== tiers.length
      || tiers.some((tier, index) => numericValue(prices[index]) !== tier.price || numericValue(quantities[index]) !== tier.minQuantity)) {
      throw await notReady('数量或价格在页面刷新后未完整保留');
    }
  }

  async fillLegacyDescription(page, product, onProgress = () => {}) {
    recordLegacyDescriptionText(page, []);
    await waitForHumanVerification(page);
    await requireClearPostingOverlays(page);
    await revealDescriptionSection(page);
    const format = await ensureSourceDescriptionMode(page, product, { onProgress,
      beforeInteraction: () => requireClearPostingOverlays(page) });
    if (format === 'structured') {
      await requireClearPostingOverlays(page);
      const images = distinctAlibabaImageUrls(product.detailImages || []);
      onProgress('下载并缓存新版详情图片');
      const files = images.length ? await this.downloadImageSet(product, images, 'structured-detail', images.length) : [];
      if (files.length !== images.length) throw Object.assign(new Error(
        `详情图片未全部下载成功（应有 ${images.length} 张，成功 ${files.length} 张），已停止提交，请检查图片后重试`
      ), { code: 'DETAIL_IMAGE_DOWNLOAD_FAILED' });
      await fillStructuredDescription(page, { html: buildLegacyDescriptionHtml(product), files, imageUrls: images,
        structure: currentDescriptionStructure(product), highlights: structuredHighlightText(product), onProgress,
        beforeInteraction: async target => { await target.scrollIntoViewIfNeeded(); await requireClearPostingOverlays(page); } });
      return true;
    }
    await prepareDescriptionEditor(page);
    const { frame, body } = await waitForDescriptionEditor(page, {
      switchMode: () => prepareDescriptionEditor(page),
      verify: () => waitForHumanVerification(page), onProgress
    });
    const compatible = descriptionCompatibility(page, product);
    const prepared = prepareLegacyDescriptionText(compatible
      ? compatibleLegacyDescriptionHtml(product, buildLegacyDescriptionHtml(product)) : buildLegacyDescriptionHtml(product));
    const html = prepared.html;
    recordLegacyDescriptionText(page, prepared.conversions);
    if (prepared.conversions.length) onProgress('详情单位已转换为等价英文写法，原始资料保留');
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
    await this.uploadLegacyDetailImages(page, product, onProgress);
    if (product.descriptionTemplate) await placeTemplateImages(page, product);
    else {
      const restored = await restoreDescriptionImages(page, html, distinctAlibabaImageUrls(product.detailImages || []).length);
      if (compatible) await acceptCompatibleLegacyDescription(page, product, restored);
    }
    return true;
  }

  async uploadLegacyDetailImages(page, product, onProgress = () => {}) {
    if (product.imageEdits?.detail && !product.detailImages?.length) return 0;
    onProgress('下载并缓存详情图片');
    // The editor already limits concurrent uploads and retries individual
    // failures. Keep every selected detail image instead of silently taking 8.
    const expectedImages = distinctAlibabaImageUrls(product.detailImages || []);
    const imagePaths = await this.downloadImageSet(product, expectedImages, 'detail', expectedImages.length);
    if (imagePaths.length !== expectedImages.length) throw Object.assign(new Error(
      `详情图片未全部下载成功（应有 ${expectedImages.length} 张，成功 ${imagePaths.length} 张），已停止提交，请检查图片后重试`
    ), { code: 'DETAIL_IMAGE_DOWNLOAD_FAILED' });
    if (!imagePaths.length) throw new Error('详情图下载失败，无法上传到国际站普通编辑器');
    onProgress(`上传详情图片 0/${imagePaths.length}`);
    const editorImageCount = async () => {
      let count = 0;
      for (const frame of page.frames()) {
        const body = frame.locator('body.mce-content-body, body[contenteditable="true"]');
        if (!await body.isVisible().catch(() => false)) continue;
        count = Math.max(count, await body.locator('img[src], img[data-src]').count().catch(() => 0));
      }
      return count;
    };
    const syncEditor = async () => {
      await page.evaluate(() => {
        const editor = [...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])]
          .find((item) => item && !item.hidden);
        editor?.save();
        editor?.fire('input');
        editor?.fire('change');
      }).catch(() => {});
    };
    const visiblePageImageDialog = async () => {
      const dialogs = page.locator('.mce-window, [role="dialog"], .next-dialog, [class*="image-dialog"], [class*="upload-dialog"]');
      for (let index = (await dialogs.count().catch(() => 0)) - 1; index >= 0; index -= 1) {
        const dialog = dialogs.nth(index);
        if (!await dialog.isVisible().catch(() => false)) continue;
        const text = compactText(await dialog.innerText().catch(() => ''), 600);
        const hasFileInput = await dialog.locator('input[type="file"]').count().catch(() => 0);
        if (hasFileInput || /图片|上传|image|upload/i.test(text)) return dialog;
      }
      return null;
    };
    let lastDialogActionAt = 0;
    const clickPageImageDialogAction = async () => {
      if (Date.now() - lastDialogActionAt < 2200) return false;
      const dialog = await visiblePageImageDialog();
      if (!dialog) return false;
      const actions = [/^确认上传/, /^开始上传/, /^上传$/, /^插入$/, /^确定$/, /^完成$/, /^确认$/];
      for (const pattern of actions) {
        const roleButton = dialog.getByRole('button', { name: pattern }).last();
        const textButton = dialog.getByText(pattern).last();
        const target = await roleButton.isVisible().catch(() => false) ? roleButton : textButton;
        if (!await target.isVisible().catch(() => false) || await target.isDisabled().catch(() => true)) continue;
        await target.click({ force: true }).catch(() => {});
        lastDialogActionAt = Date.now();
        return true;
      }
      return false;
    };
    const waitForEditorImages = async (minimum, timeout) => {
      const deadline = Date.now() + timeout;
      let count = await editorImageCount();
      while (count < minimum && Date.now() < deadline) {
        const feedback = (await visibleFeedback(page)).join(' ');
        if (/上传失败|图片.*失败|文件.*过大|图片.*不符合|upload failed/i.test(feedback)) {
          throw new Error(`国际站详情图上传失败：${compactText(feedback, 300)}`);
        }
        await clickPageImageDialogAction();
        await page.waitForTimeout(400);
        count = await editorImageCount();
      }
      if (count >= minimum) await syncEditor();
      return count;
    };
    const findUploaderFrame = async () => {
      const frames = page.frames().filter((frame) => frame !== page.mainFrame());
      const legacy = frames.find((frame) => /photobank\.alibaba\.com\/uploader\.htm/i.test(frame.url()));
      if (legacy) return legacy;
      for (const frame of frames) {
        if (!/upload|image|photo|bank/i.test(frame.url())) continue;
        if (await frame.locator('input[type="file"]').count().catch(() => 0)) return frame;
      }
      for (const frame of frames) {
        if (!await frame.locator('input[type="file"]').count().catch(() => 0)) continue;
        const text = compactText(await frame.locator('body').innerText().catch(() => ''), 500);
        if (/上传|图片|upload|image/i.test(text)) return frame;
      }
      return null;
    };
    const setFilesOnPageDialog = async (paths) => {
      const dialog = await visiblePageImageDialog();
      if (!dialog) return 0;
      const inputs = dialog.locator('input[type="file"]');
      const count = await inputs.count().catch(() => 0);
      if (!count) return 0;
      const input = inputs.nth(count - 1);
      const multiple = await input.getAttribute('multiple') !== null;
      if (multiple) {
        await input.setInputFiles(paths);
        return paths.length;
      }
      let assigned = 0;
      for (const filePath of paths) {
        await input.setInputFiles([filePath]);
        assigned += 1;
        const inserted = await waitForEditorImages(initialEditorImages + assigned, 30000);
        if (inserted < initialEditorImages + assigned) break;
      }
      return assigned;
    };
    const initialEditorImages = await editorImageCount();
    const pluginInserted = await uploadEditorDetailImages(page, imagePaths, onProgress);
    if (pluginInserted !== null) return pluginInserted;
    if (product.descriptionTemplate) throw new Error('详情模板需要国际站普通图文编辑器的图片上传组件，请重新加载发布页后继续；尚未提交商品');

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

    const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
    await uploadButton.click({ force: true });
    const chooser = await chooserPromise;
    const chooserMultiple = Boolean(chooser?.isMultiple());
    if (chooser) {
      await chooser.setFiles(chooserMultiple ? imagePaths : [imagePaths[0]]);

      // Alibaba's current ordinary editor can upload directly from the native
      // chooser. In that flow no photobank iframe is created, so completion is
      // determined from the editor content instead of requiring the old dialog.
      if (chooserMultiple) {
        const inserted = await waitForEditorImages(initialEditorImages + imagePaths.length, 60000);
        if (inserted >= initialEditorImages + imagePaths.length) return inserted - initialEditorImages;
      } else {
        let inserted = await waitForEditorImages(initialEditorImages + 1, 30000);
        if (inserted >= initialEditorImages + 1) {
          for (let index = 1; index < imagePaths.length; index += 1) {
            const nextChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
            await uploadButton.click({ force: true });
            const nextChooser = await nextChooserPromise;
            if (!nextChooser) break;
            await nextChooser.setFiles([imagePaths[index]]);
            inserted = await waitForEditorImages(initialEditorImages + index + 1, 30000);
            if (inserted < initialEditorImages + index + 1) break;
          }
          if (inserted >= initialEditorImages + imagePaths.length) return inserted - initialEditorImages;
        }
      }
    }

    if (!chooser) {
      const assigned = await setFilesOnPageDialog(imagePaths);
      if (assigned) {
        const inserted = await waitForEditorImages(initialEditorImages + imagePaths.length, 60000);
        if (inserted >= initialEditorImages + imagePaths.length) return inserted - initialEditorImages;
      }
    }

    const frameDeadline = Date.now() + 12000;
    let uploaderFrame = null;
    while (Date.now() < frameDeadline) {
      uploaderFrame = await findUploaderFrame();
      if (uploaderFrame) break;
      await page.waitForTimeout(250);
    }
    if (!uploaderFrame) {
      const inserted = await waitForEditorImages(initialEditorImages + imagePaths.length, 30000);
      if (inserted >= initialEditorImages + imagePaths.length) return inserted - initialEditorImages;
      throw new Error(`普通编辑器未完成详情图上传（已插入 ${Math.max(0, inserted - initialEditorImages)}/${imagePaths.length} 张）`);
    }

    const frameInputs = uploaderFrame.locator('input[type="file"]');
    const frameInputCount = await frameInputs.count().catch(() => 0);
    if (!frameInputCount) {
      const frameText = compactText(await uploaderFrame.locator('body').innerText().catch(() => ''), 500);
      throw new Error(`图片银行上传器没有文件输入框${frameText ? `：${frameText}` : ''}`);
    }
    const frameInput = frameInputs.nth(frameInputCount - 1);
    const inputMultiple = await frameInput.getAttribute('multiple') !== null;
    const uploaderTextBefore = compactText(await uploaderFrame.locator('body').innerText().catch(() => ''), 1200);
    const isLegacyPhotobank = /photobank\.alibaba\.com\/uploader\.htm/i.test(uploaderFrame.url())
      || /确认上传\s*[（(]\s*\d+\s*\/\s*30/i.test(uploaderTextBefore);
    if (!isLegacyPhotobank) {
      if (!chooser) {
        if (inputMultiple) await frameInput.setInputFiles(imagePaths);
        else {
          for (let index = 0; index < imagePaths.length; index += 1) {
            await frameInput.setInputFiles([imagePaths[index]]);
            const inserted = await waitForEditorImages(initialEditorImages + index + 1, 30000);
            if (inserted < initialEditorImages + index + 1) break;
          }
        }
      }
      const actions = [/^确认上传/, /^开始上传/, /^上传$/, /^插入$/, /^确定$/, /^完成$/, /^确认$/];
      for (const pattern of actions) {
        const target = uploaderFrame.getByRole('button', { name: pattern }).last();
        if (!await target.isVisible().catch(() => false) || await target.isDisabled().catch(() => true)) continue;
        await target.click({ force: true }).catch(() => {});
        break;
      }
      const inserted = await waitForEditorImages(initialEditorImages + imagePaths.length, 90000);
      if (inserted >= initialEditorImages + imagePaths.length) {
        await this.closeImageUploaderDialog(page);
        return inserted - initialEditorImages;
      }
      const frameText = compactText(await uploaderFrame.locator('body').innerText().catch(() => ''), 800);
      throw new Error(`新版普通编辑器详情图未完成上传（已插入 ${Math.max(0, inserted - initialEditorImages)}/${imagePaths.length} 张）${frameText ? `：${frameText}` : ''}`);
    }
    const queuedCount = async () => {
      const text = await uploaderFrame.locator('body').innerText().catch(() => '');
      const match = text.match(/确认上传\s*[（(]\s*(\d+)\s*\/\s*30\s*[）)]/);
      return match ? Number(match[1]) : 0;
    };
    const waitForQueuedCount = async (minimum, timeout = 12000) => {
      const deadline = Date.now() + timeout;
      let count = 0;
      while (Date.now() < deadline) {
        count = await queuedCount();
        if (count >= minimum) return count;
        await page.waitForTimeout(250);
      }
      return count;
    };

    let queued = await waitForQueuedCount(chooserMultiple ? imagePaths.length : chooser ? 1 : 0, chooser ? 12000 : 500);
    if (!chooser || (chooserMultiple && queued < imagePaths.length)) {
      await frameInput.setInputFiles(inputMultiple ? imagePaths : [imagePaths[0]]);
      queued = await waitForQueuedCount(inputMultiple ? imagePaths.length : 1);
    }
    while (queued < imagePaths.length) {
      const before = queued;
      await frameInput.setInputFiles([imagePaths[queued]]);
      queued = await waitForQueuedCount(before + 1);
      if (queued <= before) {
        const frameText = compactText(await uploaderFrame.locator('body').innerText().catch(() => ''), 800);
        throw new Error(`国际站详情图未加入上传队列（${before}/${imagePaths.length}）：${frameText}`);
      }
    }

    const uploaderButtonState = async (frame, target) => ({
      text: compactText(await frame.locator('body').innerText().catch(() => ''), 2000),
      visible: await target.isVisible().catch(() => false),
      disabled: await target.isDisabled().catch(() => false)
    });
    const clickUploaderAction = async (frame, target) => {
      const before = await uploaderButtonState(frame, target);
      await target.scrollIntoViewIfNeeded().catch(() => {});
      let clicked = false;
      const box = await target.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        clicked = true;
        await page.waitForTimeout(900);
      }
      let after = await uploaderButtonState(frame, target);
      if (!after.visible || after.disabled || after.text !== before.text) return { changed: true, method: 'mouse' };
      const locatorClick = await target.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
      clicked = clicked || locatorClick;
      await page.waitForTimeout(900);
      after = await uploaderButtonState(frame, target);
      if (!after.visible || after.disabled || after.text !== before.text) return { changed: true, method: 'locator' };
      const dispatched = await target.evaluate((node) => {
        const eventInit = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const EventCtor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          node.dispatchEvent(new EventCtor(type, eventInit));
        }
        let current = node;
        for (let level = 0; current && level < 5; level += 1, current = current.parentElement) {
          for (const key of Reflect.ownKeys(current)) {
            if (typeof key !== 'string' || !/^__react(?:Props|EventHandlers)\$/.test(key)) continue;
            const handler = current[key]?.onClick;
            if (typeof handler === 'function') {
              handler({ type: 'click', target: node, currentTarget: current, preventDefault() {}, stopPropagation() {}, persist() {} });
              return `react:${key}`;
            }
          }
        }
        for (const key of Object.getOwnPropertyNames(node)) {
          if (!/^__reactFiber\$/.test(key)) continue;
          let fiber = node[key];
          for (let depth = 0; fiber && depth < 8; depth += 1, fiber = fiber.return) {
            const handler = fiber.memoizedProps?.onClick || fiber.pendingProps?.onClick;
            if (typeof handler === 'function') {
              handler({ type: 'click', target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, persist() {} });
              return `fiber:${depth}`;
            }
          }
        }
        node.click();
        return 'native';
      }).catch(() => 'failed');
      await page.waitForTimeout(1200);
      after = await uploaderButtonState(frame, target);
      return {
        changed: !after.visible || after.disabled || after.text !== before.text,
        method: dispatched === 'failed' ? (clicked ? 'click' : 'none') : dispatched
      };
    };

    const confirmUpload = uploaderFrame.locator('button.next-btn-primary').filter({ hasText: /^确认上传/ }).last();
    if (!await confirmUpload.isVisible().catch(() => false)) {
      throw new Error(`国际站详情图已进入队列（${queued}/${imagePaths.length}），但没有找到“确认上传”按钮`);
    }

    const deadline = Date.now() + 90000;
    let uploaderAction = '';
    let uploaderActionAt = 0;
    let confirmAttempts = 0;
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
        const confirm = uploaderFrame.locator('button.next-btn-primary').filter({ hasText: /^确认上传/ }).last();
        if (await confirm.isVisible().catch(() => false) && !await confirm.isDisabled().catch(() => false)
          && confirmAttempts < 4 && Date.now() - uploaderActionAt >= 2200) {
          const result = await clickUploaderAction(uploaderFrame, confirm);
          confirmAttempts += 1;
          uploaderAction = '确认上传';
          uploaderActionAt = Date.now();
          if (result.changed) await page.waitForTimeout(500);
          continue;
        }
        for (const { key, pattern } of actionNames) {
          if (key === '确认上传' && confirmAttempts >= 4) continue;
          const action = uploaderFrame.getByRole('button', { name: pattern }).last();
          const textAction = uploaderFrame.getByText(pattern).last();
          const target = await action.isVisible().catch(() => false) ? action : textAction;
          if (!await target.isVisible().catch(() => false)) continue;
          const disabled = await target.isDisabled().catch(() => false);
          if (disabled || (uploaderAction === key && Date.now() - uploaderActionAt < 2500)) continue;
          await clickUploaderAction(uploaderFrame, target);
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
    const finalUploaderFrame = page.frames().find((frame) => /photobank\.alibaba\.com\/uploader\.htm/i.test(frame.url()));
    const buttons = finalUploaderFrame ? await finalUploaderFrame.locator('button, [role="button"], input[type="button"], input[type="submit"]').evaluateAll((nodes) => nodes.map((node) => ({
      text: String(node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
      visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
      className: String(node.className || '').slice(0, 120)
    })).filter((item) => item.visible)) : [];
    const uploaderText = finalUploaderFrame ? compactText(await finalUploaderFrame.locator('body').innerText().catch(() => ''), 1200) : '';
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

  async listSellerGroups(categoryId = '') {
    const url = buildAlibabaPublishUrl(normalizeCategoryId(categoryId) || '201346401');
    await this.open({ startUrl: url });
    const page = await this.context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitForHumanVerification(page);
      return await readSellerGroups(page);
    } finally { await page.close(); }
  }

  async publishProduct(product, publishPageUrl, mode = 'draft', publishCategory = '', jobId = '', onStage = () => {}, options = {}) {
    this.publishPageSnapshot = null;
    let lastStage = '';
    const reportStage = (stage) => {
      if (options.signal?.aborted) throw options.signal.reason;
      if (stage !== '正在恢复当前页面操作') lastStage = stage;
      try { onStage(stage); } catch {}
    };
    reportStage('检查商品资料');
    product = preparePublishProduct(product, options);
    requireSupportedVideoPlan(product, options);
    if (!publishPageUrl) throw new Error('尚未绑定阿里巴巴国际站商品发布页面');
    if (!isProductPostingUrl(publishPageUrl)) throw new Error('绑定地址不是阿里巴巴国际站商品发布页');
    const mismatch = categoryMismatchMessage(product, publishCategory);
    if (mismatch) throw new Error(mismatch);
    const validationErrors = validateProductData(product, { mode });
    if (validationErrors.length) throw new Error(`商品资料未通过上架检查：${validationErrors.join('；')}`);
    // Only download the current product's media in advance. All sets share
    // a bounded queue; low-memory machines use one image worker. Browser uploads
    // and submission remain sequential.
    const mediaController = new AbortController();
    const mediaSignal = options.signal ? AbortSignal.any([options.signal, mediaController.signal]) : mediaController.signal;
    return imageDownloadContext.run({ signal: mediaSignal, cancel: reason => mediaController.abort(reason) }, async () => {
      this.imageDownloads.limit = browserResourcePolicy().imageConcurrency;
      const mediaReady = Promise.allSettled([
        this.downloadImageSet(product, product.mainImages?.length ? product.mainImages : [product.mainImage, ...(product.images || [])], 'main', 6),
        this.downloadImageSet(product, product.detailImages || [], 'detail', (product.detailImages || []).length),
        ...[...new Set((product.variantGroups || []).find(isColorVariantGroup)?.options || [])].slice(0, 12).map((value, index) => {
          const group = product.variantGroups.find(isColorVariantGroup);
          return this.downloadImageSet(product, [group.optionImages?.[value] || group.optionImages?.[englishSpecText(value)]], `spec-color-${index}`, 1);
        }),
      ]);
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            return await withPostingPolicy({ ...options, onProgress: reportStage },
              () => this.publishPreparedProduct(product, publishPageUrl, mode, publishCategory, jobId, reportStage, options));
          } catch (error) {
            // These typed errors only originate while preparing the form, before
            // any save/submit. Never replay a submission with an unknown receipt.
            if (options.signal?.aborted || attempt || error.code !== 'PUBLISH_FORM_NOT_READY') throw error;
            reportStage('发布页加载不完整，重新加载后重试一次');
          }
        }
      } catch (error) {
        error.diagnostics = { ...(error.diagnostics || {}), publishStage: lastStage };
        throw error;
      } finally {
        // A failed form or completed receipt no longer needs speculative media.
        // Cancel before awaiting cleanup so queued retries cannot delay a pause.
        mediaController.abort();
        this.clearPublishStop(jobId);
        await mediaReady;
      }
    });
  }

  async publishPreparedProduct(product, publishPageUrl, mode, publishCategory, jobId, reportStage, options) {
    product = productForVideoUpload(product, options);
    // Decisions belong to this form attempt; never leak an automatic decision
    // into another product or change the caller's requested sales policy.
    options = { ...options, onLogisticsDecision: reportStage };
    const resources = browserResourcePolicy();
    const connection = new AbortController();
    const media = imageDownloadContext.getStore();
    const stopKey = String(jobId || '');
    let page;
    const stop = () => {
      media?.cancel(options.signal?.reason || Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' }));
      connection.abort();
      page?.close().catch(() => {});
    };
    this.clearPublishStop(stopKey);
    stop.dispose = () => options.signal?.removeEventListener('abort', stop);
    this.publishStops.set(stopKey, stop);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    reportStage(resources.constrained ? '连接国际站发布浏览器（已自动降低图片处理并发，延长页面等待）' : '连接国际站发布浏览器');
    page = await this.createProductPage(publishPageUrl, { signal: connection.signal, onProgress: reportStage });
    this.publishingPage = { page, jobId: String(jobId || ''), productId: String(product.id || '') };
    if (connection.signal.aborted) {
      page.close().catch(() => {});
      throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' });
    }
    page.setDefaultTimeout(5000);
    configurePostingInteractions(page, { recover: (target) => recoverPostingClick(page, target), onProgress: reportStage, signal: connection.signal });
    // Publishing uses a normal headless viewport without a desktop window or
    // taskbar entry. Progress and platform validation remain in the workbench.
    // Only retry navigation before any product fields or submission are touched.
    // A timeout waiting for DOMContentLoaded is distinct from a rejected field.
    const publishNavigation = { timeout: resources.navigationTimeoutMs, attempts: 2, retryTimeout: true, retryInterrupted: true,
      signal: connection.signal,
      onRetry: ({ attempt, attempts }) => reportStage(`发布页连接未完成，正在重试打开（${attempt}/${attempts}，尚未填写或提交）`),
    };
    reportStage('打开目标类目发布页');
    await gotoWithRetry(page, publishPageUrl, publishNavigation);
    await settlePage(page);
    await waitForHumanVerification(page);
    // Electron owns the authenticated browser partition. Refresh its exported
    // cookies once more before classifying a login redirect, then retry the
    // publish navigation in the already-created Playwright context.
    if (/login|passport/i.test(page.url())) {
      await globalThis.__KUA_YIPU_SELLER_BRIDGE?.sync?.().catch(() => false);
      await syncAlibabaCookies(page.context(), { force: true });
      await gotoWithRetry(page, publishPageUrl, publishNavigation).catch(() => {});
      await settlePage(page);
      await waitForHumanVerification(page);
    }
    await requirePostingPageAvailable(page);
    const expectedCategoryId = normalizeCategoryId(product.categoryId || product.sourceCategoryId);
    // A generated catId URL can legitimately land on Alibaba's category
    // chooser when the seller session has not used that leaf before. Complete
    // that chooser automatically so users never need to bind one publish page
    // per product or per category.
    reportStage('确认并进入目标类目表单');
    await enterPostingForm(page, publishPageUrl, expectedCategoryId);
    await requirePostingPageAvailable(page);
    await waitForPostingTitle(page, { verify: () => waitForHumanVerification(page), onProgress: reportStage });
    requireNewProductPage(page.url());
    const initialSchema = postingSchemaWithKnownLabels(product, await page.evaluate(readPostingAttributeSchema));
    product = bindSourceAttributesToPostingSchema(product, initialSchema);
    await ensureSimplifiedChinese(page, {
      onProgress: reportStage, verify: () => waitForHumanVerification(page),
      beforeSwitch: () => requireClearPostingOverlays(page), signal: connection.signal, reloadOnMismatch: true,
    });
    requireNewProductPage(page.url());
    const actualCategoryId = categoryIdFromUrl(page.url()) || categoryIdFromUrl(publishPageUrl);
    if (expectedCategoryId && actualCategoryId && expectedCategoryId !== actualCategoryId) {
      throw new Error(`国际站实际打开类目 ID ${actualCategoryId}，与商品目标类目 ID ${expectedCategoryId} 不一致，已停止发布`);
    }
    if (/\/product\/(?:easyListing|category)\.htm/i.test(new URL(page.url()).pathname)) {
      throw Object.assign(new Error('国际站类目选择页尚未进入商品表单，请检查目标类目后继续'), { code: 'PUBLISH_FORM_NOT_READY' });
    }

    await waitForPostingTitle(page, { verify: () => waitForHumanVerification(page), onProgress: reportStage });
    const postingText = compactText(await page.locator('body').innerText().catch(() => ''), 5000);
    const descriptionFormat = await ensureSourceDescriptionMode(page, product, { onProgress: reportStage,
      beforeInteraction: () => requireClearPostingOverlays(page) });
    const descriptionConversion = descriptionCompatibility(page, product);
    if (descriptionFormat === 'structured') {
      await requireStructuredDescriptionReady(page, { html: buildLegacyDescriptionHtml(product),
        structure: currentDescriptionStructure(product), imageUrls: product.detailImages || [], highlights: structuredHighlightText(product) });
    } else {
      await waitForDescriptionEditor(page, { switchMode: () => prepareDescriptionEditor(page),
        verify: () => waitForHumanVerification(page), onProgress: reportStage });
    }
    const visibleCategory = postingText.match(/当前类目\s*[:：]\s*(.+?)(?=切换类目|基本信息|商品图片|$)/)?.[1]?.trim() || '';
    const categoryValidatedById = Boolean(expectedCategoryId && actualCategoryId && expectedCategoryId === actualCategoryId);
    const visibleMismatch = !categoryValidatedById && visibleCategory ? categoryMismatchMessage(product, visibleCategory) : '';
    if (visibleMismatch) {
      throw new Error(`国际站发布表单实际类目为“${visibleCategory}”：${visibleMismatch}`);
    }
    // Capture the untouched baseline only. Conditional fields mounted by this
    // product's values must not become mandatory for all products in the leaf.
    const baselineSchema = (await page.evaluate(readPostingAttributeSchema)).map((field) => ({ ...field,
      labels: [...new Set([...(field.labels || [field.label]), ...(initialSchema.find((initial) => field.id && initial.id === field.id)?.labels || [])])] }));
    await options.onCategorySchema?.(categoryRequirementSchema(expectedCategoryId || actualCategoryId, baselineSchema));
    if (options.sellerGroup) {
      reportStage('检查国际站目标分组');
      await applySellerGroup(page, options.sellerGroup);
    }
    reportStage('按当前类目预检必填属性');
    await fillCategoryAttributes(page, product, reportStage);
    const attributeAi = createAttributeAiSession({ resolve: options.resolveAttributeMappings,
      readSchema: () => page.evaluate(readPostingAttributeSchema),
      fill: input => fillCategoryAttributes(page, input, reportStage),
      matches: (field, source) => attributeFieldMatchesValue(field, source.value, {
        valueIds: source.matchedById ? source.valueIds : {}, labels: optionLabels(page, field), source,
      }), onAudit: options.onAiMapping, onProgress: reportStage });
    const aiMappingAudits = attributeAi.audits;
    product = (await attributeAi.run(product)).product;
    await options.onProductSchema?.(categoryRequirementSchema(expectedCategoryId || actualCategoryId, await page.evaluate(readPostingAttributeSchema)));
    if (mode === 'submit') await requireCategoryAttributes(page, product);
    // Switching Alibaba's detail editor can rebuild the entire form. Do it
    // before filling prices, specifications and images so a late editor-mode
    // transition cannot silently erase already completed fields.
    reportStage('填写详情并上传详情图');
    await this.fillLegacyDescription(page, product, reportStage);
    reportStage('填写标题、价格和库存');
    const titleInput = await waitForPostingTitle(page, { verify: () => waitForHumanVerification(page), onProgress: reportStage });
    await fillAndVerify(titleInput, product.title, '商品标题');

    await fillProductSubtitle(page, product);

    reportStage('填写并复核商品关键词');
    await fillProductKeywords(page, product);

    // Per-SKU controls are created only after the specification matrix.
    if (!usesSkuPricing(product)) await this.fillPriceFields(page, product, { onProgress: reportStage });
    await fillFirst(page, [
      'input[placeholder="输入数量"]',
      'input[placeholder*="库存"]', 'input[placeholder*="stock" i]', 'input[placeholder*="quantity" i]', 'input[name*="stock" i]',
      '[class*="stock"] input[type="text"]', '[class*="stock"] input[type="number"]'
    ], product.stock);
    reportStage('填写类目属性和产品规格');
    const fieldMapping = await this.fillProductFields(page, product, reportStage, options);
    if (mode === 'submit') {
      const unmappedRequiredVariant = fieldMapping.blockingUnmapped?.[0]
        || findBlockingUnmappedVariant(product, fieldMapping.unmappedAttributes);
      if (unmappedRequiredVariant) {
        const failure = fieldMapping.variantFailures?.find((item) => item.values.some((value) => `${item.name}: ${value}` === unmappedRequiredVariant));
        if (failure) throw variantTransferFailure(failure);
        throw new Error(`国际站目标类目没有与来源规格“${unmappedRequiredVariant}”一致的选项；为保证数据不被篡改，请先在发布页选择匹配类目或人工映射后再提交`);
      }
    }
    reportStage('上传商品主图');
    await this.uploadMainImages(page, product, reportStage);
    const { main: videoResult, details: detailVideoResults } = await this.uploadProductVideos(page, product, { ...options, onProgress: reportStage });
    // Main/detail uploaders can re-render the specification card and restore
    // its top-level checkbox from stale form state. Recommit the complete
    // source color transaction immediately before submit: selected spec,
    // exact source value, and its uploaded source image must all be present.
    reportStage('复核颜色、型号和规格图片');
    const finalColorGroup = (product.variantGroups || []).find(isColorVariantGroup);
    const finalColorId = await colorSaleAttributeId(page);
    const finalColorValues = [...new Set(finalColorGroup?.options || [])].map((value) => englishSpecText(value)).filter(Boolean);
    const finalUsesColorSaleSpec = shouldUseColorSaleSpecification(
      finalColorGroup,
      await saleAttributeIsAvailable(page, finalColorId)
    );
    const finalHasColorImage = finalUsesColorSaleSpec && finalColorValues.some((value) => Boolean(
      finalColorGroup?.optionImages?.[value]
      || finalColorGroup?.optionImages?.[finalColorGroup.options?.find((item) => englishSpecText(item) === value)]
    ));
    const finalColorRequired = finalColorValues.length > 0;
    if (finalUsesColorSaleSpec && finalHasColorImage && finalColorRequired) {
      if (!await ensureColorSpecificationReady(page)) {
        throw new Error('国际站颜色规格提交前复核失败：颜色规格未能启用');
      }
      const colorFilled = await fillColorSpec(page, finalColorValues, reportStage);
      const colorImageUploaded = colorFilled && await enableSpecImageUpload(
        page,
        product,
        finalColorGroup,
        (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit),
        reportStage
      );
      const finalColorSelected = await saleAttributeIsSelected(page, finalColorId);
      if (!colorFilled || !finalColorSelected) {
        throw new Error('国际站颜色规格提交前复核失败：来源颜色规格值未保留');
      }
      if (!colorImageUploaded) {
        throw new Error('国际站颜色规格提交前复核失败：来源规格图片未被表单接收');
      }
    }
    const finalVariantResult = await fillVariantSpecs(page, product, reportStage);
    fieldMapping.variantFailures = finalVariantResult.failures;
    const finalUnmappedVariant = finalVariantResult.blockingUnmapped?.[0]
      || findBlockingUnmappedVariant(product, finalVariantResult.unmapped);
    if (finalUnmappedVariant) {
      const failure = finalVariantResult.failures.find((item) => item.values.some((value) => `${item.name}: ${value}` === finalUnmappedVariant));
      if (failure) throw variantTransferFailure(failure);
      throw new Error(`国际站规格提交前复核失败：来源规格“${finalUnmappedVariant}”未保留`);
    }
    const finalHasImageBackedVariant = finalVariantResult.groups.some((group) => Object.values(group.optionImages || {}).some(Boolean));
    const preserveMultiDimensionImages = finalHasImageBackedVariant && finalVariantResult.groups.length > 1;
    if (finalHasImageBackedVariant && !await enableImageBackedVariantSpecs(
      page,
      product,
      finalVariantResult.groups,
      (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit),
      reportStage
    )) {
      if (!fieldMapping.warnings.includes('当前类目未开放规格图开关；规格组合已保留，来源图片继续保留在商品主图和详情图中')) {
        fieldMapping.warnings.push('当前类目未开放规格图开关；规格组合已保留，来源图片继续保留在商品主图和详情图中');
      }
    }

    // Uploaders and rich-text editors can rerender the form after the first
    // field pass. Re-apply the all-or-nothing logistics rule immediately
    // before the final action so stale weight/volume values cannot survive.
    reportStage('复核物流和必填资料');
    await fillDeliveryFields(page, product.deliveryTime);
    await applyPostingLogistics(page, product, options);
    reportStage(usesSkuPricing(product) ? '复核各规格价格' : '复核价格阶梯');
    await this.fillPriceFields(page, product, { onProgress: reportStage });
    await fillReferencedSkuRows(page, product, fillAndVerify, reportStage, { appliedGroups: finalVariantResult.groups, normalizeValue: englishSpecText });

    // A specification or uploader rerender may replace the image component.
    // Reconcile against the real preview state immediately before submission.
    await this.reconcileMainImages(page, product, reportStage);

    // Saving a draft rebuilds Alibaba's entire controlled form. On several
    // categories that rebuild discarded required attributes or the image
    // model even though their previews remained visible. Keep direct submit
    // truly direct; the old checkpoint is available only for diagnostics.
    const useDraftCheckpoint = process.env.KUA_YIPU_PUBLISH_DRAFT_CHECKPOINT === '1';
    if (mode === 'submit' && useDraftCheckpoint && !preserveMultiDimensionImages) {
      let draftAction = null;
      for (const text of ['保存草稿', '存为草稿', '暂存草稿', 'Save as Draft', 'Save Draft']) {
        const candidate = page.getByRole('button', { name: text, exact: false }).last();
        if (await candidate.isVisible().catch(() => false) && !await candidate.isDisabled().catch(() => false)) {
          draftAction = candidate;
          break;
        }
      }
      if (draftAction) {
        const draftUrl = page.url();
        reportStage('保存提交前检查点');
        await waitForActionResult(page, draftAction, 'draft', draftUrl);
        await page.waitForTimeout(4200);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await settlePage(page);
        // Alibaba may preserve the visual previews while rebuilding the form
        // with an empty image field after a draft checkpoint. Recommit the
        // source images once after that rerender so the final submit carries
        // server-issued image records, not only client-side thumbnails.
        const draftImageState = await mainImageFormState(page);
        if (draftImageState.occupied >= 4 && !draftImageState.uploading) {
          const reset = await clearMainImagesForRetry(page);
          if (reset) await this.uploadMainImages(page, product, reportStage);
        }

        // Saving a draft rebuilds Alibaba's specification component. Custom
        // values survive that rebuild, but the specification-image switch is
        // reset to off. Restore and verify image-backed specifications after
        // the checkpoint so the final validator sees their server-side media.
        if (finalHasImageBackedVariant && !await enableImageBackedVariantSpecs(
          page,
          product,
          finalVariantResult.groups,
          (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit),
          reportStage
        )) {
          throw new Error('保存草稿后国际站规格图状态未能恢复，已停止提交以避免生成缺图商品');
        }
      }
    }

    // Saving drafts and uploading media can restore a stale, checked sales
    // attribute without any value. Alibaba reports only "属性值不能为空" for
    // that state, so remove those empty optional selections before submit.
    await clearEmptySaleAttributeSelections(page);
    const emptyRequiredSpecs = await emptyRequiredSpecificationLabels(page, true);
    if (emptyRequiredSpecs.length) {
      await recoverRequiredAttributes(page, product, emptyRequiredSpecs, reportStage);
      const remaining = await emptyRequiredSpecificationLabels(page, true);
      if (remaining.length && mode === 'submit') {
        const failure = finalVariantResult.failures.find((item) => remaining.some((label) => requiredAttributeKey(label) === requiredAttributeKey(item.targetLabel)));
        if (failure) throw variantTransferFailure(failure);
        throw await requiredAttributeFailure(page, product, remaining);
      }
    }
    if (mode === 'submit') {
      const earlyFeedback = (await visibleFeedback(page)).join(' ');
      if (isRequiredAttributeError(earlyFeedback)) {
        const earlyLabels = [...new Set([
          ...await visibleEmptyAttributeLabels(page),
          ...requiredLabelsFromError(earlyFeedback)
        ])];
        await recoverRequiredAttributes(page, product, earlyLabels, reportStage);
      }
    }

    // Media/specification updates can reset category fields after the initial
    // preflight. Reconcile against the complete source value set before the
    // final action, including partially retained multi-select values.
    reportStage('逐项复核类目属性');
    await fillCategoryAttributes(page, product, reportStage);
    product = (await attributeAi.run(product, { phase: 'final-check' })).product;
    const finalAttributePlan = planPublicAttributeTransfer(product, await page.evaluate(readPostingAttributeSchema));
    reportStage('逐项复核自定义属性');
    await fillCustomAttributes(page, finalAttributePlan.product, fillAndVerify);
    fieldMapping.attributeTransfer = await requirePublicAttributeTransfer(page, product);
    const readinessWarnings = [];
    try { await requireCategoryAttributes(page, product); }
    catch (error) {
      if (mode === 'submit') throw error;
      readinessWarnings.push(error.message);
    }
    const unresolvedAttributes = await emptyRequiredSpecificationLabels(page, true);
    if (mode !== 'submit' && unresolvedAttributes.length) readinessWarnings.push(`草稿待补充必填属性：${unresolvedAttributes.join('、')}`);
    try { await requireLogisticsReady(page, product, options); }
    catch (error) {
      if (mode === 'submit') throw error;
      readinessWarnings.push(error.message);
    }

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
      throw Object.assign(new Error('商品资料已填写，等待国际站提交入口就绪；已保留当前商品进度，请稍后继续'), { code: 'PUBLISH_CONTROL_NOT_READY' });
    }
    reportStage(mode === 'submit' ? '提交国际站并等待结果' : '保存国际站草稿');
    const originalUrl = page.url();
    let sellerGroup = null;
    let additionalFields = { regionalPrices: [], warnings: [] };
    let basicFields;
    const descriptionTextConversions = legacyDescriptionTextConversions(page);
    const verification = await submitWithRepairs({
      submit: async () => {
        if (options.sellerGroup) {
          reportStage('设置并复核国际站商品分组');
          sellerGroup = await applySellerGroup(page, options.sellerGroup);
          reportStage(mode === 'submit' ? '提交国际站并等待结果' : '保存国际站草稿');
        }
        // Recheck after all repairs: specification changes can reset main
        // images even if the preceding image repair itself succeeded.
        await this.reconcileMainImages(page, product, reportStage);
        if (usesSkuPricing(product)) {
          await this.fillPriceFields(page, product, { onProgress: reportStage });
          await fillReferencedSkuRows(page, product, fillAndVerify, reportStage, { appliedGroups: finalVariantResult.groups, normalizeValue: englishSpecText });
        }
        // Optional commerce settings must survive every image/specification
        // repair and price-table rebuild, not merely their first write.
        additionalFields = await this.fillAdditionalProductFields(page, product, reportStage);
        try { await requireLogisticsReady(page, product, options); }
        catch (error) {
          if (mode === 'submit') throw error;
          if (!readinessWarnings.includes(error.message)) readinessWarnings.push(error.message);
        }
        // Repairs and optional controls can rebuild native attributes. Verify
        // every source public row again immediately before each submission.
        fieldMapping.attributeTransfer = await requirePublicAttributeTransfer(page, product);
        const subtitleAccepted = await fillProductSubtitle(page, product);
        const keywordsAccepted = await fillProductKeywords(page, product);
        await requireSourceDescriptionMode(page, product);
        if (descriptionCompatibility(page, product)) await requireCompatibleLegacyDescription(page, product);
        else await requireAcceptedNativeDescription(page, product);
        const structuredHighlights = await acceptedStructuredHighlights(page, product);
        basicFields = {
          subtitle: { status: !product.subtitle ? 'not-supplied' : subtitleAccepted ? 'committed' : 'unavailable', value: product.subtitle || '', destination: structuredHighlights ? 'product-highlights' : 'subtitle' },
          keywords: { status: !alibabaKeywordText(product) ? 'not-supplied' : keywordsAccepted ? 'committed' : 'unavailable', value: alibabaKeywordText(product),
            destination: structuredHighlights ? 'product-highlights' : 'keywords',
            source: (product.keywords || []).some(value => String(value).trim()) ? 'product' : 'generated-from-title' },
        };
        if (videoResult?.inline) requireAcceptedInlineVideo(await page.evaluate(readPostingVideoState), videoResult.inline);
        for (const text of buttonTexts) {
          const candidate = page.getByRole('button', { name: text, exact: false }).last();
          if (await candidate.isVisible().catch(() => false) && !await candidate.isDisabled().catch(() => false)) {
            fieldMapping.salesUnit = await requireSalesUnit(page, product);
            fieldMapping.minimumOrder = await reconcileSkuMinimumOrder(page, product);
            // MOQ/specification changes can remount delivery controls. Commit
            // every source tier after those changes and immediately before save.
            fieldMapping.deliveryTime = await fillDeliveryFields(page, product.deliveryTime);
            reportStage(mode === 'submit' ? '提交国际站并等待结果' : '保存国际站草稿');
            return waitForActionResult(page, candidate, mode, originalUrl);
          }
        }
        throw new Error('国际站提交按钮未就绪，请检查当前发布页面');
      },
      beforeRepair: () => dismissPostingOverlays(page),
      onRepair: (field, attempt) => reportStage(`自动修复第 ${attempt} 次：${{
        overlay: '关闭遮挡弹窗',
        specifications: '复核规格值和全部规格图片',
        attributes: '补填来源必填属性',
        logistics: '重新填写并复核来源物流资料',
        mainImages: '重新上传并确认商品主图',
      }[field]}`),
      repairs: {
        overlay: () => dismissPostingOverlays(page),
        specifications: async (error) => {
          const result = await fillVariantSpecs(page, product, reportStage);
          const blocked = result.blockingUnmapped?.[0] || findBlockingUnmappedVariant(product, result.unmapped);
          if (blocked) throw new Error(`国际站规格修复失败：来源规格“${blocked}”未保留`);
          const download = (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit);
          const specImagesRepaired = await enableImageBackedVariantSpecs(page, product, result.groups, download, reportStage);
          const colorGroup = (product.variantGroups || []).find(isColorVariantGroup);
          const colorId = await colorSaleAttributeId(page);
          let colorRepaired = false;
          if (shouldUseColorSaleSpecification(colorGroup, await saleAttributeIsAvailable(page, colorId))) {
            colorRepaired = await fillColorSpec(page, colorGroup.options, reportStage);
            if (Object.values(colorGroup.optionImages || {}).some(Boolean)) {
              colorRepaired = await enableSpecImageUpload(page, product, colorGroup, download, reportStage);
            }
          }
          await fillReferencedSkuRows(page, product, fillAndVerify, reportStage, { appliedGroups: result.groups, normalizeValue: englishSpecText });
          if (SPECIFICATION_IMAGE_REQUIRED_TEXT.test(error.message || '')) {
            // Filling plain specification values cannot repair a missing
            // specification image. Retry only after a server image exists.
            return specImagesRepaired && await specImageIsUploaded(page.locator('#struct-specification'));
          }
          return specImagesRepaired && (result.groups.length > 0 || colorRepaired);
        },
        attributes: async (error) => {
          const emptyLabels = [...new Set([
            ...await visibleEmptyAttributeLabels(page),
            ...(error.requiredFields || []),
            ...requiredLabelsFromError(error.message),
          ])];
          error.requiredFields = emptyLabels;
          const recovered = await recoverRequiredAttributes(page, product, emptyLabels, reportStage);
          const cleared = await clearEmptySaleAttributeSelections(page);
          const mapped = await attributeAi.run(product, { phase: 'validation-repair',
            feedback: { code: error.code || 'PUBLISH_ATTRIBUTE_VALIDATION', fields: emptyLabels } });
          product = mapped.product;
          return recovered.length > 0 || cleared.length > 0 || mapped.changed;
        },
        logistics: () => repairPostingLogistics(page, product, options),
        mainImages: async () => {
          if (!await clearMainImagesForRetry(page)) return false;
          await this.uploadMainImages(page, product, reportStage);
          return true;
        },
      },
    });
    const videoAssociations = [];
    const bankVideos = [...(videoResult?.bank ? [{ ...videoResult.bank, role: 'main' }] : []), ...detailVideoResults.flatMap(item => item.bank ? [item.bank] : [])];
    for (const video of bankVideos) {
      reportStage('复核商品视频关联');
      videoAssociations.push(mode === 'submit' ? await completePublishedVideo(page, video, page.url())
        : { ...video, associated: false, pendingPublication: true });
    }
    const videoAssociation = combineVideoAssociations(videoAssociations);
    const videoWarning = videoAssociation?.warning || (videoResult?.inline && mode === 'submit' ? '主图视频已写入发布表单，公开展示仍待平台处理确认' : '');
    return {
      status: mode === 'submit' ? 'published' : 'drafted',
      message: `${mode === 'submit' ? '已提交发布' : '已保存草稿'}${videoAssociation?.warning ? '（视频待关联）' : videoAssociation?.pendingPublication ? '（视频待发布后关联）' : videoWarning ? '（视频展示待确认）' : ''}`,
      url: page.url(),
      verifiedBy: verification.verifiedBy,
      sellerGroup,
      feedback: verification.feedback,
      requiredAttributes: verification.requiredAttributes || [],
      ...(aiMappingAudits.length ? { aiMapping: aiMappingAudits } : {}),
      acceptedLogistics: verification.acceptedLogistics,
      allowPolicyWarningPublish: options.allowPolicyWarningPublish === true,
      policyAcknowledgements: policyAcknowledgements(),
      listingMode: options.effectiveListingMode || normalizeListingMode(options.listingMode),
      requestedListingMode: normalizeListingMode(options.listingMode),
      ...(options.logisticsDecision ? { logisticsDecision: options.logisticsDecision } : {}),
      stockProvenance: product.stockProvenance,
      fieldMapping,
      ...(descriptionTextConversions.length ? { descriptionTextConversions } : {}),
      ...(descriptionConversion ? { descriptionCompatibility: {
        sourceFormat: descriptionConversion.sourceFormat, targetFormat: descriptionConversion.targetFormat,
        reason: descriptionConversion.reason,
      } } : {}),
      additionalFields,
      basicFields,
      videoAssociation,
      ...(videoResult?.inline ? { inlineVideo: { ...videoResult.inline, role: 'main', verifiedBy: 'form-model', displayVerified: false } } : {}),
      videoUploadEnabled: options.uploadProductVideos !== false,
      warnings: [
        product.variantGroups?.some(group => group.optionIdentityMappings?.some(option => option.name !== option.sourceName))
          ? '来源中同名但编号不同的规格已增加区分编号；各 SKU 的图片、价格、编码和库存分别保留' : '',
        descriptionConversion?.warning || '',
        descriptionTextConversions.length ? '详情中的单位符号 ㎡ 已以等价写法 m2 填写，原始采集内容保留' : '',
        videoWarning,
        ...(options.logisticsWarnings || []),
        basicFields?.subtitle.status === 'unavailable' ? '当前发布页未提供副标题输入项，副标题保留在本地商品中' : '',
        basicFields?.keywords.status === 'unavailable' ? '当前发布页未提供关键词输入项，关键词未提交' : '',
        ...readinessWarnings,
        ...additionalFields.warnings,
        ...(fieldMapping.warnings || []),
        ...(fieldMapping.variantFailures || []).map((failure) => variantTransferFailure(failure).message),
        fieldMapping.unmappedAttributes.length ? `${fieldMapping.unmappedAttributes.length} 项来源属性或规格尚未完整写入，请查看具体原因` : ''
      ].filter(Boolean)
    };
  }

  async fillAdditionalProductFields(page, product, onProgress = () => {}) {
    onProgress('复核商品服务、关联证书和地区价格');
    const download = (urls, prefix, count) => this.downloadImageSet(product, urls, prefix, count);
    const warnings = await fillOptionalServices(page, product, { fill: fillAndVerify, choose: fillChoice,
      uploadImage: (card, url) => uploadCustomizationImage(page, card, url, download),
      fillHotspot: (section, group) => fillCustomizationHotspot(page, section, group, download),
    });
    const regionalPrices = await fillRegionalPrices(page, product, fillAndVerify);
    return { regionalPrices, warnings };
  }
}
