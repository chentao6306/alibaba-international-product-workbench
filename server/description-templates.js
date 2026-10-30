import { load } from 'cheerio';
import { createHash, randomUUID } from 'node:crypto';
import { findWorkspaceJobs } from './store.js';
import { recordProductMutation, syncProductModel } from './product-model.js';
import { localImagePath } from './image-processing.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const allowedTags = new Set('p div span h1 h2 h3 h4 h5 h6 strong b em i u s br hr ul ol li table thead tbody tfoot tr th td img a blockquote section'.split(' '));
const safeImage = (url) => /^https?:\/\/[^\s<>"']+$/i.test(url) || /^\/media\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(url);

export function sanitizeTemplateHtml(html) {
  const $ = load(String(html || ''), null, false);
  $('script,style,iframe,object,embed,svg,math,link,meta,base,form,input,button,textarea,select').remove();
  $('*').each((_, node) => {
    const element = $(node), tag = node.tagName;
    if (!allowedTags.has(tag)) { element.replaceWith(element.contents()); return; }
    for (const [key, value] of Object.entries(node.attribs || {})) {
      const allowed = ['alt', 'title'].includes(key) || ['width', 'height', 'colspan', 'rowspan'].includes(key) && /^\d{1,4}%?$/.test(value)
        || tag === 'img' && key === 'src' && safeImage(value)
        || tag === 'a' && key === 'href' && /^https?:\/\//i.test(value)
        || key === 'data-workbench-template' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
        || tag === 'img' && key === 'data-workbench-product-image' && value === '1';
      if (key === 'style') {
        const safe = value.split(';').map((part) => part.trim()).filter((part) => /^(?:color|background-color|text-align|font-size|font-weight|font-style|text-decoration|width|height|max-width|border|border-collapse|padding|margin)\s*:\s*[-#(),.%\w\s]+$/i.test(part) && !/url|expression|javascript|behavior/i.test(part)).join(';');
        if (safe) element.attr('style', safe); else element.removeAttr(key);
      } else if (!allowed) element.removeAttr(key);
    }
    if (tag === 'img' && !element.attr('src')) element.remove();
  });
  return $.root().html() || '';
}

export function templateImageUrls(html) {
  const $ = load(html || '', null, false);
  return [...new Set($('img').toArray().map((node) => $(node).attr('src')).filter(Boolean))];
}

export function descriptionRevision(product) {
  return createHash('sha256').update(JSON.stringify([product.title, product.brand, product.model, product.price, product.description, product.descriptionHtml, product.structuredDescription, product.detailImages, product.descriptionTemplate])).digest('hex');
}

export function renderDescriptionTemplate(product, template, mode) {
  if (!['replace', 'append', 'prepend'].includes(mode)) throw fail('请选择模板应用方式');
  const values = { title: product.title, brand: product.brand, model: product.model, price: product.price, description: product.description };
  const $original = load(sanitizeTemplateHtml(product.descriptionHtml || product.structuredDescription?.html || ''), null, false);
  // Do not turn a previous company banner into a product photo on reapplication.
  const productImages = (product.detailImages || []).filter(safeImage).filter((url) => {
    const nodes = $original('img').toArray().filter((node) => $original(node).attr('src') === url);
    return !nodes.length || nodes.some((node) => $original(node).attr('data-workbench-product-image') === '1' || !$original(node).closest('[data-workbench-template]').length);
  });
  const clean = sanitizeTemplateHtml(template.html);
  const $block = load(clean, null, false);
  // Variables are expanded in text nodes only, never in URL/style attributes.
  const visit = (nodes) => { for (const node of [...nodes]) {
    if (node.type === 'text') {
      const text = node.data || '';
      if (!/\{\{\w+\}\}/.test(text)) continue;
      const expanded = escape(text).replace(/\{\{(title|brand|model|price|description|productImages)\}\}/g, (_, key) => key === 'productImages'
        ? productImages.map((url) => `<img data-workbench-product-image="1" src="${escape(url)}" style="max-width:100%;height:auto">`).join('')
        : escape(values[key]).replace(/\n/g, '<br>'));
      $block(node).replaceWith(expanded);
    } else if (node.children) visit(node.children);
  } };
  visit($block.root()[0].children);
  const block = `<section data-workbench-template="${escape(template.id)}">${$block.root().html()}</section>`;
  const $ = load(sanitizeTemplateHtml(product.descriptionHtml || product.structuredDescription?.html || `<p>${escape(product.description)}</p>`), null, false);
  $('[data-workbench-template]').remove();
  const old = $.root().html() || '';
  const html = mode === 'replace' ? block : mode === 'prepend' ? block + old : old + block;
  const images = templateImageUrls(html);
  // Existing images not represented by source HTML still belong to an appended
  // product description. Full replacement only uses images in the new template.
  if (mode !== 'replace') for (const url of productImages) if (!images.includes(url)) images.push(url);
  if (images.length > 30) throw fail(`“${product.title || product.id}”详情图超过 30 张，请精简模板或现有图片`);
  const $result = load(html, null, false);
  const present = new Set(templateImageUrls(html));
  for (const url of images) if (!present.has(url)) $result.root().append($result('<img>').attr('src', url));
  const finalHtml = $result.root().html() || '';
  return { descriptionHtml: finalHtml, description: $result.root().text().trim(), detailImages: images,
    structuredDescription: { ...product.structuredDescription, html: finalHtml, text: $result.root().text().trim(), images },
    imageEdits: { ...product.imageEdits, detail: true },
    descriptionTemplate: { id: template.id, name: template.name, version: template.version, mode } };
}

// Keep image slots in the customer's chosen layout while Alibaba uploads local
// files to its own image bank; URLs are remapped after the upload succeeds.
export function templatePublishHtml(product) {
  const $ = load(sanitizeTemplateHtml(product.descriptionHtml), null, false);
  const urls = product.detailImages || [];
  $('img').each((_, node) => {
    const index = urls.indexOf($(node).attr('src'));
    if (index < 0) $(node).remove();
    else $(node).replaceWith(`<span data-workbench-image-slot="${index}"></span>`);
  });
  return $.root().html() || '';
}

export async function placeTemplateImages(page, product) {
  const count = (product.detailImages || []).length;
  if (!count) return;
  const ok = await page.evaluate(({ count, html, urls }) => {
    const editor = [...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])].find((item) => item && !item.hidden);
    const body = editor?.getBody?.(); if (!body) return false;
    const images = [...body.querySelectorAll('img')].filter((node) => node.getAttribute('src'));
    if (images.length !== count) return false;
    const document = body.ownerDocument, container = document.createElement('div'); container.innerHTML = html;
    const expected = [];
    for (const node of container.querySelectorAll('img')) {
      const image = images[urls.indexOf(node.getAttribute('src'))];
      const remote = image?.getAttribute('src');
      if (!remote || !/^(https?:)?\/\//i.test(remote)) return false;
      node.setAttribute('src', remote); expected.push(remote);
    }
    editor.setContent(container.innerHTML); editor.save(); editor.fire('input'); editor.fire('change');
    return JSON.stringify([...body.querySelectorAll('img')].map((node) => node.getAttribute('src'))) === JSON.stringify(expected);
  }, { count, html: sanitizeTemplateHtml(product.descriptionHtml), urls: product.detailImages });
  if (!ok) throw fail('公司模板图片上传后未能恢复排版，已停止提交，请重试', 409);
}

export function registerDescriptionTemplateApi(app, { store, mediaDir }) {
  app.get('/api/description-templates', (_request, response) => response.json(store.read((s) => s.descriptionTemplates || [])));
  app.post('/api/description-templates', async (request, response, next) => {
    try {
      const name = String(request.body?.name || '').trim(), raw = String(request.body?.html || '');
      if (!name || name.length > 80 || raw.length > 100000) throw fail('模板名称需为 1～80 个字符，详情不超过 10 万字符');
      const html = sanitizeTemplateHtml(raw);
      if (!load(html).text().trim() && !templateImageUrls(html).length) throw fail('请填写模板内容');
      const images = templateImageUrls(html);
      if (images.length > 30) throw fail('模板最多 30 张图片');
      for (const url of images) if (url.startsWith('/media/')) await localImagePath(mediaDir, url);
      const result = store.update((s) => {
        s.descriptionTemplates ||= [];
        const existing = request.body.id && s.descriptionTemplates.find((t) => t.id === request.body.id);
        if (request.body.id && (!existing || existing.version !== request.body.version)) throw fail('模板已更新或删除，请重新打开后编辑', 409);
        if (!existing && s.descriptionTemplates.length >= 50) throw fail('最多保存 50 套模板');
        const template = { id: existing?.id || randomUUID(), name, html, version: (existing?.version || 0) + 1, updatedAt: new Date().toISOString() };
        if (existing) Object.assign(existing, template); else s.descriptionTemplates.push(template);
        return template;
      });
      response.json(result);
    } catch (error) { next(error); }
  });
  app.delete('/api/description-templates/:id', (request, response, next) => {
    try {
      store.update((s) => {
        const existing = (s.descriptionTemplates || []).find((t) => t.id === request.params.id);
        if (!existing || existing.version !== request.body?.version) throw fail('模板已更新或删除，请刷新', 409);
        s.descriptionTemplates = s.descriptionTemplates.filter((t) => t.id !== existing.id);
      });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });
  function preview(state, body) {
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw fail('请选择 1～200 件商品');
    const template = (state.descriptionTemplates || []).find((t) => t.id === body.templateId);
    if (!template || template.version !== body.version) throw fail('模板已更新或删除，请重新选择并预览', 409);
    const index = new Map(state.products.map((p) => [p.id, p])), items = [], failures = [];
    for (const id of ids) {
      const product = index.get(id);
      try {
        if (!product) throw fail('商品已删除，请刷新', 409);
        const patch = renderDescriptionTemplate(product, template, body.mode);
        items.push({ id, title: product.title, revision: descriptionRevision(product),
          ...(body.summary ? {} : { beforeHtml: sanitizeTemplateHtml(product.descriptionHtml || `<p>${escape(product.description)}</p>`), patch }) });
      } catch (error) {
        if (!body.partial) throw error;
        failures.push({ id, title: product?.title || id, error: error.message });
      }
    }
    return { items, failures };
  }
  app.post('/api/description-templates/preview', (request, response, next) => {
    // Compute the small response before cloning; never clone the entire product
    // catalog or send hundreds of full before/after documents to the renderer.
    try { response.json(store.read((s) => preview(s, request.body || {}))); } catch (error) { next(error); }
  });
  app.post('/api/description-templates/apply', (request, response, next) => {
    try {
      const body = request.body || {}, partial = body.partial === true;
      const result = store.update((s) => {
        const { items, failures } = preview(s, { ...body, summary: false });
        const index = new Map(s.products.map((p) => [p.id, p])), ready = [];
        for (const item of items) {
          try {
            if (body.revisions?.[item.id] !== item.revision) throw fail('商品详情已修改，请重新预览后应用', 409);
            if (findWorkspaceJobs(s, { productIds: [item.id] }, ['queued', 'running', 'pause_requested']).length) throw fail('商品正在处理，请暂停或完成任务后应用模板', 409);
            ready.push(item);
          } catch (error) {
            if (!partial) throw error;
            failures.push({ id: item.id, title: item.title, error: error.message });
          }
        }
        for (const item of ready) {
          const product = index.get(item.id); syncProductModel(product);
          recordProductMutation(product, { ...item.patch, status: 'ready' }, { actor: 'user', action: 'description-template' });
        }
        return partial ? { updated: ready.length, saved: ready.map((p) => p.id), failures } : { updated: ready.length };
      });
      response.json(result);
    } catch (error) { next(error); }
  });
}
