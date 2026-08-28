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
import { createPublishSnapshot, recordProductMutation, syncProductModel } from './product-model.js';
import { ADMIN_COOKIE, SESSION_COOKIE, LicenseManager, clearCookie, setCookie } from './auth.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Desktop builds keep mutable data in the OS user-data directory. The local
// development default remains .data so existing workflows are unchanged.
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, '.data');
fs.mkdirSync(dataDir, { recursive: true });

const store = new JsonStore(path.join(dataDir, 'workspace.json'));
const publisher = new SellerPublisher(dataDir);
const collector = new ShopCollector(dataDir, (products, onProgress) => publisher.enrichSourceProducts(products, onProgress));
const licenseManager = new LicenseManager(dataDir);
store.update((state) => {
  state.version = 3;
  if (state.settings.publishPageUrl && /^https?:\/\/(?:[^/]+\.)?1688\.com(?:\/|$)/i.test(state.settings.publishPageUrl)) {
    state.settings.publishPageUrl = '';
  }
  const invalidCategoryBinding = /\/product\/(?:easyListing|category)\.htm/i.test(state.settings.publishPageUrl || '');
  if (invalidCategoryBinding) state.settings.publishPageUrl = '';
  if (invalidCategoryBinding) state.settings.publishCategory = '';
  for (const product of state.products) {
    if (product.source?.snapshot) continue;
    if (!/Alibaba Manufacturer Directory|Suppliers, Manufacturers, Exporters/i.test(product.title || '')) continue;
    const slug = product.sourceUrl?.match(/\/product-detail\/([^/?#]+?)_\d{8,}\.html/i)?.[1];
    if (!slug) continue;
    product.title = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    product.sourceTitle = product.title;
    product.updatedAt = new Date().toISOString();
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
app.use(express.json({ limit: '2mb' }));
const activePublishJobs = new Set();

function publicState(request) {
  const state = store.read();
  const session = licenseManager.session(request);
  return {
    ...state,
    auth: session ? { authenticated: true, account: session.account, license: session.license } : { authenticated: false },
    browser: publisher.status(),
    collectorBrowser: collector.status()
  };
}

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'cross-easyshop', time: new Date().toISOString() }));
app.get('/api/auth/config', (_request, response) => response.json({ requiresAlibabaLogin: true, passwordRequired: true, remoteLicenseServer: Boolean(process.env.LICENSE_SERVER_URL) }));
app.get('/api/auth/me', (request, response) => {
  const session = licenseManager.session(request);
  if (!session) return response.status(401).json({ authenticated: false, error: '请先登录阿里巴巴国际站并确认授权' });
  response.json({ authenticated: true, account: session.account, license: session.license });
});
app.post('/api/auth/preflight', (request, response) => {
  const record = licenseManager.find(request.body?.account);
  response.json({ authorized: licenseManager.isActive(record), license: licenseManager.publicLicense(record) });
});
app.post('/api/auth/establish-session', (request, response) => {
  const result = licenseManager.establish({ account: request.body?.account, deviceId: request.body?.deviceId, bridgeToken: request.body?.bridgeToken });
  if (!result.ok) return response.status(403).json({ error: result.error });
  setCookie(response, SESSION_COOKIE, result.sessionId);
  response.json({ authenticated: true, account: request.body.account, license: result.license });
});
app.post('/api/auth/logout', (_request, response) => { clearCookie(response, SESSION_COOKIE); response.json({ ok: true }); });

function requireAdmin(request, response, next) {
  if (!licenseManager.adminSession(request)) return response.status(401).json({ error: '管理员未登录' });
  next();
}

function termExpiresAt(term, startsAt = new Date()) {
  const date = new Date(startsAt);
  const value = String(term || '1d').toLowerCase();
  if (value === '1m' || value === 'month') date.setMonth(date.getMonth() + 1);
  else if (value === 'quarter' || value === '3m') date.setMonth(date.getMonth() + 3);
  else if (value === 'half-year' || value === '6m') date.setMonth(date.getMonth() + 6);
  else if (value === 'year' || value === '1y') date.setFullYear(date.getFullYear() + 1);
  else if (/^\d+$/.test(value)) date.setDate(date.getDate() + Number(value));
  else date.setDate(date.getDate() + 1);
  return date.toISOString();
}

app.post('/api/admin/login', (request, response) => {
  const sessionId = licenseManager.adminLogin(request.body?.user, request.body?.password);
  if (!sessionId) return response.status(401).json({ error: '管理员账号或密码错误' });
  setCookie(response, ADMIN_COOKIE, sessionId);
  response.json({ authenticated: true, user: request.body.user });
});
app.post('/api/admin/logout', (_request, response) => { clearCookie(response, ADMIN_COOKIE); response.json({ ok: true }); });
app.get('/api/admin/me', requireAdmin, (request, response) => response.json({ authenticated: true, user: licenseManager.adminSession(request).user }));
app.get('/api/admin/licenses', requireAdmin, (_request, response) => response.json({ licenses: licenseManager.list() }));
app.get('/api/admin/history', requireAdmin, (_request, response) => response.json({ history: licenseManager.history() }));
app.get('/api/admin/stats', requireAdmin, (_request, response) => response.json(licenseManager.stats()));
app.post('/api/admin/licenses', requireAdmin, (request, response, next) => {
  try {
    const startsAt = request.body?.startsAt ? new Date(request.body.startsAt).toISOString() : new Date().toISOString();
    const expiresAt = request.body?.expiresAt || termExpiresAt(request.body?.term || '1d', startsAt);
    response.json({ license: licenseManager.upsert({ ...request.body, startsAt, expiresAt, action: 'admin_create' }, licenseManager.adminSession(request).user) });
  } catch (error) { next(error); }
});
app.patch('/api/admin/licenses/:account', requireAdmin, (request, response, next) => {
  try {
    const patch = { ...request.body };
    if (patch.term) patch.expiresAt = termExpiresAt(patch.term, patch.startsAt || new Date());
    delete patch.term;
    response.json({ license: licenseManager.update(request.params.account, patch, licenseManager.adminSession(request).user) });
  } catch (error) { next(error); }
});
app.delete('/api/admin/licenses/:account', requireAdmin, (request, response, next) => {
  try { response.json({ license: licenseManager.update(request.params.account, { status: 'revoked', action: 'admin_revoke' }, licenseManager.adminSession(request).user) }); } catch (error) { next(error); }
});

app.get('/api/state', (request, response) => response.json(publicState(request)));

// Every business endpoint is license-gated. Auth, admin, health and state are
// intentionally excluded so the desktop shell can render the login screen.
app.use('/api', (request, response, next) => {
  if (request.path.startsWith('/auth') || request.path.startsWith('/admin') || request.path === '/health' || request.path === '/state') return next();
  if (!licenseManager.session(request)) return response.status(401).json({ error: '登录已失效或授权已过期，请重新登录' });
  next();
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
  store.patchJob(jobId, { status: 'running', message: `开始读取“${group.name}”，已保存的商品会保留` });
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
    store.update((draft) => {
      const target = draft.groups.find((item) => item.id === group.id);
      if (target) Object.assign(target, { status: 'done', collectedCount: count, lastCollectedAt: new Date().toISOString(), activeJobId: '' });
      const completeJob = draft.jobs.find((item) => item.id === jobId);
      if (completeJob) Object.assign(completeJob, { status: 'completed', progress: products.length, total: products.length, message: `读取完成，共保存 ${count} 件`, updatedAt: new Date().toISOString() });
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
        if (pausedJob) Object.assign(pausedJob, { status: 'paused', progress: count, message: `已暂停，已保存 ${count} 件商品，可继续采集`, updatedAt: new Date().toISOString() });
      });
      return;
    }
    store.patchJob(jobId, { status: 'failed', message: error.message });
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
        if (patch.imageOperation === 'dedupe' || patch.imageOperation === 'copy-detail' || patch.imageOperation === 'clean') {
          next.mainImages = [...new Set(product.mainImages || product.images || [])].filter(Boolean);
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
    response.json({ updated: updated.length });
  } catch (error) { next(error); }
});

app.post('/api/products/:id/refresh-detail', async (request, response, next) => {
  try {
    const state = store.read();
    const product = state.products.find((item) => item.id === request.params.id);
    if (!product) return next(Object.assign(new Error('没有找到该商品'), { status: 404 }));
    const [enriched] = await publisher.enrichSourceProducts([product]);
    const updated = store.update((draft) => {
      const target = draft.products.find((item) => item.id === product.id);
      Object.assign(target, enriched, { status: 'ready', updatedAt: new Date().toISOString() });
      delete target.publishResult;
      syncProductModel(target, { captureSource: true, sourceSnapshot: enriched });
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
  const allowed = ['publishPageUrl', 'publishCategory', 'defaultStock', 'priceMarkup', 'publishMode'];
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
      state.settings.publishPageUrl = bound.url;
      state.settings.publishCategory = bound.category;
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
        const publishSnapshot = createPublishSnapshot(product, { mode, category: settings.publishCategory });
        const result = await publisher.publishProduct(product, settings.publishPageUrl, mode, settings.publishCategory);
        if (result.status !== 'needs_review') await publisher.hide();
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
        });
        store.patchJob(jobId, { progress: index + 1, total, message: `已处理 ${index + 1}/${total}：${product.title}` });
      } catch (error) {
        const message = String(error.message || '');
        const requiresHuman = /captcha|verify|人机验证|安全验证|滑块|登录失效|人工验证/i.test(message);
        if (!requiresHuman) await publisher.hide().catch(() => {});
        store.update((draft) => {
          const target = draft.products.find((item) => item.id === product.id);
          if (target) {
            const result = { status: 'failed', message };
            Object.assign(target, { status: 'publish_failed', publishResult: result, updatedAt: new Date().toISOString() });
            target.publishHistory = Array.isArray(target.publishHistory) ? target.publishHistory : [];
            target.publishHistory.unshift({ ...createPublishSnapshot(target, { mode, category: store.read().settings.publishCategory }), result });
            syncProductModel(target);
          }
        });
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
    store.patchJob(jobId, { status: 'failed', message: error.message });
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
  const job = store.createJob('publish', { productIds: products.map((item) => item.id), mode });
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
  const message = status === 'paused' ? `已暂停，已处理 ${job.progress}/${job.total || 0} 件，已完成数据已保存` : '正在暂停，当前商品处理完成后停止，已完成数据会保存';
  response.json(store.patchJob(job.id, { status, message }));
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

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || '服务器错误' });
});

if (fs.existsSync(path.join(rootDir, 'dist'))) {
  app.use(express.static(path.join(rootDir, 'dist')));
      app.get(['/admin', '/admin/'], (_request, response) => response.sendFile(path.join(rootDir, 'dist', 'admin', 'index.html')));
  app.get('/{*splat}', (_request, response) => response.sendFile(path.join(rootDir, 'dist', 'index.html')));
}

const port = Number(process.env.PORT || 8787);
app.listen(port, '127.0.0.1', () => console.log(`Alibaba.com workbench API: http://127.0.0.1:${port}`));
