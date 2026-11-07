// Compare saved product copies with the actual API/publisher of a chosen build.
// Timing data stays in the isolated QA folder, never in customer-facing progress.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { productForVideoUpload } from '../server/posting-video.js';

const root = process.env.QA_OUTPUT_DIR, codeRoot = path.resolve(process.env.QA_CODE_ROOT || '.');
const uploadProductVideos = process.env.QA_UPLOAD_VIDEOS === '1';
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_WORKSPACE_FILE && process.env.QA_SOURCE_IDS);
fs.mkdirSync(root, { recursive: true });
const reportFile = path.join(root, 'performance.json');
assert.equal(fs.existsSync(reportFile), false, 'Do not repeat draft creation from an existing run');
const load = file => import(pathToFileURL(path.join(codeRoot, file)).href);
const { JsonStore } = await load('server/store.js');
const { SellerPublisher, mainImageFormState, captureCategoryAttributes, requireCategoryAttributes } = await load('server/publisher.js');
const source = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE, 'utf8'));
const ids = process.env.QA_SOURCE_IDS.split(','); assert.ok(ids.length && ids.length <= 10);
const originals = ids.map(id => { const product = source.products.find(item => item.sourceId === id); assert.ok(product); return product; });
const products = originals.map(item => ({ ...productForVideoUpload(structuredClone(item), { uploadProductVideos }),
  collectionFolderId: 'performance-qa', status: 'ready', selected: true, removedFromWorkbenchAt: undefined }));
for (const product of products) delete product.publishResult;
const report = { version: JSON.parse(fs.readFileSync(path.join(codeRoot, 'package.json'))).version,
  mode: 'draft', videos: uploadProductVideos, samples: [], started: new Date().toISOString() };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
process.env.DATA_DIR = path.join(root, 'workspace'); process.env.PORT = '0'; process.env.APP_ROOT_DIR = codeRoot;
const store = new JsonStore(path.join(process.env.DATA_DIR, 'workspace.json'));
store.update(state => {
  state.settings = { ...state.settings, ...source.settings, autoRemovePublishedProducts: false,
    uploadProductVideos, publishDelayMinSeconds: 0, publishDelayMaxSeconds: 0 };
  state.collectionFolders = [{ id: 'performance-qa', name: 'Performance QA' }]; state.products = products; state.jobs = [];
});
const sessionFile = path.join(root, 'alibaba-cookies.json');
writePrivateSession(sessionFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = sessionFile;
const original = SellerPublisher.prototype.publishProduct;
SellerPublisher.prototype.publishProduct = async function(...args) {
  assert.equal(args[2], 'draft');
  const product = args[0];
  const row = { sourceId: product.sourceId, started: new Date().toISOString(), stages: [], methods: [],
    images: { main: product.mainImages?.length, detail: product.detailImages?.length }, attributes: product.attributes?.length };
  const began = performance.now(); const progress = args[5];
  report.samples.push(row); save();
  const methods = new Map();
  let watchedPage;
  const responseReads = [];
  const onResponse = response => {
    if (!/^https:\/\/post\.alibaba\.com\//.test(response.url()) || response.request().method() !== 'POST') return;
    const receipt = { path: new URL(response.url()).pathname, status: response.status(), ids: [] };
    (row.apiReceipts ||= []).push(receipt);
    responseReads.push((async () => {
      try {
        const body = await response.text();
        if (body.length > 200000) return;
        let visited = 0;
        const inspect = (value, depth = 0, trail = []) => {
          if (!value || typeof value !== 'object' || depth > 12 || visited++ > 1000) return;
          for (const [key, item] of Object.entries(value)) {
            // models can wrap the saved identity several levels deep. Keep
            // only identity fields, never raw response or product contents.
            if (/^(?:primaryId|productId|itemId|draftId)$/i.test(key) && /^\d{10,16}$/.test(String(item))) receipt.ids.push({ key, value: String(item), path: [...trail, key].join('.') });
            else inspect(item, depth + 1, [...trail, key]);
          }
        };
        const parsed = JSON.parse(body);
        inspect(parsed);
        if (receipt.path === '/product/submitDraft.json') {
          receipt.fields = Object.keys(parsed);
          receipt.dataFields = parsed.data && typeof parsed.data === 'object' ? Object.keys(parsed.data) : typeof parsed.data;
          receipt.success = parsed.success;
          if (/^\d{10,16}$/.test(String(parsed.data))) receipt.ids.push({ key: 'data', value: String(parsed.data) });
        }
      } catch { /* Not every response is JSON. Never retain raw bodies. */ }
    })());
  };
  for (const name of ['currentSellerPage', 'downloadImageSet', 'uploadMainImages', 'reconcileMainImages',
    'fillLegacyDescription', 'fillProductFields', 'fillPriceFields', 'fillAdditionalProductFields']) {
    if (typeof this[name] !== 'function') continue;
    const method = this[name]; methods.set(name, method);
    this[name] = async (...params) => {
      const call = { name, startMs: Math.round(performance.now() - began) };
      row.methods.push(call);
      try {
        const value = await method.apply(this, params);
        if (name === 'currentSellerPage') {
          // skipNavigation creates about:blank first. Check the imported account
          // here; the publisher still verifies the actual posting page/login.
          const accountUrl = value.url() === 'about:blank' ? 'https://www.alibaba.com/' : value.url();
          assert.ok(matchesAlibabaSession(await value.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, accountUrl), 'Expected seller account must be imported before navigation');
          if (!watchedPage) { watchedPage = value; value.on('response', onResponse); }
        }
        return value;
      } catch (error) { call.errorCode = error.code || error.name; throw error; }
      finally { call.durationMs = Math.round(performance.now() - began - call.startMs); save(); }
    };
  }
  args[5] = stage => { row.stages.push({ stage, elapsedMs: Math.round(performance.now() - began) }); save(); progress?.(stage); };
  try {
    row.result = await original.apply(this, args);
    row.durationMs = Math.round(performance.now() - began);
    assert.equal(row.result.status, 'drafted');
    assert.equal(row.result.videoUploadEnabled, uploadProductVideos);
    if (uploadProductVideos) {
      const associations = row.result.videoAssociation?.items || [row.result.videoAssociation];
      for (const role of ['main', 'detail']) {
        if (role === 'main' ? product.videoUrl : product.videos?.some(video => video.role === 'detail')) {
          assert.ok(associations.some(video => video?.role === role && video.id && video.pendingPublication), `Draft ${role} video must be uploaded and retained for publication`);
        }
      }
    }
    row.form = { mainImages: await mainImageFormState(this.page), attributes: await captureCategoryAttributes(this.page) };
    assert.ok(row.form.mainImages.occupied >= Math.min(product.mainImages.length, 6));
    try { await requireCategoryAttributes(this.page, product); row.attributesAccepted = true; }
    catch (error) { row.attributesAccepted = false; row.attributeValidation = { message: error.message, fields: error.requiredFields, diagnostics: error.diagnostics }; }
    await this.page.screenshot({ path: path.join(root, `${product.sourceId}-draft.png`) });
    // A success toast precedes the platform's draft redirect. Observe the
    // existing save result only; never send another save to obtain its ID.
    await this.page.waitForURL(url => url.hostname === 'post.alibaba.com'
      && url.pathname === '/product/publish.htm' && url.searchParams.get('pubAction') === 'draft'
      && /^\d{10,16}$/.test(url.searchParams.get('itemId') || ''), { timeout: 20000 }).catch(error => {
      row.draftIdentityWarning = error.name;
    });
    const savedUrl = new URL(this.page.url());
    if (savedUrl.hostname === 'post.alibaba.com' && savedUrl.pathname === '/product/publish.htm'
      && savedUrl.searchParams.get('pubAction') === 'draft' && /^\d{10,16}$/.test(savedUrl.searchParams.get('itemId') || '')) {
      row.draftId = savedUrl.searchParams.get('itemId');
      row.savedDraftUrl = savedUrl.href;
      delete row.draftIdentityWarning;
    }
    save();
    return row.result;
  } catch (error) {
    row.error = { code: error.code, message: error.message, diagnostics: error.diagnostics };
    row.durationMs ||= Math.round(performance.now() - began);
    throw error;
  } finally {
    watchedPage?.off('response', onResponse);
    await Promise.allSettled(responseReads);
    for (const [name, method] of methods) this[name] = method;
    row.finished = new Date().toISOString(); save();
  }
};
let server;
try {
  save(); server = await load('server/index.js');
  const listener = await server.serverReady, base = `http://127.0.0.1:${listener.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, `${url}: ${result.error || response.status}`);
    return result;
  };
  if (process.env.QA_WATERMARK_SCOPES) {
    const scopes = process.env.QA_WATERMARK_SCOPES.split(',');
    assert.equal(scopes.length, products.length);
    assert.ok(scopes.every(scope => ['main', 'detail', 'both'].includes(scope)));
    assert.ok(process.env.QA_WATERMARK_LOGO);
    const logo = await post('/api/media/upload-image', { data: `data:image/png;base64,${fs.readFileSync(process.env.QA_WATERMARK_LOGO).toString('base64')}` });
    const drafts = await post('/api/products/image-drafts', { ids: products.map(p => p.id) });
    report.watermarks = [];
    for (const [index, draft] of drafts.entries()) {
      const watermark = { type: 'image', imageUrl: logo.url, position: 'southeast', size: 12, opacity: 0.6 };
      const checkpoint = { sourceId: products[index].sourceId, scope: scopes[index], images: 0, started: new Date().toISOString() };
      report.watermarks.push(checkpoint); save();
      for (const [kind, key] of [['main', 'mainImages'], ['detail', 'detailImages']]) {
        if (scopes[index] !== 'both' && scopes[index] !== kind) continue;
        for (let image = 0; image < draft[key].length; image++) {
          const result = await post('/api/media/process', { url: draft[key][image], action: 'watermark', watermark });
          assert.ok(result.changed && result.url.startsWith('/media/'));
          draft[key][image] = result.url; checkpoint.images++; save();
        }
      }
      const saved = await post('/api/products/save-images', { items: [draft] });
      assert.equal(saved.updated, 1);
      const reopened = new JsonStore(path.join(process.env.DATA_DIR, 'workspace.json')).read(state => state.products.find(p => p.id === draft.id));
      assert.deepEqual(reopened.mainImages, draft.mainImages);
      assert.deepEqual(reopened.detailImages, draft.detailImages);
      assert.deepEqual(reopened.source, products[index].source, 'Image edits must retain the original source snapshot');
      Object.assign(products[index], reopened);
      checkpoint.finished = new Date().toISOString(); save();
    }
  }
  const response = await fetch(base + '/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: products.map(p => p.id), collectionFolderId: 'performance-qa', mode: 'draft', listingMode: 'auto', publishDelayMinSeconds: 0, publishDelayMaxSeconds: 0 }) });
  assert.equal(response.status, 202); const created = await response.json(); report.jobId = created.id; save();
  const deadline = Date.now() + Math.max(20, products.length * 4) * 60 * 1000;
  for (;;) {
    const job = store.read().jobs.find(job => job.id === created.id);
    if (['completed', 'paused', 'failed', 'cancelled'].includes(job.status)) { report.job = job; break; }
    if (Date.now() > deadline) { await fetch(base + `/api/jobs/${created.id}/pause`, { method: 'POST' }); throw new Error('Bounded performance run timed out'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  for (const product of products) {
    const saved = store.read().products.find(item => item.id === product.id);
    assert.equal(saved.title, product.title); assert.deepEqual(saved.mainImages, product.mainImages); assert.deepEqual(saved.detailImages, product.detailImages);
  }
  assert.equal(report.samples.length, products.length);
  assert.ok(report.samples.every(row => !row.error && row.result?.status === 'drafted' && row.attributesAccepted === true),
    'Every measured draft must pass both save and committed-attribute validation');
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
finally {
  report.finished = new Date().toISOString(); save();
  await server?.shutdownServer(); SellerPublisher.prototype.publishProduct = original;
  fs.rmSync(sessionFile, { force: true });
  console.log(JSON.stringify({ ok: report.ok, version: report.version, samples: report.samples.map(row => ({ id: row.sourceId, ms: row.durationMs, error: row.error })), error: report.error }));
}
