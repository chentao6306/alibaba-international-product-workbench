export function publishRepairPlan(error) {
  const message = String(error?.message || error || '');
  if (/PUBLISH_ACCOUNT_LIMIT|PUBLISH_POLICY_REVIEW_REQUIRED|HUMAN_VERIFICATION|LOGIN_REQUIRED/.test(error?.code || '')
    || /禁限售|违禁|风控违规|侵权|发布额度|总量已超出限制|登录状态.*失效|prohibited|restricted product/i.test(message)) return [];

  const mainImages = /商品图片|主图.*(?:为空|失败)|请上传.*图片|image.*required/i.test(message);
  const specifications = mainImages || /商品规格项|规格图片|规格图|specification.*image|spec.*image/i.test(message);
  const attributes = (error?.requiredFields || []).length > 0
    || /属性值不能为空|required(?: field| attribute)?[^\n]{0,40}(?:empty|blank|missing)|attribute[^\n]{0,40}(?:empty|required)/i.test(message)
    || /(?:必填项?不能为空|不能为空)/.test(message);
  const logistics = /物流属性|重量、体积|(?:重量|体积|发货期|运费模[板版]).{0,10}(?:未填写|为空|必填)|logistics attribute.*(?:fill in completely|remove all|not filled|incomplete)|(?:packaging|shipping|weight|volume).*?(?:incomplete|required|empty)/i.test(message);
  const overlay = /页面仍有弹窗遮罩|overlay|intercepts pointer events/i.test(message);
  return [
    overlay && 'overlay',
    mainImages && 'mainImages',
    specifications && 'specifications',
    attributes && 'attributes',
    logistics && 'logistics',
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
