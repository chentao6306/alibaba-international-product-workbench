import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeCollectionFolders, saveCollectionFolder, requireCollectionFolder, collectionFolderDeletionPreview, deleteCollectionFolder, moveProductsToFolder, findCollectedProduct } from '../server/collection-folders.js';
import { sourcePlatform } from '../server/source-platform.js';
import { ImageDownloadQueue } from '../server/image-download-queue.js';
import { normalizeSellerGroup } from '../server/seller-groups.js';

const state = () => ({ products: [], jobs: [], settings: {}, collectionFolders: [] });

test('normalizes optional seller group choices and rejects invalid identifiers', () => {
  assert.equal(normalizeSellerGroup(null), null);
  assert.deepEqual(normalizeSellerGroup({ id: 123, name: 'Group' }), { id: '123', name: 'Group', path: 'Group' });
  assert.throws(() => normalizeSellerGroup({ id: '123"] .unrelated', name: 'Group' }), /分组无效/);
});

test('migrates old products and paused collection jobs once without changing product data', () => {
  const data = state();
  data.products.push({ id: 'p', sourceId: '123', title: 'original', price: 19, selected: true });
  data.jobs.push({ type: 'collect', status: 'paused', metadata: { options: { startPage: 3 } } });
  initializeCollectionFolders(data);
  const snapshot = structuredClone(data);
  initializeCollectionFolders(data);
  assert.deepEqual(data, snapshot);
  assert.equal(data.products[0].collectionFolderId, data.collectionFolders[0].id);
  assert.equal(data.jobs[0].metadata.options.collectionFolderId, data.products[0].collectionFolderId);
  assert.equal(data.jobs[0].metadata.options.startPage, 3);
  assert.deepEqual({ ...data.products[0], collectionFolderId: undefined }, { id: 'p', sourceId: '123', title: 'original', price: 19, selected: true, collectionFolderId: undefined });
});

test('requires an explicit folder and deduplicates only within that folder and platform', () => {
  const data = state();
  initializeCollectionFolders(data);
  assert.equal(data.collectionFolders.length, 0);
  assert.throws(() => requireCollectionFolder(data, ''), /新建并选择/);
  const a = saveCollectionFolder(data, '  A  ');
  const b = saveCollectionFolder(data, 'B');
  assert.throws(() => saveCollectionFolder(data, 'a'), /同名/);
  data.products.push({ id: 'original', sourceId: '123', sourcePlatform: 'alibaba.com', collectionFolderId: a.id });
  assert.equal(findCollectedProduct(data, { sourceId: '123' }, 'alibaba.com', a.id, sourcePlatform).id, 'original');
  assert.equal(findCollectedProduct(data, { sourceId: '123' }, 'alibaba.com', b.id, sourcePlatform), undefined);
  assert.equal(findCollectedProduct(data, { sourceId: '123' }, '1688.com', a.id, sourcePlatform), undefined);
  saveCollectionFolder(data, 'renamed', a.id);
  assert.equal(data.products[0].collectionFolderId, a.id);
});

test('protects occupied folders, unfinished tasks and duplicate products when moving', () => {
  const data = state();
  const a = saveCollectionFolder(data, 'A');
  const b = saveCollectionFolder(data, 'B');
  data.products.push({ id: 'p', sourceId: '123', collectionFolderId: a.id, selected: true });
  assert.throws(() => deleteCollectionFolder(data, a.id), /仍有商品/);
  data.jobs.push({ type: 'collect', status: 'paused', metadata: { options: { collectionFolderId: b.id } } });
  assert.throws(() => deleteCollectionFolder(data, b.id), /未完成/);
  assert.throws(() => moveProductsToFolder(data, ['p'], b.id), /未完成/);
  data.jobs = [{ type: 'publish', status: 'queued', metadata: { productIds: ['p'] } }];
  assert.throws(() => moveProductsToFolder(data, ['p'], b.id), /上架任务/);
  data.jobs = [];
  data.products.push({ id: 'copy', sourceId: '123', collectionFolderId: b.id });
  assert.throws(() => moveProductsToFolder(data, ['p'], b.id), /相同来源/);
  data.products.pop();
  assert.equal(moveProductsToFolder(data, ['p'], b.id).moved, 1);
  assert.equal(data.products[0].selected, false);
  assert.equal(data.products[0].collectionFolderId, b.id);
  deleteCollectionFolder(data, a.id);
  assert.equal(data.collectionFolders.length, 1);
});

test('limits all image batches to three downloads and shares in-flight requests', async () => {
  const queue = new ImageDownloadQueue(3);
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const download = async () => {
    calls += 1; active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return 'cached-file';
  };
  const first = queue.run('main-1', download);
  assert.equal(queue.run('main-1', download), first);
  const files = await Promise.all([first, ...Array.from({ length: 12 }, (_, i) => queue.run(`detail-${i}`, download))]);
  assert.equal(maximum, 3);
  assert.equal(calls, 13);
  assert.equal(files.length, 13);
  await assert.rejects(queue.run('failed', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await queue.run('failed', download), 'cached-file');
});

test('empty folder deletion reveals other platforms and cancels only explicitly confirmed paused dependencies', () => {
  const data = state();
  const a = saveCollectionFolder(data, '车灯');
  const b = saveCollectionFolder(data, '其他');
  data.jobs = [
    { id: 'mic', type: 'collect', status: 'paused', progress: 5, total: 121, metadata: { sourcePlatform: 'made-in-china', options: { collectionFolderId: a.id } } },
    { id: 'other', type: 'collect', status: 'paused', metadata: { collectionFolderId: b.id } },
    { id: 'done', type: 'publish', status: 'completed', results: { p: { url: 'published' } }, metadata: { collectionFolderId: a.id } },
  ];
  data.groups = [{ id: 'group', activeJobId: 'mic', status: 'collecting' }];
  const before = structuredClone(data);
  const preview = collectionFolderDeletionPreview(data, a.id);
  assert.equal(preview.productCount, 0);
  assert.equal(preview.jobs[0].platform, 'made-in-china');
  assert.equal(preview.jobs[0].progress, 5);
  assert.throws(() => deleteCollectionFolder(data, a.id), /确认取消/);
  assert.deepEqual(data, before);
  const result = deleteCollectionFolder(data, a.id, { cancelPausedJobIds: ['mic', 'other'] });
  assert.deepEqual(result.cancelledJobIds, ['mic']);
  assert.equal(data.jobs[0].status, 'cancelled');
  assert.deepEqual(data.jobs.slice(1), before.jobs.slice(1));
  assert.equal(data.groups[0].status, 'ready');
  assert.equal(data.groups[0].activeJobId, '');
});

for (const status of ['queued', 'running', 'pause_requested']) {
  test(`does not delete or cancel anything when a confirmed task changes to ${status}`, () => {
    const data = state();
    const folder = saveCollectionFolder(data, 'A');
    data.jobs = [
      { id: 'paused', type: 'collect', status: 'paused', metadata: { collectionFolderId: folder.id } },
      { id: 'changed', type: 'publish', status, metadata: { collectionFolderId: folder.id } },
    ];
    const before = structuredClone(data);
    assert.throws(() => deleteCollectionFolder(data, folder.id, { cancelPausedJobIds: ['paused', 'changed'] }), /先暂停/);
    assert.deepEqual(data, before);
  });
}

test('new paused tasks and newly collected products invalidate an earlier deletion confirmation atomically', () => {
  const data = state();
  const folder = saveCollectionFolder(data, 'A');
  data.jobs = [{ id: 'new-task', type: 'collect', status: 'paused', metadata: { collectionFolderId: folder.id } }];
  const before = structuredClone(data);
  assert.throws(() => deleteCollectionFolder(data, folder.id, { cancelPausedJobIds: ['old-task'] }), /确认取消/);
  assert.deepEqual(data, before);
  data.products.push({ id: 'new-product', collectionFolderId: folder.id });
  const occupied = structuredClone(data);
  assert.throws(() => deleteCollectionFolder(data, folder.id, { cancelPausedJobIds: ['new-task'] }), /仍有商品/);
  assert.deepEqual(data, occupied);
});

test('deleting an archive-only folder preserves product references and does not recreate a folder on restart', () => {
  const data = state();
  const folder = saveCollectionFolder(data, 'A');
  data.products = [{ id: 'archived', collectionFolderId: folder.id, removedFromWorkbenchAt: '2026-10-09',
    source: { snapshot: { title: 'Original' } }, publishHistory: [{ url: 'published' }] }];
  data.jobs = [{ id: 'legacy-publish', type: 'publish', status: 'paused', metadata: { productIds: ['archived'] }, results: { archived: { status: 'published' } } }];
  const products = structuredClone(data.products);
  const results = structuredClone(data.jobs[0].results);
  const preview = collectionFolderDeletionPreview(data, folder.id);
  assert.equal(preview.productCount, 0);
  assert.equal(preview.archivedProductCount, 1);
  assert.deepEqual(preview.jobs.map((job) => job.id), ['legacy-publish']);
  deleteCollectionFolder(data, folder.id, { cancelPausedJobIds: ['legacy-publish'] });
  initializeCollectionFolders(data);
  assert.deepEqual(data.products, products);
  assert.deepEqual(data.jobs[0].results, results);
  assert.deepEqual(data.collectionFolders, []);
  assert.equal(data.settings.activeCollectionFolderId, '');
});
