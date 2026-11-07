// Authorized live batch through the normal API, gated by exact prior drafts.
// Keep all receipts and never restart a completed/uncertain submission blindly.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR, prior = process.env.QA_DRAFT_DIR;
assert.ok(root && prior && process.env.QA_SOURCE_IDS && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const file = path.join(root, 'publication.json');
assert.equal(fs.existsSync(file), false, 'Inspect existing receipts rather than repeat live submissions');
const ids = process.env.QA_SOURCE_IDS.split(',');
assert.ok(ids.length > 0 && ids.length <= 10);
const proof = JSON.parse(fs.readFileSync(path.join(prior, 'performance.json')));
const uploadProductVideos = process.env.QA_UPLOAD_VIDEOS === '1';
assert.equal(proof.videos, uploadProductVideos, 'Use the same video setting as the verified draft');
const previous = JSON.parse(fs.readFileSync(path.join(prior, 'workspace/workspace.json')));
const products = ids.map(id => {
  const evidence = proof.samples.find(row => row.sourceId === id);
  assert.ok(evidence?.attributesAccepted && evidence.result?.status === 'drafted' && !evidence.error, `Draft required: ${id}`);
  const product = previous.products.find(row => row.sourceId === id);
  assert.ok(product && product.publishResult?.status === 'drafted');
  return { ...structuredClone(product), status: 'ready', selected: true, publishResult: undefined };
});
process.env.DATA_DIR = path.join(root, 'workspace'); process.env.PORT = '0';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
if (fs.existsSync(path.join(prior, 'workspace/media'))) fs.cpSync(path.join(prior, 'workspace/media'), path.join(process.env.DATA_DIR, 'media'), { recursive: true });
const store = new JsonStore(path.join(process.env.DATA_DIR, 'workspace.json'));
store.update(state => {
  state.settings = { ...state.settings, ...previous.settings, uploadProductVideos, autoRemovePublishedProducts: false };
  state.collectionFolders = previous.collectionFolders; state.products = products; state.jobs = [];
});
const cookieFile = path.join(root, 'cookies.json');
writePrivateSession(cookieFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
const report = { version: JSON.parse(fs.readFileSync('package.json')).version, mode: 'submit', videos: uploadProductVideos, startedAt: new Date().toISOString(), samples: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const original = SellerPublisher.prototype.publishProduct;
SellerPublisher.prototype.publishProduct = async function (...args) {
  assert.equal(args[2], 'submit');
  const page = await this.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const sample = { sourceId: args[0].sourceId, mode: 'submit', startedAt: new Date().toISOString(), stages: [] };
  report.samples.push(sample); save();
  const start = performance.now(), progress = args[5];
  args[5] = stage => { sample.stages.push({ stage, ms: Math.round(performance.now() - start) }); save(); progress?.(stage); };
  try {
    sample.result = await original.apply(this, args);
    if (sample.result.status === 'published') {
      sample.publishedId = new URL(sample.result.url).searchParams.get('primaryId');
      assert.match(sample.publishedId, /^\d+$/);
    }
    return sample.result;
  } catch (error) {
    sample.error = { message: error.message, code: error.code, diagnostics: error.diagnostics }; throw error;
  } finally {
    sample.ms = Math.round(performance.now() - start); save();
    fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify(report.samples, null, 2));
  }
};
let server;
try {
  save(); server = await import('../server/index.js');
  const listener = await server.serverReady, base = `http://127.0.0.1:${listener.address().port}`;
  const response = await fetch(base + '/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    ids: products.map(product => product.id), collectionFolderId: products[0].collectionFolderId,
    mode: 'submit', listingMode: 'auto', publishDelayMinSeconds: 0, publishDelayMaxSeconds: 0,
  }) });
  assert.equal(response.status, 202); const job = await response.json(); report.jobId = job.id; save();
  const deadline = Date.now() + Math.max(20, products.length * 4) * 60000;
  for (;;) {
    const current = store.read().jobs.find(row => row.id === job.id);
    if (['completed', 'paused', 'cancelled', 'failed'].includes(current.status)) { report.job = current; break; }
    if (Date.now() > deadline) { await fetch(`${base}/api/jobs/${job.id}/pause`, { method: 'POST' }); throw new Error('Live batch reached its time limit; inspect persisted receipts'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(report.samples.length, products.length);
  for (const product of products) {
    const saved = store.read().products.find(row => row.id === product.id);
    assert.equal(saved.publishResult?.status, 'published', saved.publishResult?.message);
    assert.deepEqual(saved.mainImages, product.mainImages); assert.deepEqual(saved.detailImages, product.detailImages);
    assert.deepEqual(saved.source, product.source);
  }
  report.ok = report.samples.every(row => row.result?.status === 'published' && !row.error);
} catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); save();
  await server?.shutdownServer(); SellerPublisher.prototype.publishProduct = original;
  fs.rmSync(cookieFile, { force: true });
  console.log(JSON.stringify({ ok: report.ok, samples: report.samples.map(row => ({ id: row.sourceId, publishedId: row.publishedId, ms: row.ms, error: row.error })), error: report.error }));
}
