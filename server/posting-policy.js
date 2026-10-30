import { AsyncLocalStorage } from 'node:async_hooks';

export const POLICY_WARNING_TEXT = /疑似涉及禁限售|涉嫌侵权|疑似侵权|(?:产品|商品).{0,40}(?:违反禁限售|涉及违禁)|(?:suspected|potential).{0,40}(?:restricted|prohibited|infringement)/i;
const POLICY_REJECTION_TEXT = /(?:禁止|不允许|不能|不可|无法)发布|(?:发布|提交|审核)(?:已)?(?:被拒绝|被拒|不通过)|(?:cannot|not allowed to|not permitted to)\s+(?:publish|list|submit)|publication\s+(?:rejected|prohibited)/i;
const policyContext = new AsyncLocalStorage();
export const POLICY_RULE_CONFIRMATION_TEXT = /请确认(?:已充分了解)?[^。\n]{0,80}禁限售规则|please confirm[^.\n]{0,160}(?:restriction|ban and restriction) rules/i;

// Alibaba's SalesRange component renders this field only when the server's
// country risk response requests a strong notice. It is not a warning dialog.
export async function acknowledgeSalesRules(page, { required = false } = {}) {
  const fields = page.locator('.sales-range:visible').filter({ hasText: POLICY_RULE_CONFIRMATION_TEXT });
  if (!await fields.count() && !required) return null;
  const unavailable = () => Object.assign(new Error('国际站要求确认禁限售规则，但确认控件尚未就绪，请查看发布页面后继续；商品进度已保留'),
    { code: 'PUBLISH_CONFIRMATION_PENDING' });
  if (await fields.count() !== 1) throw unavailable();
  const field = fields.first();
  const checkbox = field.locator('input[type="checkbox"]');
  if (await checkbox.count() !== 1) throw unavailable();
  if (await checkbox.isChecked()) return null;
  if (!policyWarningPublishingAllowed()) throw Object.assign(new Error('国际站要求确认禁限售规则；当前未启用“允许禁限售提示商品上架”，未继续提交'),
    { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
  const text = (await field.innerText()).replace(/\s+/g, ' ').trim();
  requireNoPolicyWarning([text]);
  if (!await checkbox.isVisible() || await checkbox.isDisabled()) throw unavailable();
  try {
    await checkbox.check({ timeout: 5000 });
    await page.waitForTimeout(150);
    if (!await checkbox.isChecked()) throw unavailable();
  } catch (error) { throw Object.assign(unavailable(), { cause: error }); }
  const warning = { text: text.slice(0, 1200), action: 'acknowledge-sales-rules', at: new Date().toISOString() };
  const state = policyContext.getStore();
  state.warnings.push(warning);
  state.onProgress('已按设置确认国际站禁限售规则，继续等待平台处理');
  return warning;
}

export function withPostingPolicy(options, operation) {
  return policyContext.run({ allowed: options.allowPolicyWarningPublish === true, handled: new Set(), warnings: [],
    onProgress: options.onProgress || (() => {}) }, async () => {
    try { return await operation(); }
    catch (error) {
      const warnings = policyAcknowledgements();
      if (warnings.length) error.diagnostics = { ...error.diagnostics, policyAcknowledgements: warnings };
      throw error;
    }
  });
}

export function policyWarningPublishingAllowed() {
  return policyContext.getStore()?.allowed === true;
}

export function policyAcknowledgements() {
  return structuredClone(policyContext.getStore()?.warnings || []);
}

export function isBlockingPolicyFeedback(text, allowWarnings = false) {
  return POLICY_REJECTION_TEXT.test(text) || (POLICY_WARNING_TEXT.test(text) && !allowWarnings);
}

export function requireNoPolicyWarning(feedback) {
  const warnings = feedback.filter(text => isBlockingPolicyFeedback(text, policyWarningPublishingAllowed()));
  if (!warnings.length) return;
  const detail = warnings.find(text => /商品名称|产品名称|product name/i.test(text)) || warnings[0];
  throw Object.assign(new Error(`国际站提示商品需人工核对禁限售或侵权风险，未继续提交：${String(detail).replace(/\s+/g, ' ').trim().slice(0, 700)}`),
    { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
}

export async function acknowledgePolicyWarning(page, { submission = false } = {}) {
  const state = policyContext.getStore();
  if (!state?.allowed) return null;
  const dialogs = page.locator('.next-dialog:visible, [role="dialog"]:visible, [aria-modal="true"]:visible');
  for (let index = 0; index < await dialogs.count(); index++) {
    const dialog = dialogs.nth(index);
    const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    if (!POLICY_WARNING_TEXT.test(text)) continue;
    requireNoPolicyWarning([text]);
    if (state.handled.has(text)) return null;
    const proceed = dialog.getByRole('button', { name: /^(?:继续提交|继续发布|确认提交|确认发布|仍要提交|仍要发布|Continue(?: submission| publishing)?|Submit anyway|Publish anyway)$/i });
    const close = dialog.getByRole('button', { name: /^(?:确定|确认|我知道了|知道了|关闭|OK|Got it|Close)$/i });
    const willSubmit = await proceed.count() === 1 && await proceed.isVisible();
    if (willSubmit && !submission) throw Object.assign(new Error('国际站风险提示需要确认提交，当前尚未进入正式提交阶段，已保留商品进度'), { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
    const action = willSubmit ? proceed : close;
    if (await action.count() !== 1 || !await action.isVisible() || await action.isDisabled()) continue;
    // Mark before clicking: a lost response must never submit the same notice
    // twice, including through the generic overlay recovery path.
    state.handled.add(text);
    const warning = { text: text.slice(0, 1200), action: willSubmit ? 'continue-submission' : 'acknowledge-notice', at: new Date().toISOString() };
    state.warnings.push(warning);
    state.onProgress('已启用风险提示继续上架，正在确认平台提示');
    try { await action.click({ timeout: 5000, noWaitAfter: true }); }
    catch (error) { throw Object.assign(new Error('国际站风险提示确认结果不明确，请先核对当前商品，避免重复提交'), { code: 'PUBLISH_CONFIRMATION_PENDING', cause: error }); }
    return warning;
  }
  return null;
}
