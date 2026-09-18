import { requirePostingPageAvailable } from './posting-readiness.js';

const LANGUAGE_LABEL = /^(?:English|简体中文|中文[（(]简体[）)]|Simplified Chinese|Chinese\s*[（(]Simplified[）)])$/i;
const CHINESE_LABEL = /^(?:简体中文|中文[（(]简体[）)]|Simplified Chinese|Chinese\s*[（(]Simplified[）)])$/i;
const OPTION_CONTAINER = '[role="menu"], [role="listbox"], [role="menuitem"], [role="option"], .next-menu, .next-overlay-wrapper, .ant-dropdown, .ant-select-dropdown';

function languageNotReady() {
  return Object.assign(new Error('国际站页面未能切换为简体中文；请在发布浏览器右上角选择“简体中文”后继续，已保留当前商品和任务进度'),
    { code: 'PUBLISH_LANGUAGE_NOT_READY' });
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
      return Boolean(node.closest(optionContainer))
        || (rect.top >= 0 && rect.bottom < 500 && rect.left >= innerWidth / 2);
    }, OPTION_CONTAINER).catch(() => false);
    if (usable) return option;
  }
  return null;
}

async function formLanguage(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    // Use form labels, not the logo, announcements, product text or menu options.
    const chinese = /(?:^|\n)\s*\*?\s*(?:基本信息|商品名称|商品标题|商品详情|商品描述)\s*[:：*]?\s*(?:\n|$)/.test(text)
      || /(?:^|\n)\s*当前类目\s*[:：]/.test(text);
    const english = /(?:^|\n)\s*\*?\s*(?:Basic information|Product name|Product title|Commodity details)\s*[:*]?\s*(?:\n|$)/i.test(text)
      || /(?:^|\n)\s*Current category\s*:/i.test(text);
    return { chinese, english, loading: document.readyState === 'loading' };
  }).catch(() => ({ chinese: false, english: false, loading: true }));
}

export async function ensureSimplifiedChinese(page, {
  timeoutMs = 45000, onProgress = () => {}, verify, beforeSwitch, signal,
} = {}) {
  let deadline = performance.now() + timeoutMs;
  let nextVerify = 0;
  let nextReport = 0;
  let hovered = false;
  let opened = false;
  let selected = false;
  let prepared = false;
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
    if (form.chinese && !form.english && !form.loading && (!current || current.chinese)) {
      if (selected) onProgress('国际站已切换为简体中文，继续当前商品');
      return { switched: selected };
    }
    if (performance.now() >= nextReport) {
      onProgress(selected ? '等待国际站简体中文表单加载' : '检查并切换国际站页面为简体中文');
      nextReport = performance.now() + 5000;
    }
    if (current && !current.chinese && !selected) {
      if (!prepared) { await beforeSwitch?.(); prepared = true; }
      const option = (hovered || opened) && await chineseOption(page);
      try {
        if (option) {
          await option.click({ timeout: 3000, noWaitAfter: true });
          selected = true;
        } else if (!hovered) {
          await current.control.hover({ timeout: 3000 });
          hovered = true;
        } else if (!opened) {
          await current.control.click({ timeout: 3000, noWaitAfter: true });
          opened = true;
        }
      } catch (error) {
        if (signal?.aborted || page.isClosed()) throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' });
        if (error.name === 'TimeoutError') throw languageNotReady();
        throw error;
      }
    }
    await page.waitForTimeout(250);
  }
  await requirePostingPageAvailable(page);
  throw languageNotReady();
}
