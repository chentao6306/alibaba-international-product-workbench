import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { verificationOptions, waitForVerification } from '../server/human-verification.js';
import { publishCounts, publishJobMessage } from '../server/publish-progress.js';

test('six-item drafts recover from an unresponsive third item and preserve the first two across verification pause and resume', { timeout: 95000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-stall-jobs-'));
  process.env.DATA_DIR = root;
  process.env.PORT = '0';
  process.env.KUA_YIPU_PUBLISH_STAGE_TIMEOUT_MS = '60000';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const ids = ['1', '2', '3', '4', '5', '6'];
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'Draft recovery' }];
    state.products = ids.map(id => ({ id, sourceId: id, sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      title: 'Camera ' + id, selected: true, status: 'ready', price: 100,
      categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'] }));
  });
  const originalPublish = SellerPublisher.prototype.publishProduct;
  const originalStop = SellerPublisher.prototype.requestPublishStop;
  const attempts = [];
  const stops = [];
  let scenario = 'stall', aborted = false, verified = false, close = false;
  SellerPublisher.prototype.requestPublishStop = function (id) { stops.push(id); return originalStop.call(this, id); };
  SellerPublisher.prototype.publishProduct = async (product, _url, _mode, _category, _jobId, report, options) => {
    attempts.push(product.id);
    report('上传主图');
    if (product.id === '3' && scenario === 'stall') {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
      });
      assert.fail('Timed-out product must never reach submission');
    }
    if (product.id === '3' && scenario === 'verification') {
      const context = verificationOptions();
      await waitForVerification({ ...context, pollMs: 20, isClosed: () => close,
        inspect: async () => ({ ready: verified, url: 'verified-page' }) });
      report('保存草稿');
    }
    if (product.id === '4' && scenario === 'stall') assert.equal(aborted, true);
    return { status: 'drafted', message: 'Saved receipt', productId: product.id };
  };
  let server;
  try {
    server = await import('../server/index.js');
    const listener = await server.serverReady;
    const api = async (route, body) => {
      const response = await fetch('http://127.0.0.1:' + listener.address().port + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.ok, true, await response.clone().text());
      return response.json();
    };
    const until = async (predicate, milliseconds = 10000) => {
      const deadline = Date.now() + milliseconds;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(Boolean(predicate()), true, 'Expected job checkpoint was not reached');
    };
    const getJob = id => store.read().jobs.find(job => job.id === id);
    const first = await api('/api/publish', { ids, collectionFolderId: 'folder', mode: 'draft' });
    await until(() => getJob(first.id).progress === 2);
    assert.deepEqual(publishCounts(getJob(first.id)), { success: 2, failed: 0, skipped: 0, remaining: 4 });
    await until(() => getJob(first.id).status === 'completed', 70000);
    assert.deepEqual(attempts, ids);
    assert.deepEqual(publishCounts(getJob(first.id)), { success: 5, failed: 1, skipped: 0, remaining: 0 });
    assert.equal(store.read().products.find(product => product.id === '3').publishResult.code, 'PUBLISH_STAGE_TIMEOUT');
    assert.deepEqual(stops, [first.id]);
    assert.equal(store.read().products.find(product => product.id === '1').publishHistory.length, 1);
    assert.equal(store.read().products.find(product => product.id === '2').publishHistory.length, 1);

    // Replay the reported 2/6 appearance using an actual verification wait,
    // then prove task control preserves receipts and resumes only unfinished work.
    scenario = 'verification';
    attempts.length = 0;
    const second = await api('/api/publish', { ids, collectionFolderId: 'folder', mode: 'draft' });
    await until(() => getJob(second.id).verificationState === 'waiting');
    assert.equal(getJob(second.id).progress, 2);
    assert.match(publishJobMessage(getJob(second.id)), /等待人工验证/);
    const histories = store.read().products.map(product => product.publishHistory?.length || 0);
    await api('/api/jobs/' + second.id + '/pause', {});
    await until(() => getJob(second.id).status === 'paused');
    assert.equal(getJob(second.id).progress, 2);
    assert.deepEqual(attempts, ['1', '2', '3']);
    assert.deepEqual(store.read().products.map(product => product.publishHistory?.length || 0), histories);
    verified = true;
    await api('/api/jobs/' + second.id + '/resume', {});
    await until(() => getJob(second.id).status === 'completed');
    assert.deepEqual(attempts, ['1', '2', '3', '3', '4', '5', '6']);
    assert.deepEqual(publishCounts(getJob(second.id)), { success: 6, failed: 0, skipped: 0, remaining: 0 });
    assert.equal(getJob(second.id).verificationState, '');
    const final = new JsonStore(path.join(root, 'workspace.json')).read();
    assert.equal(final.products.find(product => product.id === '1').publishHistory.length, histories[0]);
    assert.equal(final.products.find(product => product.id === '2').publishHistory.length, histories[1]);
  } finally {
    close = true;
    await server?.shutdownServer();
    SellerPublisher.prototype.publishProduct = originalPublish;
    SellerPublisher.prototype.requestPublishStop = originalStop;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
