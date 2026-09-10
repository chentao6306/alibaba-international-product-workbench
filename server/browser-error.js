export function userFacingError(error) {
  const raw = String(error?.message || error || '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').trim();
  if (/setInputFiles|fileChooser\.setFiles/i.test(raw) && /timeout/i.test(raw)) {
    return '国际站图片上传控件响应超时，请重试该商品';
  }
  if (/locator\.click|back-product-detail|overlay-backdrop|pointer events/i.test(raw)) {
    return '国际站编辑器切换失败：页面仍有弹窗遮罩，请关闭提示后重试';
  }
  const cleaned = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^--[a-z0-9-]+/i.test(line) && !/^\[\d+:\d+\]/.test(line) && !/taskkill|ERROR:services|PID\s*\d+/i.test(line))
    .join(' ').replace(/[�]{2,}/g, '').replace(/\s+/g, ' ').trim();
  return (cleaned || '浏览器操作失败，请重试').slice(0, 700);
}
