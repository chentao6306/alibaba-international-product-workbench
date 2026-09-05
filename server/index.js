import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { deleteWorkspaceEntities, findWorkspaceJobs, JsonStore, newId } from './store.js';
import { ShopCollector } from './collector.js';
import {
  canonicalizePriceTiers,
  classifyAlibabaActionResult,
  hasCompleteSourceData,
  sanitizeCollectedProduct,
  SellerPublisher
} from './publisher.js';
import { applyPublishedProductReference, copyMissingProductData, createPublishSnapshot, findAndReplaceProduct, recordProductMutation, syncProductModel } from './product-model.js';
import { buildAlibabaPublishUrl, createPublishPlan, normalizeCategoryId, productCategory, publishBindings, rememberPublishBinding, resolvePublishRoute } from './category-routing.js';
import { userFacingError } from './browser-error.js';

// In the packaged desktop build the server module is unpacked while the
// frontend remains inside app.asar. APP_ROOT_DIR keeps both layouts working.
const rootDir = process.env.APP_ROOT_DIR
  ? path.resolve(process.env.APP_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticCandidates = [
  process.env.KUA_YIPU_DIST_DIR ? path.resolve(process.env.KUA_YIPU_DIST_DIR) : '',
  path.join(rootDir, 'dist'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
  process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'dist') : '',
  process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist') : ''
].filter(Boolean);
const staticDir = staticCandidates.find((candidate) => fs.existsSync(candidate));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, '.data');
fs.mkdirSync(dataDir, { recursive: true });
const mediaDir = path.join(dataDir, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  try { if (fs.statSync(directory).isFile()) return fs.statSync(directory).size; } catch { return 0; }
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else { try { total += fs.statSync(full).size; } catch {} }
  }
  return total;
}

const store = new JsonStore(path.join(dataDir, 'workspace.json'));
const publisher = new SellerPublisher(dataDir);
const collector = new ShopCollector(dataDir, (products, onProgress) => publisher.enrichSourceProducts(products, onProgress));
store.update((state) => {
  const previousVersion = Number(state.version || 0);
  state.version = 6;
  if (!state.settings || typeof state.settings !== 'object') state.settings = {};
  if (!state.settings.publishBindings || typeof state.settings.publishBindings !== 'object' || Array.isArray(state.settings.publishBindings)) state.settings.publishBindings = {};
  if (previousVersion < 6) state.settings.publishMode = 'submit';
  if (state.settings.publishPageUrl && /^https?:\/\/(?:[^/]+\.)?1688\.com(?:\/|$)/i.test(state.settings.publishPageUrl)) {
    state.settings.publishPageUrl = '';
  }
  const invalidCategoryBinding = /\/product\/(?:easyListing|category)\.htm/i.test(state.settings.publishPageUrl || '');
  if (invalidCategoryBinding) state.settings.publishPageUrl = '';
  if (invalidCategoryBinding) state.settings.publishCategory = '';
  for (const product of state.products) {
    if (!product.sourceCategoryId && product.categoryId) product.sourceCategoryId = product.categoryId;
    if (!product.categoryId && product.sourceCategoryId) product.categoryId = product.sourceCategoryId;
    const inferredCategory = productCategory(product);
    if (!product.categoryId && inferredCategory.id) product.categoryId = inferredCategory.id;
    if (!product.sourceCategoryId && inferredCategory.id) product.sourceCategoryId = inferredCategory.id;
    if (product.source?.snapshot) continue;
    if (!/Alibaba Manufacturer Directory|Suppliers, Manufacturers, Exporters/i.test(product.title || '')) continue;
    const slug = product.sourceUrl?.match(/\/product-detail\/([^/?#]+?)_\d{8,}\.html/i)?.[1];
    if (!slug) continue;
    product.title = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    product.sourceTitle = product.title;
    product.updatedAt = new Date().toISOString();
  }
  if (state.settings.publishPageUrl) {
    rememberPublishBinding(state.settings, {
      url: state.settings.publishPageUrl,
      category: state.settings.publishCategory,
      source: 'legacy'
    });
  }
  // Never sanitize or rewrite a product that already has a source snapshot.
  // Its snapshot is the immutable capture of the source page; edits belong to
  // the working copy and must not silently become new source data.
  for (const product of state.products) {
    if (product.source?.snapshot) continue;
    const sanitized = sanitizeCollectedProduct(product);
    Object.assign(product, sanitized);
  }
  for (const product of state.products) {
    const tiers = Array.isArray(product.priceTiers) ? product.priceTiers : [];
    const canonical = canonicalizePriceTiers(tiers);
    const changed = canonical.length !== tiers.length || canonical.some((tier, index) => JSON.stringify(tier) !== JSON.stringify(tiers[index]));
    if (changed) {
      product.priceTiers = canonical;
      product.updatedAt = new Date().toISOString();
    }
  }
  for (const product of state.products) syncProductModel(product);
  for (const job of state.jobs) {
    if (!['publish', 'collect'].includes(job.type) || !['queued', 'running', 'pause_requested'].includes(job.status)) continue;
    job.status = 'paused';
    job.message = `服务重启，任务已暂停，可从 ${job.progress || 0}/${job.total || job.metadata?.productIds?.length || 0} 继续`;
    job.updatedAt = new Date().toISOString();
  }
  for (const job of state.jobs) {
    if (job.type !== 'collect' || job.status !== 'paused') continue;
    const group = state.groups.find((item) => item.id === job.metadata?.groupId);
    if (group?.activeJobId === job.id || group?.status === 'collecting') {
      group.status = 'ready';
      group.activeJobId = '';
    }
  }
  for (const job of state.jobs) {
    if (job.type !== 'publish' || job.status !== 'failed' || !/net::ERR_ABORTED/.test(job.message || '')) continue;
    const interruptedIndex = Math.max(0, Number(job.progress || 1) - 1);
    job.status = 'paused';
    job.progress = interruptedIndex;
    job.message = `浏览器连接中断，任务已暂停，可从 ${interruptedIndex}/${job.total || job.metadata?.productIds?.length || 0} 继续`;
    job.updatedAt = new Date().toISOString();
    const productId = job.metadata?.productIds?.[interruptedIndex];
    const product = state.products.find((item) => item.id === productId);
    if (product?.status === 'publish_failed' && /net::ERR_ABORTED/.test(product.publishResult?.message || '')) {
      product.status = 'ready';
      delete product.publishResult;
      product.updatedAt = new Date().toISOString();
    }
  }
  for (const product of state.products) {
    if (product.status !== 'publish_failed' || !/未识别到标题输入框/.test(product.publishResult?.message || '')) continue;
    product.status = 'ready';
    delete product.publishResult;
    product.updatedAt = new Date().toISOString();
  }
  const recoveredPublishedIds = new Set();
  for (const product of state.products) {
    // A successful result is authoritative even if an earlier process crashed
    // before it copied the result status onto the product itself.
    if (product.publishResult?.status === 'published' && product.status !== 'published') {
      product.status = 'published';
      product.selected = false;
      product.updatedAt = new Date().toISOString();
      recoveredPublishedIds.add(product.id);
    }
    if (product.status !== 'publish_failed') continue;
    const failedResult = product.publishResult || {};
    const message = String(failedResult.message || '');
    const classified = classifyAlibabaActionResult({
      mode: 'submit',
      url: failedResult.currentUrl || '',
      feedback: [message],
      bodyText: message
    });
    if (!classified.succeeded) continue;
    const result = {
      ...failedResult,
      status: 'published',
      message: '已成功提交，正在阿里巴巴国际站审核',
      verifiedBy: `recovered-${classified.verifiedBy || 'success-feedback'}`
    };
    product.status = 'published';
    product.publishResult = result;
    product.selected = false;
    product.updatedAt = new Date().toISOString();
    const failedHistory = (product.publishHistory || []).find((entry) => entry?.result?.status === 'failed' && entry?.result?.message === message);
    if (failedHistory) failedHistory.result = result;
    recoveredPublishedIds.add(product.id);
  }
  if (recoveredPublishedIds.size) {
    for (const job of state.jobs) {
      if (job.type !== 'publish' || job.metadata?.mode !== 'submit') continue;
      const productIds = job.metadata?.productIds || [];
      if (!productIds.some((id) => recoveredPublishedIds.has(id))) continue;
      const existingProducts = productIds.map((id) => state.products.find((item) => item.id === id)).filter(Boolean);
      const failedCount = existingProducts.filter((item) => item.status === 'publish_failed').length;
      const publishedCount = existingProducts.filter((item) => item.status === 'published').length;
      if (!failedCount && publishedCount === existingProducts.length) {
        job.status = 'completed';
        job.progress = job.total || productIds.length;
        job.message = `上架任务完成，共成功提交 ${publishedCount} 件，商品正在国际站审核`;
      } else {
        job.message = `上架任务完成，成功 ${publishedCount} 件，失败 ${failedCount} 件（已校正国际站成功反馈）`;
      }
      job.updatedAt = new Date().toISOString();
    }
  }
  if (invalidCategoryBinding) {
    for (const product of state.products) {
      if (product.status !== 'publish_failed' || !/未识别到标题输入框/.test(product.publishResult?.message || '')) continue;
      product.status = 'ready';
      delete product.publishResult;
      product.updatedAt = new Date().toISOString();
    }
    for (const job of state.jobs) {
      if (job.type !== 'publish' || job.status !== 'completed') continue;
      job.status = 'failed';
      job.message = '任务失败：绑定的是商品类目选择页，不是商品填写表单';
      job.updatedAt = new Date().toISOString();
    }
  }
});
const app = express();
app.use(express.json({ limit: '12mb' }));
if (process.env.KUA_YIPU_DESKTOP === '1') {
  app.use('/api', (request, response, next) => {
    if (!process.env.KUA_YIPU_LOCAL_GATE || request.headers['x-kua-yipu-gate'] !== process.env.KUA_YIPU_LOCAL_GATE) {
      return response.status(401).json({ error: '请从抄得快登录后进入工作台' });
    }
    next();
  });
}
app.use('/media', express.static(mediaDir, { fallthrough: false, maxAge: '1d' }));
const activePublishJobs = new Set();

function publicState() {
  const state = store.read();
  return { ...state, browser: publisher.status(), collectorBrowser: collector.status() };
}

app.get('/api/state', (_request, response) => response.json(publicState()));

function deleteEntities(selection) {
  const snapshot = structuredClone(store.read());
  const targets = deleteWorkspaceEntities(snapshot, selection);
  const activeJob = findWorkspaceJobs(snapshot, targets, ['queued', 'running', 'pause_requested'])[0];
  if (activeJob) throw Object.assign(new Error('关联数据正在执行采集或上架任务，请先暂停任务，待当前商品处理完成后再删除'), { status: 409 });
  return store.update((state) => {
    const deleted = deleteWorkspaceEntities(state, selection);
    const now = new Date().toISOString();
    const cancelledJobs = findWorkspaceJobs(state, deleted, ['paused']);
    for (const job of cancelledJobs) {
      Object.assign(job, {
        status: 'cancelled',
        message: '关联店铺或分组已删除，暂停任务已取消',
        updatedAt: now
      });
    }
    return { ...deleted, cancelledJobs: cancelledJobs.length };
  });
}

app.delete('/api/shops/:id', (request, response, next) => {
  try {
    const exists = store.read().shops.some((item) => item.id === request.params.id);
    if (!exists) return next(Object.assign(new Error('没有找到该店铺'), { status: 404 }));
    response.json(deleteEntities({ shopIds: [request.params.id] }));
  } catch (error) { next(error); }
});

app.post('/api/shops/delete', (request, response, next) => {
  try { response.json(deleteEntities({ shopIds: request.body.ids || [] })); } catch (error) { next(error); }
});

app.delete('/api/groups/:id', (request, response, next) => {
  try {
    const exists = store.read().groups.some((item) => item.id === request.params.id);
    if (!exists) return next(Object.assign(new Error('没有找到该分组'), { status: 404 }));
    response.json(deleteEntities({ groupIds: [request.params.id] }));
  } catch (error) { next(error); }
});

app.post('/api/groups/delete', (request, response, next) => {
  try { response.json(deleteEntities({ groupIds: request.body.ids || [] })); } catch (error) { next(error); }
});

app.post('/api/shops/read-groups', async (request, response, next) => {
  try {
    const result = await collector.listGroups(request.body.url);
    const now = new Date().toISOString();
    const saved = store.update((state) => {
      let shop = state.shops.find((item) => item.url === result.shopUrl);
      if (!shop) {
        shop = { id: newId(), url: result.shopUrl, name: result.shopName, createdAt: now, updatedAt: now };
        state.shops.unshift(shop);
      } else {
        Object.assign(shop, { name: result.shopName, updatedAt: now });
      }
      const incomingIds = new Set();
      for (const groupData of result.groups) {
        let group = state.groups.find((item) => item.shopId === shop.id && item.externalId === groupData.externalId);
        if (!group) {
          group = { id: newId(), shopId: shop.id, status: 'ready', collectedCount: 0, ...groupData };
          state.groups.push(group);
        } else Object.assign(group, groupData, { status: 'ready' });
        incomingIds.add(group.id);
      }
      return { shop, groups: state.groups.filter((item) => incomingIds.has(item.id)) };
    });
    response.json(saved);
  } catch (error) { next(error); }
});

function saveCollectedProduct(groupId, raw, options = {}) {
  if (!raw) return null;
  const now = new Date().toISOString();
  return store.update((draft) => {
    const target = draft.groups.find((item) => item.id === groupId);
    if (!target) return null;
    let product = draft.products.find((item) => item.groupId === groupId && item.sourceId === raw.sourceId);
    const priceNumber = Number(raw.price || 0);
    const markup = Number(draft.settings.priceMarkup || 0);
    const normalized = {
      ...raw,
      price: priceNumber ? (priceNumber * (1 + markup / 100)).toFixed(2) : '',
      stock: Number(raw.stock || draft.settings.defaultStock || 100),
      deliveryCountry: options.destinationCountry || raw.deliveryCountry || '',
      updatedAt: now
    };
    if (!product) {
      product = syncProductModel({ id: newId(), shopId: target.shopId, groupId, selected: false, status: 'ready', createdAt: now, ...normalized }, { captureSource: true, sourceSnapshot: raw, capturedAt: now });
      draft.products.unshift(product);
    } else {
      Object.assign(product, normalized);
      // Re-reading a group updates the working copy, but does not overwrite
      // the immutable source snapshot. An explicit “refresh detail” is the
      // operation that intentionally replaces that snapshot.
      syncProductModel(product, { captureSource: false, capturedAt: now });
    }
    target.collectedCount = Math.max(Number(target.collectedCount || 0), draft.products.filter((item) => item.groupId === groupId).length);
    return product;
  });
}

async function startCollectJob(jobId) {
  const initial = store.read();
  const job = initial.jobs.find((item) => item.id === jobId && item.type === 'collect');
  const group = initial.groups.find((item) => item.id === job?.metadata?.groupId);
  if (!job || !group || job.status === 'cancelled') return;
  // A queued job can be paused before setImmediate() gets a chance to start
  // it. Do not turn that explicit pause back into a running job.
  if (job.status === 'paused') {
    const count = initial.products.filter((item) => item.groupId === group.id).length;
    store.update((draft) => {
      const target = draft.groups.find((item) => item.id === group.id);
      if (target) Object.assign(target, { status: 'ready', collectedCount: count, activeJobId: '' });
      const pausedJob = draft.jobs.find((item) => item.id === jobId);
      if (pausedJob) Object.assign(pausedJob, { progress: count, message: `已暂停，已保存 ${count} 件商品，可继续采集`, updatedAt: new Date().toISOString() });
    });
    return;
  }
  const options = { ...(job.metadata?.options || {}), shouldStop: () => ['pause_requested', 'paused', 'cancelled'].includes(store.read().jobs.find((item) => item.id === jobId)?.status) };
  store.patchJob(jobId, { status: 'running', message: `开始采集“${group.name}”，已保存的商品会保留` });
  try {
    const products = await collector.collectGroup(group.url, (progress) => {
      if (progress.product) saveCollectedProduct(group.id, progress.product, options);
      const currentStatus = store.read().jobs.find((item) => item.id === jobId)?.status;
      const preservedStatus = ['pause_requested', 'paused', 'cancelled'].includes(currentStatus) ? currentStatus : 'running';
      store.patchJob(jobId, {
        // Do not overwrite a pause request while the current detail finishes.
        // The old unconditional `running` update made the stop request vanish
        // before the callback checked shouldStop(), so collection continued.
        status: preservedStatus,
        progress: progress.current || progress.found || 0,
        total: progress.total || 0,
        message: progress.stage === 'listing' ? `正在读取第 ${progress.page} 页（${options.startPage}-${options.endPage}），已发现 ${progress.found} 件` : `正在读取详情 ${progress.current}/${progress.total}，已保存 ${progress.current} 件`
      });
      return !options.shouldStop();
    }, options);
    for (const raw of products) saveCollectedProduct(group.id, raw, options);
    if (store.read().jobs.find((item) => item.id === jobId)?.status === 'cancelled') return;
    const count = store.read().products.filter((item) => item.groupId === group.id).length;
    const warningCount = products.filter((item) => item?.collectWarning).length;
    store.update((draft) => {
      const target = draft.groups.find((item) => item.id === group.id);
      if (target) Object.assign(target, { status: 'done', collectedCount: count, lastCollectedAt: new Date().toISOString(), activeJobId: '' });
      const completeJob = draft.jobs.find((item) => item.id === jobId);
      if (completeJob) Object.assign(completeJob, {
        status: 'completed',
        progress: products.length,
        total: products.length,
        message: warningCount ? `读取完成，共保存 ${count} 件，其中 ${warningCount} 件详情待补全` : `读取完成，共保存 ${count} 件`,
        updatedAt: new Date().toISOString()
      });
    });
  } catch (error) {
    const currentStatus = store.read().jobs.find((item) => item.id === jobId)?.status;
    if (currentStatus === 'cancelled') {
      const count = store.read().products.filter((item) => item.groupId === group.id).length;
      store.update((draft) => {
        const target = draft.groups.find((item) => item.id === group.id);
        if (target?.activeJobId === jobId) Object.assign(target, { status: 'ready', collectedCount: count, activeJobId: '' });
      });
      return;
    }
    const paused = error.code === 'COLLECT_PAUSED' || ['pause_requested', 'paused'].includes(currentStatus);
    if (paused) {
      const count = store.read().products.filter((item) => item.groupId === group.id).length;
      store.update((draft) => {
        const target = draft.groups.find((item) => item.id === group.id);
        if (target) Object.assign(target, { status: 'ready', collectedCount: count, activeJobId: '' });
        const pausedJob = draft.jobs.find((item) => item.id === jobId);
        if (pausedJob) Object.assign(pausedJob, {
          status: 'paused', progress: count,
          message: error.message && error.message !== 'COLLECT_PAUSED' ? error.message : `已暂停，已保存 ${count} 件商品，可继续采集`,
          updatedAt: new Date().toISOString()
        });
      });
      return;
    }
    store.patchJob(jobId, { status: 'failed', message: userFacingError(error) });
    store.update((draft) => { const target = draft.groups.find((item) => item.id === group.id); if (target) target.status = 'failed'; });
  }
}

app.post('/api/groups/:id/collect', (request, response, next) => {
  const state = store.read();
  const group = state.groups.find((item) => item.id === request.params.id);
  if (!group) return next(Object.assign(new Error('没有找到该分组'), { status: 404 }));
  const unfinished = state.jobs.find((item) => item.type === 'collect' && item.metadata?.groupId === group.id && ['queued', 'running', 'pause_requested', 'paused'].includes(item.status));
  if (unfinished) return next(Object.assign(new Error('该分组已有未完成的采集任务，请先继续或取消该任务'), { status: 409 }));
  const options = { startPage: Math.max(1, Number(request.body.startPage || 1)), endPage: Math.max(1, Number(request.body.endPage || 100)), delaySeconds: Math.max(0, Number(request.body.delaySeconds || 0)), destinationCountry: String(request.body.destinationCountry || ''), sort: String(request.body.sort || 'default') };
  if (options.endPage < options.startPage) options.endPage = options.startPage;
  const job = store.createJob('collect', { groupId: group.id, groupName: group.name, options });
  store.update((draft) => { const target = draft.groups.find((item) => item.id === group.id); target.status = 'collecting'; target.activeJobId = job.id; });
  response.status(202).json(job);
  setImmediate(() => startCollectJob(job.id));
});

app.post('/api/collector/open', async (request, response, next) => {
  try { response.json(await collector.open(request.body.url)); } catch (error) { next(error); }
});

app.patch('/api/products/:id', (request, response, next) => {
  const allowed = [
    'title', 'price', 'stock', 'moq', 'description', 'mainImage', 'images', 'mainImages', 'detailImages',
    'attributes', 'variantGroups', 'skus', 'priceTiers', 'deliveryTime', 'packaging',
      'origin', 'model', 'brand', 'productType', 'videoUrl', 'selected', 'subtitle', 'keywords',
    'categoryPath', 'categoryId', 'customAttributes', 'descriptionHtml', 'structuredDescription',
    'services', 'certificates', 'regionalPricing', 'shipping', 'freightTemplate', 'deliveryCountry',
    'deliveryOptions', 'salesUnit', 'paymentMethod', 'fobPrice', 'priceMode', 'skuPriceMode'
  ];
  const updated = store.update((state) => {
    const product = state.products.find((item) => item.id === request.params.id);
    if (!product) return null;
    const patch = Object.fromEntries(Object.entries(request.body).filter(([key]) => allowed.includes(key)));
    recordProductMutation(product, patch, { actor: 'user', action: 'single-edit' });
    return product;
  });
  if (!updated) return next(Object.assign(new Error('没有找到该商品'), { status: 404 }));
  response.json(updated);
});

app.post('/api/products/batch-update', (request, response, next) => {
  try {
    const ids = new Set(Array.isArray(request.body.ids) ? request.body.ids : []);
    if (!ids.size) return next(Object.assign(new Error('请至少选择一件商品'), { status: 400 }));
    const patch = request.body.patch && typeof request.body.patch === 'object' ? request.body.patch : {};
    const allowed = new Set([
      'title', 'subtitle', 'price', 'stock', 'moq', 'description', 'descriptionHtml', 'structuredDescription',
      'mainImage', 'images', 'mainImages', 'detailImages', 'attributes', 'variantGroups', 'skus', 'priceTiers',
      'origin', 'model', 'brand', 'productType', 'videoUrl', 'keywords', 'customAttributes', 'services',
      'categoryPath', 'categoryId',
      'attributeOperation', 'variantOperation', 'skuRows',
      'certificates', 'regionalPricing', 'shipping', 'freightTemplate', 'deliveryCountry', 'deliveryOptions',
      'salesUnit', 'paymentMethod', 'fobPrice', 'priceMode', 'skuPriceMode', 'packaging', 'deliveryTime'
    ]);
    const safePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
    const updated = store.update((state) => {
      const now = new Date().toISOString();
      state.products.filter((product) => ids.has(product.id)).forEach((product, index) => {
        const next = { ...safePatch };
        if (Array.isArray(patch.title)) next.title = patch.title[index] || product.title;
        if (patch.priceTransform) {
          const base = Number(product.price || 0);
          const nextPrice = base * (1 + Number(patch.priceTransform.percent || 0) / 100) + Number(patch.priceTransform.fixed || 0);
          next.price = Math.max(0, nextPrice).toFixed(2);
          next.priceTiers = (product.priceTiers || []).map((tier) => ({ ...tier, price: Math.max(0, Number(tier.price || 0) * (1 + Number(patch.priceTransform.percent || 0) / 100) + Number(patch.priceTransform.fixed || 0)).toFixed(2) }));
        }
        if (patch.skuTransform) next.skus = (product.skus || []).map((sku) => ({ ...sku, ...(patch.skuTransform.price == null ? {} : { price: patch.skuTransform.price }), ...(patch.skuTransform.stock == null ? {} : { stock: patch.skuTransform.stock }) }));
        if (Array.isArray(patch.skuRows)) {
          const rows = patch.skuRows.filter((row) => !row.productId || String(row.productId) === String(product.sourceId || product.id));
          if (rows.length) next.skus = rows.map((row, rowIndex) => ({
            id: row.id || `${product.sourceId || product.id}-sku-${rowIndex + 1}`,
            code: row.code || row.skuCode || '', price: Number(row.price || product.price || 0),
            stock: Number(row.stock ?? product.stock ?? 0), image: row.image || '', source: 'csv', derived: false,
            attributes: Object.fromEntries(Object.entries(row).filter(([key, value]) => !['id', 'product', 'productId', 'code', 'skuCode', 'price', 'stock', 'image'].includes(key) && value !== ''))
          }));
        }
        if (patch.attributeOperation?.item?.name) {
          const target = patch.attributeOperation.target === 'customAttributes' ? 'customAttributes' : 'attributes';
          const current = Array.isArray(product[target]) ? product[target].map((item) => ({ ...item })) : [];
          const item = patch.attributeOperation.item;
          if (patch.attributeOperation.mode === 'replace') next[target] = [item];
          else if (patch.attributeOperation.mode === 'append') next[target] = [...current, item];
          else {
            const match = current.findIndex((value) => String(value.name || '').trim().toLowerCase() === String(item.name).trim().toLowerCase());
            if (match >= 0) current[match] = { ...current[match], ...item };
            else current.push(item);
            next[target] = current;
          }
        }
        if (patch.variantOperation?.group?.name) {
          const current = Array.isArray(product.variantGroups) ? product.variantGroups.map((group) => ({ ...group, options: [...(group.options || [])] })) : [];
          const group = patch.variantOperation.group;
          if (patch.variantOperation.mode === 'replace') next.variantGroups = [group];
          else if (patch.variantOperation.mode === 'append') next.variantGroups = [...current, group];
          else {
            const match = current.findIndex((value) => String(value.name || '').trim().toLowerCase() === String(group.name).trim().toLowerCase());
            if (match >= 0) current[match] = { ...current[match], ...group };
            else current.push(group);
            next.variantGroups = current;
          }
        }
        if (patch.descriptionPrefix) next.description = `${product.description || ''}\n${patch.descriptionPrefix}`.trim();
        if (patch.services) next.services = { ...(product.services || {}), ...patch.services };
        if (patch.regionalPricing) next.regionalPricing = { ...(product.regionalPricing || {}), ...patch.regionalPricing };
        if (patch.packaging) next.packaging = { ...(product.packaging || {}), ...patch.packaging };
        if (patch.imageOperation === 'dedupe' || patch.imageOperation === 'copy-detail' || patch.imageOperation === 'clean' || patch.imageOperation === 'clear-main' || /^delete-main-\d+$/.test(String(patch.imageOperation || ''))) {
          next.mainImages = [...new Set(product.mainImages || product.images || [])].filter(Boolean);
          if (patch.imageOperation === 'clear-main') next.mainImages = [];
          const deleteSlot = String(patch.imageOperation || '').match(/^delete-main-(\d+)$/);
          if (deleteSlot) next.mainImages.splice(Number(deleteSlot[1]) - 1, 1);
          next.images = next.mainImages;
          next.mainImage = next.mainImages[0] || '';
          next.detailImages = patch.imageOperation === 'copy-detail'
            ? [...next.mainImages]
            : [...new Set(product.detailImages || next.mainImages)].filter(Boolean);
        }
        if (patch.descriptionPrefix || patch.imageOperation) { delete next.descriptionPrefix; delete next.imageOperation; }
        delete next.priceTransform; delete next.skuTransform; delete next.skuRows;
        delete next.attributeOperation; delete next.variantOperation;
        // Never accept source snapshot fields from a batch patch. The source
        // capture is immutable; this operation only changes the working copy.
        delete next.source;
        delete next.sourceSnapshot;
        delete next.sourceSnapshotHash;
        recordProductMutation(product, { ...next, status: 'ready' }, { actor: 'user', action: 'batch-edit' });
      });
      return state.products.filter((product) => ids.has(product.id));
    });
    response.json({ updated: updated.length, categoryBindingReset: false });
  } catch (error) { next(error); }
});

app.post('/api/products/:id/refresh-detail', async (request, response, next) => {
  try {
    const state = store.read();
    const product = state.products.find((item) => item.id === request.params.id);
    if (!product) return next(Object.assign(new Error('没有找到该商品'), { status: 404 }));
    const [enriched] = await Promise.race([
      publisher.enrichSourceProducts([product]),
      // A real Alibaba CAPTCHA is shown to the user and may reasonably take
      // several minutes. Keep the API request alive through that interaction.
      new Promise((_, reject) => setTimeout(() => reject(new Error('重新采集详情超时，请完成验证码后重试')), 330000))
    ]);
    const updated = store.update((draft) => {
      const target = draft.products.find((item) => item.id === product.id);
      // A public listing can be readable while Alibaba blocks an individual
      // detail page. Keep the existing complete fields in that case instead of
      // replacing them with an incomplete warning record.
      const hasWarning = Boolean(enriched?.collectWarning);
      if (hasWarning) Object.assign(target, { collectWarning: enriched.collectWarning });
      else {
        Object.assign(target, enriched);
        delete target.collectWarning;
      }
      Object.assign(target, { status: 'ready', updatedAt: new Date().toISOString() });
      delete target.publishResult;
      if (!hasWarning) syncProductModel(target, { captureSource: true, sourceSnapshot: enriched });
      return target;
    });
    response.json(updated);
  } catch (error) { next(error); }
});

app.post('/api/products/select', (request, response) => {
  const selected = Boolean(request.body?.selected);
  const selectAll = request.body?.all === true;
  const ids = selectAll ? null : new Set(Array.isArray(request.body?.ids) ? request.body.ids : []);
  const count = store.update((state) => {
    let changed = 0;
    for (const item of state.products) {
      if (!selectAll && !ids.has(item.id)) continue;
      if (item.selected !== selected) changed += 1;
      item.selected = selected;
    }
    return changed;
  });
  response.json({ ok: true, selected, all: selectAll, changed: count });
});

app.delete('/api/products/:id', (request, response, next) => {
  try {
    const exists = store.read().products.some((item) => item.id === request.params.id);
    if (!exists) return response.status(404).json({ error: '没有找到该商品' });
    response.json(deleteEntities({ productIds: [request.params.id] }));
  } catch (error) { next(error); }
});

app.post('/api/products/delete', (request, response, next) => {
  try { response.json(deleteEntities({ productIds: request.body.ids || [] })); } catch (error) { next(error); }
});

app.patch('/api/settings', (request, response) => {
  const allowed = ['publishPageUrl', 'publishCategory', 'publishBindings', 'defaultStock', 'priceMarkup', 'publishMode'];
  const settings = store.update((state) => {
    for (const key of allowed) if (Object.hasOwn(request.body, key)) state.settings[key] = request.body[key];
    return state.settings;
  });
  response.json(settings);
});

app.post('/api/seller/open', async (_request, response, next) => {
  try { response.json(await publisher.open({ reveal: true })); } catch (error) { next(error); }
});

app.post('/api/seller/bind-page', async (_request, response, next) => {
  try {
    const bound = await publisher.bindCurrentPage();
    store.update((state) => {
      rememberPublishBinding(state.settings, { ...bound, source: 'verified' });
    });
    response.json(bound);
  } catch (error) { next(error); }
});

app.get('/api/seller/diagnostics', async (request, response, next) => {
  try { response.json(await publisher.inspectPublishPage(store.read().settings.publishPageUrl, String(request.query.q || ''), String(request.query.detailMode || ''))); }
  catch (error) { next(error); }
});

app.get('/api/seller/source-diagnostics', async (request, response, next) => {
  try { response.json(await publisher.inspectSourcePage(String(request.query.url || ''))); }
  catch (error) { next(error); }
});

app.get('/api/seller/uploader-diagnostics', async (_request, response, next) => {
  try { response.json(await publisher.diagnoseMainImageUploader(store.read().settings.publishPageUrl)); }
  catch (error) { next(error); }
});

app.get('/api/seller/current-form-diagnostics', async (_request, response, next) => {
  try { response.json(await publisher.inspectCurrentForm()); }
  catch (error) { next(error); }
});

app.get('/api/seller/diagnose-video-uploader', async (_request, response, next) => {
  try { response.json(await publisher.diagnoseVideoUploader(store.read().settings.publishPageUrl)); } catch (error) { next(error); }
});

async function runPublishJob(jobId) {
  if (activePublishJobs.has(jobId)) return;
  activePublishJobs.add(jobId);
  try {
    let state = store.read();
    let job = state.jobs.find((item) => item.id === jobId && item.type === 'publish');
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const productIds = job.metadata?.productIds || [];
    const mode = job.metadata?.mode === 'submit' ? 'submit' : 'draft';
    const total = productIds.length;
    store.patchJob(jobId, { status: 'running', total, message: '正在连接阿里巴巴国际站卖家后台' });

    for (let index = Number(job.progress || 0); index < total; index += 1) {
      state = store.read();
      job = state.jobs.find((item) => item.id === jobId);
      if (!job) return;
      if (['pause_requested', 'paused'].includes(job.status)) {
        store.patchJob(jobId, { status: 'paused', progress: index, total, message: `已暂停，已处理 ${index}/${total} 件` });
        return;
      }

      let product = state.products.find((item) => item.id === productIds[index]);
      if (!product) {
        store.patchJob(jobId, { progress: index + 1, total, message: `已跳过不存在的商品 ${index + 1}/${total}` });
        continue;
      }
      store.patchJob(jobId, { status: 'running', progress: index, total, message: `正在处理 ${index + 1}/${total}：${product.title}` });
      try {
        if (!hasCompleteSourceData(product)) {
          store.patchJob(jobId, { message: `正在补全商品资料 ${index + 1}/${total}：${product.title}` });
          const [enriched] = await publisher.enrichSourceProducts([product]);
          store.update((draft) => {
            const target = draft.products.find((item) => item.id === product.id);
            if (target) Object.assign(target, enriched, { status: 'ready', updatedAt: new Date().toISOString() });
          });
          product = { ...product, ...enriched };
        }
        const settings = store.read().settings;
        const route = resolvePublishRoute(product, settings);
        if (route.error || !route.url) throw new Error(route.error || '该商品没有可用的国际站发布页');
        const publishSnapshot = createPublishSnapshot(product, { mode, category: route.category, categoryId: route.categoryId, publishPageUrl: route.url });
        store.patchJob(jobId, { message: `正在处理 ${index + 1}/${total}：${product.title}（${route.category || '未识别类目'}）` });
        const itemTimeoutMs = Math.max(60000, Number(process.env.KUA_YIPU_PUBLISH_ITEM_TIMEOUT_MS || 120000));
        const timeoutToken = Symbol('publish-item-timeout');
        let timeoutHandle;
        const timeout = new Promise((_, reject) => { timeoutHandle = setTimeout(() => {
          publisher.requestPublishStop(jobId);
          const error = new Error(`单件商品处理超过 ${Math.round(itemTimeoutMs / 60000)} 分钟，已自动跳过；可稍后单独重试`);
          error.code = 'PUBLISH_ITEM_TIMEOUT';
          error.timeoutToken = timeoutToken;
          reject(error);
        }, itemTimeoutMs); });
        const publishPromise = publisher.publishProduct(product, route.url, mode, route.category, jobId);
        // The timeout closes the active page. Consume the eventual rejection
        // from the cancelled automation so it cannot become an unhandled
        // rejection while the queue moves to the next product.
        publishPromise.catch(() => {});
        const result = await Promise.race([publishPromise, timeout]).finally(() => clearTimeout(timeoutHandle));
        // Keep the real publishing page visible for inspection. The user
        // explicitly requested to see the browser while an item is being
        // uploaded and submitted; collection still uses the hidden context.
        store.update((draft) => {
          const target = draft.products.find((item) => item.id === product.id);
          if (target) Object.assign(target, {
            status: result.status,
            selected: false,
            publishResult: result,
            updatedAt: new Date().toISOString()
          });
          if (target) {
            target.publishHistory = Array.isArray(target.publishHistory) ? target.publishHistory : [];
            target.publishHistory.unshift({ ...publishSnapshot, result });
            syncProductModel(target);
          }
          rememberPublishBinding(draft.settings, { ...route, verifiedAt: new Date().toISOString(), source: 'verified' });
        });
        publisher.clearPublishStop(jobId);
        store.patchJob(jobId, { progress: index + 1, total, message: `已处理 ${index + 1}/${total}：${product.title}` });
      } catch (error) {
        const message = userFacingError(error);
        const requiresHuman = /captcha|verify|人机验证|安全验证|滑块|登录失效|人工验证/i.test(message);
        const currentJobStatus = store.read().jobs.find((item) => item.id === jobId)?.status;
        const pauseRequested = ['pause_requested', 'paused'].includes(currentJobStatus) || error.code === 'PUBLISH_PAUSED';
        // Preserve the visible publishing page on both success and failure so
        // the user can inspect Alibaba's exact validation state. It can be
        // hidden later through the normal seller-browser lifecycle.
        if (!pauseRequested) store.update((draft) => {
          const target = draft.products.find((item) => item.id === product.id);
          if (target) {
            const result = { status: 'failed', message };
            Object.assign(target, { status: 'publish_failed', publishResult: result, updatedAt: new Date().toISOString() });
            target.publishHistory = Array.isArray(target.publishHistory) ? target.publishHistory : [];
            const failureRoute = resolvePublishRoute(target, store.read().settings);
            target.publishHistory.unshift({ ...createPublishSnapshot(target, { mode, category: failureRoute.category, categoryId: failureRoute.categoryId, publishPageUrl: failureRoute.url }), result });
            syncProductModel(target);
          }
        });
        publisher.clearPublishStop(jobId);
        if (pauseRequested) {
          store.patchJob(jobId, { status: 'paused', progress: index, total, message: `已立即暂停，当前商品未继续操作，已完成 ${index}/${total} 件` });
          return;
        }
        if (requiresHuman) {
          store.patchJob(jobId, {
            status: 'paused', progress: index, total,
            message: `已暂停：${product.title} - ${message}。完成验证后可继续`
          });
          return;
        }
        // A product-level validation or upload error must not discard the
        // remaining batch. Keep the failed item visible and continue with the
        // next product; the final job status summarizes the failures.
        store.patchJob(jobId, {
          status: 'running', progress: index + 1, total,
          message: `第 ${index + 1}/${total} 件失败，继续处理下一件：${product.title}`
        });
        continue;
      }
    }
    const finalState = store.read();
    const failedCount = productIds.filter((id) => finalState.products.find((item) => item.id === id)?.status === 'publish_failed').length;
    store.patchJob(jobId, {
      status: 'completed', progress: total, total,
      message: failedCount ? `上架任务完成，成功 ${total - failedCount} 件，失败 ${failedCount} 件（可查看每件商品的具体原因）` : `上架任务完成，共处理 ${total} 件`
    });
  } catch (error) {
    store.patchJob(jobId, { status: 'failed', message: userFacingError(error) });
  } finally {
    activePublishJobs.delete(jobId);
  }
}

app.post('/api/publish', (request, response, next) => {
  const state = store.read();
  const existing = state.jobs.find((job) => job.type === 'publish' && ['queued', 'running', 'pause_requested', 'paused'].includes(job.status));
  if (existing) return next(Object.assign(new Error('已有未完成的上架任务，请先继续或完成该任务'), { status: 409 }));
  const ids = new Set(request.body.ids || state.products.filter((item) => item.selected).map((item) => item.id));
  const products = state.products.filter((item) => ids.has(item.id));
  if (!products.length) return next(Object.assign(new Error('请至少选择一件商品'), { status: 400 }));
  const mode = request.body.mode === 'submit' ? 'submit' : 'draft';
  const plan = createPublishPlan(products, state.settings);
  const unresolved = plan.filter((group) => group.error || !group.url);
  if (unresolved.length) {
    return next(Object.assign(new Error(`有 ${unresolved.length} 个商品类目无法自动路由：${unresolved.map((group) => group.error || group.category || group.categoryId).join('；')}`), { status: 400 }));
  }
  const job = store.createJob('publish', {
    productIds: products.map((item) => item.id), mode,
    categoryGroups: plan.map((group) => ({ categoryId: group.categoryId, category: group.category, productIds: group.products.map((item) => item.id) }))
  });
  store.patchJob(job.id, { total: products.length });
  response.status(202).json({ ...job, total: products.length });
  setImmediate(() => runPublishJob(job.id));
});

app.post('/api/jobs/:id/pause', (request, response, next) => {
  const state = store.read();
  const job = state.jobs.find((item) => item.id === request.params.id && ['publish', 'collect'].includes(item.type));
  if (!job) return next(Object.assign(new Error('没有找到该上架任务'), { status: 404 }));
  if (!['queued', 'running', 'pause_requested'].includes(job.status)) {
    return next(Object.assign(new Error('当前任务不能暂停'), { status: 409 }));
  }
  const status = job.status === 'queued' ? 'paused' : 'pause_requested';
  const message = status === 'paused' ? `已暂停，已处理 ${job.progress}/${job.total || 0} 件，已完成数据已保存` : '正在立即暂停，正在关闭当前商品操作，已完成数据会保存';
  const updated = store.patchJob(job.id, { status, message });
  if (status === 'pause_requested' && job.type === 'publish') publisher.requestPublishStop(job.id);
  response.json(updated);
});

app.post('/api/jobs/:id/resume', (request, response, next) => {
  const state = store.read();
  const job = state.jobs.find((item) => item.id === request.params.id && ['publish', 'collect'].includes(item.type));
  if (!job) return next(Object.assign(new Error('没有找到该上架任务'), { status: 404 }));
  if (job.status !== 'paused') {
    return next(Object.assign(new Error('当前任务不能继续'), { status: 409 }));
  }
  const updated = store.patchJob(job.id, { status: 'queued', message: `等待继续，已处理 ${job.progress}/${job.total} 件` });
  response.json(updated);
  setImmediate(() => job.type === 'collect' ? startCollectJob(job.id) : runPublishJob(job.id));
});

app.post('/api/jobs/:id/cancel', (request, response, next) => {
  const state = store.read();
  const job = state.jobs.find((item) => item.id === request.params.id && ['publish', 'collect'].includes(item.type));
  if (!job) return next(Object.assign(new Error('没有找到该任务'), { status: 404 }));
  if (job.status !== 'paused') {
    return next(Object.assign(new Error('请先暂停任务并等待当前商品处理完成，再取消任务'), { status: 409 }));
  }
  const updated = store.patchJob(job.id, {
    status: 'cancelled',
    message: `任务已取消，已完成 ${job.progress}/${job.total || 0} 件，已保存数据不受影响`
  });
  if (job.type === 'collect') {
    store.update((draft) => {
      const group = draft.groups.find((item) => item.id === job.metadata?.groupId);
      if (group?.activeJobId === job.id || group?.status === 'collecting') {
        group.status = 'ready';
        group.activeJobId = '';
      }
    });
  }
  response.json(updated);
});

app.post('/api/products/find-replace', (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) && request.body.ids.length
      ? new Set(request.body.ids) : null;
    const search = String(request.body?.search ?? '');
    if (!search) return next(Object.assign(new Error('请输入要查找的内容'), { status: 400 }));
    const replacement = String(request.body?.replacement ?? '');
    const caseSensitive = Boolean(request.body?.caseSensitive);
    const dryRun = Boolean(request.body?.dryRun);
    const result = store.update((state) => {
      const matches = [];
      let changedProducts = 0;
      for (const product of state.products) {
        if (ids && !ids.has(product.id)) continue;
        const found = findAndReplaceProduct(product, search, replacement, { caseSensitive });
        if (!found.count) continue;
        if (!dryRun) recordProductMutation(product, found.patch, { actor: 'user', action: 'find-replace' });
        matches.push({ id: product.id, title: product.title, count: found.count, fields: found.matches });
        changedProducts += 1;
      }
      return { changedProducts, matches, total: matches.reduce((sum, item) => sum + item.count, 0) };
    });
    response.json(result);
  } catch (error) { next(error); }
});

app.get('/api/publish/plan', (request, response, next) => {
  try {
    const state = store.read();
    const ids = new Set(Array.isArray(request.query.ids) ? request.query.ids : String(request.query.ids || '').split(',').filter(Boolean));
    const products = ids.size ? state.products.filter((item) => ids.has(item.id)) : state.products.filter((item) => item.selected);
    response.json({ groups: createPublishPlan(products, state.settings), bindings: publishBindings(state.settings) });
  } catch (error) { next(error); }
});

app.post('/api/products/reference', (request, response, next) => {
  try {
    const ids = new Set(Array.isArray(request.body?.ids) ? request.body.ids : []);
    const referenceId = String(request.body?.referenceId || '');
    if (!ids.size || !referenceId) return next(Object.assign(new Error('请选择待补全商品和引用商品'), { status: 400 }));
    const result = store.update((state) => {
      const reference = state.products.find((item) => item.id === referenceId && (
        item.status === 'published'
        || (Array.isArray(item.publishHistory) && item.publishHistory.some((entry) => ['published', 'submitted', 'success'].includes(String(entry.result?.status || entry.status || '').toLowerCase())))
      ));
      if (!reference) throw Object.assign(new Error('只能引用已成功上架的商品'), { status: 400 });
      const changed = [];
      for (const product of state.products) {
        if (!ids.has(product.id) || product.id === reference.id) continue;
        // A failed product can have plenty of source data while still missing
        // Alibaba-controlled values. Use the successful product as a complete
        // publish template instead of only filling blank fields.
        const patch = applyPublishedProductReference(product, reference);
        if (!Object.keys(patch).length) continue;
        recordProductMutation(product, patch, { actor: 'user', action: 'reference-published-product' });
        changed.push({ id: product.id, title: product.title, fields: Object.keys(patch), categoryId: product.categoryId || '' });
      }
      return { referenceId, referenceTitle: reference.title || reference.id, changed };
    });
    response.json(result);
  } catch (error) { next(error); }
});

app.get('/api/storage', (_request, response) => {
  const workspace = path.join(dataDir, 'workspace.json');
  const images = path.join(dataDir, 'publish-images');
  const videos = path.join(dataDir, 'publish-videos');
  response.json({
    root: dataDir,
    workspace,
    media: mediaDir,
    images,
    videos,
    bytes: { root: directoryBytes(dataDir), workspace: directoryBytes(workspace), media: directoryBytes(mediaDir), images: directoryBytes(images), videos: directoryBytes(videos) }
  });
});

app.post('/api/media/upload', (request, response, next) => {
  try {
    const data = String(request.body?.data || '');
    const match = data.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) return response.status(400).json({ error: '仅支持 JPG、PNG 或 WebP 图片' });
    const extension = match[1].toLowerCase().includes('png') ? 'png' : match[1].toLowerCase().includes('webp') ? 'webp' : 'jpg';
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${extension}`;
    fs.writeFileSync(path.join(mediaDir, fileName), Buffer.from(match[2], 'base64'), { mode: 0o600 });
    response.status(201).json({ url: `/media/${fileName}`, name: String(request.body?.name || fileName) });
  } catch (error) { next(error); }
});

app.delete('/api/media', (request, response, next) => {
  try {
    const url = String(request.body?.url || '');
    const fileName = path.basename(url);
    if (!/^\/media\/[A-Za-z0-9._-]+$/i.test(url) || !fileName) return response.status(400).json({ error: '媒体文件地址无效' });
    fs.rmSync(path.join(mediaDir, fileName), { force: true });
    response.json({ ok: true });
  } catch (error) { next(error); }
});

if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
  app.use(express.static(staticDir));
  app.get('/{*splat}', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')));
}

app.use((error, _request, response, _next) => {
  console.error(error);
  const safeMessage = userFacingError(error);
  response.status(error.status || 500).json({ error: safeMessage });
});

const port = Number(process.env.PORT || 8787);
let listener = null;
export const serverReady = new Promise((resolve, reject) => {
  listener = app.listen(port, '127.0.0.1', () => {
    console.log(`Alibaba.com workbench API: http://127.0.0.1:${port}`);
    resolve(listener);
  });
  listener.once('error', reject);
});

export async function shutdownServer() {
  await Promise.allSettled([collector.resetContext(), publisher.shutdown()]);
  const active = listener;
  listener = null;
  if (!active?.listening) return;
  await new Promise((resolve) => active.close(() => resolve()));
}
