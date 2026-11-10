import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { JsonStore } from '../server/store.js';
import { createPublishDiagnosticStore } from '../server/publish-diagnostics.js';
import { buildDiagnosticReport, diagnosticSummaryFromState } from '../server/diagnostic-report.js';

test('draft and submit failures retain correlated timing and category evidence while the batch continues', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-timeline-api-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, PORT: process.env.PORT, KUA_YIPU_ACCOUNT: process.env.KUA_YIPU_ACCOUNT };
  Object.assign(process.env, { DATA_DIR: root, PORT: '0', KUA_YIPU_ACCOUNT: 'timing-fixture' });
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update(state => {
    state.collectionFolders = [{ id: 'folder', name: 'Timing fixture' }];
    state.settings.aiProductAssistance = { mode: 'rules' };
    state.products = ['a', 'b'].map(id => ({ id, sourceId: id, sourcePlatform: 'alibaba.com', collectionFolderId: 'folder',
      title: 'Synthetic camera', price: 12, categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'] }));
  });
  const original = SellerPublisher.prototype.publishProduct;
  const calls = [];
  SellerPublisher.prototype.publishProduct = async (product, url, mode, category, jobId, progress) => {
    calls.push([product.id, mode]);
    progress('填写类目属性');
    progress('核对规格');
    if (product.id === 'a') throw Object.assign(new Error('Synthetic rejected SKU'), { code: 'PUBLISH_FIELD_NOT_READY' });
    progress(mode === 'draft' ? '保存草稿' : '提交商品');
    return { status: mode === 'draft' ? 'drafted' : 'published', message: 'Synthetic fresh receipt' };
  };
  let api;
  try {
    api = await import('../server/index.js');
    const listener = await api.serverReady;
    for (const mode of ['draft', 'submit']) {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['a', 'b'], collectionFolderId: 'folder', mode }),
      });
      assert.equal(response.status, 202);
      const job = await response.json();
      const deadline = Date.now() + 5000;
      while (store.read(state => state.jobs.find(item => item.id === job.id).status) !== 'completed') {
        assert.ok(Date.now() < deadline, 'batch did not finish');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.deepEqual(calls, [['a', 'draft'], ['b', 'draft'], ['a', 'submit'], ['b', 'submit']]);
    const retained = createPublishDiagnosticStore(root, 'timing-fixture').read();
    assert.equal(retained.failures.length, 2);
    assert.deepEqual(new Set(retained.failures.map(item => item.mode)), new Set(['draft', 'submit']));
    const report = buildDiagnosticReport({ version: '1.4.103', files: [path.join(root, 'service-runtime.log')],
      dataDirectory: root, account: 'timing-fixture', summary: diagnosticSummaryFromState(store.read()) });
    for (const failure of report.failures) {
      assert.equal(failure.targetCategoryId, '201346401');
      assert.equal(failure.processingMode, 'rules');
      assert.equal(failure.timeline.entries.at(-1).stage, 'specifications');
      assert.equal(failure.timeline.entries.at(-1).outcome, 'failed');
      assert.ok(report.events.some(event => event.event === 'publish-failed' && event.attemptId === failure.attemptId && event.mode === failure.mode));
      assert.ok(report.failureIndex.some(item => item.attemptId === failure.attemptId && item.evidence === 'included'));
    }
    assert.notEqual(report.failures[0].attemptId, report.failures[1].attemptId);
    const saved = store.read(state => state.products.find(item => item.id === 'a').publishResult);
    assert.equal(saved.diagnostics.processingMode, 'rules');
    assert.ok(report.failures.some(item => item.attemptId === saved.diagnostics.attemptId));
  } finally {
    await api?.shutdownServer();
    SellerPublisher.prototype.publishProduct = original;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
