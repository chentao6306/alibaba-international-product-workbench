import { isBrowserInteractionError, isPostingOverlayError } from './browser-error.js';

export const SPECIFICATION_IMAGE_REQUIRED_TEXT = /请选择(?:至少)?一个规格上传图片|(?:please\s+)?(?:select|choose)\s+(?:at least\s+)?(?:one|a)\s+(?:specification|variant)\s+(?:to|for)\s+upload(?:ing)?\s+(?:an?\s+)?(?:image|photo)/i;
export const MAIN_IMAGE_VALIDATION_TEXT = /(?:商品|产品)\s*图片|主图.*(?:为空|失败)|请上传.*图片|product\s+(?:images?|photos?)|image.*required/i;

export function publishEnvironmentBlockCode(error) {
  const codes = ['PUBLISH_EDITOR_NOT_READY', 'PUBLISH_FORM_NOT_READY', 'PUBLISH_FIELD_NOT_READY',
    'PUBLISH_BROWSER_NOT_READY', 'PUBLISH_LANGUAGE_NOT_READY', 'PUBLISH_NAVIGATION_TIMEOUT', 'PUBLISH_NAVIGATION_INTERRUPTED', 'PUBLISH_EXISTING_PRODUCT_PAGE', 'PUBLISH_ACCOUNT_LIMIT',
    'PUBLISH_CATEGORY_INVALID', 'PUBLISH_OVERLAY_BLOCKED', 'PUBLISH_CONTROL_OBSCURED', 'PUBLISH_CONFIRMATION_PENDING', 'PUBLISH_SUBMIT_RESULT_UNKNOWN',
    'PUBLISH_IMAGE_BANK_FULL', 'PUBLISH_IMAGE_SERVICE_BLOCKED', 'PUBLISH_CONTROL_NOT_READY',
    'PUBLISH_CONTROL_RESULT_UNKNOWN', 'PUBLISH_IMAGE_RECEIPT_UNKNOWN',
    'MAIN_IMAGE_CONTROL_NOT_READY', 'MAIN_IMAGE_UPLOAD_PENDING', 'IMAGE_UPLOAD_TIMEOUT', 'PUBLISH_STAGE_TIMEOUT'];
  if (codes.includes(error?.code)) return error.code;
  // Playwright can encounter a dialog between two checked stages. Preserve
  // this as an environment blocker even when it has no application error code.
  if (isPostingOverlayError(error)) return 'PUBLISH_OVERLAY_BLOCKED';
  if (/intercepts pointer events/i.test(error?.message || '')) return 'PUBLISH_CONTROL_OBSCURED';
  if (isBrowserInteractionError(error)) return 'PUBLISH_CONTROL_NOT_READY';
  return '';
}

export function publishRepairPlan(error) {
  const message = String(error?.message || error || '');
  if (['PUBLISH_CONTROL_RESULT_UNKNOWN', 'PUBLISH_IMAGE_RECEIPT_UNKNOWN', 'PUBLISH_NAVIGATION_INTERRUPTED', 'PUBLISH_EXISTING_PRODUCT_PAGE'].includes(error?.code)) return [];
  // A browser timeout may occur after an action was dispatched. Repair fields
  // only from actual form validation, never from selectors in a call log.
  if (isBrowserInteractionError(error)) return [];
  if (/PUBLISH_ACCOUNT_LIMIT|PUBLISH_IMAGE_BANK_FULL|PUBLISH_IMAGE_SERVICE_BLOCKED|PUBLISH_POLICY_REVIEW_REQUIRED|PUBLISH_CONFIRMATION_PENDING|PUBLISH_SUBMIT_RESULT_UNKNOWN|PUBLISH_STAGE_TIMEOUT|PUBLISH_NAVIGATION_TIMEOUT|HUMAN_VERIFICATION|LOGIN_REQUIRED/.test(error?.code || '')
    || /禁限售|违禁|风控违规|侵权|发布额度|总量已超出限制|登录状态.*失效|prohibited|restricted product/i.test(message)) return [];

  const specificationImageError = error?.code === 'PUBLISH_SPEC_IMAGE_REQUIRED';
  const mainImages = !specificationImageError && MAIN_IMAGE_VALIDATION_TEXT.test(message);
  const specifications = specificationImageError || mainImages || SPECIFICATION_IMAGE_REQUIRED_TEXT.test(message)
    || /商品规格项|规格图片|规格图|specification.*image|spec.*image/i.test(message);
  const attributes = !specificationImageError && ((error?.requiredFields || []).length > 0
    || /属性值不能为空|required(?: field| attribute)?[^\n]{0,40}(?:empty|blank|missing)|attribute[^\n]{0,40}(?:empty|required)/i.test(message)
    || /(?:必填项?不能为空|不能为空)/.test(message));
  const logistics = /物流属性|重量、体积|(?:重量|体积|发货期|运费模[板版]).{0,10}(?:未填写|为空|必填)|logistics attribute.*(?:fill in completely|remove all|not filled|incomplete)|(?:packaging|shipping|weight|volume).*?(?:incomplete|required|empty)/i.test(message);
  const overlay = isPostingOverlayError(error);
  return [
    overlay && 'overlay',
    specifications && 'specifications',
    attributes && 'attributes',
    logistics && 'logistics',
    // Repair the final image model after specifications can rebuild it.
    mainImages && 'mainImages',
  ].filter(Boolean);
}

// Repair all reported fields before resubmitting. A second validation response
// can reveal another missing field, but an uncertain receipt must not be retried.
export async function submitWithRepairs({ submit, repairs, beforeRepair = async () => {}, onRepair = () => {}, maxRepairs = 2 }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await submit();
    } catch (error) {
      const plan = publishRepairPlan(error);
      if (!plan.length || attempt >= maxRepairs) throw error;
      await beforeRepair();
      let changed = false;
      for (const field of plan) {
        if (!repairs[field]) continue;
        onRepair(field, attempt + 1);
        changed = Boolean(await repairs[field](error)) || changed;
      }
      if (!changed) throw error;
    }
  }
}
