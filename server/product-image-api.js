import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { imageRevision as imageState, productImageLists } from './product-images.js';
import { findWorkspaceJobs } from './store.js';
import { imageError, friendlyImageError, localImagePath, processImage, uploadImage } from './image-processing.js';
import { recordProductMutation, syncProductModel } from './product-model.js';

const imageRevision = (product) => createHash('sha256').update(imageState(product)).digest('hex');

export function imageListPatch(product, lists) {
  const before = productImageLists(product);
  const mainChanged = JSON.stringify(before.mainImages) !== JSON.stringify(lists.mainImages);
  const detailChanged = JSON.stringify(before.detailImages) !== JSON.stringify(lists.detailImages);
  if (!mainChanged && !detailChanged) return {};
  const patch = { ...lists, images: [...lists.mainImages], mainImage: lists.mainImages[0] || '',
    imageEdits: { ...product.imageEdits, ...(mainChanged ? { main: true } : {}), ...(detailChanged ? { detail: true } : {}) } };
  if (detailChanged) {
    // Replace image elements while retaining source text, tables and video. The
    // publisher and editor must not resurrect stale HTML images after deletion.
    const replaceImages = (html) => {
      const $ = load(html || '', null, false);
      const present = new Set();
      $('img').each((_, node) => {
        const image = $(node);
        const old = image.attr('data-src') || image.attr('data-original') || image.attr('src') || '';
        const index = before.detailImages.indexOf(old);
        const url = lists.detailImages.includes(old) ? old
          : before.detailImages.length === lists.detailImages.length && index >= 0 ? lists.detailImages[index] : '';
        if (!url) { image.remove(); return; }
        image.attr('src', url).removeAttr('data-src data-original srcset'); present.add(url);
      });
      $('picture source').remove();
      $('picture').each((_, node) => { if (!$(node).find('img').length) $(node).remove(); });
      for (const url of lists.detailImages) if (!present.has(url)) { $.root().append($('<img>').attr('src', url)); present.add(url); }
      return $.root().html() || '';
    };
    patch.descriptionHtml = replaceImages(product.descriptionHtml || product.structuredDescription?.html || '');
    if (product.structuredDescription) patch.structuredDescription = { ...product.structuredDescription, images: [...lists.detailImages], html: replaceImages(product.structuredDescription.html || '') };
  }
  return patch;
}

export function registerProductImageApi(app, { store, mediaDir }) {
  let processing = 0;
  let sourceRevision, sourceUrls;
  app.post('/api/products/image-drafts', (request, response, next) => {
    try {
      const ids = request.body?.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw imageError('请选择 1～200 件商品');
      const products = store.read((state) => {
        const index = new Map(state.products.map((p) => [p.id, p]));
        return ids.map((id) => {
          const product = index.get(id);
          if (!product) throw imageError(`商品 ${id} 已不存在，请刷新`, 409);
          return { id, title: product.title, revision: imageRevision(product), ...productImageLists(product) };
        });
      });
      response.json(products);
    } catch (error) { next(error); }
  });
  app.post('/api/products/save-images', async (request, response, next) => {
    try {
      const items = request.body?.items;
      if (!Array.isArray(items) || !items.length || items.length > 200 || items.some((item) => !item || typeof item.id !== 'string') || new Set(items.map((item) => item.id)).size !== items.length) throw imageError('图片保存参数无效');
      const partial = request.body.partial === true, failures = [], valid = [], paths = new Map();
      for (const item of items) {
        try {
          for (const [key, limit] of [['mainImages', 6], ['detailImages', 30]]) {
            if (!Array.isArray(item[key]) || item[key].length > limit || item[key].some((url) => typeof url !== 'string' || url.length > 4096 || !/^(https?:\/\/|\/media\/)/i.test(url))) throw imageError('图片列表无效：主图最多 6 张，详情图最多 30 张');
            for (const url of item[key]) if (url.startsWith('/media/')) {
              if (!paths.has(url)) paths.set(url, localImagePath(mediaDir, url));
              await paths.get(url);
            }
          }
          valid.push(item);
        } catch (error) {
          if (!partial) throw error;
          failures.push({ id: item.id, error: error.message });
        }
      }
      const result = store.update((state) => {
        const index = new Map(state.products.map((p) => [p.id, p])), ready = [];
        // Legacy callers retain atomic saves; explicit partial mode reports
        // conflicts per product without overwriting concurrent edits.
        for (const item of valid) {
          try {
            const product = index.get(item.id);
            if (!product || imageRevision(product) !== item.revision) throw imageError('商品图片或详情已被其他操作修改，请关闭窗口后重新编辑', 409);
            if (findWorkspaceJobs(state, { productIds: [product.id] }, ['queued', 'running', 'pause_requested']).length) throw imageError('商品正在处理，请等待任务完成或暂停后再保存图片', 409);
            ready.push({ product, patch: imageListPatch(product, productImageLists(item)) });
          } catch (error) {
            if (!partial) throw error;
            failures.push({ id: item.id, error: error.message });
          }
        }
        let count = 0; const saved = [];
        for (const { product, patch } of ready) {
          if (Object.keys(patch).length) {
            syncProductModel(product); // Capture unmodified source before first edit.
            recordProductMutation(product, { ...patch, status: 'ready' }, { actor: 'user', action: 'image-edit' });
            count++;
          }
          saved.push({ id: product.id, revision: imageRevision(product) });
        }
        return partial ? { updated: count, saved, failures } : { updated: count };
      });
      response.json(result);
    } catch (error) { next(error); }
  });
  app.post('/api/media/process', async (request, response, next) => {
    if (processing >= 2) return next(imageError('图片处理繁忙，请稍后重试', 429));
    processing++;
    try {
      const body = request.body || {};
      // Remote sources must already belong to a product. Arbitrary URL fetching
      // is not exposed; network DNS/redirect checks still apply during download.
      const revision = store.revision();
      if (sourceRevision !== revision) {
        sourceUrls = new Set(store.read((state) => state.products.flatMap((p) => {
          const lists = productImageLists(p);
          return [...lists.mainImages, ...lists.detailImages];
        })));
        sourceRevision = revision;
      }
      const known = typeof body.url === 'string' && (body.url.startsWith('/media/') || sourceUrls.has(body.url));
      if (!known) throw imageError('图片不属于当前商品，请重新选择或本地上传');
      response.json(await processImage(mediaDir, body));
    } catch (error) { next(friendlyImageError(error)); }
    finally { processing--; }
  });
  app.post('/api/media/upload-image', async (request, response, next) => {
    try { response.status(201).json({ url: await uploadImage(mediaDir, request.body?.data) }); }
    catch (error) { next(error); }
  });
}
