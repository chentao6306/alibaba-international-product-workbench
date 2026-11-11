import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { applyStockPolicy, normalizeListingMode, hasManualStock } from './publish-policy.js';
import { fileURLToPath } from 'node:url';
import { deleteWorkspaceEntities, findWorkspaceJobs, JsonStore, newId } from './store.js';
import { ShopCollector, collectionPageRange } from './collector.js';
import {
  canonicalizePriceTiers,
  categoryMismatchMessage,
  classifyAlibabaActionResult,
  preparePublishProduct,
  requiredLabelsFromError,
  sanitizeCollectedProduct,
  SellerPublisher
} from './publisher.js';
import { copyMissingProductData, createPublishSnapshot, findAndReplaceProduct, recordProductMutation, syncProductModel } from './product-model.js';
import { publishCounts, recordPublishOutcome } from './publish-progress.js';
import { removePublishedFromWorkbench, workbenchProducts } from './published-cleanup.js';
import { registerPublishedVideoRetry } from './published-video-retry.js';
import { publishDelayFromRequest, waitForPublishDelay } from './publish-delay.js';
import { attachCategoryRequirements, rememberCategoryRequirements } from './category-readiness.js';
import { publishEnvironmentBlockCode } from './publish-recovery.js';
import { buildAlibabaPublishUrl, createPublishPlan, normalizeCategoryId, productCategory, publishBindings, rememberPublishBinding, resolvePublishRoute } from './category-routing.js';
import { findPublishedReferenceRepair } from './publish-reference.js';
import { applyReferencePreview, applyReferencePreviewAsync, failedPublishProducts, previewProductReferenceAsync, referenceCandidates } from './reference-workflow.js';
import { userFacingError } from './browser-error.js';
import { runWithProgressTimeout } from './progress-timeout.js';
import { withVerificationContext } from './human-verification.js';
import { CollectionCheckpoint, collectionResumeMessage } from './collection-checkpoint.js';
import { recoverCollectionGroups, runCollectionControl } from './collection-control.js';
import { collectionUrls, convertProductPrices, crossPlatformPublishErrors, parseCollectionUrl, sourcePlatform } from './source-platform.js';
import { cleanupWorkspace } from './storage-cleanup.js';
import { AnnouncementInbox } from './announcements.js';
import { DEFAULT_SERVICE_ORIGIN } from './auth-endpoint.js';
import { normalizeSellerGroup } from './seller-groups.js';
import { categoryChangePatch, productEditPatch } from './product-edit.js';
import { AUTO_TEXT_SETTINGS, collectedTextPatch } from './product-keywords.js';
import { importSkuRows, transformProductPrices } from './batch-commerce.js';
import { batchTextPatch } from './batch-text.js';
import { CATEGORY_CATALOG as categoryCatalog } from './category-catalog-data.js';
import { createCategoryCatalog } from './category-catalog-model.js';
import { mapSourceCategory } from './source-category-mapping.js';
import { SecureSettings } from './secure-settings.js';
import { aiProductSettings } from './ai-product-settings.js';
import { assistCollectedProduct, assistAttributeMapping, requestProductAi, createProductAiServiceState } from './ai-product-assistance.js';
import { DEFAULT_PROCESSING, prepareMarketplaceProduct, processingSettings, translateProductTitle } from './product-processing.js';
import { initializeCollectionFolders, requireCollectionFolder, saveCollectionFolder, collectionFolderDeletionPreview, deleteCollectionFolder, moveProductsToFolder, findCollectedProduct } from './collection-folders.js';
import { createWorkbenchStateReader } from './workbench-state.js';
import { registerProductImageApi, coherentProductImagePatch } from './product-image-api.js';
import { registerDescriptionTemplateApi } from './description-templates.js';
import { createUpdateGuard } from './update-guard.js';
import { createBackgroundTasks } from './background-tasks.js';
import { isStorageError } from './storage-error.js';
import { createRuntimeDiagnostics, pruneRuntimeDiagnostics } from './runtime-diagnostics.js';
import { diagnosticSummaryFromState } from './diagnostic-report.js';
import { diagnosticCode, diagnosticStage, diagnosticRequestContext } from '../auth-server/diagnostic-schema.js';
import { capturePublishFailure, createPublishDiagnosticStore, pruneAllPublishDiagnostics } from './publish-diagnostics.js';
import { createPublishTimeline } from './publish-timeline.js';

// APP_ROOT_DIR also supports desktop builds with assets inside app.asar.
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
const runtimeDiagnostic = createRuntimeDiagnostics(path.join(dataDir, 'service-runtime.log'));
const diagnosticRetentionTimer = setInterval(() => {
  pruneRuntimeDiagnostics(path.join(dataDir, 'service-runtime.log'));
  try { pruneAllPublishDiagnostics(dataDir); } catch {}
}, 3600000);
diagnosticRetentionTimer.unref();
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
const sourceCategoryCatalog = createCategoryCatalog(categoryCatalog.nodes);
const secureSettings = new SecureSettings(dataDir);
const aiServiceState = createProductAiServiceState();
async function processingPatch(product) {
  let apiKey = '';
  try { apiKey = secureSettings.key(); } catch {}
  const settings = store.read().settings;
  const patch = await prepareMarketplaceProduct(product, settings.marketplaceProcessing || DEFAULT_PROCESSING, { apiKey });
  const config = aiProductSettings(settings.aiProductAssistance);
  let aiKey = '';
  if (config.mode === 'assisted') { try { aiKey = secureSettings.key(config.provider); } catch {} }
  return { ...patch, ...await assistCollectedProduct({ ...product, ...patch }, config, { apiKey: aiKey, serviceState: aiServiceState }) };
}
const inbox = new AnnouncementInbox(path.join(dataDir, 'announcement-reads.json'), process.env.KUA_YIPU_AUTH_URL || DEFAULT_SERVICE_ORIGIN, process.env.KUA_YIPU_ACCOUNT || 'local');
const publisher = new SellerPublisher(dataDir);
const collector = new ShopCollector(dataDir, (products, onProgress, options) => publisher.enrichSourceProducts(products, onProgress, options));
store.update((state) => {
  initializeCollectionFolders(state);
  const previousVersion = Number(state.version || 0);
  state.version = 6;
  if (!state.settings || typeof state.settings !== 'object') state.settings = {};
  if (typeof state.settings.uploadProductVideos !== 'boolean') state.settings.uploadProductVideos = true;
  for (const key of Object.keys(AUTO_TEXT_SETTINGS)) if (typeof state.settings[key] !== 'boolean') state.settings[key] = false;
  if (!state.settings.publishBindings || typeof state.settings.publishBindings !== 'object' || Array.isArray(state.settings.publishBindings)) state.settings.publishBindings = {};
  if (previousVersion < 6) state.settings.publishMode = 'submit';
  if (state.settings.publishPageUrl && /^https?:\/\/(?:[^/]+\.)?1688\.com(?:\/|$)/i.test(state.settings.publishPageUrl)) {
    state.settings.publishPageUrl = '';
  }
  const invalidCategoryBinding = /\/product\/(?:easyListing|category)\.htm/i.test(state.settings.publishPageUrl || '');
  if (invalidCategoryBinding) state.settings.publishPageUrl = '';
  if (invalidCategoryBinding) state.settings.publishCategory = '';
  for (const product of state.products) {
    product.sourcePlatform = sourcePlatform(product);
    if (product.sourcePlatform !== 'alibaba.com') continue;
    if (!product.sourceCategoryId && product.categoryId) product.sourceCategoryId = product.categoryId;
    if (!product.categoryId && product.sourceCategoryId) product.categoryId = product.sourceCategoryId;
    const inferredCategory = productCategory(product);
    if (!product.categoryId && inferredCategory.id) product.categoryId = inferredCategory.id;
    if (!product.sourceCategoryId && inferredCategory.id) product.sourceCategoryId = inferredCategory.id;
    if (product.source?.snapshot) continue;
    if (!/Alibaba Manufacturer Directory|Suppliers, Manufacturers, Exporters/i.test(product.title || '')) continue;
    const slug = product.sourceUrl?.match(/\/product-detail\/([^/?#]+?)[_-]\d{8,}\.html/i)?.[1];
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
  for (const product of state.products) syncProductModel(attachCategoryRequirements(product, state.postingSchemas));
  for (const job of state.jobs) {
    if (!['publish', 'collect'].includes(job.type) || !['queued', 'running', 'pause_requested'].includes(job.status)) continue;
    job.status = 'paused';
    job.message = `服务重启，任务已暂停，可从 ${job.progress || 0}/${job.total || job.metadata?.productIds?.length || 0} 继续`;
    job.updatedAt = new Date().toISOString();
  }
  recoverCollectionGroups(state);
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
app.disable('x-powered-by');
app.use((_request, response, next) => {
  response.set('X-Content-Type-Options', 'nosniff');
  response.set('Referrer-Policy', 'no-referrer');
  response.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data: blob:; media-src 'self' https: http: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  next();
});
app.get('/health', (_request, response) => response.json({ ok: true }));
if (process.env.KUA_YIPU_DESKTOP === '1') {
  app.use('/api', async (request, response, next) => {
    if (!process.env.KUA_YIPU_LOCAL_GATE || request.headers['x-kua-yipu-gate'] !== process.env.KUA_YIPU_LOCAL_GATE) {
      return response.status(401).json({ error: '请从抄得快登录后进入工作台' });
    }
    const authorization = globalThis.__KUA_YIPU_AUTHORIZATION;
    const access = authorization?.check ? await authorization.check()
      : { valid: authorization?.valid(), canRead: authorization?.canRead?.() };
    if (!access.valid && !(request.method === 'GET' && request.path === '/state' && access.canRead)) {
      return response.status(401).json({ error: '授权连接中断，任务已保留，请等待重新连接' });
    }
    next();
  });
}
app.use('/media', express.static(mediaDir, { fallthrough: false, maxAge: '1d' }));
const activePublishJobs = new Set();
const activeCollectJobs = new Set();
const backgroundTasks = createBackgroundTasks({ onStop: async (jobId) => {
  publisher.requestPublishStop(jobId);
  for (const activeId of activePublishJobs) publisher.requestPublishStop(activeId);
  await collector.resetContext();
} });
app.use('/api', backgroundTasks.middleware);
const updateGuard = createUpdateGuard(() => activePublishJobs.size || activeCollectJobs.size
  || processingProducts.size || refreshingProducts.size || readingSellerGroups || videoRetry.isBusy()
  || store.read().jobs.some((job) => ['queued', 'running', 'pause_requested'].includes(job.status)));
app.use('/api', updateGuard.middleware);
let collectionQueue = Promise.resolve();
function queueCollection(jobId) {
  collectionQueue = collectionQueue.catch(() => {}).then(() => backgroundTasks.run(jobId, () => startCollectJob(jobId)));
}
app.use(express.json({ limit: '12mb' }));
const videoRetry = registerPublishedVideoRetry(app, { store, publisher, sellerBusy: () => readingSellerGroups || activePublishJobs.size > 0 });
registerProductImageApi(app, { store, mediaDir });
registerDescriptionTemplateApi(app, { store, mediaDir });

function publicState() {
  const state = store.read();
  return { ...state, products: workbenchProducts(state.products), browser: publisher.status(), collectorBrowser: collector.status() };
}

const readWorkbenchState = createWorkbenchStateReader(store);
app.get('/api/state', async (request, response) => {
  // Idle polling must not block the API worker waiting for Electron. An
  // unresponsive desktop bridge is bounded and never grants cached access.
  const browser = globalThis.__KUA_YIPU_SELLER_BRIDGE?.readStatus
    ? await globalThis.__KUA_YIPU_SELLER_BRIDGE.readStatus() : publisher.status();
  const collectorBrowser = collector.status();
  if (request.query.view === 'summary') {
    return response.json(backgroundTasks.state({ ...readWorkbenchState(request.query.revision), browser, collectorBrowser }));
  }
  const revision = store.revision();
  if (request.query.revision === revision) {
    return response.json(backgroundTasks.state({ unchanged: true, revision, jobs: store.read((state) => state.jobs), browser, collectorBrowser }));
  }
  const state = store.read();
  response.json(backgroundTasks.state({ ...state, products: workbenchProducts(state.products), browser, collectorBrowser, revision }));
});

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
      if (job.type === 'collect') new CollectionCheckpoint(dataDir, job.id).clear();
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
    const platform = result.sourcePlatform || sourcePlatform({ sourceUrl: result.shopUrl });
    if (request.body.platform && request.body.platform !== platform) throw new Error('链接与当前采集平台不一致');
    const now = new Date().toISOString();
    const saved = store.update((state) => {
      let shop = state.shops.find((item) => item.url === result.shopUrl);
      if (!shop) {
        shop = { id: newId(), url: result.shopUrl, name: result.shopName, sourcePlatform: platform, createdAt: now, updatedAt: now };
        state.shops.unshift(shop);
      } else {
        Object.assign(shop, { name: result.shopName, sourcePlatform: platform, updatedAt: now });
      }
      const incomingIds = new Set();
      for (const groupData of result.groups) {
        let group = state.groups.find((item) => item.shopId === shop.id && item.externalId === groupData.externalId);
        if (!group) {
          group = { id: newId(), shopId: shop.id, sourcePlatform: platform, status: 'ready', collectedCount: 0, ...groupData };
          state.groups.push(group);
        } else Object.assign(group, groupData, { sourcePlatform: platform });
        incomingIds.add(group.id);
      }
      return { shop, groups: state.groups.filter((item) => incomingIds.has(item.id)) };
    });
    response.json(saved);
  } catch (error) { next(error); }
});

function saveCollectedProduct(groupId, raw, options = {}) {
  if (!raw) return null;
  const { _collectedSnapshot: collectedSnapshot, ...working } = raw;
  raw = working;
  const now = new Date().toISOString();
  return store.update((draft) => {
    const target = groupId ? draft.groups.find((item) => item.id === groupId) : null;
    if (groupId && !target) return null;
    const platform = sourcePlatform(raw);
    let product = findCollectedProduct(draft, raw, platform, options.collectionFolderId, sourcePlatform);
    const priceNumber = Number(raw.price || 0);
    const markup = Number(draft.settings.priceMarkup || 0);
    const normalized = {
      ...applyStockPolicy(raw, { stockPolicy: draft.settings.stockPolicy || 'minimum-order', defaultStock: draft.settings.defaultStock, collected: true }),
      sourcePlatform: platform,
      collectionFolderId: options.collectionFolderId,
      collectionMethod: options.collectionMethod || 'shop',
      price: platform === 'alibaba.com' && markup ? (priceNumber * (1 + markup / 100)).toFixed(2) : raw.price ?? '',
      deliveryCountry: options.destinationCountry || raw.deliveryCountry || '',
      updatedAt: now
    };
    attachCategoryRequirements(normalized, draft.postingSchemas);
    Object.assign(normalized, collectedTextPatch(normalized, draft.settings, product));
    if (!product) {
      product = syncProductModel({ id: newId(), shopId: target?.shopId || '', groupId: groupId || '', selected: false, status: 'ready', createdAt: now, ...normalized }, { captureSource: true, sourceSnapshot: collectedSnapshot || raw, capturedAt: now });
      draft.products.unshift(product);
    } else {
      // An explicit new collection restores a usable working copy while the
      // previous accepted publication stays in its history.
      if (product.removedFromWorkbenchAt) {
        delete product.removedFromWorkbenchAt;
        product.status = 'ready';
        delete product.publishResult;
      }
      if (options.collectionMethod) {
        // A product collected through a direct link may later be discovered
        // in a shop group. Associate it without replacing the user's edits.
        if (target && !product.groupId) { product.groupId = groupId; product.shopId = target.shopId; }
        return product;
      }
      for (const field of ['stock', 'skus']) {
        if (hasManualStock(product, field)) normalized[field] = product[field];
      }
      normalized.stockProvenance = { ...normalized.stockProvenance, ...product.stockProvenance };
      Object.assign(product, normalized);
      // Re-reading a group updates the working copy, but does not overwrite
      // the immutable source snapshot. An explicit “refresh detail” is the
      // operation that intentionally replaces that snapshot.
      syncProductModel(product, { captureSource: false, capturedAt: now });
    }
    if (target) target.collectedCount = Math.max(Number(target.collectedCount || 0), draft.products.filter((item) => item.groupId === groupId).length);
    return product;
  });
}

function collectionControlOptions(jobId) {
  const stopRequested = (immediate) => {
    if (backgroundTasks.status()) return true;
    const job = store.read((state) => state.jobs.find((item) => item.id === jobId));
    if (immediate && job?.status === 'pause_requested' && job.pauseAfterCurrent) return false;
    return ['pause_requested', 'paused', 'cancelled'].includes(job?.status);
  };
  return { shouldStop: () => stopRequested(false), shouldInterrupt: () => stopRequested(true) };
}

async function startCollectJob(jobId) {
  const queued = store.read().jobs.find((item) => item.id === jobId);
  if (queued?.metadata?.collectionMethod) return startLinkCollectJob(jobId);
  const initial = store.read();
  const job = initial.jobs.find((item) => item.id === jobId && item.type === 'collect');
  const group = initial.groups.find((item) => item.id === job?.metadata?.groupId);
  const inJobFolder = (item) => item.groupId === group?.id && item.collectionFolderId === job?.metadata?.options?.collectionFolderId;
  if (!job || !group || job.status === 'cancelled') return;
  // A queued job can be paused before setImmediate() gets a chance to start
  // it. Do not turn that explicit pause back into a running job.
  if (job.status === 'paused') {
    const count = initial.products.filter(inJobFolder).length;
    store.update((draft) => {
      const target = draft.groups.find((item) => item.id === group.id);
      if (target) Object.assign(target, { status: 'ready', collectedCount: count, activeJobId: '' });
      const pausedJob = draft.jobs.find((item) => item.id === jobId);
      if (pausedJob) Object.assign(pausedJob, { message: `已暂停，已保存 ${count} 件商品，可继续采集`, updatedAt: new Date().toISOString() });
    });
    return;
  }
  const options = { ...(job.metadata?.options || {}), ...collectionControlOptions(jobId) };
  options.prepareDetailProduct = async product => ({ ...product, ...await processingPatch(product), _collectedSnapshot: product._collectedSnapshot || product });
  const checkpoint = new CollectionCheckpoint(dataDir, jobId);
  options.onCheckpoint = (value) => { checkpoint.write(value); options.checkpoint = value; };
  options.onWaiting = (message) => { if (!options.shouldStop()) store.patchJob(jobId, { message }); };
  const savedProducts = new Set();
  try {
    options.checkpoint = checkpoint.read();
    store.patchJob(jobId, { status: 'running', message: collectionResumeMessage(options.checkpoint, `开始采集“${group.name}”，已保存的商品会保留`) });
    const products = await runCollectionControl(options, (controlled, guard) => withVerificationContext(controlled, () => collector.collectGroup(group.url, guard((progress) => {
      if (progress.product) {
        saveCollectedProduct(group.id, progress.product, options);
        savedProducts.add(progress.product.sourceId || progress.product.sourceUrl);
      }
      if (progress.skippedProduct) {
        const skipped = progress.skippedProduct;
        runtimeDiagnostic('collection-product-skipped', { code: skipped.code, reason: skipped.reason, count: progress.skippedCount, stage: 'collection' });
        try {
          createPublishDiagnosticStore(dataDir, process.env.KUA_YIPU_ACCOUNT).write({ stage: 'collection',
            product: { sourceId: skipped.sourceId, sourceUrl: skipped.sourceUrl, title: skipped.title },
            error: { code: skipped.code, message: skipped.message, reason: skipped.reason } });
        } catch { runtimeDiagnostic('collection-skip-log-failed', { stage: 'collection' }); }
      }
      const currentStatus = store.read((state) => state.jobs.find((item) => item.id === jobId)?.status);
      const preservedStatus = ['pause_requested', 'paused', 'cancelled'].includes(currentStatus) ? currentStatus : 'running';
      store.patchJob(jobId, {
        // Do not overwrite a pause request while the current detail finishes.
        // The old unconditional `running` update made the stop request vanish
        // before the callback checked shouldStop(), so collection continued.
        status: preservedStatus,
        collectionStage: progress.stage,
        discovered: progress.found || 0,
        progress: progress.stage === 'listing' ? 0 : (progress.current ?? 0),
        total: progress.total || 0,
        skippedCount: progress.skippedCount || 0,
        ...(progress.skippedProduct ? { lastSkippedProduct: progress.skippedProduct } : {}),
        message: progress.stage === 'listing' ? `正在读取第 ${progress.page} 页（${progress.allPages ? '全部页' : `${options.startPage}-${options.endPage} 页`}），已发现 ${progress.found} 件${progress.storeTotal ? `，店铺显示 ${progress.storeTotal} 件` : ''}` : `正在读取详情 ${progress.current}/${progress.total}，已保存 ${progress.saved ?? progress.current} 件${progress.skippedCount ? `，已跳过 ${progress.skippedCount} 件失效或已跳转商品` : ''}`
      });
      return !options.shouldStop();
    }), controlled)));
    for (const raw of products) {
      if (!savedProducts.has(raw.sourceId || raw.sourceUrl)) saveCollectedProduct(group.id, raw, options);
    }
    if (store.read().jobs.find((item) => item.id === jobId)?.status === 'cancelled') return;
    const count = store.read().products.filter(inJobFolder).length;
    const warningCount = store.read((state) => state.products.filter(inJobFolder).filter((item) => item.collectWarning).length);
    const completedTotal = options.checkpoint?.products.length ?? products.length;
    store.update((draft) => {
      const target = draft.groups.find((item) => item.id === group.id);
      if (target) Object.assign(target, { status: 'done', collectedCount: count, lastCollectedAt: new Date().toISOString(), activeJobId: '' });
      const completeJob = draft.jobs.find((item) => item.id === jobId);
      if (completeJob) Object.assign(completeJob, {
        status: 'completed',
        progress: completedTotal,
        total: completedTotal,
        skippedCount: options.checkpoint?.skippedProducts?.length || 0,
        message: `${options.checkpoint?.discoveredOnly ? `已发现的 ${completedTotal} 件商品采集完成（列表读取至第 ${options.checkpoint.page} 页）` : collectionPageRange(options).allPages ? '全部页读取完成' : `第 ${options.startPage}-${options.endPage} 页读取完成`}，共保存 ${count} 件${options.checkpoint?.skippedProducts?.length ? `，已跳过 ${options.checkpoint.skippedProducts.length} 件失效或已跳转商品` : ''}${warningCount ? `，其中 ${warningCount} 件详情待补全` : ''}`,
        updatedAt: new Date().toISOString()
      });
    });
    checkpoint.clear();
  } catch (error) {
    runtimeDiagnostic('collection-failed', { code: diagnosticCode(error), stage: 'collection' });
    const currentStatus = store.read().jobs.find((item) => item.id === jobId)?.status;
    if (currentStatus === 'cancelled') {
      const count = store.read().products.filter(inJobFolder).length;
      store.update((draft) => {
        const target = draft.groups.find((item) => item.id === group.id);
        if (target?.activeJobId === jobId) Object.assign(target, { status: 'ready', collectedCount: count, activeJobId: '' });
      });
      return;
    }
    const paused = ['COLLECT_PAUSED', 'COLLECT_STALLED'].includes(error.code) || ['pause_requested', 'paused'].includes(currentStatus) || Boolean(options.checkpoint);
    if (paused) {
      const count = store.read().products.filter(inJobFolder).length;
      store.update((draft) => {
        const target = draft.groups.find((item) => item.id === group.id);
        if (target) Object.assign(target, { status: 'ready', collectedCount: count, activeJobId: '' });
        const pausedJob = draft.jobs.find((item) => item.id === jobId);
        if (pausedJob) Object.assign(pausedJob, {
          status: 'paused',
          message: `${error.message && error.message !== 'COLLECT_PAUSED' ? `${userFacingError(error)}；` : ''}已暂停，${collectionResumeMessage(options.checkpoint, `已保存 ${count} 件商品，可继续采集`)}`,
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
  try { requireCollectionFolder(state, request.body.collectionFolderId); } catch (error) { return next(error); }
  const group = state.groups.find((item) => item.id === request.params.id);
  if (!group) return next(Object.assign(new Error('没有找到该分组'), { status: 404 }));
  const unfinished = state.jobs.find((item) => item.type === 'collect' && item.metadata?.groupId === group.id && ['queued', 'running', 'pause_requested', 'paused'].includes(item.status));
  if (unfinished) return next(Object.assign(new Error('该分组已有未完成的采集任务，请先继续或取消该任务'), { status: 409 }));
  const options = { collectionFolderId: request.body.collectionFolderId, ...collectionPageRange(request.body), delaySeconds: Math.max(0, Number(request.body.delaySeconds || 0)), destinationCountry: String(request.body.destinationCountry || ''), sort: String(request.body.sort || 'default') };
  const platform = sourcePlatform({ ...group, sourceUrl: group.url });
  const mic = platform === 'made-in-china';
  if (mic) {
    options.delaySeconds = Math.min(60, options.delaySeconds || 0);
    options.maxProducts = Number(request.body.maxProducts) > 0 ? Math.floor(Number(request.body.maxProducts)) : null;
    options.destinationCountry = ''; options.sort = 'default';
  }
  const job = store.createJob('collect', { groupId: group.id, groupName: group.name, sourcePlatform: platform,
    ...(mic ? { collectionMethod: 'shop-products', links: [parseCollectionUrl(group.url, 'shop-products', platform)] } : {}),
    collectionFolderId: options.collectionFolderId, options });
  store.update((draft) => { const target = draft.groups.find((item) => item.id === group.id); target.status = 'collecting'; target.activeJobId = job.id; });
  response.status(202).json(job);
  setImmediate(() => queueCollection(job.id));
});

async function startLinkCollectJob(jobId) {
  if (activeCollectJobs.has(jobId)) return;
  const job = store.read().jobs.find((item) => item.id === jobId);
  if (!job || !['queued', 'running'].includes(job.status)) return;
  activeCollectJobs.add(jobId);
  const metadata = job.metadata;
  if (metadata.groupId && !store.read().groups.some(group => group.id === metadata.groupId)) {
    store.patchJob(jobId, { status: 'cancelled', message: '店铺分组已删除' });
    activeCollectJobs.delete(jobId);
    return;
  }
  const completedKeys = new Set(metadata.completedKeys || []);
  const failures = [...(metadata.failures || [])];
  const options = { ...metadata.options, collectionMethod: metadata.collectionMethod,
    prepareProduct: async (product) => ({ ...product, ...mapSourceCategory(product, sourceCategoryCatalog), ...await processingPatch(product), _collectedSnapshot: product._collectedSnapshot || product }),
    completedKeys: [...completedKeys],
    ...collectionControlOptions(jobId),
  };
  options.onWaiting = (message) => { if (!options.shouldStop()) store.patchJob(jobId, { message }); };
  try {
    if (metadata.collectionMethod === 'shop-products') {
      const checkpoint = new CollectionCheckpoint(dataDir, jobId);
      options.checkpoint = checkpoint.read();
      options.onCheckpoint = (value) => { checkpoint.write(value); options.checkpoint = value; };
    }
    store.patchJob(jobId, { status: 'running', message: '正在读取来源商品' });
    if (metadata.groupId) store.update(state => {
      const group = state.groups.find(item => item.id === metadata.groupId);
      if (group) Object.assign(group, { status: 'collecting', activeJobId: jobId });
    });
    const progress = (event) => {
      if (event.product) saveCollectedProduct(metadata.groupId || '', event.product, options);
      const status = store.read().jobs.find((item) => item.id === jobId)?.status;
      if (['cancelled', 'paused'].includes(status)) return false;
      if (event.key) completedKeys.add(event.key);
      if (event.error) failures.push({ source: event.key, url: event.url, error: userFacingError(new Error(event.error)) });
      store.patchJob(jobId, { progress: completedKeys.size, total: event.total || job.total || 0,
        collectionStage: event.stage, discovered: event.found || options.checkpoint?.products.length || event.total || 0,
        metadata: { ...metadata, completedKeys: [...completedKeys], failures },
        message: event.stage === 'listing' ? `正在读取结果第 ${event.page} 页，已发现 ${event.found} 件`
          : `已处理 ${event.current}/${event.total} 件，失败 ${failures.length} 件`,
      });
      return !options.shouldStop();
    };
    const products = await runCollectionControl(options, (controlled, guard) => withVerificationContext(controlled, () => metadata.collectionMethod === 'image-search'
      ? collector.collectSearch(metadata.links[0], guard(progress), controlled)
      : metadata.collectionMethod === 'shop-products' ? collector.collectMadeInChinaShop(metadata.links[0], guard(progress), controlled)
      : collector.collectLinks(metadata.links, guard(progress), controlled)));
    if (options.shouldStop()) throw Object.assign(new Error('已暂停采集'), { code: 'COLLECT_PAUSED' });
    store.patchJob(jobId, { status: failures.length === completedKeys.size ? 'failed' : 'completed', progress: completedKeys.size, total: completedKeys.size,
      message: `采集完成，成功 ${completedKeys.size - failures.length} 件，失败 ${failures.length} 件${failures.length ? `：${failures[0].error}` : ''}` });
    if (metadata.collectionMethod === 'shop-products') new CollectionCheckpoint(dataDir, jobId).clear();
  } catch (error) {
    if (store.read().jobs.find((item) => item.id === jobId)?.status === 'cancelled') return;
    runtimeDiagnostic('collection-failed', { code: diagnosticCode(error), stage: 'collection' });
    store.patchJob(jobId, { status: options.shouldStop() || ['COLLECT_PAUSED', 'COLLECT_STALLED'].includes(error.code) ? 'paused' : 'failed', message: userFacingError(error) });
  } finally {
    if (metadata.groupId) store.update(state => {
      const group = state.groups.find(item => item.id === metadata.groupId);
      const current = state.jobs.find(item => item.id === jobId);
      if (group && (!group.activeJobId || group.activeJobId === jobId)) Object.assign(group, {
        status: current?.status === 'completed' ? 'done' : current?.status === 'failed' ? 'failed' : 'ready',
        activeJobId: '', collectedCount: Math.max(group.collectedCount || 0, completedKeys.size - failures.length),
        ...(current?.status === 'completed' ? { lastCollectedAt: new Date().toISOString() } : {}),
      });
    });
    activeCollectJobs.delete(jobId);
  }
}

app.post('/api/collect/links', (request, response, next) => {
  try {
    requireCollectionFolder(store.read(), request.body.collectionFolderId);
    const method = ['image-search', 'shop-products'].includes(request.body.method) ? request.body.method : 'product';
    const links = collectionUrls(request.body.urls, method, request.body.platform);
    const unfinished = store.read().jobs.find((item) => item.type === 'collect' && item.metadata?.collectionMethod === method
      && item.metadata?.collectionFolderId === request.body.collectionFolderId
      && item.metadata?.sourcePlatform === links[0].platform && ['queued', 'running', 'paused', 'pause_requested'].includes(item.status));
    if (unfinished) throw Object.assign(new Error('当前入口已有采集任务，请先继续或取消该任务'), { status: 409 });
    const number = (value, fallback, max) => Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)));
    const options = {
      collectionFolderId: request.body.collectionFolderId,
      startPage: number(request.body.startPage, 1, 100), endPage: number(request.body.endPage, 1, 100),
      maxProducts: number(request.body.maxProducts, 100, 1000), delaySeconds: Math.max(0, Math.min(60, Number(request.body.delaySeconds) || 0)),
    };
    if (options.endPage < options.startPage) throw new Error('结束页不能小于起始页');
    const job = store.createJob('collect', { collectionMethod: method, sourcePlatform: links[0].platform, collectionFolderId: options.collectionFolderId, links, options });
    response.status(202).json(job);
    setImmediate(() => queueCollection(job.id));
  } catch (error) { next(Object.assign(error, { status: error.status || 400 })); }
});

app.post('/api/collect/login', async (request, response, next) => {
  try {
    if (store.read().jobs.some((job) => job.type === 'collect' && ['running', 'queued'].includes(job.status))) throw new Error('请先暂停采集任务再打开平台登录');
    response.json(await collector.openMarketplace(request.body.platform));
  } catch (error) { next(error); }
});

app.post('/api/collection-folders', (request, response, next) => {
  try { response.status(201).json(store.update((state) => saveCollectionFolder(state, request.body.name))); } catch (error) { next(error); }
});
app.patch('/api/collection-folders/:id', (request, response, next) => {
  try { response.json(store.update((state) => saveCollectionFolder(state, request.body.name, request.params.id))); } catch (error) { next(error); }
});
app.post('/api/collection-folders/:id/select', (request, response, next) => {
  try { response.json(store.update((state) => { requireCollectionFolder(state, request.params.id); state.settings.activeCollectionFolderId = request.params.id; return { ok: true }; })); } catch (error) { next(error); }
});
app.delete('/api/collection-folders/:id', (request, response, next) => {
  try {
    const result = store.update((state) => deleteCollectionFolder(state, request.params.id, { cancelPausedJobIds: request.body?.cancelPausedJobIds }));
    // Cancellation must be durable before removing resumable checkpoints.
    for (const id of result.cancelledJobIds) {
      try { new CollectionCheckpoint(dataDir, id).clear(); } catch (error) { console.warn('Cancelled task checkpoint cleanup failed:', error.code || error.name); }
    }
    response.json(result);
  } catch (error) { next(error); }
});
app.get('/api/collection-folders/:id/deletion-preview', (request, response, next) => {
  try { response.json(store.read((state) => collectionFolderDeletionPreview(state, request.params.id))); } catch (error) { next(error); }
});
app.post('/api/products/move-folder', (request, response, next) => {
  try { response.json(store.update((state) => moveProductsToFolder(state, Array.isArray(request.body.ids) ? request.body.ids : [], request.body.collectionFolderId))); } catch (error) { next(error); }
});

app.get('/api/categories/catalog', (request, response) => {
  response.json(categoryCatalog);
});

app.post('/api/categories/from-product', async (request, response, next) => {
  try {
    const link = parseCollectionUrl(request.body.url, 'product', 'alibaba.com');
    const [product] = await collector.enrichProducts([{ sourceId: link.sourceId, sourceUrl: link.url }]);
    const category = productCategory(product);
    if (!category.id) throw new Error('该商品未公开具体类目，请使用另一个同类商品链接');
    response.json({ path: category.pathText || category.id, id: category.id });
  } catch (error) { next(error); }
});

app.post('/api/collector/open', async (request, response, next) => {
  try { response.json(await collector.open(request.body.url)); } catch (error) { next(error); }
});

app.get('/api/products/:id', (request, response) => {
  const product = store.read((state) => state.products.find((item) => item.id === request.params.id));
  if (!product) return response.status(404).json({ error: '没有找到该商品' });
  response.json(product);
});

app.patch('/api/products/:id', (request, response, next) => {
  try {
    const snapshot = store.snapshot();
    const updated = store.updateProducts([request.params.id], (products) => {
      const product = products[0];
      if (!product) throw Object.assign(new Error('没有找到该商品'), { status: 404 });
      const state = { ...snapshot, products: snapshot.products.map(item => item.id === product.id ? product : item) };
      assertProductsEditable(state, [product.id]);
      const patch = productEditPatch(request.body);
      if (Object.hasOwn(request.body, 'selected')) patch.selected = Boolean(request.body.selected);
      if (Object.hasOwn(patch, 'sellerGroup')) patch.sellerGroup = normalizeSellerGroup(patch.sellerGroup);
      if (request.body.referenceReview) {
        applyReferencePreview(state, { ...request.body.referenceReview, ids: [product.id] });
      }
      Object.assign(patch, categoryChangePatch(product, patch));
      if (request.body.usdRate && product.currencySymbol !== '$') Object.assign(patch, convertProductPrices({ ...product, ...patch }, request.body.usdRate));
      Object.assign(patch, coherentProductImagePatch(product, patch));
      if (!product.source?.snapshot) syncProductModel(product);
      recordProductMutation(product, patch, { actor: 'user', action: 'single-edit' });
      syncProductModel(attachCategoryRequirements(product, state.postingSchemas));
      return product;
    });
    response.json(updated);
  } catch (error) { next(error); }
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
      'categoryPath', 'categoryId', 'currencySymbol',
      'attributeOperation', 'variantOperation', 'skuRows',
      'certificates', 'regionalPricing', 'shipping', 'freightTemplate', 'logisticsAttributes', 'deliveryCountry', 'deliveryOptions',
      'salesUnit', 'paymentMethod', 'fobPrice', 'priceMode', 'skuPriceMode', 'packaging', 'deliveryTime'
    ]);
    const safePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
    const updated = store.update((state) => {
      const now = new Date().toISOString();
      const selected = state.products.filter((product) => ids.has(product.id));
      assertProductsEditable(state, selected.map((product) => product.id));
      const imported = Array.isArray(patch.skuRows) ? importSkuRows(selected, patch.skuRows) : new Map();
      const requestOrder = new Map([...ids].map((id, index) => [id, index]));
      state.products.filter((product) => ids.has(product.id)).forEach((product) => {
        const next = { ...safePatch, ...(imported.has(product.id) ? { skus: imported.get(product.id) } : {}) };
        if (patch.usdRate && product.currencySymbol !== '$') Object.assign(next, convertProductPrices({ ...product, ...next }, patch.usdRate));
        if (Array.isArray(patch.title)) next.title = patch.title[requestOrder.get(product.id)] || product.title;
        Object.assign(next, batchTextPatch(product, { ...patch, ...(Object.hasOwn(next, 'title') ? { title: next.title } : {}) }));
        if (patch.priceTransform) {
          Object.assign(next, transformProductPrices({ ...product, ...next }, patch.priceTransform));
        }
        if (patch.skuTransform) next.skus = (next.skus || product.skus || []).map((sku) => ({ ...sku, ...(patch.skuTransform.price == null ? {} : { price: patch.skuTransform.price }), ...(patch.skuTransform.stock == null ? {} : { stock: patch.skuTransform.stock }) }));
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
        Object.assign(next, coherentProductImagePatch(product, next, patch.imageOperation));
        if (patch.descriptionPrefix || patch.imageOperation) { delete next.descriptionPrefix; delete next.imageOperation; }
        delete next.priceTransform; delete next.skuTransform; delete next.skuRows;
        delete next.attributeOperation; delete next.variantOperation;
        // Never accept source snapshot fields from a batch patch. The source
        // capture is immutable; this operation only changes the working copy.
        delete next.source;
        delete next.sourceSnapshot;
        delete next.sourceSnapshotHash;
        if (!product.source?.snapshot) syncProductModel(product);
        recordProductMutation(product, { ...categoryChangePatch(product, next), status: 'ready' }, { actor: 'user', action: 'batch-edit' });
        syncProductModel(attachCategoryRequirements(product, state.postingSchemas));
      });
      return state.products.filter((product) => ids.has(product.id));
    });
    response.json({ updated: updated.length, categoryBindingReset: false });
  } catch (error) { next(error); }
});

const refreshingProducts = new Set();
app.post('/api/products/:id/refresh-detail', async (request, response, next) => {
  const id = request.params.id;
  let acquired = false;
  try {
    const state = store.read();
    const product = state.products.find((item) => item.id === id);
    if (!product) return next(Object.assign(new Error('没有找到该商品'), { status: 404 }));
    assertProductsEditable(state, [id]);
    if (refreshingProducts.has(id) || processingProducts.has(id)) throw Object.assign(new Error('商品正在重新采集或加工，请完成后再重试'), { status: 409 });
    refreshingProducts.add(id);
    acquired = true;
    const revision = JSON.stringify(product);
    const [collected] = await collector.enrichProducts([product]);
    const { _collectedSnapshot: sourceSnapshot, ...enriched } = collected;
    const aiConfig = aiProductSettings(state.settings.aiProductAssistance);
    let aiKey = '';
    if (aiConfig.mode === 'assisted') { try { aiKey = secureSettings.key(aiConfig.provider); } catch {} }
    const aiPatch = await assistCollectedProduct(enriched, aiConfig, { apiKey: aiKey });
    const updated = store.update((draft) => {
      const target = draft.products.find((item) => item.id === product.id);
      if (!target || JSON.stringify(target) !== revision) throw Object.assign(new Error('商品在重新采集期间已修改或删除，已保留最新数据，请重新读取后再试'), { status: 409 });
      assertProductsEditable(draft, [id]);
      // A public listing can be readable while Alibaba blocks an individual
      // detail page. Keep the existing complete fields in that case instead of
      // replacing them with an incomplete warning record.
      const hasWarning = Boolean(enriched?.collectWarning);
      if (hasWarning) {
        target.collectWarning = enriched.collectWarning;
        return target;
      }
      else {
        const generated = collectedTextPatch(enriched, draft.settings, target);
        Object.assign(target, enriched, aiPatch, mapSourceCategory(enriched, sourceCategoryCatalog), generated);
        delete target.collectWarning;
      }
      Object.assign(target, { status: 'ready', updatedAt: new Date().toISOString() });
      delete target.publishResult;
      if (!hasWarning) syncProductModel(attachCategoryRequirements(target, draft.postingSchemas), { captureSource: true, sourceSnapshot: sourceSnapshot || enriched });
      return target;
    });
    response.json(updated);
  } catch (error) { next(error); }
  finally { if (acquired) refreshingProducts.delete(id); }
});

app.post('/api/products/select', (request, response) => {
  const selected = Boolean(request.body?.selected);
  const selectAll = request.body?.all === true;
  const ids = selectAll ? null : new Set(Array.isArray(request.body?.ids) ? request.body.ids : []);
  const count = store.update((state) => {
    let changed = 0;
    for (const item of state.products) {
      if (item.removedFromWorkbenchAt) continue;
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

app.get('/api/settings/processing', (_request, response) => {
  response.json({ ...DEFAULT_PROCESSING, ...store.read().settings.marketplaceProcessing, apiKeyConfigured: secureSettings.configured() });
});

app.get('/api/settings/ai-products', (_request, response) => {
  const config = aiProductSettings(store.read().settings.aiProductAssistance);
  response.json({ ...config, apiKeyConfigured: secureSettings.configured(config.provider) });
});

app.patch('/api/settings/ai-products', (request, response, next) => {
  try {
    const config = aiProductSettings({ ...store.read().settings.aiProductAssistance, ...request.body });
    if (Object.hasOwn(request.body, 'apiKey')) secureSettings.saveKey(request.body.apiKey, config.provider);
    if (config.mode === 'assisted' && !secureSettings.configured(config.provider)) throw new Error('开启 AI 辅助前请先保存该服务的 API 密钥');
    store.update(state => { state.settings.aiProductAssistance = config; });
    aiServiceState.clear();
    response.json({ ...config, apiKeyConfigured: secureSettings.configured(config.provider) });
  } catch (error) { next(Object.assign(error, { status: 400 })); }
});

app.post('/api/settings/ai-products/test', async (_request, response, next) => {
  try {
    const config = aiProductSettings(store.read().settings.aiProductAssistance);
    const result = await requestProductAi({ task: 'collection', evidence: [{ evidenceId: 'e0', kind: 'description', text: 'Material: PET' }] },
      config, { apiKey: secureSettings.key(config.provider) });
    if (!Array.isArray(result.attributes)) throw new Error('AI 返回结果格式不正确');
    aiServiceState.clear();
    response.json({ ok: true, provider: config.provider, model: config[`${config.provider}Model`] });
  } catch (error) { next(Object.assign(error, { status: 400 })); }
});

app.patch('/api/settings/processing', (request, response, next) => {
  try {
    const config = processingSettings(request.body);
    if (Object.hasOwn(request.body, 'apiKey')) secureSettings.saveKey(request.body.apiKey);
    store.update((state) => { state.settings.marketplaceProcessing = config; });
    response.json({ ...config, apiKeyConfigured: secureSettings.configured() });
  } catch (error) { next(Object.assign(error, { status: 400 })); }
});

app.post('/api/settings/processing/test', async (_request, response, next) => {
  try {
    const title = await translateProductTitle('不锈钢杯 500ml', { apiKey: secureSettings.key(), model: store.read().settings.marketplaceProcessing?.deepseekModel });
    response.json({ ok: true, title });
  } catch (error) { next(Object.assign(error, { status: 400 })); }
});

const processingProducts = new Set();
app.post('/api/products/process', async (request, response, next) => {
  const id = String(request.body?.id || '');
  let acquired = false;
  try {
    const state = store.read();
    const product = state.products.find((item) => item.id === id);
    if (!product) return response.status(404).json({ error: '没有找到该商品' });
    if (product.status === 'published' || findWorkspaceJobs(state, { productIds: [id] }, ['queued', 'running', 'pause_requested']).length || processingProducts.has(id) || refreshingProducts.has(id)) return response.status(409).json({ error: '商品正在处理或已发布，请勿重复加工' });
    processingProducts.add(id);
    acquired = true;
    const revision = JSON.stringify(product);
    const patch = await processingPatch(product);
    const updated = store.update((draft) => {
      const current = draft.products.find((item) => item.id === id);
      if (!current || JSON.stringify(current) !== revision) throw Object.assign(new Error('商品资料已变更，请重新加工'), { status: 409 });
      // The request was authorized before processing. Preserve its completed
      // result even when authorization expires while the provider responds.
      recordProductMutation(current, patch, { actor: 'user', action: 'marketplace-processing' });
      return { id, warnings: current.processingWarnings || [] };
    });
    response.json(updated);
  } catch (error) { next(error); }
  finally { if (acquired) processingProducts.delete(id); }
});

app.patch('/api/settings', (request, response, next) => {
  for (const [key, label] of Object.entries(AUTO_TEXT_SETTINGS)) {
    if (Object.hasOwn(request.body, key) && typeof request.body[key] !== 'boolean') {
      return next(Object.assign(new Error(`${label}开关必须为布尔值`), { status: 400 }));
    }
  }
  if (Object.hasOwn(request.body, 'uploadProductVideos') && typeof request.body.uploadProductVideos !== 'boolean') {
    return next(Object.assign(new Error('上传商品视频开关必须为布尔值'), { status: 400 }));
  }
  if (Object.hasOwn(request.body, 'autoRemovePublishedProducts') && typeof request.body.autoRemovePublishedProducts !== 'boolean') {
    return next(Object.assign(new Error('成功发布后自动删除开关必须为布尔值'), { status: 400 }));
  }
  if (Object.hasOwn(request.body, 'allowPolicyWarningPublish')) {
    if (typeof request.body.allowPolicyWarningPublish !== 'boolean') return next(Object.assign(new Error('风险提示上架开关必须为布尔值'), { status: 400 }));
    if (request.body.allowPolicyWarningPublish && store.read().settings.allowPolicyWarningPublish !== true && request.body.confirmPolicyWarningPublish !== true) {
      return next(Object.assign(new Error('请先确认启用风险提示商品上架'), { status: 400 }));
    }
  }
  if (Object.hasOwn(request.body, 'stockPolicy') && !['minimum-order', 'fixed'].includes(request.body.stockPolicy)) return next(Object.assign(new Error('不支持的默认库存规则'), { status: 400 }));
  if (Object.hasOwn(request.body, 'listingMode') && !['auto', 'inquiry', 'complete-logistics'].includes(request.body.listingMode)) return next(Object.assign(new Error('不支持的销售方式'), { status: 400 }));
  let delay;
  try {
    const settings = store.read().settings;
    delay = publishDelayFromRequest(request.body, { minSeconds: settings.publishDelayMinSeconds, maxSeconds: settings.publishDelayMaxSeconds });
  } catch (error) { return next(error); }
  const allowed = ['publishPageUrl', 'publishCategory', 'publishBindings', 'defaultStock', 'priceMarkup', 'publishMode', 'stockPolicy', 'listingMode', 'publishDelayMinSeconds', 'publishDelayMaxSeconds', 'allowPolicyWarningPublish', 'autoRemovePublishedProducts', 'uploadProductVideos', ...Object.keys(AUTO_TEXT_SETTINGS)];
  const settings = store.update((state) => {
    for (const key of allowed) if (Object.hasOwn(request.body, key)) state.settings[key] = request.body[key];
    if (request.body.allowPolicyWarningPublish === true && request.body.confirmPolicyWarningPublish === true) state.settings.policyWarningPublishConfirmedAt = new Date().toISOString();
    if (Object.hasOwn(request.body, 'publishDelayMinSeconds') || Object.hasOwn(request.body, 'publishDelayMaxSeconds')) {
      state.settings.publishDelayMinSeconds = delay.minSeconds;
      state.settings.publishDelayMaxSeconds = delay.maxSeconds;
    }
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
    let job = store.read((state) => state.jobs.find((item) => item.id === jobId && item.type === 'publish'));
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const productIds = job.metadata?.productIds || [];
    const mode = job.metadata?.mode === 'submit' ? 'submit' : 'draft';
    const total = productIds.length;
    const waitedIndices = new Set();
    store.patchJob(jobId, { status: 'running', total, message: '正在连接阿里巴巴国际站卖家后台' });

    for (let index = Number(job.progress || 0); index < total; index += 1) {
      if (backgroundTasks.status()) return;
      job = store.read((state) => state.jobs.find((item) => item.id === jobId));
      if (!job || job.status === 'cancelled') return;
      if (['pause_requested', 'paused'].includes(job.status)) {
        store.patchJob(jobId, { status: 'paused', progress: index, total, message: `已暂停，已处理 ${index}/${total} 件` });
        return;
      }

      if (index > 0 && !waitedIndices.has(index)) {
        const continued = await waitForPublishDelay(job.metadata?.publishDelay, {
          shouldStop: () => Boolean(backgroundTasks.status()) || store.read((state) => state.jobs.find((item) => item.id === jobId)?.status) !== 'running',
          onWaiting: (seconds) => store.patchJob(jobId, { currentProductId: productIds[index], waitingForDelay: true,
            message: `上架间隔等待，还剩 ${seconds} 秒后处理第 ${index + 1}/${total} 件` }),
        });
        if (!continued) {
          if (store.read((state) => state.jobs.find((item) => item.id === jobId)?.status) !== 'cancelled') {
            store.patchJob(jobId, { status: 'paused', progress: index, total, waitingForDelay: false, message: `已暂停，已处理 ${index}/${total} 件` });
          }
          return;
        }
        waitedIndices.add(index);
      }

      let product = store.read((state) => state.products.find((item) => item.id === productIds[index]));
      if (!product) {
        store.update((draft) => recordPublishOutcome(draft, jobId, productIds[index], { status: 'skipped' }, index + 1));
        store.patchJob(jobId, { progress: index + 1, total, message: `已跳过不存在的商品 ${index + 1}/${total}` });
        continue;
      }
      if (job.metadata.failedOnly && !failedPublishProducts([product]).length) {
        store.update((draft) => recordPublishOutcome(draft, jobId, product.id, { status: 'skipped', message: '商品已完成处理，无需重试' }, index + 1));
        continue;
      }
      const diagnosticStarted = performance.now();
      let diagnosticCurrentStage = 'publishing';
      let diagnosticCategoryId = 0;
      let diagnosticAiMapping = [];
      const diagnosticAttemptId = newId();
      const diagnosticTimeline = createPublishTimeline(diagnosticCurrentStage);
      let diagnosticProcessingMode = 'rules';
      const diagnosticContext = () => ({ attemptId: diagnosticAttemptId, mode, processingMode: diagnosticProcessingMode,
        categoryId: diagnosticCategoryId, elapsedMs: performance.now() - diagnosticStarted });
      try {
        product = preparePublishProduct(product, { stockPolicy: job.metadata.stockPolicy || 'preserve', defaultStock: job.metadata.defaultStock });
        store.update((draft) => {
          const target = draft.products.find((item) => item.id === product.id);
          if (target) Object.assign(target, product, { updatedAt: new Date().toISOString() });
          const currentJob = draft.jobs.find((item) => item.id === jobId);
          Object.assign(currentJob, { status: 'running', progress: index, total, waitingForDelay: false, verificationState: '', currentProductId: product.id,
            message: `正在处理 ${index + 1}/${total}：${product.title}`, updatedAt: new Date().toISOString() });
        });
        // Publishing consumes saved product data only. Source visits belong to
        // collection or an explicit refresh, including missing-data repairs.
        const settings = store.read((state) => state.settings);
        diagnosticProcessingMode = settings.aiProductAssistance?.mode === 'assisted' ? 'assisted' : 'rules';
        runtimeDiagnostic('publish-started', { ...diagnosticContext(), stage: diagnosticCurrentStage });
        if (['pause_requested', 'paused'].includes(store.read((state) => state.jobs.find((item) => item.id === jobId)?.status))) {
          throw Object.assign(new Error('任务已暂停，已完成数据已保存'), { code: 'PUBLISH_PAUSED' });
        }
        const sourceErrors = crossPlatformPublishErrors(product);
        if (sourceErrors.length) throw new Error(sourceErrors.join('；'));
        const route = resolvePublishRoute(product, settings);
        diagnosticCategoryId = Number(route.categoryId) || 0;
        if (route.error || !route.url) throw new Error(route.error || '该商品没有可用的国际站发布页');
        const publishSnapshot = createPublishSnapshot(product, { mode, category: route.category, categoryId: route.categoryId, publishPageUrl: route.url });
        store.patchJob(jobId, { message: `正在处理 ${index + 1}/${total}：${product.title}（${route.category || '未识别类目'}）` });
        // Do not cap the total time for a product. Only stop when one concrete
        // stage has made no progress for an extended period.
        const stageTimeoutMs = Math.max(60000, Number(process.env.KUA_YIPU_PUBLISH_STAGE_TIMEOUT_MS || 180000));
        let verificationState = '';
        const result = await runWithProgressTimeout(
          (reportStage, signal) => withVerificationContext({
            onWaiting: stage => {
              verificationState = /^验证已完成/.test(stage) ? '' : /^验证页面出错/.test(stage) ? 'error' : 'waiting';
              reportStage(stage);
            },
            shouldStop: () => signal.aborted || Boolean(backgroundTasks.status()) || ['pause_requested', 'paused', 'cancelled'].includes(store.read((state) => state.jobs.find((item) => item.id === jobId)?.status))
          }, () => publisher.publishProduct(product, route.url, mode, route.category, jobId, stage => {
            verificationState = '';
            reportStage(stage);
          }, {
            signal,
            sellerGroup: job.metadata?.sellerGroup || product.sellerGroup, listingMode: job.metadata?.listingMode,
            stockPolicy: job.metadata?.stockPolicy || 'preserve', defaultStock: job.metadata?.defaultStock,
            allowPolicyWarningPublish: settings.allowPolicyWarningPublish === true,
            uploadProductVideos: settings.uploadProductVideos !== false,
            resolveAttributeMappings: async (input, schema, context = {}) => {
              const config = aiProductSettings(settings.aiProductAssistance);
              let apiKey = '';
              if (config.mode === 'assisted') { try { apiKey = secureSettings.key(config.provider); } catch {} }
              return assistAttributeMapping(input, schema, config, { apiKey, signal, feedback: context.feedback,
                onProgress: context.onProgress, serviceState: aiServiceState });
            },
            onAiMapping: audit => {
              diagnosticAiMapping = audit;
              store.update(state => {
                const target = state.products.find(item => item.id === product.id);
                if (target) target.aiMapping = audit;
              });
            },
            onProductSchema: schema => store.update(state => {
              const target = state.products.find(item => item.id === product.id);
              if (target) { target.postingRequirements = { ...schema, productSpecific: true }; syncProductModel(target); }
            }),
            onCategorySchema: (schema) => store.update((state) => {
              rememberCategoryRequirements(state, schema);
              for (const item of state.products) {
                if (item.postingRequirements === schema) syncProductModel(item);
              }
            }),
          })),
          {
            timeoutMs: stageTimeoutMs,
            initialStage: '启动国际站发布流程',
            onProgress: (stage) => {
              const nextStage = diagnosticStage(stage);
              const completedStage = diagnosticTimeline.advance(nextStage, { waiting: verificationState === 'waiting' });
              if (completedStage) runtimeDiagnostic('publish-stage-completed', { ...diagnosticContext(),
                stage: completedStage.stage, stageMs: completedStage.durationMs });
              if (nextStage !== diagnosticCurrentStage) {
                diagnosticCurrentStage = nextStage;
                runtimeDiagnostic('publish-progress', { ...diagnosticContext(), stage: nextStage });
              }
              store.patchJob(jobId, { verificationState, message: `正在处理 ${index + 1}/${total}：${product.title} - ${stage}` });
            },
            onTimeout: () => publisher.requestPublishStop(jobId)
          }
        );
        // The publishing session remains in the background after completion.
        runtimeDiagnostic('publish-completed', { ...diagnosticContext(), stage: diagnosticCurrentStage,
          stageMs: diagnosticTimeline.snapshot('completed').entries.at(-1).durationMs });
        store.update((draft) => {
          const target = draft.products.find((item) => item.id === product.id);
          if (target) Object.assign(target, {
            status: result.status,
            selected: false,
            publishResult: result,
            updatedAt: new Date().toISOString()
          });
          if (target) {
            if (target.referenceRecovery) target.referenceRecovery.state = 'completed';
            target.publishHistory = Array.isArray(target.publishHistory) ? target.publishHistory : [];
            target.publishHistory.unshift({ ...publishSnapshot, result });
            syncProductModel(target);
          }
          rememberPublishBinding(draft.settings, { ...route, verifiedAt: new Date().toISOString(), source: 'verified' });
          recordPublishOutcome(draft, jobId, product.id, result, index + 1);
          removePublishedFromWorkbench(draft, product.id, result, jobId);
        });
        publisher.clearPublishStop(jobId);
        store.patchJob(jobId, { progress: index + 1, total, message: `已处理 ${index + 1}/${total}：${product.title}` });
      } catch (error) {
        const diagnosticTrace = diagnosticTimeline.snapshot('failed');
        runtimeDiagnostic('publish-failed', { ...diagnosticContext(), code: diagnosticCode(error), stage: diagnosticCurrentStage,
          stageMs: diagnosticTrace.entries.at(-1).durationMs });
        try {
          const current = publisher.publishingPage;
          const page = current?.productId === String(product.id) && current?.jobId === String(jobId) ? current.page : null;
          const evidence = await capturePublishFailure({ page, product, error, mode, aiMapping: diagnosticAiMapping,
            attemptId: diagnosticAttemptId, timeline: diagnosticTrace, targetCategoryId: diagnosticCategoryId, processingMode: diagnosticProcessingMode,
            stage: error.diagnostics?.publishStage || diagnosticCurrentStage, elapsedMs: performance.now() - diagnosticStarted });
          createPublishDiagnosticStore(dataDir, process.env.KUA_YIPU_ACCOUNT).write(evidence);
        } catch { /* Diagnostics must never replace the original publish error. */ }
        if (isStorageError(error)) throw error;
        const message = userFacingError(error);
        const requiresHuman = ['LOGIN_REQUIRED', 'HUMAN_VERIFICATION_REQUIRED'].includes(error.code) || /captcha|verify|人机验证|安全验证|滑块|登录(?:状态)?(?:已)?失效|人工验证/i.test(message);
        const environmentNotReady = publishEnvironmentBlockCode(error);
        const currentJobStatus = store.read((state) => state.jobs.find((item) => item.id === jobId)?.status);
        if (currentJobStatus === 'cancelled') return;
        // Only a task-control request may pause a running batch. Browser and
        // verification helpers also use *_PAUSED when their page disappears;
        // those errors must not strand every remaining product.
        const pauseRequested = ['pause_requested', 'paused'].includes(currentJobStatus);
        if (!pauseRequested) store.update((draft) => {
          const target = draft.products.find((item) => item.id === product.id);
          if (target) {
            const result = { status: 'failed', message, code: error.code || '',
              listingMode: normalizeListingMode(job.metadata?.listingMode),
              diagnostics: { ...(error.diagnostics || {}), attemptId: diagnosticAttemptId, processingMode: diagnosticProcessingMode,
                targetCategoryId: diagnosticCategoryId, publishStage: error.diagnostics?.publishStage || diagnosticCurrentStage },
              requiredFields: [...new Set([...(error.requiredFields || []), ...requiredLabelsFromError(message)])], missingSourceFields: error.missingSourceFields || [],
              unmatchedSourceFields: error.unmatchedSourceFields || [], conflictingSourceFields: error.conflictingSourceFields || [] };
            Object.assign(target, { status: 'publish_failed', publishResult: result, updatedAt: new Date().toISOString() });
            if (target.referenceRecovery) target.referenceRecovery.state = 'failed';
            target.publishHistory = Array.isArray(target.publishHistory) ? target.publishHistory : [];
            const failureRoute = resolvePublishRoute(target, draft.settings);
            target.publishHistory.unshift({ ...createPublishSnapshot(target, { mode, category: failureRoute.category, categoryId: failureRoute.categoryId, publishPageUrl: failureRoute.url }), result });
            syncProductModel(target);
          }
        });
        publisher.clearPublishStop(jobId);
        // Repair only from the reference explicitly selected for this product.
        // Unrelated successful products are not evidence for its attributes.
        const jobState = store.read((state) => state.jobs.find((item) => item.id === jobId));
        const retries = jobState?.metadata?.autoReferenceRetries && typeof jobState.metadata.autoReferenceRetries === 'object'
          ? jobState.metadata.autoReferenceRetries : {};
        const requiredFields = [...new Set([...(error.requiredFields || []), ...requiredLabelsFromError(message)])];
        const attempted = retries[product.id]?.referenceIds || (retries[product.id]?.referenceId ? [retries[product.id].referenceId] : []);
        if (product.categoryReference && !pauseRequested && !requiresHuman && !environmentNotReady && error.code !== 'PUBLISH_POLICY_REVIEW_REQUIRED' && requiredFields.length && attempted.length < 2) {
          const frozen = product.categoryReference.template;
          const candidates = frozen ? [{ ...frozen, id: product.categoryReference.referenceId, status: 'published' }]
            : store.read((state) => state.products.filter((candidate) => candidate.id === product.categoryReference.referenceId));
          const repair = ['full', 'failed-fields', undefined].includes(product.categoryReference.scope)
            ? findPublishedReferenceRepair(product, candidates, requiredFields, attempted) : null;
          if (repair) {
            store.update((draft) => {
              const target = draft.products.find((item) => item.id === product.id);
              if (!target) return;
              recordProductMutation(target, repair.patch, { actor: 'system', action: 'automatic-publish-reference' });
              target.status = 'ready';
              delete target.publishResult;
            });
            retries[product.id] = {
              referenceIds: [...attempted, repair.referenceId], fields: repair.fields, at: new Date().toISOString()
            };
            store.patchJob(jobId, {
              metadata: { ...(jobState?.metadata || {}), autoReferenceRetries: retries },
              message: `已引用同类目成功商品的缺失字段（${repair.fields.join('、')}），准备重试 ${index + 1}/${total}`
            });
            index -= 1;
            continue;
          }
        }
        if (pauseRequested) {
          store.patchJob(jobId, { status: 'paused', progress: index, total, message: `已立即暂停，当前商品未继续操作，已完成 ${index}/${total} 件` });
          return;
        }
        // A product-level validation or upload error must not discard the
        // remaining batch. Keep the failed item visible and continue with the
        // next product; the final job status summarizes the failures.
        store.update((draft) => recordPublishOutcome(draft, jobId, product.id, { status: 'failed', message, code: error.code || environmentNotReady || '' }, index + 1));
        store.patchJob(jobId, {
          status: 'running', progress: index + 1, total,
          message: `第 ${index + 1}/${total} 件失败，继续处理下一件：${product.title}`
        });
        continue;
      }
    }
    const counts = publishCounts(store.read((state) => state.jobs.find((item) => item.id === jobId)));
    store.patchJob(jobId, {
      status: 'completed', progress: total, total, currentProductId: null,
      message: `上架任务完成，成功 ${counts.success} 件，失败 ${counts.failed} 件${counts.skipped ? `，跳过 ${counts.skipped} 件` : ''}`
    });
  } catch (error) {
    if (isStorageError(error)) throw error;
    store.patchJob(jobId, { status: 'failed', message: userFacingError(error) });
  } finally {
    activePublishJobs.delete(jobId);
  }
}

let readingSellerGroups = false;
app.get('/api/seller/product-groups', async (request, response, next) => {
  if (readingSellerGroups || store.read().jobs.some((job) => job.type === 'publish' && ['queued', 'running', 'pause_requested'].includes(job.status))) return next(Object.assign(new Error('正在处理上架任务或读取分组，请稍后重试'), { status: 409 }));
  readingSellerGroups = true;
  try { response.json({ groups: await publisher.listSellerGroups(normalizeCategoryId(request.query.categoryId)) }); }
  catch (error) { next(error); }
  finally { readingSellerGroups = false; }
});

app.post('/api/publish', (request, response, next) => {
  if (Object.hasOwn(request.body, 'listingMode') && !['auto', 'inquiry', 'complete-logistics'].includes(request.body.listingMode)) return next(Object.assign(new Error('不支持的销售方式'), { status: 400 }));
  const state = store.read();
  if (readingSellerGroups) return next(Object.assign(new Error('正在读取国际站分组，请稍后开始上架'), { status: 409 }));
  const existing = state.jobs.find((job) => job.type === 'publish' && ['queued', 'running', 'pause_requested', 'paused'].includes(job.status));
  if (existing) return next(Object.assign(new Error('已有未完成的上架任务，请先继续或完成该任务'), { status: 409 }));
  const ids = new Set(request.body.ids || state.products.filter((item) => item.selected).map((item) => item.id));
  const candidates = state.products.filter((item) => ids.has(item.id) && !item.removedFromWorkbenchAt);
  const products = request.body.failedOnly ? failedPublishProducts(candidates) : candidates;
  if (!products.length) return next(Object.assign(new Error('请至少选择一件商品'), { status: 400 }));
  if (products.some((product) => processingProducts.has(product.id) || refreshingProducts.has(product.id))) return next(Object.assign(new Error('商品正在加工或重新采集，请完成后再上架'), { status: 409 }));
  let sellerGroup;
  const folderId = request.body.collectionFolderId || products[0].collectionFolderId;
  try {
    requireCollectionFolder(state, folderId);
    sellerGroup = normalizeSellerGroup(request.body.sellerGroup);
    if (products.some((product) => product.collectionFolderId !== folderId)) throw Object.assign(new Error('请在同一个采集分组内选择上架商品'), { status: 400 });
  } catch (error) { return next(error); }
  const mode = request.body.mode === 'submit' ? 'submit' : 'draft';
  let publishDelay;
  try { publishDelay = publishDelayFromRequest(request.body, { minSeconds: state.settings.publishDelayMinSeconds, maxSeconds: state.settings.publishDelayMaxSeconds }); }
  catch (error) { return next(error); }
  const plan = createPublishPlan(products, state.settings);
  const job = store.createJob('publish', {
    productIds: products.map((item) => item.id), mode, failedOnly: Boolean(request.body.failedOnly),
    listingMode: normalizeListingMode(request.body.listingMode || state.settings.listingMode || 'auto'),
    publishDelay,
    stockPolicy: state.settings.stockPolicy || 'minimum-order',
    defaultStock: state.settings.defaultStock,
    collectionFolderId: folderId, sellerGroup,
    sourcePlatforms: [...new Set(products.map(sourcePlatform))],
    categoryGroups: plan.map((group) => ({ sourcePlatform: group.sourcePlatform, categoryId: group.categoryId, category: group.category, productIds: group.products.map((item) => item.id) }))
  });
  store.patchJob(job.id, { total: products.length });
  store.update((state) => {
    state.settings.publishDelayMinSeconds = publishDelay.minSeconds;
    state.settings.publishDelayMaxSeconds = publishDelay.maxSeconds;
  });
  response.status(202).json({ ...job, total: products.length });
  setImmediate(() => backgroundTasks.run(job.id, () => runPublishJob(job.id)));
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
  const updated = store.patchJob(job.id, { status, message, pauseAfterCurrent: false });
  if (status === 'pause_requested' && job.type === 'publish') publisher.requestPublishStop(job.id);
  response.json(updated);
});

app.post('/api/jobs/:id/collect-discovered', (request, response, next) => {
  try {
    const job = store.read((state) => state.jobs.find((item) => item.id === request.params.id));
    if (!job || job.type !== 'collect' || !job.metadata?.groupId) throw Object.assign(new Error('没有找到店铺采集任务'), { status: 404 });
    if (job.status !== 'paused') throw Object.assign(new Error('请先暂停并等待当前页读取结束'), { status: 409 });
    const disk = new CollectionCheckpoint(dataDir, job.id);
    const checkpoint = disk.read();
    if (checkpoint?.stage !== 'listing' || !checkpoint.products.length) throw Object.assign(new Error('当前没有可转为详情采集的已发现商品'), { status: 409 });
    // Persist the stage before queueing. A restart must never resume pagination
    // after the user explicitly chose to collect only the discovered products.
    disk.write({ ...checkpoint, stage: 'detail', discoveredOnly: true });
    const updated = store.patchJob(job.id, { status: 'queued', collectionStage: 'detail',
      discovered: checkpoint.products.length, total: checkpoint.products.length, progress: checkpoint.completedIds.length,
      message: `停止继续翻页，开始采集已发现的 ${checkpoint.products.length} 件商品` });
    response.json(updated);
    setImmediate(() => queueCollection(job.id));
  } catch (error) { next(error); }
});

app.post('/api/jobs/:id/resume', (request, response, next) => {
  const state = store.read();
  const job = state.jobs.find((item) => item.id === request.params.id && ['publish', 'collect'].includes(item.type));
  if (!job) return next(Object.assign(new Error('没有找到该上架任务'), { status: 404 }));
  if (job.status !== 'paused') {
    return next(Object.assign(new Error('当前任务不能继续'), { status: 409 }));
  }
  if (job.type === 'publish' && readingSellerGroups) return next(Object.assign(new Error('正在读取国际站分组，请稍后继续任务'), { status: 409 }));
  if (job.type === 'publish' && (job.metadata?.productIds || []).slice(Number(job.progress || 0)).some(id => processingProducts.has(id) || refreshingProducts.has(id))) {
    return next(Object.assign(new Error('待上架商品正在加工或重新采集，请完成后再继续任务'), { status: 409 }));
  }
  const metadata = { ...job.metadata };
  if (job.type === 'publish' && Object.hasOwn(request.body || {}, 'listingMode')) {
    if (!['auto', 'inquiry', 'complete-logistics'].includes(request.body.listingMode)) return next(Object.assign(new Error('不支持的销售方式'), { status: 400 }));
    // Apply a deliberate policy change only to unfinished products. Completed
    // receipts and the current cursor remain intact; never replay successes.
    metadata.listingMode = request.body.listingMode;
  }
  if (job.type === 'publish' && (Object.hasOwn(request.body || {}, 'publishDelayMinSeconds') || Object.hasOwn(request.body || {}, 'publishDelayMaxSeconds'))) {
    try { metadata.publishDelay = publishDelayFromRequest(request.body, metadata.publishDelay); }
    catch (error) { return next(error); }
  }
  const updated = store.patchJob(job.id, { status: 'queued', message: job.type === 'collect' && job.collectionStage === 'listing'
    ? `等待从断点继续，已发现 ${job.discovered || 0} 件` : `等待继续，已处理 ${job.progress}/${job.total} 件`, metadata });
  if (job.type === 'publish' && metadata.publishDelay) store.update((state) => {
    state.settings.publishDelayMinSeconds = metadata.publishDelay.minSeconds;
    state.settings.publishDelayMaxSeconds = metadata.publishDelay.maxSeconds;
  });
  response.json(updated);
  setImmediate(() => job.type === 'collect' ? queueCollection(job.id) : backgroundTasks.run(job.id, () => runPublishJob(job.id)));
});

app.get('/api/jobs/:id/publish-page', (request, response, next) => {
  const job = store.read((state) => state.jobs.find((item) => item.id === request.params.id && item.type === 'publish'));
  if (!job) return next(Object.assign(new Error('没有找到该上架任务'), { status: 404 }));
  if (job.status !== 'paused') return next(Object.assign(new Error('任务已继续，请关闭暂停画面'), { status: 409 }));
  const snapshot = publisher.readPublishPageSnapshot(job.id, job.currentProductId);
  if (!snapshot) return next(Object.assign(new Error('本次暂停画面不可用，可能在暂停后重启过软件。任务进度已保留。'), { status: 410 }));
  response.set('Cache-Control', 'no-store').json(snapshot);
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
    new CollectionCheckpoint(dataDir, job.id).clear();
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

function assertProductsEditable(state, ids) {
  if (findWorkspaceJobs(state, { productIds: ids }, ['queued', 'running', 'pause_requested']).length) {
    throw Object.assign(new Error('商品正在处理，请暂停或完成任务后再修改'), { status: 409 });
  }
}

app.post('/api/products/find-replace', (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) && request.body.ids.length
      ? new Set(request.body.ids) : null;
    const search = String(request.body?.search ?? '');
    if (!search) return next(Object.assign(new Error('请输入要查找的内容'), { status: 400 }));
    const replacement = String(request.body?.replacement ?? '');
    const caseSensitive = Boolean(request.body?.caseSensitive);
    const dryRun = Boolean(request.body?.dryRun);
    const operation = (state) => {
      if (!dryRun) assertProductsEditable(state, state.products.filter((product) => !ids || ids.has(product.id)).map((product) => product.id));
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
    };
    const result = dryRun ? store.read(operation) : store.update(operation);
    response.json(result);
  } catch (error) { next(error); }
});

function publishPlanResponse(request, response, next) {
  try {
    // Routing is read-only; do not copy descriptions/history for a category preview.
    const state = store.snapshot();
    const provided = request.method === 'POST' ? request.body.ids : request.query.ids;
    const ids = new Set(Array.isArray(provided) ? provided : String(provided || '').split(',').filter(Boolean));
    const products = provided != null ? state.products.filter((item) => ids.has(item.id)) : state.products.filter((item) => item.selected);
    const groups = createPublishPlan(products, state.settings).map((group) => ({ ...group,
      products: group.products.map((product) => ({ id: product.id, sourcePlatform: sourcePlatform(product) })),
    }));
    response.json({ groups, total: products.length, bindings: publishBindings(state.settings) });
  } catch (error) { next(error); }
}
app.get('/api/publish/plan', publishPlanResponse);
app.post('/api/publish/plan', publishPlanResponse);

app.get('/api/references', (_request, response) => {
  response.json({ references: store.read(state => referenceCandidates(state)) });
});
app.post('/api/products/reference/preview', async (request, response, next) => {
  try { response.json(await previewProductReferenceAsync(store.snapshot(), request.body)); }
  catch (error) { next(error); }
});
app.post('/api/products/reference', async (request, response, next) => {
  try {
    response.json(await store.updateProductsAsync(Array.isArray(request.body.ids) ? request.body.ids : [], (products, snapshot) => {
      const selected = new Map(products.map(product => [product.id, product]));
      return applyReferencePreviewAsync({ ...snapshot, products: snapshot.products.map(product => selected.get(product.id) || product) }, request.body);
    }));
  }
  catch (error) { next(error); }
});
app.post('/api/references/capture-current', async (_request, response, next) => {
  if (readingSellerGroups || store.read().jobs.some((job) => job.type === 'publish' && ['queued', 'running', 'pause_requested'].includes(job.status))) {
    return next(Object.assign(new Error('卖家窗口正在处理任务，请暂停后再读取模板'), { status: 409 }));
  }
  readingSellerGroups = true;
  try {
    const template = await publisher.captureCurrentReference();
    store.update((state) => {
      state.referenceTemplates = [template, ...(state.referenceTemplates || []).filter((item) => item.id !== template.id)].slice(0, 300);
    });
    response.json({ reference: template });
  } catch (error) { next(error); }
  finally { readingSellerGroups = false; }
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

app.get('/api/announcements', async (request, response) => {
  inbox.account = process.env.KUA_YIPU_ACCOUNT || 'local';
  response.set('Cache-Control', 'no-store').json(await inbox.list({ refresh: request.query.refresh === '1' }));
});
app.post('/api/announcements/read', (request, response) => {
  inbox.account = process.env.KUA_YIPU_ACCOUNT || 'local';
  response.json(inbox.markRead(request.body?.id, request.body?.revision));
});

app.post('/api/storage/cleanup', (request, response, next) => {
  try { response.json(cleanupWorkspace(store, dataDir, request.body)); }
  catch (error) { next(error); }
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

app.post('/api/media/video', express.raw({ type: 'video/mp4', limit: '100mb' }), (request, response, next) => {
  try {
    const buffer = request.body;
    if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') {
      return response.status(400).json({ error: '请选择有效的 MP4 视频' });
    }
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.mp4`;
    fs.writeFileSync(path.join(mediaDir, fileName), buffer, { mode: 0o600 });
    response.status(201).json({ url: `/media/${fileName}` });
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

app.use((error, request, response, _next) => {
  const diagnostic = { code: diagnosticCode(error), ...diagnosticRequestContext(request) };
  runtimeDiagnostic('api-error', diagnostic);
  console.error('Local API request failed', diagnostic);
  const safeMessage = diagnostic.code === 'ERR_STRING_TOO_LONG'
    ? '本地数据处理失败：单次处理的数据超过字符串长度限制。已保存数据和任务进度保留；请上传日志，并先核对当前商品的发布结果，不要重复提交上架。'
    : userFacingError(error);
  response.status(error.status || 500).json({ error: safeMessage, code: diagnostic.code });
});

const port = Number(process.env.PORT || 8787);
let listener = null;
export function diagnosticSummary() { return store.read(state => diagnosticSummaryFromState(state)); }
export const serverReady = new Promise((resolve, reject) => {
  listener = app.listen(port, '127.0.0.1', (error) => {
    // Express 5 invokes the callback with bind errors as well as on success.
    // A failed listener has no address and must never resolve readiness.
    if (error) { reject(error); return; }
    console.log(`Alibaba.com workbench API: http://127.0.0.1:${port}`);
    resolve(listener);
  });
  listener.once('error', reject);
});

export async function shutdownServer() {
  clearInterval(diagnosticRetentionTimer);
  await Promise.allSettled([collector.resetContext(), publisher.shutdown()]);
  const active = listener;
  listener = null;
  if (!active?.listening) return;
  await new Promise((resolve) => active.close(() => resolve()));
}

export function prepareForUpdate() { return updateGuard.acquire(); }
export function cancelUpdatePreparation() { updateGuard.release(); }

export async function suspendAuthorizedWork({ graceful = false } = {}) {
  const jobs = store.read().jobs.filter((job) => ['queued', 'running', 'pause_requested'].includes(job.status));
  for (const job of jobs) {
    store.patchJob(job.id, { status: graceful && job.status !== 'queued' ? 'pause_requested' : 'paused', pauseAfterCurrent: graceful && (job.status === 'running' || Boolean(job.pauseAfterCurrent)), message: graceful ? '授权连接中断，当前商品处理结束后暂停，已完成数据保留' : '授权校验中断，任务已暂停，请联网后重新登录' });
    if (!graceful && job.type === 'publish') publisher.requestPublishStop(job.id);
  }
  if (!graceful) await collector.resetContext();
}
