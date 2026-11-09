import crypto from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { applyPublishedProductReference, recordProductMutation, syncProductModel } from './product-model.js';
import { createPublishedReferenceTemplate, createRequiredFieldRepair, requiredAttributeKey } from './publish-reference.js';
import { productCategory } from './category-routing.js';
import { attachCategoryRequirements } from './category-readiness.js';
import { findWorkspaceJobs } from './store.js';
import { productEditPatch } from './product-edit.js';
import { sourcePlatform, sourcePlatformLabel } from './source-platform.js';

const success = (status) => ['published', 'submitted', 'success'].includes(String(status || '').toLowerCase());
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const templateFields = ['id', 'title', 'categoryId', 'categoryPath', 'attributes', 'customAttributes', 'requiredAttributes',
  'origin', 'province', 'brand', 'brandName', 'compatibleBrand', 'compatibleBrands', 'privateMold', 'model',
  'compatibleModel', 'compatibleModels', 'productType', 'type', 'color', 'material', 'variantGroups', 'skus',
  'modelImages', 'colorImages', 'specifications', 'platformAttributes', 'internationalAttributes', 'targetAttributes',
  'packaging', 'deliveryTime', 'salesUnit', 'freightTemplate', 'logisticsAttributes'];
const specFields = ['variantGroups', 'skus', 'modelImages', 'colorImages', 'specifications'];
const shippingFields = ['packaging', 'deliveryTime', 'salesUnit', 'freightTemplate', 'logisticsAttributes', 'services', 'certificates'];
const categoryFields = ['categoryId', 'categoryPath', 'targetCategory', 'targetCategoryId', 'targetCategoryPath',
  'internationalCategory', 'internationalCategoryPath', 'publishCategory', 'publishCategoryId', 'categoryAttributes'];

export function publishedReference(product) {
  return product.status === 'published' || success(product.publishResult?.status)
    || (product.publishHistory || []).some((entry) => success(entry.result?.status || entry.status));
}

export function referenceTemplate(product) {
  const snapshot = product.publishHistory?.find((entry) => success(entry.result?.status || entry.status) && entry.data);
  const source = createPublishedReferenceTemplate(product, snapshot);
  source.categoryId ||= source.targetCategoryId || source.sourceCategoryId;
  if (!source.categoryPath?.length) source.categoryPath = source.targetCategoryPath || source.sourceCategoryPath || [];
  return structuredClone(Object.fromEntries(templateFields.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]])));
}

export function referenceCandidates(state) {
  return [...state.products.filter(publishedReference), ...(state.referenceTemplates || [])].map((product) => {
    const template = product.referenceTemplate || referenceTemplate(product);
    return { id: product.id, title: product.title, categoryId: template.categoryId, categoryPath: template.categoryPath,
      source: product.referenceTemplate ? 'seller' : 'local',
      sourcePlatform: product.referenceTemplate ? 'alibaba.com' : sourcePlatform(product),
      sourcePlatformLabel: product.referenceTemplate ? '国际站卖家商品' : sourcePlatformLabel(product), template };
  });
}

export function buildReferencePatch(target, template, options = {}) {
  const scope = options.scope || 'full';
  if (!['full', 'attributes', 'specifications', 'failed-fields'].includes(scope)) fail('不支持的引用范围');
  const beforeCategory = productCategory(target), afterCategory = productCategory(template);
  if (!afterCategory.id) fail('引用商品没有可用的类目 ID，请重新读取');
  if (scope !== 'full' && beforeCategory.id !== afterCategory.id) fail('单独引用属性或规格需要相同类目；如需更换类目，请选择完整引用');
  let patch;
  if (scope === 'failed-fields') {
    const fields = target.publishResult?.requiredFields || target.referenceRecovery?.failure?.requiredFields || [];
    patch = createRequiredFieldRepair(target, template, fields)?.patch || {};
  } else {
    patch = applyPublishedProductReference(target, template, { fullTemplate: true });
    if (scope !== 'full') {
      for (const field of categoryFields) delete patch[field];
      delete patch.categoryReference;
      for (const field of Object.keys(patch)) {
        if ((scope === 'specifications') !== specFields.includes(field)) delete patch[field];
      }
    }
    if (!options.includeLogistics) for (const field of shippingFields) delete patch[field];
    if (options.preserveSkuStock !== false && patch.skus) {
      const key = (sku) => JSON.stringify(Object.entries(sku.attributes || {}).map(([name, value]) => [requiredAttributeKey(name), value]).sort());
      const existing = new Map((target.skus || []).map((sku) => [key(sku), sku]));
      patch.skus = patch.skus.map((sku) => {
        const original = existing.get(key(sku));
        const next = { ...sku };
        for (const field of ['stock', 'code', 'enabled']) {
          if (original && Object.hasOwn(original, field)) next[field] = original[field];
          else if (field === 'stock') next.stock = target.stock ?? null;
          else if (field === 'code') next.code = '';
          else next.enabled = true;
        }
        return next;
      });
    }
  }
  // Keep a frozen template for subsequent targeted repairs even if the source
  // reference is edited or removed. This is working data, not source evidence.
  if (Object.keys(patch).length) patch.categoryReference = { referenceId: template.id, categoryId: afterCategory.id,
    categoryPath: afterCategory.path, scope, template: structuredClone(template), templateHash: hash(template) };
  return patch;
}

function* prepareReferenceReview(state, request) {
  const ids = [...new Set(Array.isArray(request.ids) ? request.ids : [])];
  if (!ids.length) fail('请选择需要引用的商品');
  const candidate = state.products.find(item => item.id === request.referenceId && publishedReference(item))
    || (state.referenceTemplates || []).find(item => item.id === request.referenceId);
  const reference = candidate && { id: candidate.id, title: candidate.title,
    template: candidate.referenceTemplate || referenceTemplate(candidate) };
  if (!reference) fail('请选择已成功上架或从卖家后台读取的商品');
  const byId = new Map(state.products.map(product => [product.id, product]));
  const storedProducts = ids.map(id => byId.get(id));
  if (storedProducts.some((item) => !item)) fail('部分商品已不存在，请刷新列表', 409);
  if (request.editorDraft && ids.length !== 1) fail('编辑预览只能包含一件商品');
  const products = request.editorDraft ? storedProducts.map(product => ({ ...product, ...productEditPatch(request.editorDraft) })) : storedProducts;
  if (findWorkspaceJobs(state, { productIds: ids }, ['queued', 'running', 'pause_requested']).length) fail('所选商品正在处理，请暂停任务后再引用资料', 409);
  const options = request.options || {};
  // Never stringify the whole selection: descriptions, captures and history
  // can exceed V8's single-string limit even when the machine has free RAM.
  // Bind every selected product, including off-page changes, in bounded units.
  const storedHashes = [];
  for (const product of storedProducts) { storedHashes.push(hash(product)); yield; }
  const productHashes = products === storedProducts ? storedHashes : [];
  if (products !== storedProducts) for (const product of products) { productHashes.push(hash(product)); yield; }
  const token = hash({ schema: 2, ids, options, reference: hash(reference.template), storedProducts: storedHashes,
    products: productHashes });
  return { ids, products, reference, options, token };
}

function referenceReviewItem(product, reference, options) {
  const blocked = product.id === reference.id || product.status === 'published';
  const patch = blocked ? {} : buildReferencePatch(product, reference.template, options);
  const changes = Object.entries(patch).filter(([field, value]) => field !== 'categoryReference' && JSON.stringify(product[field]) !== JSON.stringify(value))
    .map(([field, value]) => ({ field, before: product[field] ?? null, after: value }));
  return { id: product.id, title: product.title, categoryChanged: Boolean(patch.categoryId && patch.categoryId !== productCategory(product).id),
    failure: product.publishResult || product.referenceRecovery?.failure || null, changes,
    skipped: blocked ? '商品已发布或就是引用商品' : !changes.length ? '没有需要修改的字段' : '', patch };
}

function* previewReferenceSteps(state, request) {
  const { products, reference, options, token } = yield* prepareReferenceReview(state, request);
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(request.pageSize) || 30)));
  const page = Math.min(Math.ceil(products.length / pageSize), Math.max(1, Math.floor(Number(request.page) || 1)));
  const start = (page - 1) * pageSize;
  const items = [];
  let totalChanged = 0;
  for (let index = 0; index < products.length; index++) {
    const item = referenceReviewItem(products[index], reference, options);
    if (!item.skipped) totalChanged++;
    if (index >= start && index < start + pageSize) items.push(item);
    yield;
  }
  return { referenceId: reference.id, referenceTitle: reference.title, token, items,
    page, pageSize, total: products.length, totalChanged };
}

function* applyReferenceSteps(state, request) {
  const { products, reference, options, token } = yield* prepareReferenceReview(state, request);
  if (!request.previewToken || request.previewToken !== token) fail('商品或引用内容已变化，请重新预览后保存', 409);
  const changed = [];
  const byId = new Map(state.products.map(product => [product.id, product]));
  for (const reviewed of products) {
    const item = referenceReviewItem(reviewed, reference, options);
    if (item.skipped) continue;
    const product = byId.get(item.id);
    const recovery = { referenceId: reference.id, appliedAt: new Date().toISOString(),
      failure: structuredClone(product.publishResult || product.referenceRecovery?.failure || null),
      fields: item.changes.map((change) => change.field), state: 'ready' };
    if (!product.source?.snapshot) syncProductModel(product); // Preserve legacy data before the first reference edit.
    recordProductMutation(product, { ...productEditPatch(request.editorDraft), ...item.patch, referenceRecovery: recovery, status: 'ready', selected: true },
      { actor: 'user', action: 'reference-published-product', changedFieldsOnly: true });
    delete product.publishResult;
    attachCategoryRequirements(product, state.postingSchemas);
    syncProductModel(product);
    changed.push({ id: product.id, title: product.title, fields: recovery.fields, categoryId: product.categoryId });
    yield;
  }
  return { referenceId: reference.id, referenceTitle: reference.title, changed };
}

function completeReferenceSteps(steps) {
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

async function completeReferenceStepsAsync(steps) {
  let resumedAt = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - resumedAt >= 8) {
      await yieldToRequests();
      resumedAt = performance.now();
    }
  }
}

export const previewProductReference = (state, request) => completeReferenceSteps(previewReferenceSteps(state, request));
export const applyReferencePreview = (state, request) => completeReferenceSteps(applyReferenceSteps(state, request));
// HTTP callers yield between products. Applying must use detached products in
// an optimistic store transaction, never mutate a live shared snapshot.
export const previewProductReferenceAsync = (state, request) => completeReferenceStepsAsync(previewReferenceSteps(state, request));
export const applyReferencePreviewAsync = (state, request) => completeReferenceStepsAsync(applyReferenceSteps(state, request));

export function failedPublishProducts(products) {
  return products.filter((product) => product.status === 'publish_failed'
    || (product.status === 'ready' && product.referenceRecovery?.state === 'ready' && product.referenceRecovery?.failure));
}
