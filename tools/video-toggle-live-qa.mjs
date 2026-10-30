// Real video-bearing samples, production settings API and draft submission.
// Runs in an isolated workspace; never deletes or overwrites customer products.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JsonStore } from '../server/store.js';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR;
const uploadEnabled = process.env.QA_UPLOAD_VIDEOS === '1';
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_WORKSPACE_FILE && process.env.QA_SOURCE_IDS);
fs.mkdirSync(root, { recursive: true });
const reportFile = path.join(root, 'video-toggle-live.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : { samples: [], videoRequests: [] };
assert.equal(report.samples.length, 0, 'Do not repeat saved drafts automatically');
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const source = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE));
const ids = process.env.QA_SOURCE_IDS.split(','); assert.ok(ids.length <= 3);
const products = ids.map(id => {
  const product = source.products.find(item => item.sourceId === id);
  assert.ok(product?.videoUrl && product.videos?.length, 'Sample must have collected video');
  return { ...structuredClone(product), collectionFolderId: 'video-off-qa', status: 'ready', removedFromWorkbenchAt: undefined };
});
process.env.DATA_DIR = path.join(root, 'workspace'); process.env.PORT = '0';
const store = new JsonStore(path.join(process.env.DATA_DIR, 'workspace.json'));
store.update(state => { state.settings = { ...state.settings, ...source.settings, autoRemovePublishedProducts: false };
  state.collectionFolders = [{ id: 'video-off-qa', name: 'Video switch QA' }]; state.products = products; state.jobs = []; });
const sessionFile = path.join(root, 'alibaba-cookies.json');
writePrivateSession(sessionFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = sessionFile;
const original = SellerPublisher.prototype.publishProduct;
SellerPublisher.prototype.publishProduct = async function(...args) {
  const [product, , mode, , , progress, options] = args;
  assert.equal(mode, 'draft'); assert.equal(options.uploadProductVideos, uploadEnabled);
  const page = await this.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const context = page.context(), newPage = context.newPage.bind(context);
  let diagnosticIndex = 0;
  context.newPage = async () => {
    const child = await newPage(), close = child.close.bind(child), index = ++diagnosticIndex;
    child.close = async (...args) => {
      try {
        fs.writeFileSync(path.join(root, `video-child-${index}.json`), JSON.stringify({
          url: child.url(), title: await child.title(), text: (await child.locator('body').innerText({ timeout: 3000 })).slice(0, 10000),
        }, null, 2));
      } catch {}
      return close(...args);
    };
    return child;
  };
  const row = { sourceId: product.sourceId, mainVideo: Boolean(product.videoUrl), detailVideos: product.videos.filter(video => video.role === 'detail').length,
    started: new Date().toISOString(), stages: [] };
  report.samples.push(row); save();
  const watch = request => {
    if (/videobank\/|(?:play|cloud)\.video\.alibaba\.com\/|gv\.videocdn\.alibaba\.com\//i.test(request.url())) report.videoRequests.push(request.url());
  };
  page.context().on('request', watch);
  const download = this.downloadProductVideo, upload = this.uploadMainVideo;
  if (!uploadEnabled) {
    this.downloadProductVideo = async () => { assert.fail('Video download must not run when disabled'); };
    this.uploadMainVideo = async () => { assert.fail('Video uploader must not run when disabled'); };
  }
  args[5] = stage => { row.stages.push(stage); save(); progress(stage); };
  try {
    row.result = await original.apply(this, args);
    assert.equal(row.result.status, 'drafted'); assert.equal(row.result.videoUploadEnabled, uploadEnabled);
    if (uploadEnabled) {
      const videos = row.result.videoAssociation?.items || [row.result.videoAssociation];
      assert.ok(videos.length >= 2 && videos.every(video => video?.pendingPublication));
      assert.ok(videos.some(video => video.role === 'main') && videos.some(video => video.role === 'detail'));
    } else {
      assert.equal(row.result.videoAssociation, null);
      assert.ok(!row.stages.some(stage => /处理商品视频|复核商品视频关联/.test(stage)));
      assert.equal(report.videoRequests.length, 0);
    }
    await this.page.screenshot({ path: path.join(root, `${product.sourceId}-draft.png`) });
    return row.result;
  } catch (error) { row.error = { message: error.message, code: error.code }; throw error; }
  finally { this.downloadProductVideo = download; this.uploadMainVideo = upload; context.newPage = newPage; page.context().off('request', watch);
    row.finished = new Date().toISOString(); save(); }
};
let server;
try {
  server = await import('../server/index.js');
  const listener = await server.serverReady, base = `http://127.0.0.1:${listener.address().port}`;
  const setting = await fetch(base + '/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadProductVideos: uploadEnabled }) });
  assert.equal(setting.status, 200); assert.equal((await setting.json()).uploadProductVideos, uploadEnabled);
  const created = await fetch(base + '/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: products.map(product => product.id), collectionFolderId: 'video-off-qa', mode: 'draft', listingMode: 'auto' }) });
  assert.equal(created.status, 202); const job = await created.json(); report.jobId = job.id; save();
  const end = Date.now() + 20 * 60 * 1000;
  for (;;) {
    const current = store.read().jobs.find(item => item.id === job.id);
    if (['completed', 'failed', 'paused', 'cancelled'].includes(current.status)) { report.job = current; break; }
    if (Date.now() > end) { await fetch(base + `/api/jobs/${job.id}/pause`, { method: 'POST' }); throw new Error('Bounded draft validation timed out'); }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  for (const expected of products) {
    const saved = store.read().products.find(product => product.id === expected.id);
    assert.equal(saved.videoUrl, expected.videoUrl); assert.deepEqual(saved.videos, expected.videos);
  }
  assert.equal(report.samples.length, products.length);
  assert.ok(report.samples.every(row => !row.error && row.result?.status === 'drafted'), 'Every draft and video assertion must pass');
  report.ok = true; delete report.error;
} catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
finally {
  save(); await server?.shutdownServer(); SellerPublisher.prototype.publishProduct = original;
  fs.rmSync(sessionFile, { force: true });
  console.log(JSON.stringify({ ok: report.ok, samples: report.samples.map(row => ({ sourceId: row.sourceId, status: row.result?.status, error: row.error })), error: report.error }));
}
