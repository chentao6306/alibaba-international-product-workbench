import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { load } from 'cheerio';
import { hasExplicitHumanChallenge, hidePage, launchPersistent, revealPage, settlePage, syncAlibabaCookies, waitForHumanVerification } from './browser-runtime.js';
import { extractAlibabaSourceData, parseAlibabaDetailDataScript } from './alibaba-source-data.js';
import { SOURCE_LANGUAGE_HEADERS, withSourceLocale } from './source-locale.js';
import { categoryIdFromUrl, normalizeCategoryId } from './category-routing.js';

const WORKBENCH_URL = 'https://i.alibaba.com/';
const TITLE_SELECTORS = [
  'input[name="productTitle"]',
  'input[placeholder*="商品标题"]', 'input[placeholder*="标题"]',
  'input[placeholder*="product title" i]', 'input[placeholder*="product name" i]',
  'input[placeholder*="enter a title" i]', 'input[name*="title" i]',
  'textarea[placeholder*="标题"]', 'textarea[placeholder*="title" i]',
  '[contenteditable="true"][aria-label*="title" i]', '[contenteditable="true"][data-testid*="title" i]'
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
  const sourceCategoryId = normalizeCategoryId(product.sourceCategoryId || product.categoryId);
  return {
    ...product,
    ...(categoryPath.length ? { sourceCategoryPath: categoryPath } : {}),
    ...(sourceCategoryId ? { sourceCategoryId, categoryId: product.categoryId || sourceCategoryId } : {}),
    productType, keywords, subtitle, description
  };
}

const CATEGORY_LEAF_ALIASES = new Map([
  ['drones accessories', 'drones accessories'], ['无人机配件', 'drones accessories'],
  ['camera photo accessories', 'camera photo accessories'], ['相机照片配件', 'camera photo accessories'],
  ['other consumer electronics', 'other consumer electronics'], ['其他消费电子产品', 'other consumer electronics'],
  ['rugged phone', 'rugged phone'], ['坚固型手机', 'rugged phone'],
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

async function fillAndVerify(locator, value, fieldName) {
  const expected = String(value ?? '').trim();
  const matches = (actual) => {
    const normalized = String(actual || '').replace(/,/g, '').trim();
    if (normalized === expected) return true;
    const expectedNumber = Number(expected);
    const actualNumber = Number(normalized);
    return expected !== '' && Number.isFinite(expectedNumber) && Number.isFinite(actualNumber) && expectedNumber === actualNumber;
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
    }, expected);
    await locator.page().waitForTimeout(150);
    actual = (await locator.inputValue().catch(() => '')).trim();
  }
  if (!matches(actual)) throw new Error(`${fieldName}写入失败，国际站输入框未保留内容`);
}

async function gotoWithRetry(page, url, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 4));
  const navigationOptions = {
    waitUntil: options.waitUntil || 'domcontentloaded',
    timeout: options.timeout || 60000
  };
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await page.goto(url, navigationOptions);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const transient = /ERR_(?:CONNECTION_(?:CLOSED|RESET|ABORTED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED|HTTP2_PROTOCOL_ERROR|SOCKET_NOT_CONNECTED)/i.test(message);
      if (!transient || attempt === attempts - 1 || page.isClosed()) throw error;
      const backoff = [2000, 5000, 10000][attempt] || 10000;
      await page.waitForTimeout(backoff);
    }
  }
  throw lastError;
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

const SUBMIT_SUCCESS_TEXT = /(?:发布成功|提交成功|已提交发布|审核中|产品信息已经成功提交|产品已经进入审核流程|您的产品信息已经成功提交|您的产品已经进入审核流程|successfully\s+(?:submitted|published)|submitted successfully)/i;
const DRAFT_SUCCESS_TEXT = /(?:保存成功|草稿.*成功|已保存|successfully\s+saved|saved successfully)/i;
const BLOCKING_FEEDBACK_TEXT = /(?:报错反馈|错误项|必填项.*不能为空|请上传相关产品图片|请不要输入如下非英文字符|required|invalid)/i;

export function classifyAlibabaActionResult({ mode = 'draft', url = '', originalUrl = '', feedback = [], bodyText = '' } = {}) {
  const messages = Array.isArray(feedback) ? feedback.filter(Boolean) : [];
  const feedbackText = messages.join(' ');
  const combinedText = `${feedbackText} ${String(bodyText || '')}`;
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

  const blockingFeedback = BLOCKING_FEEDBACK_TEXT.test(feedbackText);
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
  if (navigatedAway) return { succeeded: true, verifiedBy: 'navigation', blockingFeedback };
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
      const result = classifyAlibabaActionResult({ mode, url, originalUrl, feedback });
      if (result.succeeded) return { verifiedBy: result.verifiedBy, feedback, responses };
    }
    const feedback = await visibleFeedback(page);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    // The success page can render immediately after the polling deadline. The
    // final snapshot must be classified before it is used to build an error.
    const finalResult = classifyAlibabaActionResult({
      mode,
      url: page.url(),
      originalUrl,
      feedback,
      bodyText
    });
    if (finalResult.succeeded) {
      return { verifiedBy: finalResult.verifiedBy, feedback, responses };
    }
    const relevant = feedback
      .filter((text) => /必填|不能为空|请填写|请上传|请不要输入|非英文|至少|错误|失败|error|required/i.test(text))
      .sort((left, right) => left.length - right.length);
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

const SOURCE_ATTRIBUTE_LABEL_ALIASES = new Map([
  ['private mold', ['私模']],
  ['material', ['材质']],
  ['feature', ['功能', '特性', '功能/特性']],
  ['features', ['功能', '特性', '功能/特性']],
  ['brand name', ['品牌名称']],
  ['place of origin', ['产地']],
  ['model number', ['型号']]
]);

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
  const sourceRange = product.sourcePriceRange || {};
  const hasSourceRange = numericValue(sourceRange.minPrice) > 0
    && numericValue(sourceRange.maxPrice) >= numericValue(sourceRange.minPrice);
  if ((product.skus || []).some((sku) => sku.price != null && sku.price !== '' && numericValue(sku.price) <= 0)) errors.push('SKU 价格无效');
  if ((product.skus || []).some((sku) => sku.stock != null && numericValue(sku.stock) < 0)) errors.push('SKU 库存无效');
  if (!hasSourceRange && (product.skus || []).some((sku) => sku.price == null || sku.price === '')) errors.push('SKU 缺少价格');
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

export function mainImageSlotsComplete(initialSlotCount, remainingSlotCount, expectedCount) {
  const initial = Math.max(0, Number(initialSlotCount) || 0);
  const remaining = Math.max(0, Number(remainingSlotCount) || 0);
  const expected = Math.max(0, Number(expectedCount) || 0);
  return remaining <= Math.max(0, initial - expected);
}

async function mainImageFormState(page) {
  return page.locator('.image-uploader .image-upload-list-item').evaluateAll((nodes) => {
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const slots = nodes.filter(visible);
    const empty = slots.filter((slot) => visible(slot.querySelector('#image-placeholder-span'))).length;
    const uploading = slots.filter((slot) => /uploading|loading|progress/i.test(String(slot.className || ''))
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
    return {
      total: slots.length,
      empty,
      uploading,
      occupied: remotePreviews,
      previews,
      remotePreviews,
      previewSchemes: previewUrls.map((source) => source.startsWith('//') ? 'protocol-relative' : source.split(':')[0] || '').filter(Boolean)
    };
  }).catch(() => ({ total: 0, empty: 0, uploading: 0, occupied: 0, previews: 0 }));
}

async function clearMainImagesForRetry(page) {
  const deleteAll = page.getByRole('button', { name: /删除全部图片|清空.*图片|delete all images/i }).last();
  if (!await deleteAll.isVisible().catch(() => false)) return false;
  await deleteAll.click({ force: true });
  await page.waitForTimeout(250);
  for (const pattern of [/^确定$/, /^确认$/, /^删除$/, /确认删除|confirm|delete/i]) {
    const confirm = page.getByRole('button', { name: pattern }).last();
    if (!await confirm.isVisible().catch(() => false)) continue;
    await confirm.click({ force: true }).catch(() => {});
    break;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await mainImageFormState(page);
    if (!state.uploading && state.occupied === 0 && state.empty >= 4) return true;
    await page.waitForTimeout(250);
  }
  return (await mainImageFormState(page)).occupied === 0;
}

export function distinctAlibabaImageUrls(urls = []) {
  const seen = new Set();
  const result = [];
  for (const value of urls.filter(Boolean)) {
    let key = String(value).trim().toLowerCase();
    try {
      const parsed = new URL(value);
      const file = decodeURIComponent(parsed.pathname.split('/').pop() || '');
      // CDN derivatives append transformations after the original extension,
      // for example Hxxx.jpg_960x960q80.jpg. They are the same source asset.
      key = file.replace(/\.(?:jpe?g|png|webp)_[^./]+\.(?:jpe?g|png|webp)$/i, (match) => match.split('_')[0]).toLowerCase() || key;
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function isRequiredTargetVariantGroup(group) {
  if (!group?.name || /颜色|colou?r/i.test(group.name)) return false;
  const options = [...new Set((group.options || []).map((value) => englishSpecText(value)).filter(Boolean))];
  if (options.length > 1) return true;
  const imageBacked = String(group.type || '').toUpperCase() === 'IMAGE'
    && Object.values(group.optionImages || {}).some(Boolean);
  const normalizedName = String(group.name || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // A single model with a source image is a real sale specification on forms
  // that require an SKU image. Other single-value fields (for example Socket
  // Standard) remain descriptive product data and must not block publishing.
  return imageBacked && /^(?:model(?: number)?|型号)$/.test(normalizedName);
}

export function findBlockingUnmappedVariant(product, unmappedAttributes = []) {
  const required = new Set();
  for (const group of product?.variantGroups || []) {
    if (!isRequiredTargetVariantGroup(group)) continue;
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

const LOGISTICS_FIELD_LABELS = {
  weight: ['单个产品毛重', 'single gross weight', 'gross weight', 'product weight'],
  length: ['长(CM/Piece)', '包装长度', 'package length', 'length(cm/piece)', 'length'],
  width: ['宽(CM/Piece)', '包装宽度', 'package width', 'width(cm/piece)', 'width'],
  height: ['高(CM/Piece)', '包装高度', 'package height', 'height(cm/piece)', 'height']
};

const LOGISTICS_FIELD_SELECTORS = {
  weight: [
    'input[name="pkgWeight"]', 'input[name*="pkgWeight" i]',
    'input[name*="grossWeight" i]', 'input[placeholder*="重量"]',
    'input[placeholder*="weight" i]'
  ],
  length: [
    'input[name="pkgLength"]', 'input[name*="pkgLength" i]',
    'input[name*="packageLength" i]', 'input[placeholder*="长(CM/Piece)" i]',
    'input[placeholder*="length" i]'
  ],
  width: [
    'input[name="pkgWidth"]', 'input[name*="pkgWidth" i]',
    'input[name*="packageWidth" i]', 'input[placeholder*="宽(CM/Piece)" i]',
    'input[placeholder*="width" i]'
  ],
  height: [
    'input[name="pkgHeight"]', 'input[name*="pkgHeight" i]',
    'input[name*="packageHeight" i]', 'input[placeholder*="高(CM/Piece)" i]',
    'input[placeholder*="height" i]'
  ]
};

const LOGISTICS_EXTRA_SELECTORS = [
  'input[name*="volume" i]', 'input[name*="shipping" i]',
  'input[name*="logistic" i]', 'input[name*="package" i]:not([name*="Length" i]):not([name*="Width" i]):not([name*="Height" i])',
  'input[placeholder*="体积"]', 'input[placeholder*="物流"]',
  'input[placeholder*="volume" i]', 'input[placeholder*="shipping" i]',
  'input[placeholder*="logistic" i]'
].join(', ');

async function logisticsFields(page) {
  const fields = {};
  for (const key of Object.keys(LOGISTICS_FIELD_LABELS)) {
    fields[key] = await firstVisible(page, LOGISTICS_FIELD_SELECTORS[key]);
    if (!fields[key]) fields[key] = await fieldByAnyLabel(page, LOGISTICS_FIELD_LABELS[key]);
  }
  return fields;
}

async function setLogisticsSectionEnabled(page, enabled) {
  const candidates = page.getByText(/包装运输\s*Packaging\s*&\s*shipping\s*specifications/i).last();
  if (!await candidates.isVisible().catch(() => false)) return false;
  let container = candidates.locator('xpath=ancestor::label[.//input[@type="checkbox"]][1]');
  if (!await container.count().catch(() => 0)) container = candidates.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]');
  const checkbox = container.locator('input[type="checkbox"]').first();
  if (!await checkbox.count().catch(() => 0)) return false;
  const checked = await checkbox.isChecked().catch(() => false);
  if (checked !== enabled) {
    if (enabled) await checkbox.check({ force: true }).catch(() => container.click({ force: true }).catch(() => {}));
    else await checkbox.uncheck({ force: true }).catch(() => container.click({ force: true }).catch(() => {}));
    await page.waitForTimeout(350);
  }
  return await checkbox.isChecked().catch(() => enabled) === enabled;
}

// Alibaba has changed the logistics form several times. Depending on the
// selected category it can render more than one logistics card (for example a
// product card and a "volume and weight including package" card), and the
// generated input names are not stable. Resolve controls from their nearby
// labels/containers instead of relying on one name or one optional checkbox.
async function syncLogisticsControls(page, values, { clear = false } = {}) {
  const numeric = {
    weight: numericValue(values.weight),
    length: numericValue(values.length),
    width: numericValue(values.width),
    height: numericValue(values.height)
  };
  numeric.volume = numeric.length > 0 && numeric.width > 0 && numeric.height > 0
    ? numeric.length * numeric.width * numeric.height
    : 0;
  return page.evaluate(({ numeric, clear }) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const logisticsHint = /logistic|shipping|package|packaging|volume|weight|length|width|height|物流|体积|重量|包装|尺寸|毛重|包装长|包装宽|包装高/i;
    const metric = (node, context) => {
      const ownText = `${node.name || ''} ${node.id || ''} ${node.placeholder || ''} ${node.getAttribute('aria-label') || ''}`;
      const classify = (text) => {
        if (/weight|gross|重量|毛重/i.test(text)) return 'weight';
        if (/length|包装长|\b长\b|长\s*[（(]/i.test(text)) return 'length';
        if (/width|包装宽|\b宽\b|宽\s*[（(]/i.test(text)) return 'width';
        if (/height|包装高|\b高\b|高\s*[（(]/i.test(text)) return 'height';
        if (/volume|体积/i.test(text)) return 'volume';
        return '';
      };
      // A shared logistics wrapper often contains all four labels. Classify
      // from the control's own metadata first so sibling labels cannot win.
      return classify(ownText) || classify(context);
    };
    const setter = (node, value) => {
      if (node instanceof HTMLSelectElement) {
        if (clear) node.selectedIndex = 0;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setValue?.call(node, clear ? '' : String(value));
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: clear ? 'deleteContentBackward' : 'insertText', data: clear ? null : String(value) }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.blur();
    };
    const controls = [];
    for (const node of document.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
      if (!visible(node) || node.disabled) continue;
      const ownText = `${node.name || ''} ${node.id || ''} ${node.placeholder || ''} ${node.getAttribute('aria-label') || ''}`;
      const nearbyText = clean(node.closest('label')?.textContent || node.parentElement?.textContent || '').slice(0, 450);
      let logisticsContext = logisticsHint.test(`${ownText} ${nearbyText}`);
      let parent = node.parentElement;
      for (let level = 0; parent && level < 6; level += 1, parent = parent.parentElement) {
        const className = typeof parent.className === 'string' ? parent.className : '';
        const id = parent.id || '';
        const parentText = clean(parent.textContent).slice(0, 700);
        if (logisticsHint.test(`${className} ${id}`) || /物流属性|体积与重量|包装运输|shipping specifications/i.test(parentText)) {
          logisticsContext = true;
          break;
        }
      }
      if (!logisticsContext) continue;
      const key = metric(node, nearbyText);
      if (!key) continue;
      controls.push({ node, key });
    }
    const seen = new Set();
    let count = 0;
    for (const { node, key } of controls) {
      if (seen.has(node)) continue;
      seen.add(node);
      setter(node, numeric[key]);
      count += 1;
    }
    return { count, keys: controls.map(({ key }) => key) };
  }, { numeric, clear }).catch(() => ({ count: 0, keys: [] }));
}

async function clearLogisticsFields(page, fields = null) {
  const targets = fields || await logisticsFields(page);
  const extras = page.locator(LOGISTICS_EXTRA_SELECTORS);
  const extraCount = await extras.count().catch(() => 0);
  const allFields = [...Object.values(targets)];
  for (let index = 0; index < extraCount; index += 1) {
    const extra = extras.nth(index);
    if (await extra.isVisible().catch(() => false)) allFields.push(extra);
  }
  const seen = new Set();
  for (const field of allFields) {
    if (!field) continue;
    const key = await field.evaluate((node) => node).catch(() => null);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    await field.fill('').catch(() => {});
    await commitControlledInput(field, '');
  }
  return targets;
}

async function forceClearLogisticsSection(page) {
  const fields = await logisticsFields(page);
  await clearLogisticsFields(page, fields);
  await syncLogisticsControls(page, {}, { clear: true });
  // If Alibaba kept the optional logistics module selected after a failed
  // submit, clear its selection as well so the retry is a true all-empty
  // logistics state. The helper is deliberately only used during recovery;
  // normal filling never toggles this similarly named content option.
  await setLogisticsSectionEnabled(page, false);
  // The form may keep controlled values in React state even after the native
  // input is cleared. Clear every visible logistics-like input once more and
  // dispatch the same events the page uses for a user edit.
  await page.evaluate(() => {
    const pattern = /pkg|weight|volume|shipping|logistic|package|length|width|height|物流|重量|体积|包装|尺寸/i;
    for (const node of document.querySelectorAll('input:not([type="hidden"]), textarea')) {
      const signature = `${node.name || ''} ${node.id || ''} ${node.placeholder || ''} ${node.parentElement?.textContent || ''}`;
      if (!pattern.test(signature)) continue;
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(node, '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.blur();
    }
  }).catch(() => {});
  await page.waitForTimeout(500);
}

async function fillLogisticsFields(page, packaging = {}) {
  const values = {
    weight: packaging.weight,
    length: packaging.length,
    width: packaging.width,
    height: packaging.height
  };
  const completeSource = Object.values(values).every((value) => numericValue(value) > 0);
  // Populate every rendered logistics card. Do not toggle the similarly named
  // "Packaging & shipping specifications" checkbox: on current Alibaba forms
  // that checkbox belongs to an unrelated optional content module.
  const synced = await syncLogisticsControls(page, values, { clear: !completeSource });
  const fields = await logisticsFields(page);
  // The fixed labels used by older posting forms are not present in every
  // category. The generic resolver above is authoritative; require one
  // recognized control for each metric instead of rejecting a valid form just
  // because its generated label/name changed.
  const completeTarget = ['weight', 'length', 'width', 'height']
    .every((key) => synced.keys.includes(key));

  // Alibaba accepts this section only as a complete set or as an empty set.
  // Never leave source or target values partially populated.
  if (!completeSource || !completeTarget) {
    await clearLogisticsFields(page, fields);
    await syncLogisticsControls(page, {}, { clear: true });
    return false;
  }

  try {
    for (const key of Object.keys(values)) {
      if (fields[key]) await fillAndVerify(fields[key], values[key], key);
    }
    return completeTarget;
  } catch {
    await clearLogisticsFields(page, fields);
    await syncLogisticsControls(page, {}, { clear: true });
    return false;
  }
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
    const controls = row.getByText(/^\+?\s*添加$/, { exact: true });
    for (let index = await controls.count().catch(() => 0) - 1; index >= 0; index -= 1) {
      const control = controls.nth(index);
      if (!await control.isVisible().catch(() => false)) continue;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await control.click({ force: true }).catch(() => {});
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
  const colorInput = await firstVisible(page, [colorInputSelector]);
  if (!colorInput) return false;
  for (const color of colors) {
    const inputs = page.locator(colorInputSelector);
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
      const refreshedInputs = page.locator(colorInputSelector);
      for (let inputIndex = 0; inputIndex < await refreshedInputs.count().catch(() => 0); inputIndex += 1) {
        const candidate = refreshedInputs.nth(inputIndex);
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (!String(await candidate.inputValue().catch(() => '')).trim()) { input = candidate; break; }
      }
    }
    if (!input) break;
    const existingValue = String(await input.inputValue().catch(() => '')).trim();
    if (existingValue.toLowerCase() !== color.toLowerCase()) {
      await input.click({ force: true });
      await input.fill(color);
      await page.waitForTimeout(500);
    }
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
    if (!label) return null;
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
    const control = await resolveTarget();
    if (!control) return false;
    if (!await switchIsOn(control)) {
      await control.scrollIntoViewIfNeeded().catch(() => {});
      await control.click({ force: true }).catch(() => {});
      if (!await switchIsOn(control)) await control.press('Space').catch(() => {});
    }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (await hasUploadSurface()) return true;
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

async function fillVariantSpecs(page, variantGroups) {
  // A single image-backed source SKU can satisfy categories that require one
  // sales specification and must keep the source specification image.
  const groups = (variantGroups || []).filter(isRequiredTargetVariantGroup);
  const unmapped = [];
  const aliasesFor = (name) => {
    const normalized = String(name || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(?:compatible\s+model|model\s+compatibility|适用型号)$/i.test(normalized)) return ['适用型号', 'compatible model'];
    if (/^(?:type|类型)$/i.test(normalized)) return ['类型', 'type'];
    if (/^(?:model(?: number)?|型号)$/i.test(normalized)) return ['型号', 'model number', 'model'];
    if (/^(?:socket standard|socket type|plug type|connector type|connector)$/i.test(normalized)) {
      return ['插座标准', '插头类型', '连接器类型', 'socket standard', 'socket type', 'plug type', 'connector type', 'connector'];
    }
    return [String(name || '').trim()].filter(Boolean);
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
      for (const input of node.querySelectorAll('input, textarea')) {
        if (normalize(input.value) !== target) continue;
        if (!['checkbox', 'radio'].includes(String(input.type || '').toLowerCase()) || input.checked) return true;
      }
      return [...node.querySelectorAll('label, [class*="tag"], [class*="value"], [class*="item"]')]
        .some((item) => normalize(item.textContent) === target
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
      if (!await input.isChecked().catch(() => false)) {
        await label.click({ force: true }).catch(() => {});
        await page.waitForTimeout(160);
      }
      if (await input.isChecked().catch(() => false)) return true;
    }
    return false;
  };
  const addCustomVariantValue = async (row, value) => {
    // Current Alibaba forms render a ready-to-use blank combobox. Clicking
    // "+ 添加" before filling it creates another empty row and discards the
    // intended custom model value.
    const inputs = row.locator('input[role="colorCombobox"], input[placeholder*="输入"], input[placeholder*="enter" i]');
    const inputCount = await inputs.count().catch(() => 0);
    let customInput = null;
    for (let index = inputCount - 1; index >= 0; index -= 1) {
      const input = inputs.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      const current = String(await input.inputValue().catch(() => '')).trim();
      if (!current || current.toLowerCase() === value.toLowerCase()) { customInput = input; break; }
    }
    if (!customInput) return false;
    await customInput.click({ force: true });
    await customInput.fill('');
    await customInput.pressSequentially(value, { delay: 18 });
    await page.waitForTimeout(350);
    const exactOption = page.getByRole('option', { name: value, exact: true }).last();
    let selectedPreset = false;
    if (await exactOption.isVisible().catch(() => false)) {
      await exactOption.click({ force: true }).catch(() => {});
      selectedPreset = true;
    }
    await page.waitForTimeout(250);
    if (selectedPreset && await selectExactValue(row, value)) return true;
    await customInput.press('Tab').catch(() => {});
    await page.waitForTimeout(350);
    const retained = String(await customInput.inputValue().catch(() => '')).trim();
    if (retained.toLowerCase() === value.toLowerCase()) return true;
    await customInput.click({ force: true }).catch(() => {});
    await customInput.fill(value).catch(() => {});
    await customInput.dispatchEvent('change').catch(() => {});
    await customInput.dispatchEvent('blur').catch(() => {});
    await page.waitForTimeout(250);
    return String(await customInput.inputValue().catch(() => '')).trim().toLowerCase() === value.toLowerCase();
  };
  for (const group of groups) {
    const targetHasSourceId = group.id && await saleAttributeIsAvailable(page, group.id);
    if (targetHasSourceId && !await ensureSaleAttributeSelected(page, group.id)) {
      for (const rawValue of [...new Set(group.options || [])]) {
        const value = englishSpecText(rawValue);
        if (value) unmapped.push(`${group.name}: ${value}`);
      }
      continue;
    }
    const directRow = targetHasSourceId ? page.locator(`#struct-specification [id="p-${String(group.id).replace(/["\\]/g, '')}"]`).first() : null;
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
    for (const rawValue of [...new Set(group.options || [])]) {
      const value = englishSpecText(rawValue);
      if (!value) continue;
      if (!row) {
        unmapped.push(`${group.name}: ${value}`);
        continue;
      }
      if (!await selectExactValue(row, value)) {
        const added = await addCustomVariantValue(row, value);
        if (!added) unmapped.push(`${group.name}: ${value}`);
      }
    }
  }
  return { unmapped, groups };
}

async function visibleColorSpecControl(page) {
  // Alibaba has used several different container class names for this area.
  // Resolve the first visible exact color checkbox in document order and
  // explicitly reject the later light/deep-customization sections.
  const wrappers = page.locator('label, [role="checkbox"]')
    .filter({ hasText: /^(?:颜色|colou?r)$/i });
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
    if (!metadata || metadata.excluded || !/^(?:颜色|colou?r)$/i.test(metadata.text)) continue;
    const input = wrapper.locator('input[type="checkbox"]').first();
    if (!await input.count().catch(() => 0)) continue;
    candidates.push({ wrapper, input, top: metadata.top });
  }
  candidates.sort((left, right) => left.top - right.top);
  return candidates[0] || null;
}

async function visibleColorSpecRow(page) {
  const rows = page.locator('[id="p-191288010"], [id="struct-p-191288010"], [data-attribute-id="191288010"], [data-id="191288010"], [data-attribute-id="color"], [data-spec-id="191288010"]');
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (await row.isVisible().catch(() => false)
      && await row.locator([
        'input[role="colorCombobox"]',
        '.posting-field-color-select input[placeholder*="请输入"]',
        '.posting-feild-color-select input[placeholder*="请输入"]',
        '.posting-field-color-item input[placeholder*="请输入"]',
        '.posting-feild-color-item input[placeholder*="请输入"]',
        '.posting-feild-color-item-container input[placeholder*="请输入"]'
      ].join(', ')).count().catch(() => 0)) return row;
  }
  return null;
}

async function saleAttributeIsSelected(page, value) {
  return page.evaluate((expectedValue) => {
    const root = document.querySelector('#saleAttributesItems');
    if (!root) return false;
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
  return page.evaluate((expectedValue) => {
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
      const selectedIds = [...current.map((item) => String(item?.value)), String(option.value)];
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
    if (String(value) === '191288010') {
      const control = await visibleColorSpecControl(page);
      if (!control || await control.input.isDisabled().catch(() => true)) return false;
      return ensureSpecControlChecked(page, () => visibleColorSpecControl(page));
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
      if (!props.value.some((item) => String(item?.value) === String(expectedValue))) {
        return { ok: true, already: true };
      }
      const selectedIds = props.value
        .filter((item) => String(item?.value) !== String(expectedValue))
        .map((item) => String(item?.value));
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

// A category can arrive with sale-attribute options preselected from the
// previous browser session. Those defaults are not part of the source product
// and image-type defaults make Alibaba reject the form with
// “商品图片项必填项不能为空”. Clear the controlled list before applying the
// source specifications so only exact source values remain selected.
async function clearSaleAttributeSelections(page) {
  const result = await page.evaluate(() => {
    const root = document.querySelector('#saleAttributesItems');
    if (!root) return { ok: false, reason: 'missing-root' };
    const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems' || !Array.isArray(props.value)) continue;
      const visit = (candidate, level = 0, seen = new Set()) => {
        if (!candidate || level > 18 || seen.has(candidate)) return null;
        seen.add(candidate);
        const instance = candidate.stateNode;
        if (instance?.constructor?.name === 'SaleAttributesItems' && typeof instance.onChange === 'function') return instance;
        return visit(candidate.child, level + 1, seen) || visit(candidate.sibling, level, seen);
      };
      const instance = visit(fiber.child);
      if (instance) {
        instance.onChange([]);
        return { ok: true, method: 'SaleAttributesItems.onChange' };
      }
      if (typeof props.changeValue === 'function') {
        props.changeValue.call(props, []);
        return { ok: true, method: 'changeValue' };
      }
      if (typeof props.change === 'function') {
        props.change(props.id, { props: { value: [] } });
        return { ok: true, method: 'change' };
      }
      return { ok: false, reason: 'missing-change-handler' };
    }
    return { ok: false, reason: 'missing-component' };
  }).catch((error) => ({ ok: false, reason: error.message }));
  if (!result?.ok) return false;
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const root = document.querySelector('#saleAttributesItems');
    const fiberKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? root[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id === 'saleAttributesItems' && Array.isArray(props.value)) return props.value.length === 0;
    }
    return false;
  }).catch(() => false);
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

async function visibleEmptyAttributeLabels(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').replace(/^[*＊]\s*/, '').trim();
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const labels = [];
    for (const error of document.querySelectorAll('[class*="error"], [class*="invalid"], [aria-invalid="true"]')) {
      if (!visible(error) || !/属性值不能为空|必填项不能为空|required|不能为空/i.test(clean(error.textContent) + ' ' + (error.getAttribute?.('itemmessage') || ''))) continue;
      let row = error;
      for (let level = 0; row && level < 7; level += 1, row = row.parentElement) {
        const label = [...row.querySelectorAll('label, legend, [class*="label"]')]
          .map((node) => clean(node.textContent)).find((text) => text && text.length <= 80 && !/属性值不能为空|必填项不能为空|required|不能为空/i.test(text));
        if (label) { labels.push(label); break; }
      }
    }
    return [...new Set(labels)].slice(0, 8);
  }).catch(() => []);
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
    await control.input.evaluate((input) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      descriptor?.set?.call(input, true);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
    await page.waitForTimeout(350);
  }
  return specControlIsChecked(await resolveControl());
}

export async function enableSpecImageUpload(page, product, colorGroup, downloadImages) {
  const colorValues = [...new Set(colorGroup?.options || [])].map((value) => englishSpecText(value)).filter(Boolean);
  const imageUrl = colorValues.map((value) => colorGroup?.optionImages?.[value] || colorGroup?.optionImages?.[colorGroup.options?.find((item) => englishSpecText(item) === value)]).find(Boolean);
  if (!imageUrl) return false;

  // Commit through the specification selector's own form-model callback.
  // Mutating the child row directly creates a visually populated value that
  // Alibaba rejects because saleAttributesItems still omits the specification.
  if (!await ensureSaleAttributeSelected(page, '191288010')) return false;

  // A populated color input is already a committed specification in the
  // current editor. The separate "+ 添加" control creates another blank row.
  if (!await fillColorSpec(page, colorValues)) return false;

  const rowDeadline = Date.now() + 10000;
  let row = await visibleColorSpecRow(page);
  while (!row && Date.now() < rowDeadline) {
    await page.waitForTimeout(200);
    row = await visibleColorSpecRow(page);
  }
  if (!row) return false;
  await removeEmptyColorSpecRows(page, colorValues);
  row = await visibleColorSpecRow(page) || row;
  if (!await ensureColorSpecImageSwitch(page, row)) {
    const state = await row.evaluate((node) => ({
      rowClass: String(node.className || ''),
      switches: [...node.querySelectorAll('[role="switch"], .next-switch')].map((item) => ({
        className: String(item.className || ''),
        ariaChecked: item.getAttribute('aria-checked')
      })),
      colorValues: [...node.querySelectorAll('input[role="colorCombobox"]')].map((item) => item.value)
    })).catch(() => null);
    throw new Error(`国际站颜色规格图片开关未能打开（${JSON.stringify(state || {})}）`);
  }
  const files = await downloadImages([imageUrl], 'spec', 1);
  if (!files.length) return false;
  const expectedColor = colorValues[0];
  const items = row.locator('.posting-feild-color-item, .posting-field-color-item, .posting-feild-color-item-container');
  let item = null;
  for (let index = 0; index < await items.count().catch(() => 0); index += 1) {
    const candidate = items.nth(index);
    const inputValue = await candidate.locator('input[role="colorCombobox"]').inputValue().catch(() => '');
    if (String(inputValue).trim().toLowerCase() === expectedColor.toLowerCase()) {
      item = candidate;
      break;
    }
  }
  if (!item) {
    // Alibaba can rebuild the row after the image switch is enabled. Re-resolve
    // the generated item after restoring the source value.
    if (!await fillColorSpec(page, [expectedColor])) return false;
    const refreshedItems = row.locator('.posting-feild-color-item, .posting-field-color-item, .posting-feild-color-item-container');
    for (let index = 0; index < await refreshedItems.count().catch(() => 0); index += 1) {
      const candidate = refreshedItems.nth(index);
      const inputValue = await candidate.locator('input[role="colorCombobox"], input').first().inputValue().catch(() => '');
      if (String(inputValue).trim().toLowerCase() === expectedColor.toLowerCase()) {
        item = candidate;
        break;
      }
    }
  }
  if (!item) return false;

  // Only the uploaded preview is authoritative. The upload menu itself also
  // contains decorative <img> icons, so broad `img[src]` selectors report a
  // false success before Alibaba has accepted the source file.
  const uploadedPreview = () => item.locator([
    '.value-preview.uploaded img[src]',
    '.value-preview.uploaded [style*="background-image"]',
    '.custom-upload-image.uploaded .value-preview img[src]'
  ].join(', '));
  if (await uploadedPreview().count().catch(() => 0)) {
    return ensureSaleAttributeSelected(page, '191288010');
  }

  const uploadBox = item.locator('.custom-upload-image, [class*="upload-image"], [class*="upload-trigger"]').first();
  await uploadBox.scrollIntoViewIfNeeded().catch(() => {});
  await uploadBox.hover({ force: true }).catch(() => {});
  await page.waitForTimeout(250);
  // The Alibaba uploader renders its menu in a document-level portal, so the
  // menu button is often not a descendant of the color item. Prefer a direct
  // file input, then resolve the newest visible portal menu after opening the
  // item; never use the first page-wide text match (that can hit the assistant
  // drawer or image bank menu).
  let input = item.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
  if (await input.count().catch(() => 0)) {
    await input.setInputFiles(files[0]);
  }
  const uploadButton = item.getByRole('button', { name: /本地选取|本地上传|local/i }).last();
  let chooserUsed = false;
  if (!await input.count().catch(() => 0) && await uploadButton.isVisible().catch(() => false)) {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await uploadButton.click({ force: true }).catch(() => {});
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(files[0]);
      chooserUsed = true;
    }
  }
  if (!await input.count() && !chooserUsed) {
    // Some editor versions open the action menu on click rather than hover.
    // Click only the resolved color-slot trigger before inspecting portal text.
    await uploadBox.click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
    const portalUpload = page.getByText('本地上传', { exact: true });
    const portalCount = await portalUpload.count().catch(() => 0);
    for (let index = portalCount - 1; index >= 0 && !chooserUsed; index -= 1) {
      const candidate = portalUpload.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await candidate.click({ force: true }).catch(() => {});
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(files[0]);
        chooserUsed = true;
      }
    }
  }
  if (!await input.count() && !chooserUsed) {
    const pageInputs = page.locator('input[type="file"][accept*="image" i], input[type="file"]');
    const inputCount = await pageInputs.count().catch(() => 0);
    if (!inputCount) return false;
    await pageInputs.nth(inputCount - 1).setInputFiles(files[0]);
  }

  const uploadDeadline = Date.now() + 60000;
  while (!await uploadedPreview().count().catch(() => 0) && Date.now() < uploadDeadline) {
    const feedback = (await visibleFeedback(page)).join(' ');
    if (/上传失败|图片.*不符合|upload failed/i.test(feedback)) return false;
    await page.waitForTimeout(350);
  }
  if (!await uploadedPreview().count().catch(() => 0)) return false;
  // Repeat the same transaction for each color option. The old code uploaded
  // only the first value, leaving the remaining Alibaba color rows empty.
  for (const additionalColor of colorValues.slice(1)) {
    const additionalUrl = colorGroup?.optionImages?.[additionalColor]
      || colorGroup?.optionImages?.[colorGroup.options?.find((value) => englishSpecText(value) === additionalColor)];
    if (!additionalUrl) continue;
    const additionalFiles = await downloadImages([additionalUrl], 'spec', 1);
    if (!additionalFiles.length) return false;
    const additionalItems = row.locator('.posting-feild-color-item, .posting-field-color-item, .posting-feild-color-item-container');
    let additionalItem = null;
    for (let index = 0; index < await additionalItems.count().catch(() => 0); index += 1) {
      const candidate = additionalItems.nth(index);
      const value = await candidate.locator('input[role="colorCombobox"], input').first().inputValue().catch(() => '');
      if (String(value).trim().toLowerCase() === additionalColor.toLowerCase()) { additionalItem = candidate; break; }
    }
    if (!additionalItem) return false;
    const additionalPreview = additionalItem.locator('.value-preview.uploaded img[src], .value-preview.uploaded [style*="background-image"]');
    if (await additionalPreview.count().catch(() => 0)) continue;
    const additionalInput = additionalItem.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (await additionalInput.count().catch(() => 0)) await additionalInput.setInputFiles(additionalFiles[0]);
    else {
      const trigger = additionalItem.locator('.custom-upload-image, [class*="upload-image"], [class*="upload-trigger"]').first();
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await trigger.click({ force: true }).catch(() => {});
      let chooser = await chooserPromise;
      if (!chooser) {
        const portal = page.getByText('本地上传', { exact: true }).last();
        if (await portal.isVisible().catch(() => false)) {
          const portalChooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
          await portal.click({ force: true }).catch(() => {});
          chooser = await portalChooser;
        }
      }
      if (!chooser) return false;
      await chooser.setFiles(additionalFiles[0]);
    }
    const deadline = Date.now() + 60000;
    while (!await additionalPreview.count().catch(() => 0) && Date.now() < deadline) {
      const feedback = (await visibleFeedback(page)).join(' ');
      if (/上传失败|图片.*不符合|upload failed/i.test(feedback)) return false;
      await page.waitForTimeout(350);
    }
    if (!await additionalPreview.count().catch(() => 0)) return false;
  }
  // The uploader rerenders the color row. Wait for the enclosing form model
  // to settle and recommit the exact sale attribute if that rerender briefly
  // removed it instead of turning a successful upload into a false failure.
  return ensureSaleAttributeSelected(page, '191288010');
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
    const inputValue = String(await candidate.locator('input').first().inputValue().catch(() => '')).trim().toLowerCase();
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

async function uploadSpecFile(page, item, file) {
  const uploadedPreview = () => item.locator([
    '.value-preview.uploaded img[src]',
    '.value-preview.uploaded [style*="background-image"]',
    '.custom-upload-image.uploaded img[src]',
    '.custom-upload-image [data-role="preview"] img[src]'
  ].join(', '));
  if (await uploadedPreview().count().catch(() => 0)) return true;

  const trigger = item.locator('.custom-upload-image, [class*="upload-image"], [class*="upload-trigger"], .value-preview').first();
  let input = item.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
  if (await input.count().catch(() => 0)) {
    await input.setInputFiles(file);
  } else {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.hover({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
    input = item.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (await input.count().catch(() => 0)) {
      await input.setInputFiles(file);
    } else {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await trigger.click({ force: true }).catch(() => {});
      let chooser = await chooserPromise;
      if (!chooser) {
        const portal = page.getByText(/^(?:本地上传|本地选取)$/).last();
        if (await portal.isVisible().catch(() => false)) {
          const portalChooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
          await portal.click({ force: true }).catch(() => {});
          chooser = await portalChooser;
        }
      }
      if (!chooser) return false;
      await chooser.setFiles(file);
    }
  }

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await uploadedPreview().count().catch(() => 0)) return true;
    const feedback = (await visibleFeedback(page)).join(' ');
    if (/上传失败|图片.*不符合|upload failed/i.test(feedback)) return false;
    await page.waitForTimeout(350);
  }
  return false;
}

async function enableImageBackedVariantSpecs(page, product, groups, downloadImages) {
  const imageGroups = (groups || []).filter((group) => group?.id
    && String(group.type || '').toUpperCase() === 'IMAGE'
    && !/颜色|colou?r/i.test(group.name)
    && Object.values(group.optionImages || {}).some(Boolean));
  for (const group of imageGroups) {
    if (!await ensureSaleAttributeSelected(page, group.id)) return false;
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

    for (const rawValue of sourceOptions) {
      const value = englishSpecText(rawValue);
      const imageUrl = group.optionImages?.[rawValue] || group.optionImages?.[value];
      if (!value || !imageUrl) continue;
      const files = await downloadImages([imageUrl], `spec-${group.id}`, 1);
      if (!files.length) return false;
      row = await visibleSaleSpecRow(page, group.id) || row;
      const item = await specValueUploadContainer(row, value);
      if (!item || !await uploadSpecFile(page, item, files[0])) return false;
    }
    if (!await ensureSaleAttributeSelected(page, group.id)) return false;
  }
  return true;
}

async function dismissPostingOverlays(page) {
  const harmlessActions = [
    /^(?:我知道了|知道了|关闭|取消|稍后再说|暂不|以后再说|Got it|Close|Cancel)$/i,
    /^(?:继续返回旧版|确认返回旧版)$/i
  ];
  for (let pass = 0; pass < 4; pass += 1) {
    const overlays = page.locator('.next-overlay-wrapper.opened, .next-dialog:visible, [role="dialog"]:visible, .mce-window:visible');
    let acted = false;
    for (let index = (await overlays.count().catch(() => 0)) - 1; index >= 0; index -= 1) {
      const overlay = overlays.nth(index);
      if (!await overlay.isVisible().catch(() => false)) continue;
      for (const pattern of harmlessActions) {
        const action = overlay.getByRole('button', { name: pattern }).last();
        if (!await action.isVisible().catch(() => false)) continue;
        await action.click({ force: true }).catch(() => action.evaluate((node) => node.click()).catch(() => {}));
        acted = true;
        break;
      }
      if (acted) break;
      const close = overlay.locator('.next-dialog-close, .next-overlay-close, .mce-close, [aria-label="关闭"], [aria-label="close" i]').last();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ force: true }).catch(() => close.evaluate((node) => node.click()).catch(() => {}));
        acted = true;
        break;
      }
    }
    if (!acted) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
      const blockingBackdrop = page.locator('.next-overlay-wrapper.opened .next-overlay-backdrop:visible');
      if (!await blockingBackdrop.count().catch(() => 0)) return true;
      break;
    }
    await page.waitForTimeout(300);
  }
  return !await page.locator('.next-overlay-wrapper.opened .next-overlay-backdrop:visible').count().catch(() => 0);
}

async function switchToLegacyDetails(page) {
  await dismissPostingOverlays(page);
  const oldMode = page.getByRole('button', { name: '返回老版', exact: true }).first();
  if (await oldMode.isVisible().catch(() => false)) {
    await oldMode.click({ force: true, timeout: 5000 })
      .catch(() => oldMode.evaluate((node) => node.click()));
    await page.waitForTimeout(350);
    const confirm = page.getByRole('button', { name: '继续返回旧版', exact: true }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click({ force: true, timeout: 5000 })
        .catch(() => confirm.evaluate((node) => node.click()));
    }
    await dismissPostingOverlays(page);
  }
  const normalEditor = page.getByText('普通编辑', { exact: true }).last();
  if (await normalEditor.isVisible().catch(() => false)) {
    await normalEditor.click({ force: true, timeout: 5000 })
      .catch(() => normalEditor.evaluate((node) => node.click()).catch(() => {}));
  }
  await page.waitForTimeout(600);
}

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
    this.publishStops = new Map();
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
      this.sourceContext.on('close', () => { this.sourceContext = null; });
    }
    await globalThis.__KUA_YIPU_SELLER_BRIDGE?.sync?.().catch(() => false);
    await syncAlibabaCookies(this.sourceContext);
    return this.sourceContext;
  }

  async completeSourceVerification(url) {
    const previous = this.sourceContext;
    this.sourceContext = null;
    await previous?.close().catch(() => {});
    const context = await launchPersistent(this.sourceProfileDir, {
      headless: false,
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Keep the headed fallback off-screen unless a real challenge is
      // visible. This path is only used outside the Electron bridge.
      if (!await hasExplicitHumanChallenge(page)) return;
      await revealPage(page);
      await waitForHumanVerification(page, { timeout: 300000 });
    } finally {
      await context.close().catch(() => {});
    }
  }

  async open(options = {}) {
    if (options.reveal && globalThis.__KUA_YIPU_SELLER_BRIDGE?.open) {
      return globalThis.__KUA_YIPU_SELLER_BRIDGE.open();
    }
    await globalThis.__KUA_YIPU_SELLER_BRIDGE?.sync?.().catch(() => false);
    if (!this.context) {
      // Keep normal publishing completely out of the desktop and taskbar.
      // The shared Electron bridge reveals a real window only if Alibaba
      // presents a CAPTCHA or login challenge.
      this.context = await launchPersistent(this.profileDir, { headless: true });
      this.context.on('close', () => { this.context = null; this.page = null; });
    }
    await syncAlibabaCookies(this.context);
    const pages = this.context.pages();
    this.page = pages.find((item) => isAlibabaInternationalUrl(item.url())) || pages[0] || await this.context.newPage();
    if (this.page.url() === 'about:blank' || !isAlibabaInternationalUrl(this.page.url())) {
      await gotoWithRetry(this.page, options.startUrl || WORKBENCH_URL, { timeout: 60000 });
    }
    if (options.reveal) {
      // My Alibaba is an explicit user action: always restore and maximize the
      // seller browser so the user can choose the posting form visibly.
      await revealPage(this.page);
      await this.page.bringToFront().catch(() => {});
      this.visible = true;
    }
    else { await hidePage(this.page); this.visible = false; }
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
    const contexts = [...new Set([this.context, this.sourceContext].filter(Boolean))];
    this.context = null;
    this.sourceContext = null;
    this.page = null;
    this.visible = false;
    await Promise.allSettled(contexts.map((context) => context.close()));
  }

  requestPublishStop(jobId) {
    const stop = this.publishStops.get(String(jobId || ''));
    if (!stop) return false;
    stop();
    return true;
  }

  clearPublishStop(jobId) {
    this.publishStops.delete(String(jobId || ''));
  }

  async hide() {
    if (this.page) await hidePage(this.page);
    this.visible = false;
  }

  async currentSellerPage(startUrl = '') {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.open(startUrl ? { startUrl } : {});
        const pages = this.context.pages();
        const current = [...pages].reverse().find((item) => isAlibabaInternationalUrl(item.url()));
        if (current) this.page = current;
        return this.page;
      } catch (error) {
        const message = String(error?.message || '');
        const closed = /browser.*退出|browser has been closed|target page, context or browser has been closed|采集浏览器已关闭/i.test(message);
        if (!closed || attempt > 0) throw error;
        await this.context?.close().catch(() => {});
        this.context = null;
        this.page = null;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error('卖家浏览器启动失败，请重试');
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
      const titleField = await firstVisible(page, TITLE_SELECTORS);
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
        let enrichedProduct;
        try {
          enrichedProduct = await withSourceLocale(context, () => this.readSourceProduct(page, products[index]), options);
        } catch (error) {
          if (error?.code === 'HUMAN_VERIFICATION_REQUIRED') {
            await this.completeSourceVerification(error.verificationUrl || products[index].sourceUrl);
            return this.enrichSourceProducts(products.slice(index), onProgress, options)
              .then((remaining) => [...enriched, ...remaining]);
          }
          if (error?.code === 'COLLECT_PAUSED') throw error;
          // Do not turn a CAPTCHA, empty shell, or parser failure into a
          // seemingly successful product that contains only a title/thumb.
          // The job must stop so the user can fix authentication and retry.
          throw new Error(`第 ${index + 1} 件商品详情读取失败：${String(error?.message || '未获得有效详情数据')}`);
        }
        enriched.push(enrichedProduct);
        const keepGoing = onProgress(index + 1, products.length, enriched[index]);
        if (keepGoing === false) { const error = new Error('COLLECT_PAUSED'); error.code = 'COLLECT_PAUSED'; throw error; }
        if (Number(options.delaySeconds || 0) > 0) await page.waitForTimeout(Number(options.delaySeconds) * 1000);
      }
      return enriched;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async readSourceProduct(page, base, retry = 0) {
    await page.setExtraHTTPHeaders(SOURCE_LANGUAGE_HEADERS);
    await page.goto(base.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
    await waitForHumanVerification(page, { timeout: 300000 });
    await page.waitForTimeout(250);
    // Product attributes and the rich description are lazy-rendered on many
    // Alibaba templates. Trigger the section and allow the DOM a short,
    // bounded window to populate before extracting it. This replaces the old
    // unconditional iframe wait that added 8 seconds even when no iframe
    // existed.
    await page.locator('[data-module-name="module_description"], [data-testid="module-description"]').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.locator('[data-testid="module-attribute-row"], [data-module-name*="attribute" i], [data-module-name*="specification" i], table').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.locator('[data-module-name="module_product_specification"] iframe, iframe[src*="descIframe"]')
      .first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(450);
    if (/login|passport/i.test(page.url())) {
      // Alibaba may require authentication for an individual detail page even
      // when its public listing page is readable. Keep the listing record and
      // let the remaining products continue.
      return { ...base, collectWarning: '阿里巴巴要求登录，详情暂未补全' };
    }
    const detailIframe = page.locator('iframe[src*="descIframe"]');
    if (await detailIframe.count().catch(() => 0)) {
      await detailIframe.first().waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(350);
    await waitForHumanVerification(page, { timeout: 300000 });
    const detailDataScript = await page.evaluate(() => [...document.scripts]
      .map((script) => script.textContent || '')
      .find((text) => /(?:window\.)?detailData\s*=\s*\{/.test(text)) || '').catch(() => '');
    const structuredSource = extractAlibabaSourceData(parseAlibabaDetailDataScript(detailDataScript));
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
      const descriptionModule = document.querySelector('[data-module-name="module_description"], [data-testid="module-description"]');
      // Alibaba changes gallery markup frequently. When the size suffix or
      // JSON-LD gallery is absent, use loaded product images outside the rich
      // text module as a conservative fallback instead of returning zero
      // source images.
      if (mainImages.length < 4) {
        const galleryImages = [...document.querySelectorAll('img')]
          .map((image) => ({
            url: image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-original') || '',
            width: image.naturalWidth || Number(image.getAttribute('width') || 0),
            insideDescription: Boolean(image.closest('[data-module-name="module_description"], [data-testid="module-description"]'))
          }))
          .filter((item) => item.url && /\/kf\//i.test(item.url) && !item.insideDescription && item.width >= 120)
          .map((item) => item.url);
        mainImages = [...new Set([...mainImages, ...unique(galleryImages)])].slice(0, 6);
      }
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
        const fallbackAttributes = [...document.querySelectorAll('table tr, dl, [class*=attribute] li, [class*=attribute] [class*=row], [class*=parameter] li, [class*=specification] li')].map((row) => {
          const cells = [...row.querySelectorAll('th,td')].map(textOf).filter(Boolean);
          const text = textOf(row);
          if (cells.length >= 2) return { name: cells[0], value: cells.slice(1).join(' ') };
          const terms = [...row.querySelectorAll('dt, dd')].map(textOf).filter(Boolean);
          if (terms.length >= 2) return { name: terms[0], value: terms.slice(1).join(' ') };
          const match = text.match(/^([^:：]{1,80})\s*[:：]\s*(.{1,240})$/);
          return match ? { name: clean(match[1]), value: clean(match[2]) } : null;
        }).filter((item) => item?.name && item?.value);
        attributes.push(...fallbackAttributes);
      }
      // New Alibaba templates render the attribute grid as anonymous divs
      // (no table/data-testid/class hint). Recover the same label/value pairs
      // from the visible section text using a conservative label vocabulary.
      if (attributes.length < 2) {
        const knownLabel = /^(?:材质|material|私模|private\s*mold|产地|place\s+of\s+origin|原产地|product\s+name|weight|重量|color|颜色|size|尺寸|feature|特征|moq|blade\s+pitch|blade\s+width|blade\s+diameter|销售单位|sales\s+unit|单个包装尺寸|single\s+package\s+size|单个产品毛重|single\s+gross\s+weight|包装重量|gross\s+weight|型号|model(?:\s+number)?|品牌(?:名称)?|brand(?:\s+name)?|type|类型)$/i;
        const lines = bodyText.split(/\r?\n/).map(clean).filter((line) => line && line.length < 160);
        const recovered = [];
        for (let index = 0; index < lines.length - 1; index += 1) {
          if (!knownLabel.test(lines[index]) || knownLabel.test(lines[index + 1])) continue;
          const name = clean(lines[index]);
          const value = clean(lines[index + 1]);
          if (name && value && !recovered.some((item) => item.name === name && item.value === value)) {
            recovered.push({ name, value, section: 'Product Attributes', source: 'visible-text' });
          }
        }
        attributes.push(...recovered.filter((item) => !attributes.some((current) => current.name === item.name && current.value === item.value)));
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
        bodyText.match(/(?:¥|￥|\$)\s*[\d,.]+\s*(?:\d+\s*[-–]\s*\d+|≥\s*[\d,]+)?/g)?.join(' ')
      ].filter(Boolean).join(' '));
      const categoryLinks = [...document.querySelectorAll('nav a, [data-testid*="breadcrumb"] a, a[href*="categoryId="], a[href*="catId="]')];
      const categoryPath = categoryLinks
        .map((node) => clean(node.textContent)).filter((text) => text && text.length < 80
          && !/(?:Alibaba\s*Lens|免费比价插件|寻找价格更低|相似商品|下载扩展程序|Accio\s*Work|报告可疑活动|report suspicious activity)/i.test(text)).slice(0, 8);
      const categoryIdCandidates = [];
      const addCategoryId = (value) => {
        const match = String(value || '').match(/(?:categoryId|catId|leafCategoryId)["'=:\s%]*(\d{4,})/i)
          || String(value || '').match(/\b(\d{6,})\b/);
        if (match?.[1] && !categoryIdCandidates.includes(match[1])) categoryIdCandidates.push(match[1]);
      };
      for (const link of categoryLinks) addCategoryId(link.href || link.getAttribute('href'));
      for (const meta of document.querySelectorAll('meta[name*="category" i], meta[property*="category" i]')) addCategoryId(meta.content);
      for (const script of document.scripts) {
        const text = script.textContent || '';
        if (/categoryId|catId|leafCategoryId/i.test(text)) addCategoryId(text);
      }
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
        productType: categoryPath.at(-1) || '', categoryPath, categoryId: categoryIdCandidates[0] || '', priceText, subtitle, keywords,
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
        renderTextSample: clean(bodyText).slice(0, 3000)
      };
    });
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
      return this.readSourceProduct(page, base, retry + 1);
    }
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
      origin: detail.origin,
      model: detail.model,
      brand: detail.brand,
      productType: detail.productType,
      sourceCategoryPath: detail.categoryPath,
      sourceCategoryId: structuredSource?.sourceCategoryId || detail.categoryId || base.sourceCategoryId || base.categoryId || '',
      categoryId: base.categoryId || structuredSource?.sourceCategoryId || detail.categoryId || base.sourceCategoryId || '',
      description: detail.description,
      videoUrl: detail.videoUrl,
      dataCompleteness: {
        ...detail.dataCompleteness,
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

  async downloadImageSet(product, urls, prefix, limit = 6) {
    fs.mkdirSync(this.imageDir, { recursive: true });
    const selectedUrls = distinctAlibabaImageUrls(urls).filter(isUsableImageUrl).slice(0, limit);
    const downloadOne = async (url, index) => {
      try {
        let contentType = '';
        let buffer;
        if (/^data:image\//i.test(url)) {
          const match = String(url).match(/^data:(image\/[^;]+);base64,(.+)$/i);
          if (!match) return '';
          contentType = match[1];
          buffer = Buffer.from(match[2], 'base64');
        } else if (/^\/media\//i.test(url)) {
          const localPath = path.join(this.dataDir, 'media', path.basename(url));
          if (!fs.existsSync(localPath)) return '';
          contentType = `image/${path.extname(localPath).slice(1).toLowerCase() === 'png' ? 'png' : 'jpeg'}`;
          buffer = fs.readFileSync(localPath);
        } else {
          let lastError;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const response = await fetch(url, {
                headers: {
                  accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                  referer: product.sourceUrl,
                  'user-agent': 'Mozilla/5.0'
                },
                signal: AbortSignal.timeout(30000)
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              contentType = response.headers.get('content-type') || '';
              buffer = Buffer.from(await response.arrayBuffer());
              break;
            } catch (error) {
              lastError = error;
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
            }
          }
          if (!buffer) throw lastError || new Error('图片下载失败');
        }
        if (!/^image\//i.test(contentType)) return '';
        let extension = /png/i.test(contentType) ? 'png' : 'jpg';
        if (!buffer.length || buffer.length > 5 * 1024 * 1024) return '';
        if (!/^image\/(?:jpeg|jpg|png)/i.test(contentType)) {
          buffer = await sharp(buffer, { animated: false }).jpeg({ quality: 92 }).toBuffer();
          extension = 'jpg';
        }
        if (prefix === 'detail') {
          const metadata = await sharp(buffer).metadata();
          if ((metadata.width || 0) > 960 || (metadata.height || 0) > 960 || buffer.length > 3 * 1024 * 1024) {
            buffer = await sharp(buffer)
              .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: buffer.length > 3 * 1024 * 1024 ? 82 : 90 })
              .toBuffer();
            extension = 'jpg';
          }
        }
        const safeId = String(product.sourceId || product.id || 'product').replace(/[^A-Za-z0-9]/g, '').slice(-16);
        const safePrefix = String(prefix || 'image').replace(/[^A-Za-z0-9]/g, '');
        const filePath = path.join(this.imageDir, `${safeId}${safePrefix}${index}.${extension}`);
        fs.writeFileSync(filePath, buffer);
        return filePath;
      } catch { return ''; }
    };
    // AliCDN occasionally resets a burst of six parallel TLS connections.
    // Three workers retain good throughput while each file still gets its own
    // retry budget, avoiding false "only two images" failures.
    const paths = new Array(selectedUrls.length).fill('');
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(3, selectedUrls.length) }, async () => {
      while (nextIndex < selectedUrls.length) {
        const index = nextIndex;
        nextIndex += 1;
        paths[index] = await downloadOne(selectedUrls[index], index);
      }
    }));
    return paths.filter(Boolean);
  }

  async uploadMainImages(page, product) {
    const urls = product.mainImages?.length ? product.mainImages : [product.mainImage, ...(product.images || [])];
    const downloaded = await this.downloadImageSet(product, urls, 'main', 6);
    if (downloaded.length < 4) throw new Error(`主图资料不足：仅下载到 ${downloaded.length} 张，至少需要 4 张`);
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
    const images = downloaded.slice(0, uploadCount);
    if (initialOccupied + images.length < 4) throw new Error(`国际站主图槽位不足：已有 ${initialOccupied} 张，可用空槽位 ${initialSlotCount} 个，至少需要 4 张`);
    const finishBatchUpload = async () => {
      const result = await this.waitForMainImageUploads(page, images.length, initialSlotCount);
      const finalState = await mainImageFormState(page);
      if (finalState.uploading || finalState.occupied < initialOccupied + images.length || finalState.occupied < 4) {
        throw new Error(`国际站主图批量上传完成校验失败：表单已确认 ${finalState.occupied} 张，仍在上传 ${finalState.uploading} 张`);
      }
      return result;
    };
    if (!images.length) return finishBatchUpload();
    const firstTrigger = placeholders().first();
    const firstSlot = firstTrigger.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " image-upload-list-item ")][1]');
    const firstInput = firstSlot.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (await firstInput.count().catch(() => 0) && await firstInput.getAttribute('multiple') !== null) {
      await firstInput.setInputFiles(images);
      return finishBatchUpload();
    }
    // Alibaba renders several unrelated "本地上传" labels (the AI assistant,
    // image bank and the active slot menu) in the same document. Resolve the
    // menu item closest to the slot that was just opened instead of using a
    // page-wide text locator, which could click an unrelated overlay.
    const findLocalUpload = async (trigger, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const triggerBox = await trigger.boundingBox().catch(() => null);
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
          scored.push({ candidate, score: distance + popupBias });
        }
        scored.sort((left, right) => left.score - right.score);
        if (scored[0]) return scored[0].candidate;
        await page.waitForTimeout(250);
      }
      return null;
    };
    for (const [index, image] of images.entries()) {
      const before = await placeholders().count().catch(() => 0);
      const trigger = placeholders().first();
      if (!before || !await trigger.isVisible().catch(() => false)) {
        throw new Error(`国际站主图第 ${index + 1} 个上传槽位不存在`);
      }
      const slot = trigger.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " image-upload-list-item ")][1]');
      let slotInput = slot.locator('input[type="file"][accept*="image" i], input[type="file"]');
      let assignedDirectly = false;
      if (await slotInput.count().catch(() => 0)) {
        await slotInput.last().setInputFiles([image]);
        assignedDirectly = true;
      }
      if (!assignedDirectly) {
        await trigger.hover().catch(() => {});
        await page.waitForTimeout(250);
        // Current Alibaba forms create one hidden, page-level multiple input
        // only after the main-image slot is hovered. It lives in a portal and
        // therefore is not a descendant of the slot. Prefer that real batch
        // input before trying to click a localized popover label.
        const portalImageInputs = page.locator('input[type="file"][accept*="image" i][multiple]');
        if (index === 0 && await portalImageInputs.count().catch(() => 0)) {
          await portalImageInputs.last().setInputFiles(images);
          return finishBatchUpload();
        }
        let localUpload = await findLocalUpload(trigger, 900);
        if (!localUpload) {
          await trigger.click({ force: true }).catch(() => {});
          localUpload = await findLocalUpload(trigger, 5000);
        }
        if (!localUpload) {
          const menuText = compactText((await page.locator('[class*="menu"], [class*="popup"], [class*="overlay"]').evaluateAll((nodes) => nodes
            .filter((node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length))
            .map((node) => String(node.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-4).join(' ')).catch(() => '')), 500);
          throw new Error(`国际站主图第 ${index + 1} 个槽位未出现“本地上传”${menuText ? `，当前弹层：${menuText}` : ''}`);
        }

        const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        const clicked = await localUpload.click({ force: true }).then(() => true).catch(() => false);
        const chooser = await chooserPromise;
        if (chooser) {
          if (index === 0 && chooser.isMultiple()) {
            await chooser.setFiles(images);
            return finishBatchUpload();
          }
          await chooser.setFiles([image]);
        } else {
          const uploadHost = localUpload.locator('xpath=ancestor-or-self::*[.//input[@type="file"]][1]');
          let scopedInput = uploadHost.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
          if (!await scopedInput.count().catch(() => 0)) {
            slotInput = slot.locator('input[type="file"][accept*="image" i], input[type="file"]');
            if (await slotInput.count().catch(() => 0)) scopedInput = slotInput.last();
          }
          if (!await scopedInput.count().catch(() => 0)) {
            const activePopupInputs = page.locator('[role="menu"] input[type="file"], [class*="popup"] input[type="file"], [class*="overlay"] input[type="file"]');
            if (await activePopupInputs.count().catch(() => 0)) scopedInput = activePopupInputs.last();
          }
          if (!await scopedInput.count().catch(() => 0)) {
            throw new Error(`国际站主图第 ${index + 1} 个槽位未打开文件选择窗口${clicked ? '' : '（本地上传按钮点击失败）'}`);
          }
          if (index === 0 && await scopedInput.getAttribute('multiple') !== null) {
            await scopedInput.setInputFiles(images);
            return finishBatchUpload();
          }
          await scopedInput.setInputFiles([image]);
        }
      }

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const remaining = await placeholders().count().catch(() => before);
        const feedback = (await visibleFeedback(page)).join(' ');
        if (/上传失败|文件.*过大|图片.*不符合|upload failed/i.test(feedback)) {
          throw new Error(`国际站主图第 ${index + 1} 张上传失败：${compactText(feedback, 300)}`);
        }
        if (remaining < before) break;
        await page.waitForTimeout(400);
      }
      const remainingAfter = await placeholders().count().catch(() => before);
      if (remainingAfter >= before) {
        throw new Error(`国际站主图第 ${index + 1} 张上传超过 60 秒仍未完成`);
      }
    }
    return finishBatchUpload();
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

  async waitForMainImageUploads(page, expectedCount, initialSlotCount = 6) {
    const uploadDeadline = Date.now() + 60000;
    while (Date.now() < uploadDeadline) {
      // Count one canonical marker per empty slot. The icon and photobank
      // trigger are children of that same slot; counting all three inflated a
      // single empty slot into multiple entries and falsely timed out after
      // every per-image upload had already succeeded.
      const remainingSlots = await page.locator('.image-uploader .image-upload-list-item #image-placeholder-span:visible')
        .count().catch(() => initialSlotCount);
      const feedback = (await visibleFeedback(page)).join(' ');
      if (/上传失败|文件.*过大|图片.*不符合|upload failed/i.test(feedback)) {
        throw new Error(`国际站主图上传失败：${compactText(feedback, 300)}`);
      }
      const state = await mainImageFormState(page);
      if (!state.uploading && state.occupied >= 4 && mainImageSlotsComplete(initialSlotCount, remainingSlots, expectedCount)) return expectedCount;
      await page.waitForTimeout(500);
    }
    const remainingSlots = await page.locator('.image-uploader .image-upload-list-item #image-placeholder-span:visible')
      .count().catch(() => initialSlotCount);
    const occupiedSlots = Math.max(0, initialSlotCount - remainingSlots);
    throw new Error(`国际站主图上传超过 60 秒仍未完成（已占用 ${occupiedSlots}/${expectedCount} 个槽位，空槽位 ${remainingSlots}）`);
  }

  async fillProductFields(page, product) {
    const categoryPath = sanitizeCategoryPath(product.sourceCategoryPath || product.categoryPath);
    const productTypeCandidate = [product.productType, ...categoryPath.slice().reverse()].find((value) => value && !isPromotionalText(value));
    const productType = englishSpecText(productTypeCandidate, 'Other');
    const attributeItems = [...(product.attributes || []), ...(product.customAttributes || [])]
      .filter((item) => item?.name && item?.value);
    const mappedAttributes = new Set();
    const unmappedAttributes = new Set();
    const normalizedName = (value) => String(value || '').trim().toLowerCase();
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

    await clearSaleAttributeSelections(page);

    const productTypeFilled = await fillChoice(page, await fieldByLabel(page, '产品类型'), productType || 'Other');
    markSourceAttributes(['产品类型', 'product type'], productTypeFilled);

    const originValue = product.origin || attributeValue(product, '产地', 'Place of Origin') || 'China';
    const originFilled = await fillChoice(page, await fieldByAnyLabel(page, ['产地', 'Place of Origin']), originValue);
    markSourceAttributes(['产地', 'place of origin'], originFilled);

    const modelValue = product.model || attributeValue(product, '型号', 'Model Number');
    const modelFilled = await fillFirst(page, ['input[name="p-3"]'], modelValue)
      || await fillChoice(page, await fieldByAnyLabel(page, ['型号', 'Model Number']), modelValue);
    markSourceAttributes(['型号', 'model', 'model number'], modelFilled);

    const brandValue = product.brand || attributeValue(product, '品牌名称', 'Brand Name');
    const brandFilled = await fillFirst(page, ['input[name="p-2"]'], brandValue)
      || await fillChoice(page, await fieldByAnyLabel(page, ['品牌名称', 'Brand Name']), brandValue);
    markSourceAttributes(['品牌名称', 'brand', 'brand name'], brandFilled);

    const featureValue = attributeValue(product, '功能/特性', 'Feature', 'Features');
    const featureFilled = await fillFirst(page, ['input[name="p-373265001"]'], featureValue)
      || await fillChoice(page, await fieldByAnyLabel(page, ['功能/特性', '功能', '特性', 'Feature', 'Features']), featureValue);
    markSourceAttributes(['功能/特性', '功能', '特性', 'feature', 'features'], featureFilled);

    const materialValue = attributeValue(product, '材料', '材质', 'Material');
    const materialFilled = await fillFirst(page, ['input[name="p-390873113"]'], materialValue)
      || await fillChoice(page, await fieldByAnyLabel(page, ['材料', '材质', 'Material']), materialValue);
    markSourceAttributes(['材料', '材质', 'material'], materialFilled);

    const reserved = /^(?:型号|model(?: number)?|品牌名称|brand(?: name)?|功能\/特性|功能|特性|features?|材料|材质|material|颜色|colou?r|产地|place of origin|产品类型|product type|销售单位|selling units?|单个包装尺寸|single package size|单个产品毛重|single gross weight)$/i;
    for (const [index, item] of attributeItems.entries()) {
      if (reserved.test(String(item.name).trim())) continue;
      const aliases = SOURCE_ATTRIBUTE_LABEL_ALIASES.get(normalizedName(item.name)) || [];
      const labels = [String(item.name).trim(), englishAttributeName(item.name, index), ...aliases];
      const field = await fieldByAnyLabel(page, [...new Set(labels)]);
      if (!field) { unmappedAttributes.add(item.name); continue; }
      const filled = await fillChoice(page, field, item.value).catch(() => false);
      (filled ? mappedAttributes : unmappedAttributes).add(item.name);
    }

    const colorGroup = (product.variantGroups || []).find((group) => /颜色|colou?r/i.test(group.name));
    const colorValues = colorGroup?.options?.length ? colorGroup.options : [];
    const targetSupportsColor = await saleAttributeIsAvailable(page, '191288010');
    const useColorSaleSpec = shouldUseColorSaleSpecification(colorGroup, targetSupportsColor);
    const sourceHasSpecImage = useColorSaleSpec && Boolean(
      colorGroup?.options?.some((value) => colorGroup.optionImages?.[value])
    );
    if (useColorSaleSpec && !await ensureSaleAttributeSelected(page, '191288010')) {
      throw new Error('国际站商品规格区的颜色规格未能启用');
    }
    const colorSpecRow = useColorSaleSpec ? await visibleColorSpecRow(page) : null;
    if (useColorSaleSpec && !colorSpecRow) {
      throw new Error('国际站商品规格区的颜色规格未能启用');
    }
    const variantResult = await fillVariantSpecs(page, product.variantGroups);
    const hasImageBackedVariant = variantResult.groups.some((group) => String(group.type || '').toUpperCase() === 'IMAGE'
      && Object.values(group.optionImages || {}).some(Boolean));
    if (hasImageBackedVariant && !await enableImageBackedVariantSpecs(
      page,
      product,
      variantResult.groups,
      (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit)
    )) {
      throw new Error('国际站型号规格图片未能上传，已停止提交以避免生成缺图商品');
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
    const colorControl = useColorSaleSpec ? await firstVisible(page, [colorControlSelector]) : null;
    // Color is optional at the source level and not every Alibaba category
    // exposes it as a target specification. Only require a successful value
    // when the selected target category actually renders a visible control.
    const colorFilled = colorControl ? await fillColorSpec(page, colorValues) : true;
    if (colorControl && !colorFilled) {
      throw new Error('国际站颜色规格未成功添加，请检查颜色输入框和“添加”按钮');
    }
    if (colorControl && colorGroup?.options?.length) {
      const specImageUploaded = await enableSpecImageUpload(
        page,
        product,
        colorGroup,
        (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit)
      );
      if (sourceHasSpecImage && !specImageUploaded) {
        throw new Error('国际站颜色规格图片未能上传，已停止提交以避免生成缺图商品');
      }
    }
    markSourceAttributes(['颜色', 'color', 'colour'], Boolean(colorValues.length) && colorFilled);

    const logisticsFilled = await fillLogisticsFields(page, product.packaging || {});
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
    return {
      mappedAttributes: [...mappedAttributes],
      unmappedAttributes: [...new Set([...unmappedAttributes, ...variantResult.unmapped])]
    };
  }

  async fillPriceFields(page, product) {
    const fob = product.fobPrice && typeof product.fobPrice === 'object' ? product.fobPrice : {};
    const sourceTiers = product.priceMode === 'fob-tier' && Array.isArray(fob.tiers) ? fob.tiers : (product.priceTiers || []);
    const validTiers = sourceTiers
      .filter((tier) => numericValue(tier.price) > 0 && numericValue(tier.minQuantity) > 0)
      .sort((left, right) => numericValue(left.minQuantity) - numericValue(right.minQuantity));
    const fallbackPrice = product.priceMode === 'fob-range' && numericValue(fob.minPrice) > 0 ? fob.minPrice : product.price;
    const tiers = validTiers.length ? validTiers : [{ price: fallbackPrice, minQuantity: product.moq || 1 }];
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
      await commitControlledInput(quantityInputs.nth(index), tiers[index].minQuantity);
      await commitControlledInput(priceInputs.nth(index), tiers[index].price);
      await fillAndVerify(quantityInputs.nth(index), tiers[index].minQuantity, `第 ${index + 1} 档起订量`);
      await fillAndVerify(priceInputs.nth(index), tiers[index].price, `第 ${index + 1} 档价格`);
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
    const uploadViaAlibabaEditorPlugin = async () => {
      const payloads = imagePaths.map((filePath) => ({
        name: path.basename(filePath),
        type: path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
        data: fs.readFileSync(filePath).toString('base64')
      }));
      const started = await page.evaluate((files) => {
        const editors = [...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])];
        const editor = editors.find((item) => item && !item.hidden && item.plugins?.alipicpastedrag);
        const plugin = editor?.plugins?.alipicpastedrag;
        if (!editor || !plugin?.insertAnchorImages || !plugin?.uploadFiles) return false;
        const created = files.map((item, index) => {
          const binary = atob(item.data);
          const bytes = new Uint8Array(binary.length);
          for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
          const file = new File([bytes], item.name, { type: item.type || 'image/jpeg' });
          file.fileUUID = `kyp-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
          return file;
        });
        if (plugin.checkFilesError?.(created)) return { started: false, reason: 'rejected' };
        // Alibaba's custom drag/paste plugin requires placeholders before its
        // uploader can associate server responses with editor images.
        plugin.insertAnchorImages(created);
        plugin.uploadFiles(created);
        return { started: true };
      }, payloads).catch(() => ({ started: false, reason: 'exception' }));
      if (!started?.started) return null;

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        let stable = 0;
        for (const frame of page.frames()) {
          const body = frame.locator('body.mce-content-body, body[contenteditable="true"]');
          if (!await body.isVisible().catch(() => false)) continue;
          stable = Math.max(stable, await body.locator('img[src], img[data-src]').evaluateAll((nodes) => nodes.filter((node) => {
            const url = String(node.getAttribute('data-src') || node.getAttribute('src') || '').trim();
            return /^(?:https?:)?\/\//i.test(url) && !/loading|progress|placeholder/i.test(url);
          }).length).catch(() => 0));
        }
        if (stable >= initialEditorImages + imagePaths.length) {
          await syncEditor();
          return stable - initialEditorImages;
        }
        const feedback = (await visibleFeedback(page)).join(' ');
        if (/上传失败|图片.*失败|文件.*过大|图片.*不符合|upload failed/i.test(feedback)) {
          throw new Error(`国际站详情图上传失败：${compactText(feedback, 300)}`);
        }
        await page.waitForTimeout(600);
      }
      const inserted = await editorImageCount();
      throw new Error(`普通编辑器未完成详情图上传（已插入 ${Math.max(0, inserted - initialEditorImages)}/${imagePaths.length} 张）`);
    };
    const pluginInserted = await uploadViaAlibabaEditorPlugin();
    if (pluginInserted !== null) return pluginInserted;

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

  async publishProduct(product, publishPageUrl, mode = 'draft', publishCategory = '', jobId = '') {
    if (!publishPageUrl) throw new Error('尚未绑定阿里巴巴国际站商品发布页面');
    if (!isProductPostingUrl(publishPageUrl)) throw new Error('绑定地址不是阿里巴巴国际站商品发布页');
    const mismatch = categoryMismatchMessage(product, publishCategory);
    if (mismatch) throw new Error(mismatch);
    const validationErrors = validateProductData(product);
    if (validationErrors.length) throw new Error(`商品资料未通过上架检查：${validationErrors.join('；')}`);
    const page = await this.currentSellerPage(publishPageUrl);
    const stopKey = String(jobId || '');
    if (stopKey) this.publishStops.set(stopKey, () => { page.close().catch(() => {}); });
    // Normal publishing is headless and must not appear in the Windows taskbar.
    // waitForHumanVerification raises a typed error for a real challenge; the
    // caller can then use the headed verification flow without exposing every
    // upload and form interaction.
    await hidePage(page);
    this.visible = false;
    if (page.url() !== publishPageUrl) await gotoWithRetry(page, publishPageUrl, { timeout: 60000 });
    await settlePage(page);
    await waitForHumanVerification(page, { timeout: 300000 });
    // Electron owns the authenticated browser partition. Refresh its exported
    // cookies once more before classifying a login redirect, then retry the
    // publish navigation in the already-created Playwright context.
    if (/login|passport/i.test(page.url())) {
      await globalThis.__KUA_YIPU_SELLER_BRIDGE?.sync?.().catch(() => false);
      await syncAlibabaCookies(page.context());
      await gotoWithRetry(page, publishPageUrl, { timeout: 60000 }).catch(() => {});
      await settlePage(page);
      await waitForHumanVerification(page, { timeout: 300000 });
    }
    if (/login|passport/i.test(page.url())) throw new Error('阿里巴巴国际站登录状态已失效，请重新登录');
    const expectedCategoryId = normalizeCategoryId(product.categoryId || product.sourceCategoryId);
    const actualCategoryId = categoryIdFromUrl(page.url()) || categoryIdFromUrl(publishPageUrl);
    if (expectedCategoryId && actualCategoryId && expectedCategoryId !== actualCategoryId) {
      throw new Error(`国际站实际打开类目 ID ${actualCategoryId}，与商品目标类目 ID ${expectedCategoryId} 不一致，已停止发布`);
    }
    if (/\/product\/(?:easyListing|category)\.htm/i.test(new URL(page.url()).pathname)) {
      throw new Error('绑定的是商品类目选择页，不是商品填写表单。请先完成类目选择后重新绑定');
    }

    let titleInput = null;
    for (let formAttempt = 0; formAttempt < 3; formAttempt += 1) {
      titleInput = await waitForFirstVisible(page, TITLE_SELECTORS, formAttempt ? 20000 : 30000);
      if (titleInput) break;
      if (/login|passport/i.test(page.url())) break;
      await globalThis.__KUA_YIPU_SELLER_BRIDGE?.sync?.().catch(() => false);
      await syncAlibabaCookies(page.context());
      await gotoWithRetry(page, publishPageUrl, { timeout: 60000, attempts: 2 });
      await settlePage(page);
      await waitForHumanVerification(page, { timeout: 300000 });
    }
    if (!titleInput) {
      const shellText = compactText(await page.locator('body').innerText().catch(() => ''), 500);
      throw new Error(`国际站商品表单未完成加载${shellText ? `：${shellText}` : ''}`);
    }
    const postingText = compactText(await page.locator('body').innerText().catch(() => ''), 5000);
    const visibleCategory = postingText.match(/当前类目\s*[:：]\s*(.+?)(?=切换类目|基本信息|商品图片|$)/)?.[1]?.trim() || '';
    const categoryValidatedById = Boolean(expectedCategoryId && actualCategoryId && expectedCategoryId === actualCategoryId);
    const visibleMismatch = !categoryValidatedById && visibleCategory ? categoryMismatchMessage(product, visibleCategory) : '';
    if (visibleMismatch) {
      throw new Error(`国际站发布表单实际类目为“${visibleCategory}”：${visibleMismatch}`);
    }
    // Switching Alibaba's detail editor can rebuild the entire form. Do it
    // before filling prices, specifications and images so a late editor-mode
    // transition cannot silently erase already completed fields.
    await this.fillLegacyDescription(page, product);
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
      const unmappedRequiredVariant = findBlockingUnmappedVariant(product, fieldMapping.unmappedAttributes);
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
    // Main/detail uploaders can re-render the specification card and restore
    // its top-level checkbox from stale form state. Recommit the complete
    // source color transaction immediately before submit: selected spec,
    // exact source value, and its uploaded source image must all be present.
    const finalColorGroup = (product.variantGroups || []).find((group) => /颜色|colou?r/i.test(group.name));
    const finalColorValues = [...new Set(finalColorGroup?.options || [])].map((value) => englishSpecText(value)).filter(Boolean);
    const finalUsesColorSaleSpec = shouldUseColorSaleSpecification(
      finalColorGroup,
      await saleAttributeIsAvailable(page, '191288010')
    );
    const finalHasColorImage = finalUsesColorSaleSpec && finalColorValues.some((value) => Boolean(
      finalColorGroup?.optionImages?.[value]
      || finalColorGroup?.optionImages?.[finalColorGroup.options?.find((item) => englishSpecText(item) === value)]
    ));
    if (finalUsesColorSaleSpec && finalHasColorImage) {
      const colorFilled = await fillColorSpec(page, finalColorValues);
      const colorImageUploaded = colorFilled && await enableSpecImageUpload(
        page,
        product,
        finalColorGroup,
        (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit)
      );
      const finalColorSelected = await saleAttributeIsSelected(page, '191288010');
      if (!colorFilled || !finalColorSelected) {
        throw new Error('国际站颜色规格提交前复核失败：来源颜色规格值未保留');
      }
      if (!colorImageUploaded) {
        throw new Error('国际站颜色规格提交前复核失败：来源规格图片未被表单接收');
      }
    }
    const finalVariantResult = await fillVariantSpecs(page, product.variantGroups);
    const finalUnmappedVariant = findBlockingUnmappedVariant(product, finalVariantResult.unmapped);
    if (finalUnmappedVariant) {
      throw new Error(`国际站规格提交前复核失败：来源规格“${finalUnmappedVariant}”未保留`);
    }
    const finalHasImageBackedVariant = finalVariantResult.groups.some((group) => String(group.type || '').toUpperCase() === 'IMAGE'
      && Object.values(group.optionImages || {}).some(Boolean));
    if (finalHasImageBackedVariant && !await enableImageBackedVariantSpecs(
      page,
      product,
      finalVariantResult.groups,
      (urls, prefix, limit) => this.downloadImageSet(product, urls, prefix, limit)
    )) {
      throw new Error('国际站型号规格提交前复核失败：来源规格图片未被表单接收');
    }

    // Uploaders and rich-text editors can rerender the form after the first
    // field pass. Re-apply the all-or-nothing logistics rule immediately
    // before the final action so stale weight/volume values cannot survive.
    await fillLogisticsFields(page, product.packaging || {});

    // A specification or uploader rerender may replace the image component.
    // Reconcile against the real preview state immediately before submission.
    const preSubmitImages = await mainImageFormState(page);
    if (preSubmitImages.occupied < 4 || preSubmitImages.uploading) {
      await this.uploadMainImages(page, product);
    }

    // Alibaba's current image uploader can show completed remote previews
    // while its submit validator still holds an empty image value. Persisting
    // the form once makes the server-issued image records authoritative. The
    // user still performs one "direct submit" action; this draft checkpoint is
    // an automatic reliability step before the final publish click.
    if (mode === 'submit') {
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
        await waitForActionResult(page, draftAction, 'draft', draftUrl);
        await page.waitForTimeout(4200);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await settlePage(page);
      }
    }

    // Saving drafts and uploading media can restore a stale, checked sales
    // attribute without any value. Alibaba reports only "属性值不能为空" for
    // that state, so remove those empty optional selections before submit.
    await clearEmptySaleAttributeSelections(page);

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
    let verification;
    try {
      verification = await waitForActionResult(page, action, mode, originalUrl);
    } catch (error) {
      const actionError = String(error?.message || '');
      if (/商品图片|请上传.*图片|image.*required/i.test(actionError)) {
        const cleared = await clearMainImagesForRetry(page);
        if (!cleared) throw error;
        await this.uploadMainImages(page, product);
        let retryAction = null;
        for (const text of buttonTexts) {
          const candidate = page.getByRole('button', { name: text, exact: false }).last();
          if (await candidate.isVisible().catch(() => false) && !await candidate.isDisabled().catch(() => false)) { retryAction = candidate; break; }
        }
        if (!retryAction) throw error;
        verification = await waitForActionResult(page, retryAction, mode, originalUrl);
      } else if (/属性值不能为空|attribute value.*(?:empty|required)/i.test(actionError)) {
        const emptyLabels = await visibleEmptyAttributeLabels(page);
        const cleared = await clearEmptySaleAttributeSelections(page);
        if (!cleared.length) {
          throw new Error(`${actionError}${emptyLabels.length ? `（空字段：${emptyLabels.join('、')}）` : '；国际站未返回具体属性名称，请在当前发布表单查看红色标记字段'}`);
        }
        let retryAction = null;
        for (const text of buttonTexts) {
          const candidate = page.getByRole('button', { name: text, exact: false }).last();
          if (await candidate.isVisible().catch(() => false) && !await candidate.isDisabled().catch(() => false)) { retryAction = candidate; break; }
        }
        if (!retryAction) throw error;
        verification = await waitForActionResult(page, retryAction, mode, originalUrl);
      } else {
      // Alibaba sometimes restores a partially selected logistics card during
      // the final submit transaction. Recover once by disabling and clearing
      // the whole card, then retry the same action instead of reporting a
      // product-level failure to the user.
      if (!/物流属性|重量、体积|packaging|shipping/i.test(actionError)) throw error;
      await forceClearLogisticsSection(page);
      let fallbackAction = null;
      for (const text of buttonTexts) {
        const candidate = page.getByRole('button', { name: text, exact: false }).last();
        if (await candidate.isVisible().catch(() => false) && !await candidate.isDisabled().catch(() => false)) { fallbackAction = candidate; break; }
      }
      if (!fallbackAction) throw error;
      verification = await waitForActionResult(page, fallbackAction, mode, originalUrl);
      }
    }
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
