import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { editImageLists, imageRevision as imageState, productImageLists } from './product-images.js';
import { findWorkspaceJobs } from './store.js';
import { imageError, friendlyImageError, localImagePath, processImage, uploadImage } from './image-processing.js';
import { recordProductMutation, syncProductModel, verifySourceIntegrity } from './product-model.js';
import { createRuntimeDiagnostics } from './runtime-diagnostics.js';
import { syncStructuredDescriptionImages } from './description-structure.js';

const imageRevision = (product) => createHash('sha256').update(JSON.stringify([
  imageState(product), product.source?.snapshotHash || '',
  product.source?.snapshot ? productImageLists(product.source.snapshot) : null,
])).digest('hex');

// Only the immutable capture can provide collected originals. Current images
// and watermark repair history are working copies, not a collection snapshot.
export function sourceImageDraft(product) {
  const integrity = verifySourceIntegrity(product);
  if (!integrity.present) return { sourceImages: null, sourceImageError: '没有采集原图快照，无法恢复；请重新采集后重试' };
  if (!integrity.valid) return { sourceImages: null, sourceImageError: '来源快照校验失败，无法恢复采集原图；请重新采集后重试' };
  const sourceImages = productImageLists(product.source.snapshot), sourceImageErrors = {};
  for (const key of ['mainImages', 'detailImages']) {
    const label = key === 'mainImages' ? '主图' : '详情图';
    if (!sourceImages[key].length) sourceImageErrors[key] = `采集快照中没有${label}，无法恢复`;
    else if (sourceImages[key].some(url => typeof url !== 'string' || url.length > 4096 || !/^(https?:\/\/|\/media\/)/i.test(url))) sourceImageErrors[key] = `采集${label}地址无效，无法恢复；请重新采集后重试`;
  }
  return { sourceImages, sourceImageErrors };
}

export function imageListPatch(product, lists, { forceMain = false, forceDetail = false } = {}) {
  const before = productImageLists(product);
  const mainChanged = forceMain || JSON.stringify(before.mainImages) !== JSON.stringify(lists.mainImages);
  const detailChanged = forceDetail || JSON.stringify(before.detailImages) !== JSON.stringify(lists.detailImages);
  if (!mainChanged && !detailChanged) return {};
  const patch = { ...lists, images: [...lists.mainImages], mainImage: lists.mainImages[0] || '',
    imageEdits: { ...product.imageEdits, ...(mainChanged ? { main: true } : {}), ...(detailChanged ? { detail: true } : {}) } };
  if (detailChanged) {
    // Replace image elements while retaining source text, tables and video. The
    // publisher and editor must not resurrect stale HTML images after deletion.
    const replaceImages = (html) => {
      const $ = load(html || '', null, false);
      const remaining = new Map();
      for (const url of lists.detailImages) remaining.set(url, (remaining.get(url) || 0) + 1);
      const present = [];
      $('img').each((_, node) => {
        const image = $(node);
        const old = image.attr('data-src') || image.attr('data-original') || image.attr('src') || '';
        const index = before.detailImages.indexOf(old);
        const url = lists.detailImages.includes(old) ? old
          : before.detailImages.length === lists.detailImages.length && index >= 0 ? lists.detailImages[index] : '';
        if (!url || !remaining.get(url)) { image.remove(); return; }
        image.attr('src', url).removeAttr('data-src data-original srcset');
        remaining.set(url, remaining.get(url) - 1);
        present.push({ url, node });
      });
      $('picture source').remove();
      $('picture').each((_, node) => { if (!$(node).find('img').length) $(node).remove(); });
      // Insert restored images before their next surviving image, preserving
      // the selected sequence without replacing edited text, tables or video.
      let previous = null;
      const anchors = [...present];
      for (const [index, url] of lists.detailImages.entries()) {
        const match = anchors.findIndex(item => item.url === url);
        if (match >= 0) { previous = anchors.splice(match, 1)[0].node; continue; }
        const image = $('<img>').attr('src', url);
        const following = lists.detailImages.slice(index + 1).map(next => anchors.find(item => item.url === next)).find(Boolean);
        if (following) $(following.node).before(image);
        else if (previous) $(previous).after(image);
        else $.root().append(image);
        previous = image[0];
      }
      return $.root().html() || '';
    };
    patch.descriptionHtml = replaceImages(product.descriptionHtml || product.structuredDescription?.html || '');
    const structure = syncStructuredDescriptionImages(product, {
      beforeImages: before.detailImages, detailImages: lists.detailImages, html: patch.descriptionHtml,
      restoreStructure: verifySourceIntegrity(product).valid ? product.source?.snapshot?.structuredDescription : null,
    });
    if (!structure && product.structuredDescription?.version === 1) patch.structuredDescription = null;
    else if (structure || product.structuredDescription) patch.structuredDescription = {
      ...(structure || product.structuredDescription), images: [...lists.detailImages],
      html: structure ? structure.html : replaceImages(product.structuredDescription?.html || ''),
    };
  }
  return patch;
}

// Editor and batch APIs may send images together with new description text.
// Reconcile against that text while comparing lists with the persisted product.
export function coherentProductImagePatch(product, patch, operation = '') {
  const imageFields = ['mainImages', 'images', 'mainImage', 'detailImages'];
  if (!operation && !imageFields.some(key => Object.hasOwn(patch, key))) return patch;
  const integrity = verifySourceIntegrity(product);
  if (integrity.present && !integrity.valid) throw imageError('来源快照校验失败，未保存图片；请重新采集后重试', 409);
  let lists = productImageLists(product);
  for (const key of ['mainImages', 'images', 'detailImages']) {
    if (Object.hasOwn(patch, key) && (!Array.isArray(patch[key]) || patch[key].some(url => typeof url !== 'string'))) throw imageError('图片列表无效');
  }
  if (Object.hasOwn(patch, 'mainImages')) lists.mainImages = [...patch.mainImages];
  else if (Object.hasOwn(patch, 'images')) lists.mainImages = [...patch.images];
  else if (Object.hasOwn(patch, 'mainImage')) {
    if (typeof patch.mainImage !== 'string') throw imageError('主图地址无效');
    lists.mainImages = patch.mainImage ? [patch.mainImage, ...lists.mainImages.slice(1)] : [];
  }
  if (Object.hasOwn(patch, 'detailImages')) lists.detailImages = [...patch.detailImages];
  if (operation) {
    try { lists = editImageLists({ ...product, ...lists, ...sourceImageDraft(product) }, operation); }
    catch (error) { throw imageError(error.message, error.status || 400); }
  }
  const descriptions = Object.fromEntries(['descriptionHtml', 'structuredDescription'].filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
  const mainSupplied = ['mainImages', 'images', 'mainImage'].some(key => Object.hasOwn(patch, key));
  // An explicit clear also confirms intent for older saved empty arrays that
  // predate imageEdits. Never infer that intent during publication itself.
  const forceMain = !product.imageEdits?.main && !lists.mainImages.length && (mainSupplied || operation === 'clear-main');
  const forceDetail = !product.imageEdits?.detail && !lists.detailImages.length && (Object.hasOwn(patch, 'detailImages') || operation === 'clear-detail');
  return {
    ...patch, ...imageListPatch({ ...product, ...descriptions }, lists, { forceMain, forceDetail }),
    ...(mainSupplied
      ? { mainImages: [...lists.mainImages], images: [...lists.mainImages], mainImage: lists.mainImages[0] || '' } : {}),
  };
}

export function registerProductImageApi(app, { store, mediaDir }) {
  const diagnostic = createRuntimeDiagnostics(path.join(mediaDir, '..', 'runtime-diagnostics.log'));
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
          return { id, title: product.title, revision: imageRevision(product), ...productImageLists(product), ...sourceImageDraft(product) };
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
      const busyProducts = new Set(store.read(state => valid.filter(item => findWorkspaceJobs(state, { productIds: [item.id] }, ['queued', 'running', 'pause_requested']).length).map(item => item.id)));
      diagnostic('image-save-start', { count: valid.length });
      const result = store.updateProducts(valid.map(item => item.id), (products) => {
        const index = new Map(products.map((p) => [p.id, p])), ready = [];
        // Legacy callers retain atomic saves; explicit partial mode reports
        // conflicts per product without overwriting concurrent edits.
        for (const item of valid) {
          try {
            const product = index.get(item.id);
            if (!product || imageRevision(product) !== item.revision) throw imageError('商品图片或详情已被其他操作修改，请关闭窗口后重新编辑', 409);
            if (busyProducts.has(product.id)) throw imageError('商品正在处理，请等待任务完成或暂停后再保存图片', 409);
            const integrity = verifySourceIntegrity(product);
            if (integrity.present && !integrity.valid) throw imageError('来源快照校验失败，未保存图片；请重新采集后重试', 409);
            ready.push({ product, patch: imageListPatch(product, productImageLists(item)) });
          } catch (error) {
            if (!partial) throw error;
            failures.push({ id: item.id, error: error.message });
          }
        }
        let count = 0; const saved = [];
        for (const { product, patch } of ready) {
          if (Object.keys(patch).length) {
            if (!product.source?.snapshot) syncProductModel(product); // Capture unmodified source before first edit.
            recordProductMutation(product, { ...patch, status: 'ready' }, { actor: 'user', action: 'image-edit', changedFieldsOnly: true });
            count++;
          }
          saved.push({ id: product.id, revision: imageRevision(product) });
        }
        return partial ? { updated: count, saved, failures } : { updated: count };
      });
      diagnostic('image-save-complete', { count: valid.length, updated: result.updated, failed: failures.length });
      response.json(result);
    } catch (error) { diagnostic('image-save-failed', { code: error.code }); next(error); }
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
          const originals = sourceImageDraft(p).sourceImages;
          return [...lists.mainImages, ...lists.detailImages, ...(originals?.mainImages || []), ...(originals?.detailImages || [])];
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
