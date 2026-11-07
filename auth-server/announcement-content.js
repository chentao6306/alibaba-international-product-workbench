export const ANNOUNCEMENT_IMAGE_PATH = /^\/api\/announcement-images\/[a-f0-9]{64}\.webp$/;
export const ANNOUNCEMENT_MAX_IMAGES = 10;
export const ANNOUNCEMENT_MAX_BLOCKS = 40;

export function announcementBlocks(item) {
  if (Array.isArray(item?.blocks) && item.blocks.length) return item.blocks;
  return item?.content ? [{ type: 'text', text: item.content }] : [];
}

export function validateAnnouncementBlocks(blocks) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!Array.isArray(blocks) || blocks.length > ANNOUNCEMENT_MAX_BLOCKS) fail('公告最多包含 40 个文字或图片段落');
  let images = 0;
  let textLength = 0;
  const normalized = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      textLength += text.length;
      if (textLength > 20000) fail('公告文字最多 20000 字');
      if (text) normalized.push({ type: 'text', text });
    } else if (block?.type === 'image' && typeof block.src === 'string' && ANNOUNCEMENT_IMAGE_PATH.test(block.src)) {
      if (++images > ANNOUNCEMENT_MAX_IMAGES) fail('每条公告最多上传 10 张图片');
      const alt = String(block.alt || '').trim();
      if (alt.length > 200) fail('图片说明最多 200 字');
      normalized.push({ type: 'image', src: block.src, alt });
    } else fail('公告包含无效的段落或图片，请重新上传图片');
  }
  if (!normalized.length) fail('请添加公告文字或图片');
  return normalized;
}

export function announcementPlainText(blocks) {
  return blocks.map(block => block.type === 'text' ? block.text : '[本公告包含图片，请更新至 1.4.64 或更高版本查看]').join('\n\n');
}

export function nextAnnouncementPopup(items, dismissed) {
  return items.find(item => item.kind === 'popup' && (item.popup_policy === 'every-login'
    ? !dismissed.has(`${item.id}:${item.revision}`) : !item.read)) || null;
}
