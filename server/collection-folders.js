import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const unfinished = (job) => ['queued', 'running', 'pause_requested', 'paused'].includes(job.status);

export function initializeCollectionFolders(state) {
  state.collectionFolders ||= [];
  state.settings ||= {};
  const ungrouped = state.products.filter((product) => !product.removedFromWorkbenchAt && !state.collectionFolders.some((folder) => folder.id === product.collectionFolderId));
  const jobs = (state.jobs || []).filter((job) => job.type === 'collect' && unfinished(job) && !job.metadata?.options?.collectionFolderId);
  if (ungrouped.length || jobs.length) {
    const folder = { id: randomUUID(), name: '历史商品', createdAt: new Date().toISOString() };
    state.collectionFolders.push(folder);
    for (const product of ungrouped) product.collectionFolderId = folder.id;
    for (const job of jobs) {
      job.metadata ||= {}; job.metadata.options ||= {};
      job.metadata.options.collectionFolderId = folder.id;
      job.metadata.collectionFolderId = folder.id;
    }
  }
  if (!state.collectionFolders.some((folder) => folder.id === state.settings.activeCollectionFolderId)) {
    state.settings.activeCollectionFolderId = state.collectionFolders[0]?.id || '';
  }
}

export function requireCollectionFolder(state, id) {
  const folder = (state.collectionFolders || []).find((item) => item.id === id);
  if (!folder) throw fail('请先新建并选择采集分组');
  return folder;
}

export function saveCollectionFolder(state, name, id = '') {
  const cleaned = String(name || '').trim();
  if (!cleaned || cleaned.length > 80) throw fail('分组名称须为 1 至 80 个字符');
  if ((state.collectionFolders || []).some((item) => item.id !== id && item.name.toLowerCase() === cleaned.toLowerCase())) throw fail('已有同名分组');
  const folder = id ? requireCollectionFolder(state, id) : { id: randomUUID(), createdAt: new Date().toISOString() };
  folder.name = cleaned;
  if (!id) { state.collectionFolders.push(folder); state.settings.activeCollectionFolderId = folder.id; }
  return folder;
}

export function collectionFolderDeletionPreview(state, id) {
  const folder = requireCollectionFolder(state, id);
  const products = state.products.filter((item) => item.collectionFolderId === id);
  const productIds = new Set(products.map((item) => item.id));
  const jobs = (state.jobs || []).filter((job) => unfinished(job) && (job.metadata?.collectionFolderId === id
    || job.metadata?.options?.collectionFolderId === id
    || job.type === 'publish' && job.metadata?.productIds?.some((productId) => productIds.has(productId))));
  return {
    id: folder.id, name: folder.name,
    productCount: products.filter((item) => !item.removedFromWorkbenchAt).length,
    archivedProductCount: products.filter((item) => item.removedFromWorkbenchAt).length,
    jobs: jobs.map((job) => ({ id: job.id, type: job.type, status: job.status,
      platform: job.metadata?.sourcePlatform || (state.groups || []).find((group) => group.id === job.metadata?.groupId)?.sourcePlatform || 'alibaba.com',
      name: job.metadata?.groupName || (job.type === 'publish' ? '商品上架' : '商品采集'),
      progress: job.progress || 0, total: job.total || 0 })),
  };
}

export function deleteCollectionFolder(state, id, { cancelPausedJobIds = [] } = {}) {
  const preview = collectionFolderDeletionPreview(state, id);
  if (preview.productCount) throw fail('分组内仍有商品，请先移动或删除商品', 409);
  if (preview.jobs.some((job) => job.status !== 'paused')) throw fail('分组仍有执行中或等待中的任务，请先暂停并等待当前处理结束', 409);
  const confirmed = new Set(Array.isArray(cancelPausedJobIds) ? cancelPausedJobIds : []);
  if (preview.jobs.some((job) => !confirmed.has(job.id))) throw fail('分组存在未完成任务，请核对并确认取消暂停任务后删除', 409);
  // Recheck every dependency before changing anything. Only jobs shown in the
  // confirmed preview may be cancelled; a newly queued/resumed job blocks deletion.
  const cancelledJobIds = preview.jobs.map((job) => job.id);
  const cancelled = new Set(cancelledJobIds);
  for (const job of state.jobs || []) {
    if (!cancelled.has(job.id)) continue;
    Object.assign(job, { status: 'cancelled', message: '采集分组已删除，暂停任务已取消；已完成数据和发布记录保留', updatedAt: new Date().toISOString() });
    const group = (state.groups || []).find((item) => item.activeJobId === job.id);
    if (group) { group.status = 'ready'; group.activeJobId = ''; }
  }
  state.collectionFolders = state.collectionFolders.filter((item) => item.id !== id);
  if (state.settings.activeCollectionFolderId === id) state.settings.activeCollectionFolderId = state.collectionFolders[0]?.id || '';
  return { ok: true, cancelledJobIds };
}

export function moveProductsToFolder(state, ids, folderId) {
  requireCollectionFolder(state, folderId);
  const selected = new Set(ids);
  if (state.jobs.some((job) => unfinished(job) && job.type === 'publish' && job.metadata?.productIds?.some((id) => selected.has(id)))) throw fail('商品存在未完成上架任务，请先完成或取消任务', 409);
  const products = state.products.filter((item) => selected.has(item.id));
  if (!products.length) throw fail('请选择需要移动的商品');
  if (state.jobs.some((job) => unfinished(job) && job.type === 'collect' && (job.metadata?.options?.collectionFolderId === folderId || products.some((product) => product.collectionFolderId === job.metadata?.options?.collectionFolderId)))) throw fail('来源或目标分组存在未完成采集任务，请先完成或取消任务', 409);
  const destinationProducts = state.products.filter((product) => selected.has(product.id) || product.collectionFolderId === folderId);
  const keys = destinationProducts.map((product) => `${product.sourcePlatform || 'alibaba.com'}:${product.sourceId || product.id}`);
  if (new Set(keys).size !== keys.length) throw fail('目标分组已有相同来源的商品，请先处理重复商品', 409);
  for (const product of products) { product.collectionFolderId = folderId; product.selected = false; }
  return { moved: products.length };
}

export function findCollectedProduct(state, raw, platform, folderId, platformOf) {
  requireCollectionFolder(state, folderId);
  return state.products.find((item) => item.collectionFolderId === folderId && platformOf(item) === platform && item.sourceId === raw.sourceId);
}
