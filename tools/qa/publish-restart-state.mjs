import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from '../../server/store.js';
import { SellerPublisher } from '../../server/publisher.js';
import { publishCounts, publishJobMessage } from '../../server/publish-progress.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && !fs.existsSync(root));
fs.mkdirSync(root, { recursive: true });
process.env.DATA_DIR = root;
process.env.PORT = '0';
const store = new JsonStore(path.join(root, 'workspace.json'));
const ids = ['1', '2', '3', '4', '5', '6'];
const receipts = Object.fromEntries(ids.slice(0, 2).map(id => [id, { status: 'drafted', message: 'Saved receipt ' + id }]));
store.update(state => {
  state.products = ids.map(id => ({ id, sourceId: id, title: 'Camera ' + id, status: receipts[id] ? 'drafted' : 'ready',
    ...(receipts[id] ? { publishResult: receipts[id], publishHistory: [{ result: receipts[id] }] } : {}) }));
  state.jobs = [{ id: 'interrupted', type: 'publish', status: 'running', progress: 2, total: 6,
    currentProductId: '3', verificationState: 'waiting', metadata: { productIds: ids, mode: 'draft' }, results: receipts }];
});
let attempts = 0;
const original = SellerPublisher.prototype.publishProduct;
SellerPublisher.prototype.publishProduct = async () => { attempts++; throw Error('Must not publish on restart'); };
const server = await import('../../server/index.js');
try {
  await server.serverReady;
  const job = store.read().jobs[0];
  assert.equal(job.status, 'paused');
  assert.equal(job.progress, 2);
  assert.deepEqual(job.results, receipts);
  assert.deepEqual(publishCounts(job), { success: 2, failed: 0, skipped: 0, remaining: 4 });
  assert.match(publishJobMessage(job), /服务重启/);
  assert.equal(attempts, 0);
  for (const product of store.read().products.slice(0, 2)) {
    assert.deepEqual(product.publishResult, receipts[product.id]);
    assert.equal(product.publishHistory.length, 1);
  }
  const result = { ok: true, status: job.status, progress: job.progress, total: job.total,
    counts: publishCounts(job), automaticPublishAttempts: attempts };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await server.shutdownServer();
  SellerPublisher.prototype.publishProduct = original;
}
