import { isStorageError, storageError } from './storage-error.js';

export function isPostingOverlayError(error) {
  return error?.code === 'PUBLISH_OVERLAY_BLOCKED'
    || /(?:next-)?overlay-backdrop|mce-modal-block|页面仍有弹窗遮罩/i.test(String(error?.message || error || ''));
}

export function isBrowserInteractionError(error) {
  const message = String(error?.message || error || '');
  return /(?:locator|page|frame|elementHandle|fileChooser|browserContext|browser)\.[a-zA-Z]+\s*:/.test(message)
    || /Call log:|strict mode violation|Execution context was destroyed|Target (?:page, context or browser|closed)|element is not attached to the DOM/i.test(message);
}

export function userFacingError(error) {
  if (isStorageError(error)) return error.storageFailure ? error.message : storageError(error).message;
  const raw = String(error?.message || error || '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').trim();
  if (error?.code === 'PUBLISH_SUBMIT_RESULT_UNKNOWN') return `发布结果待核对：${raw}`.slice(0, 700);
  if (error?.code === 'PUBLISH_CONTROL_OBSCURED' && error.diagnostics?.target?.label) {
    const label = String(error.diagnostics.target.label).replace(/\s+/g, ' ').trim().slice(0, 100);
    return `“${label}”的页面操作未完成，请稍后重试该商品`;
  }
  if (/setInputFiles|fileChooser\.setFiles/i.test(raw) && /timeout/i.test(raw)) {
    return '国际站图片上传控件响应超时，请重试该商品';
  }
  if (isPostingOverlayError(error)) {
    const prompt = error?.diagnostics?.overlays?.find((overlay) => overlay.text)?.text;
    return prompt ? `国际站有待处理的提示：${prompt}；请处理后重试该商品`
      : '国际站有待处理的页面提示，请查看卖家页面后重试该商品';
  }
  if (/intercepts pointer events/i.test(raw)) {
    return '当前商品页面操作尚未完成，请稍后重试该商品';
  }
  if (/locator\.click/i.test(raw) && /timeout/i.test(raw)) {
    return '国际站页面按钮未就绪或已发生变化，请重试该商品';
  }
  if (isBrowserInteractionError(error)) {
    if (/image-placeholder-span|image-uploader|scrollIntoViewIfNeeded.*主图/i.test(raw)) {
      return '国际站主图上传入口暂未就绪，请稍后重试该商品';
    }
    if (/Target.*closed|browser has been closed/i.test(raw)) return '国际站卖家页面已关闭，请稍后重试该商品';
    return '国际站页面操作未完成，请稍后重试该商品';
  }
  const cleaned = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^--[a-z0-9-]+/i.test(line) && !/^\[\d+:\d+\]/.test(line) && !/taskkill|ERROR:services|PID\s*\d+/i.test(line))
    .join(' ').replace(/[�]{2,}/g, '').replace(/\s+/g, ' ').trim()
    .replace(/已保留当前商品进度[，；]?请(?:稍后)?继续/g, '请稍后重试该商品');
  return (cleaned || '浏览器操作失败，请重试').slice(0, 700);
}
