import { requirePostingPageAvailable } from './posting-readiness.js';
import { clickPostingControl } from './posting-interaction.js';

const LANGUAGE_LABEL = /^(?:English|简体中文|中文[（(]简体[）)]|Simplified Chinese|Chinese\s*[（(]Simplified[）)])$/i;
const CHINESE_LABEL = /^(?:简体中文|中文[（(]简体[）)]|Simplified Chinese|Chinese\s*[（(]Simplified[）)])$/i;
const OPTION_CONTAINER = '[role="menu"], [role="listbox"], [role="menuitem"], [role="option"], .next-menu, .next-overlay-wrapper, .ant-dropdown, .ant-select-dropdown, a[data-role="item"][rel="zh_CN"], a[data-role="item"][rel="en_US"]';

function languageNotReady() {
  return Object.assign(new Error('国际站发布页语言设置暂未生效；已保留当前商品和任务进度，请稍后重试当前商品'),
    { code: 'PUBLISH_LANGUAGE_NOT_READY' });
}

function chinesePostingUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'post.alibaba.com' || url.pathname !== '/product/publish.htm') return '';
    // The header preference does not override an explicit English form URL.
    // Keep the category, item ID and all other parameters on the same form.
    url.searchParams.set('language', 'zh_CN');
    return url.href;
  } catch { return ''; }
}

async function languageControl(page) {
  const controls = page.getByText(LANGUAGE_LABEL);
  for (let index = 0, count = await controls.count(); index < count; index++) {
    const control = controls.nth(index);
    const label = await control.evaluate((node, optionContainer) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(node).visibility === 'hidden'
        || node.closest(`${optionContainer}, select, #struct-title, #struct-specification, .posting-field`)) return '';
      const inHeader = node.closest('header, [role="banner"], #header, [class*="header" i]');
      if (!inHeader && !(rect.top >= 0 && rect.bottom <= 200 && rect.left >= innerWidth / 2)) return '';
      return node.textContent.trim();
    }, OPTION_CONTAINER).catch(() => '');
    if (label) return { control, chinese: CHINESE_LABEL.test(label) };
  }
  return null;
}

async function chineseOption(page) {
  const options = page.getByText(CHINESE_LABEL);
  for (let index = 0, count = await options.count(); index < count; index++) {
    const option = options.nth(index);
    const usable = await option.evaluate((node, optionContainer) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(node).visibility === 'hidden'
        || node.closest('select, #struct-title, #struct-specification, .posting-field')) return false;
      if (node.closest('header, [role="banner"], #header, [class*="header" i]') && !node.closest(optionContainer)) return false;
      return Boolean(node.closest(optionContainer))
        || (rect.top >= 0 && rect.bottom < 500 && rect.left >= innerWidth / 2);
    }, OPTION_CONTAINER).catch(() => false);
    if (usable) return option;
  }
  return null;
}

async function formLanguage(page) {
  return page.evaluate(() => {
    const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const category = document.querySelector('#struct-catInfo');
    // The quality assistant and header are translated independently. In new
    // accounts they can say "Basic information" beside a Chinese form.
    const nativeCategory = category && visible(category) ? category.innerText : '';
    if (/当前类目\s*[:：]|Current category\s*:/i.test(nativeCategory)) return {
      chinese: /当前类目\s*[:：]/.test(nativeCategory),
      english: /Current category\s*:/i.test(nativeCategory), loading: document.readyState === 'loading',
    };
    const form = document.querySelector('#struct-content');
    const text = form ? form.innerText : [...document.querySelectorAll('h1,h2,h3,h4,label')]
      .filter(node => visible(node) && !node.closest('header,aside,nav,[role="banner"],[role="complementary"],#header,#struct-desc-card,#textDesc'))
      .map(node => node.innerText).join('\n');
    // Use form labels, not the logo, announcements, product text or menu options.
    const chinese = /(?:^|\n)\s*\*?\s*(?:基本信息|商品名称|商品标题|商品详情|商品描述)\s*[:：*]?\s*(?:\n|$)/.test(text)
      || /(?:^|\n)\s*当前类目\s*[:：]/.test(text);
    const english = /(?:^|\n)\s*\*?\s*(?:Basic information|Product name|Product title|Commodity details)\s*[:*]?\s*(?:\n|$)/i.test(text)
      || /(?:^|\n)\s*Current category\s*:/i.test(text);
    return { chinese, english, loading: document.readyState === 'loading' };
  }).catch(() => ({ chinese: false, english: false, loading: true }));
}

export async function ensureSimplifiedChinese(page, {
  timeoutMs = 45000, onProgress = () => {}, verify, beforeSwitch, signal, reloadOnMismatch = false,
} = {}) {
  let deadline = performance.now() + timeoutMs;
  let nextVerify = 0;
  let nextReport = 0;
  let hovered = false;
  let opened = false;
  let selected = false;
  let prepared = false;
  let selectedAt = 0;
  let mismatchSince = 0;
  let englishSince = 0;
  let reloaded = false;
  let switched = false;
  while (performance.now() < deadline) {
    if (signal?.aborted || page.isClosed()) {
      throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' });
    }
    if (performance.now() >= nextVerify) {
      const started = performance.now();
      await verify?.();
      deadline += performance.now() - started;
      nextVerify = performance.now() + 5000;
    }
    await requirePostingPageAvailable(page);
    let current;
    try { current = await languageControl(page); }
    catch (error) {
      if (page.isClosed()) throw error;
      // A language selection can replace the execution context during navigation.
      if (!/execution context was destroyed|cannot find context/i.test(error.message)) throw error;
    }
    const form = await formLanguage(page);
    if (form.chinese && !form.english && !form.loading) {
      if (switched) onProgress('国际站已切换为简体中文，继续当前商品');
      return { switched };
    }
    const mismatch = current?.chinese && form.english && !form.loading;
    mismatchSince = mismatch ? mismatchSince || performance.now() : 0;
    englishSince = form.english && !form.loading ? englishSince || performance.now() : 0;
    if (performance.now() >= nextReport) {
      onProgress(selected ? '等待国际站简体中文表单加载' : '检查并切换国际站页面为简体中文');
      nextReport = performance.now() + 5000;
    }
    // The header can already say Chinese while the product form still renders
    // English. Reselect the actual menu option, never the header label itself.
    if (current && (!current.chinese || (mismatchSince && performance.now() - mismatchSince >= 1000)) && !selected) {
      if (!prepared) { await beforeSwitch?.(); prepared = true; }
      const option = (hovered || opened) && await chineseOption(page);
      try {
        if (option) {
          await clickPostingControl(page, option, { timeout: 3000, noWaitAfter: true });
          selected = true;
          switched = true;
          selectedAt = performance.now();
        } else if (!hovered) {
          await current.control.hover({ timeout: 3000 });
          hovered = true;
        } else if (!opened) {
          await clickPostingControl(page, current.control, { timeout: 3000, noWaitAfter: true });
          opened = true;
        }
      } catch (error) {
        if (signal?.aborted || page.isClosed()) throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' });
        if (error.name === 'TimeoutError') throw languageNotReady();
        throw error;
      }
    }
    // The caller permits this only before it writes product fields. A new
    // account can load an English form without a usable header menu; a stale
    // language=en_US can also outlive a successful header switch. Recover the
    // form language once, without changing its category or replaying a save.
    const chineseUrl = reloadOnMismatch && chinesePostingUrl(page.url());
    const staleSelection = selected && englishSince && performance.now() - selectedAt >= 3000;
    const missingMenu = !selected && (!current || (hovered && opened)) && englishSince && performance.now() - englishSince >= 5000;
    if (reloadOnMismatch && !reloaded && (staleSelection || (chineseUrl && missingMenu))) {
      reloaded = true;
      switched = true;
      onProgress('语言设置与发布表单不同步，正在重新加载当前类目');
      await beforeSwitch?.();
      const navigation = { waitUntil: 'domcontentloaded', timeout: Math.max(1000, Math.min(30000, deadline - performance.now())) };
      await (chineseUrl && chineseUrl !== page.url() ? page.goto(chineseUrl, navigation) : page.reload(navigation)).catch((error) => {
        if (signal?.aborted || page.isClosed()) throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' });
        if (error.name !== 'TimeoutError') throw error;
      });
      hovered = false;
      opened = false;
      selected = false;
      prepared = false;
      mismatchSince = 0;
      englishSince = 0;
    }
    await page.waitForTimeout(250);
  }
  await requirePostingPageAvailable(page);
  throw languageNotReady();
}
