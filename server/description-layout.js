import { load } from 'cheerio';

export function descriptionImageSlots(html, urls) {
  const $ = load(html || '', null, false);
  const used = new Set();
  $('img').each((_, node) => {
    const image = $(node);
    const index = urls.indexOf(image.attr('src'));
    if (index < 0) { image.remove(); return; }
    // Retain the surrounding paragraph/table, never a remote source image.
    image.replaceWith(`<span data-workbench-source-image="${index}"></span>`);
    used.add(index);
  });
  $('picture source').remove();
  for (const [index] of urls.entries()) if (!used.has(index)) $.root().append(`<p><span data-workbench-source-image="${index}"></span></p>`);
  return $.root().html() || '';
}

// Image uploads finish in source order. Rebuild from the prepared HTML rather
// than the editor's live selection, which may move during asynchronous uploads.
export async function restoreDescriptionImages(page, html, count) {
  if (!count) return html;
  const restored = await page.evaluate(({ html, count }) => {
    const editor = [...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])].find(item => item && !item.hidden);
    const body = editor?.getBody?.();
    if (!body) return null;
    const images = [...body.querySelectorAll('img[src]')];
    if (images.length !== count || images.some(node => !/^(https?:)?\/\//i.test(node.getAttribute('src')))) return false;
    const container = body.ownerDocument.createElement('div');
    container.innerHTML = html;
    const expected = [];
    for (const slot of container.querySelectorAll('[data-workbench-source-image]')) {
      const image = images[Number(slot.getAttribute('data-workbench-source-image'))];
      if (!image) return false;
      const copy = image.cloneNode(true);
      copy.removeAttribute('data-mce-src');
      expected.push(copy.getAttribute('src'));
      slot.replaceWith(copy);
    }
    if (expected.length < count) return false;
    editor.setContent(container.innerHTML); editor.save(); editor.fire('input'); editor.fire('change'); editor.fire('blur');
    return JSON.stringify([...body.querySelectorAll('img')].map(node => node.getAttribute('src'))) === JSON.stringify(expected)
      ? { html: container.innerHTML } : false;
  }, { html, count });
  if (restored === null) {
    // The existing publisher also supports an editable iframe without an
    // exposed TinyMCE instance. Preserve that path instead of introducing a
    // failure for otherwise usable editors.
    for (const frame of page.frames()) {
      const body = frame.locator('body.mce-content-body, body[contenteditable="true"]').first();
      if (!await body.isVisible().catch(() => false)) continue;
      const urls = await body.locator('img[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
      if (urls.length !== count || urls.some(url => !/^(https?:)?\/\//i.test(url))) break;
      const $ = load(html, null, false), expected = [];
      let valid = true;
      $('[data-workbench-source-image]').each((_, node) => {
        const url = urls[Number($(node).attr('data-workbench-source-image'))];
        if (!url) { valid = false; return; }
        $(node).replaceWith($('<img>').attr('src', url).attr('style', 'max-width:100%;height:auto'));
        expected.push(url);
      });
      if (!valid || expected.length < count) break;
      const content = $.root().html();
      await body.evaluate((node, value) => {
        node.innerHTML = value;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
      }, content);
      const element = await frame.frameElement().catch(() => null);
      const editorId = String(await element?.getAttribute('id') || '').replace(/_ifr$/, '');
      if (editorId) {
        const field = page.locator(`[id=${JSON.stringify(editorId)}]`);
        if (await field.count()) await field.evaluate((node, value) => {
          node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
        }, content);
      }
      const actual = await body.locator('img').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
      if (JSON.stringify(actual) === JSON.stringify(expected)) return content;
      break;
    }
  }
  if (!restored) throw Object.assign(new Error('详情图片上传后未能确认图文顺序，已保留商品，请重试'), { code: 'DETAIL_IMAGE_LAYOUT_FAILED' });
  return restored.html;
}

export function descriptionContainsText(html, text) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const source = normalize(load(html || '').text());
  const candidate = normalize(text);
  return Boolean(source && candidate && (source.includes(candidate)
    // Legacy captures append this source module heading to the plain-text
    // summary, even though sanitization has removed it from the HTML.
    || source === candidate.replace(/companyprofile$/, '')));
}
