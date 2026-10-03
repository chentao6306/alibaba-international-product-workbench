import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { SOURCE_ATTRIBUTE_SCHEMA_VERSION } from '../server/category-attributes.js';

test('item errors record failures and continue the batch; only a task pause preserves the current position', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-readiness-jobs-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.collectionFolders = [{ id: 'folder', name: 'Cameras' }];
    state.products = [1, 2, 3].map((id) => ({ id: String(id), sourceId: String(id), sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      title: `Camera ${id}`, selected: true, status: 'ready', price: 100, origin: 'China',
      categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'], description: 'Camera',
      attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
      mainImages: [1, 2, 3, 4].map((n) => `https://example.com/${n}.jpg`), detailImages: ['https://example.com/detail.jpg'] }));
    Object.assign(state.products[0], { detailImages: [], categoryReference: { id: 'reference' },
      variantGroups: [{ name: 'Type', options: ['Motor'] }], skus: [{ attributes: { Type: 'Motor' }, code: 'KEPT', stock: 5 }] });
    state.products[1].publishResult = { status: 'failed', message: '国际站必填属性或规格未填写：年龄段、原产地' };
  });
  const original = SellerPublisher.prototype.publishProduct;
  const originalEnrich = SellerPublisher.prototype.enrichSourceProducts;
  let enrichmentCalls = 0;
  SellerPublisher.prototype.enrichSourceProducts = async ([product]) => {
    enrichmentCalls++;
    return [{ ...product, title: 'Source title', price: 1, categoryId: '999999999', variantGroups: [], skus: [],
      attributes: [...product.attributes, { id: '123', name: 'Age Range', value: '3-6 years' }], sourceAttributeSchemaVersion: SOURCE_ATTRIBUTE_SCHEMA_VERSION,
      detailImages: ['https://example.com/recovered-detail.jpg'] }];
  };
  const attempts = [];
  let blockingCode = 'LOGIN_REQUIRED';
  let categoryCorrected = false;
  let releaseProduct;
  SellerPublisher.prototype.publishProduct = async (product) => {
    attempts.push(product.id);
    if (product.id === '1') {
      assert.equal(product.title, 'Camera 1');
      assert.equal(product.price, 100);
      assert.equal(product.categoryId, '201346401');
      assert.equal(product.skus[0].code, 'KEPT');
      assert.deepEqual(product.detailImages, []);
      if (blockingCode === 'manual-pause') await new Promise((resolve, reject) => {
        releaseProduct = () => reject(Object.assign(new Error('page closed'), { code: 'PUBLISH_PAUSED' }));
      });
    }
    if (product.id === '1' && blockingCode) throw blockingCode === 'raw-scroll'
      ? new Error('locator.scrollIntoViewIfNeeded: Timeout 3000ms exceeded. Call log: waiting for image-placeholder-span')
      : blockingCode === 'raw-overlay'
      ? new Error('locator.click: Timeout 5000ms exceeded. next-overlay-backdrop intercepts pointer events')
      : blockingCode === 'raw-control'
        ? new Error('locator.click: Timeout 5000ms exceeded. posting-footer intercepts pointer events')
      : Object.assign(new Error(blockingCode), { code: blockingCode });
    if (product.id === '2') assert.equal(product.attributes.find((item) => item.name === 'Age Range'), undefined);
    if (product.id === '2' && !categoryCorrected) throw Object.assign(new Error('当前类目不可用，请重新选择有效类目'), { code: 'PUBLISH_CATEGORY_INVALID' });
    return { status: 'drafted', message: 'Saved receipt', productId: product.id };
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  };
  const until = async (condition) => {
    const deadline = Date.now() + 10000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), 'Expected task state did not arrive');
  };
  try {
    const blockers = ['LOGIN_REQUIRED', 'HUMAN_VERIFICATION_REQUIRED', 'PUBLISH_STAGE_TIMEOUT', 'PUBLISH_EDITOR_NOT_READY', 'PUBLISH_FORM_NOT_READY', 'PUBLISH_FIELD_NOT_READY', 'PUBLISH_BROWSER_NOT_READY', 'PUBLISH_LANGUAGE_NOT_READY', 'PUBLISH_IMAGE_BANK_FULL', 'PUBLISH_IMAGE_SERVICE_BLOCKED', 'PUBLISH_OVERLAY_BLOCKED', 'raw-overlay', 'PUBLISH_CONTROL_OBSCURED', 'raw-control', 'PUBLISH_CONFIRMATION_PENDING', 'PUBLISH_SUBMIT_RESULT_UNKNOWN', 'raw-scroll', 'MAIN_IMAGE_CONTROL_NOT_READY', 'MAIN_IMAGE_UPLOAD_PENDING', 'IMAGE_UPLOAD_TIMEOUT', 'COLLECT_PAUSED', 'PUBLISH_PAUSED'];
    for (const code of blockers) {
      blockingCode = code; attempts.length = 0;
      const task = await api('/api/publish', { ids: ['1', '2', '3'], collectionFolderId: 'folder', mode: 'draft' });
      await until(() => store.read().jobs.find((job) => job.id === task.id).status === 'completed');
      const state = store.read();
      const job = state.jobs.find((job) => job.id === task.id);
      assert.equal(job.progress, 3, code);
      assert.deepEqual(attempts, ['1', '2', '3'], code);
      assert.equal(state.products[0].status, 'publish_failed', code);
      assert.equal(state.products[1].status, 'publish_failed');
      assert.equal(state.products[2].status, 'drafted');
      assert.equal(job.results['1'].status, 'failed');
      assert.match(job.message, /成功 1 件，失败 2 件/);
      assert.doesNotMatch(state.products[0].publishResult.message, /locator\.|Call log:|弹窗遮罩|任务已暂停/);
      if (code === 'PUBLISH_SUBMIT_RESULT_UNKNOWN') assert.match(state.products[0].publishResult.message, /待核对/);
    }
    blockingCode = 'manual-pause'; attempts.length = 0;
    const before = store.read().products[0].publishHistory.length;
    const task = await api('/api/publish', { ids: ['1', '2', '3'], collectionFolderId: 'folder', mode: 'draft' });
    await until(() => Boolean(releaseProduct));
    await api(`/api/jobs/${task.id}/pause`, {});
    releaseProduct();
    await until(() => store.read().jobs.find((job) => job.id === task.id).status === 'paused');
    assert.equal(store.read().jobs.find((job) => job.id === task.id).progress, 0);
    assert.equal(store.read().products[0].publishHistory.length, before);
    assert.equal(attempts.includes('3'), false);
    blockingCode = ''; categoryCorrected = true;
    await api(`/api/jobs/${task.id}/resume`, {});
    await until(() => store.read().jobs.find((job) => job.id === task.id).status === 'completed');
    const state = store.read();
    assert.deepEqual(attempts, ['1', '1', '2', '3']);
    assert.equal(state.products[0].publishHistory.length, before + 1);
    assert.equal(state.products[0].status, 'drafted');
    assert.equal(state.products[1].status, 'drafted');
    assert.equal(state.products[2].status, 'drafted');
    assert.match(state.jobs.find((job) => job.id === task.id).message, /成功 3 件，失败 0 件/);
    assert.equal(enrichmentCalls, 0);
  } finally {
    await server.shutdownServer(); SellerPublisher.prototype.publishProduct = original;
    SellerPublisher.prototype.enrichSourceProducts = originalEnrich;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
