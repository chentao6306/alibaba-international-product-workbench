import { currentDescriptionStructure, extractDescriptionStructure } from './description-structure.js';
import { revealDescriptionSection } from './posting-readiness.js';
import { clickPostingControl } from './posting-interaction.js';
import { descriptionCompatibilityKey } from './description-compatibility.js';

const compatibility = new WeakMap();
export function descriptionCompatibility(page, product) {
  const selected = compatibility.get(page);
  return selected?.url === page.url() && selected.key === descriptionCompatibilityKey(product) ? selected : null;
}

const legacyButton = /^(?:返回老版|返回旧版|Switch to (?:the )?(?:old|classic|legacy) (?:version|editor)|Back to (?:the )?(?:old|classic|legacy) (?:version|editor))$/i;
const structuredButton = /^(?:使用新版|切换新版|切换到新版|体验新版|试用新版|升级新版|Switch to (?:the )?(?:new|structured) (?:version|editor))$/i;
const confirmation = /^(?:继续返回旧版|继续返回老版|Continue (?:to|with) (?:the )?(?:old|classic|legacy) (?:version|editor))$/i;

export function sourceDescriptionFormat(product) {
  if (product.descriptionTemplate) return 'legacy';
  if (currentDescriptionStructure(product)) return 'structured';
  // An edited/stale module capture is not evidence of an old source page.
  const snapshot = product.source?.snapshot;
  if (product.structuredDescription?.version === 1 || snapshot?.structuredDescription?.version === 1
    || extractDescriptionStructure(snapshot?.descriptionHtml)) return 'structured';
  return 'legacy';
}

export async function postingDescriptionMode(page) {
  const mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
  if ([4, 5].includes(Number(mode))) return 'structured';
  if (await page.locator('#textDesc, #detailImage').filter({ visible: true }).count()
    || await page.getByRole('button', { name: legacyButton }).filter({ visible: true }).count()) return 'structured';
  if (mode != null || await page.locator('#struct-superText, .posting-field-supertext, iframe[id$="_ifr"]').filter({ visible: true }).count()) return 'legacy';
  return 'unknown';
}

function mismatch(format, stage) {
  return Object.assign(new Error(`原商品使用${format === 'legacy' ? '旧版图文' : '新版结构化'}详情，当前发布页未能切换到对应编辑器；已保留原始内容，尚未提交商品`), {
    code: 'PUBLISH_DESCRIPTION_MODE_UNAVAILABLE', diagnostics: { sourceDescriptionFormat: format, stage },
  });
}

// Prefer the source format. Only an unavailable native entrance can select
// the existing legacy editor; a rejected/ambiguous switch is never bypassed.
export async function ensureSourceDescriptionMode(page, product, { timeoutMs = 12000, onProgress = () => {}, beforeInteraction = async () => {} } = {}) {
  const format = sourceDescriptionFormat(product);
  if (format === 'structured' && !currentDescriptionStructure(product)) throw mismatch(format, 'source-modules-unavailable');
  await revealDescriptionSection(page);
  const initial = await postingDescriptionMode(page);
  if (initial === format || (initial === 'unknown' && format === 'legacy')) {
    compatibility.delete(page);
    return format;
  }
  if (initial === 'legacy' && descriptionCompatibility(page, product)) return 'legacy';
  onProgress(`按原商品使用${format === 'legacy' ? '旧版图文' : '新版结构化'}详情`);
  const button = page.getByRole('button', { name: format === 'legacy' ? legacyButton : structuredButton }).filter({ visible: true });
  try { await button.first().waitFor({ state: 'visible', timeout: timeoutMs }); }
  catch (error) {
    if (page.isClosed() || !/Timeout/i.test(error.message)) throw error;
    if (format === 'structured' && await postingDescriptionMode(page) === 'legacy'
      && await page.locator('#struct-superText, #super-text-container, #productDescType, iframe[id$="_ifr"]').filter({ visible: true }).count()) {
      const warning = '当前账号未开放新版详情入口，已兼容使用普通图文编辑器；正文、表格和图片仍逐项核验，视频仍单独上传关联';
      compatibility.set(page, { url: page.url(), key: descriptionCompatibilityKey(product),
        sourceFormat: format, targetFormat: 'legacy', reason: 'structured-entry-unavailable', warning });
      onProgress(warning);
      return 'legacy';
    }
    throw mismatch(format, 'switch-entry');
  }
  if (await button.count() !== 1) throw mismatch(format, 'ambiguous-switch-entry');
  await beforeInteraction();
  await clickPostingControl(page, button);
  let confirmed = false;
  const deadline = Date.now() + timeoutMs;
  do {
    if (await postingDescriptionMode(page) === format) return format;
    if (format === 'legacy' && !confirmed) {
      const confirm = page.getByRole('button', { name: confirmation }).filter({ visible: true });
      if (await confirm.count() === 1) { await clickPostingControl(page, confirm); confirmed = true; }
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw mismatch(format, 'switch-not-committed');
}

export async function requireSourceDescriptionMode(page, product) {
  const expected = descriptionCompatibility(page, product)?.targetFormat || sourceDescriptionFormat(product);
  const actual = await postingDescriptionMode(page);
  if (actual !== expected && !(expected === 'legacy' && actual === 'unknown')) throw mismatch(expected, 'before-submit');
}
