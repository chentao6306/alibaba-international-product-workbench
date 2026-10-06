import { announcementBlocks, validateAnnouncementBlocks, ANNOUNCEMENT_MAX_IMAGES, ANNOUNCEMENT_MAX_BLOCKS } from './announcement-content.js';
import { uploadAnnouncementImage } from './admin-image-upload.js';

export function createNoticeEditor({ getToken }) {
  const $ = id => document.getElementById(id);
  let blocks = [];
  let generation = 0;
  let uploading = false;
  const urls = new Map();
  const pending = new Map();
  const imageUrl = async src => {
    if (urls.has(src)) return urls.get(src);
    if (!pending.has(src)) {
      const current = generation;
      pending.set(src, (async () => {
        const response = await fetch(src.replace('/api/', '/api/admin/'), { headers: { authorization: `Bearer ${getToken()}` }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw Error('图片加载失败，请检查登录状态后重新打开公告');
        const blob = await response.blob();
        if (generation !== current) throw Error('公告已关闭');
        const url = URL.createObjectURL(blob);
        urls.set(src, url);
        return url;
      })().finally(() => { if (current === generation) pending.delete(src); }));
    }
    return pending.get(src);
  };
  function release() {
    generation++;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear(); pending.clear();
  }
  function button(label, action, disabled = false) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'secondary'; node.textContent = label; node.disabled = disabled;
    node.onclick = action;
    return node;
  }
  function appendImage(container, block) {
    const img = document.createElement('img');
    img.alt = block.alt || '公告图片';
    const status = document.createElement('small'); status.textContent = '正在加载图片…';
    container.append(img, status);
    imageUrl(block.src).then(url => {
      if (!img.isConnected) return;
      img.onload = () => status.remove();
      img.onerror = () => { status.textContent = '图片加载失败，请重新打开预览'; };
      img.src = url;
    }).catch(error => { if (status.isConnected) status.textContent = error.message; });
  }
  function render() {
    $('noticeBlocks').replaceChildren();
    blocks.forEach((block, index) => {
      const card = document.createElement('div'); card.className = 'notice-block';
      const toolbar = document.createElement('div'); toolbar.className = 'notice-block-toolbar';
      const title = document.createElement('strong'); title.textContent = `${index + 1}. ${block.type === 'image' ? '图片' : '文字'}`;
      const move = step => { [blocks[index], blocks[index + step]] = [blocks[index + step], blocks[index]]; render(); };
      toolbar.append(title, button('上移', () => move(-1), index === 0 || uploading), button('下移', () => move(1), index === blocks.length - 1 || uploading), button('删除', () => { blocks.splice(index, 1); render(); }, uploading));
      card.append(toolbar);
      if (block.type === 'text') {
        const textarea = document.createElement('textarea');
        textarea.setAttribute('aria-label', `文字段落 ${index + 1}`); textarea.maxLength = 20000;
        if (!blocks.slice(0, index).some(item => item.type === 'text')) textarea.id = 'noticeContent';
        textarea.placeholder = '输入公告正文，可在段落之间添加图片'; textarea.value = block.text;
        textarea.oninput = () => { block.text = textarea.value; };
        card.append(textarea);
      } else {
        appendImage(card, block);
        const label = document.createElement('label'); label.className = 'field'; label.textContent = '图片说明（可选）';
        const input = document.createElement('input'); input.maxLength = 200; input.value = block.alt;
        input.oninput = () => { block.alt = input.value; }; label.append(input); card.append(label);
      }
      $('noticeBlocks').append(card);
    });
    $('addNoticeText').disabled = uploading || blocks.length >= ANNOUNCEMENT_MAX_BLOCKS;
    $('addNoticeImages').disabled = uploading || blocks.length >= ANNOUNCEMENT_MAX_BLOCKS || blocks.filter(block => block.type === 'image').length >= ANNOUNCEMENT_MAX_IMAGES;
    $('saveNotice').disabled = uploading;
  }
  $('addNoticeText').onclick = () => { blocks.push({ type: 'text', text: '' }); render(); $('noticeBlocks').lastElementChild?.querySelector('textarea')?.focus(); };
  $('addNoticeImages').onclick = () => $('noticeImageFiles').click();
  $('noticeImageFiles').onchange = async event => {
    const input = event.target;
    const files = [...input.files];
    if (!files.length || uploading) return;
    if (files.length + blocks.filter(block => block.type === 'image').length > ANNOUNCEMENT_MAX_IMAGES || files.length + blocks.length > ANNOUNCEMENT_MAX_BLOCKS) {
      input.value = ''; $('noticeError').textContent = '每条公告最多 10 张图片、40 个段落'; return;
    }
    if (files.some(file => file.size > 8 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) {
      input.value = ''; $('noticeError').textContent = '请选择 JPG、PNG 或 WebP 图片，单张不超过 8 MB'; return;
    }
    const current = generation;
    uploading = true; render();
    try {
      for (const [index, file] of files.entries()) {
        $('noticeError').textContent = `正在上传图片 ${index + 1}/${files.length}…`;
        const data = await uploadAnnouncementImage(file, { token: getToken() });
        if (current !== generation) return;
        blocks.push({ type: 'image', src: data.src, alt: '' });
      }
      $('noticeError').textContent = '图片已上传，保存公告后生效';
    } catch (error) { if (current === generation) $('noticeError').textContent = error.message; }
    finally { if (current === generation) { input.value = ''; uploading = false; render(); } }
  };
  function preview(item) {
    const content = $('previewContent'); content.replaceChildren();
    $('previewTitle').textContent = item.title || '公告预览';
    for (const block of announcementBlocks(item)) {
      if (block.type === 'text') { const p = document.createElement('p'); p.textContent = block.text; content.append(p); }
      else if (block.type === 'image') {
        const figure = document.createElement('figure'); content.append(figure); appendImage(figure, block);
        if (block.alt) { const caption = document.createElement('figcaption'); caption.textContent = block.alt; figure.append(caption); }
      }
    }
    $('previewDialog').showModal();
  }
  $('noticeDialog').addEventListener('close', () => { release(); uploading = false; });
  $('previewDialog').addEventListener('close', () => { if (!$('noticeDialog').open) release(); });
  return {
    reset(item) { release(); uploading = false; $('noticeImageFiles').value = ''; blocks = announcementBlocks(item).map(block => ({ ...block })); if (!blocks.length) blocks.push({ type: 'text', text: '' }); render(); },
    value() { if (uploading) throw Error('图片正在上传，请稍候'); return validateAnnouncementBlocks(blocks); },
    preview,
  };
}
