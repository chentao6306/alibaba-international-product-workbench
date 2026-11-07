import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher, preparePublishProduct, buildLegacyDescriptionHtml } from '../server/publisher.js';
import { productForVideoUpload, productVideoUploads, videoResourceKey, combineVideoAssociations, requireSupportedVideoPlan, resolveCollectedVideos } from '../server/posting-video.js';
import { currentDescriptionStructure, descriptionSourceHash } from '../server/description-structure.js';
import { compileNativeDescription } from '../server/native-description-fields.js';

test('disabling videos preserves verified native company galleries through publication preparation without reviving stale edits', () => {
  // Sanitized HTML can retain images but omit the original gallery heading.
  // Its verified module snapshot still records the exact native gallery.
  const html = '<section data-module-name="module_structure_descption_companyInfo"><video src="https://example.test/clip.mp4"></video><div data-testid="product-detail-image-simple"><img src="https://example.test/company.jpg"></div></section>';
  const product = { descriptionHtml: html, detailImages: ['https://example.test/company.jpg'],
    videos: [{ role: 'detail', url: 'https://example.test/clip.mp4' }],
    structuredDescription: { version: 1, sourceHtmlHash: descriptionSourceHash(html), modules: [
      { type: 'gallery', scope: 'company', title: 'Extended company profile', images: [{ url: 'https://example.test/company.jpg', caption: '' }] },
    ] }, source: { snapshot: { descriptionHtml: html } } };
  const original = structuredClone(product);
  const disabled = productForVideoUpload(product, { uploadProductVideos: false });
  const prepared = preparePublishProduct(disabled, { uploadProductVideos: false });
  assert.doesNotMatch(prepared.descriptionHtml, /<video/);
  assert.deepEqual(currentDescriptionStructure(prepared).modules, original.structuredDescription.modules);
  const plan = compileNativeDescription(currentDescriptionStructure(prepared), { companyImage: {
    maxImageItem: 30, dataSource: [{ value: '500', enName: 'Extended company profile' }],
  } });
  assert.deepEqual(plan.galleries.map(item => [item.rootId, item.name, item.images.length]), [['companyImage', 'Extended company profile', 1]]);
  assert.deepEqual(product, original);
  const edited = { ...product, descriptionHtml: '<p>Merchant replacement</p><video src="https://example.test/new.mp4"></video>' };
  assert.equal(currentDescriptionStructure(productForVideoUpload(edited, { uploadProductVideos: false })), null);
  assert.equal(currentDescriptionStructure(preparePublishProduct(edited, { uploadProductVideos: false })), null);
});

test('plans main-only, detail-only and combined videos without promoting detail media into the main slot', () => {
  const main = 'https://play.video.alibaba.com/play/u/1/p/1/e/6/t/10300/6001.mp4';
  const detail = 'https://cloud.video.alibaba.com/play/u/1/p/1/e/6/t/1/d/hd/6001.mp4';
  assert.equal(videoResourceKey(main), videoResourceKey(detail));
  assert.deepEqual(productVideoUploads({ videoUrl: main }), [{ role: 'main', url: main }]);
  const onlyDetail = { videos: [{ role: 'detail', url: detail }, { role: 'detail', url: detail }, { role: 'detail', url: '/media/local.mp4' }] };
  assert.deepEqual(productVideoUploads(onlyDetail).map(video => video.role), ['detail', 'detail']);
  assert.equal(preparePublishProduct(onlyDetail).videoUrl, '');
  assert.equal(preparePublishProduct({ videos: [{ role: 'main', url: main }] }).videoUrl, main);
  assert.deepEqual(productVideoUploads({ ...onlyDetail, videoUrl: main }).map(video => video.role), ['main', 'detail', 'detail']);
  assert.deepEqual(productVideoUploads(onlyDetail, { uploadProductVideos: false }), []);
  assert.doesNotMatch(buildLegacyDescriptionHtml(onlyDetail), /Product Detail Video|View source product video/);
  const items = [{ id: '1', productId: '99', role: 'main', associated: true }, { id: '1', productId: '99', role: 'detail', associated: false, warning: 'detail pending' }];
  assert.equal(combineVideoAssociations(items).associated, false);
  assert.equal(combineVideoAssociations(items).warning, 'detail pending');
  assert.equal(combineVideoAssociations(items.map(item => ({ ...item, associated: true }))).associated, true);
});

test('detail video processing skips all work when disabled and reuses a matching main-video upload', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('Unexpected video network or upload work'); } });
  const product = { videoUrl: 'https://play.video.alibaba.com/6001.mp4', videos: [{ role: 'detail', url: 'https://cloud.video.alibaba.com/6001.mp4' }] };
  assert.deepEqual(await SellerPublisher.prototype.uploadDetailVideos.call(forbidden, forbidden, product, null, { uploadProductVideos: false }), []);
  const bank = { id: '987', name: 'same.mp4', bankUrl: 'https://hz-productposting.alibaba.com/product/videobank/home.htm' };
  const result = await SellerPublisher.prototype.uploadDetailVideos.call(forbidden, forbidden, product, { bank });
  assert.deepEqual(result, [{ bank: { ...bank, role: 'detail' }, sourceUrl: product.videos[0].url }]);
  assert.equal(bank.role, undefined);
  const multiple = { ...product, videos: [...product.videos, { role: 'detail', url: 'https://example.test/second.mp4' }] };
  const selected = requireSupportedVideoPlan(multiple, { bank });
  assert.deepEqual(selected.map(video => video.role), ['main', 'detail']);
  assert.match((selected.warnings || []).join(' '), /只支持一段/);
  const localSelected = requireSupportedVideoPlan({ ...multiple, videos: [...product.videos, { role: 'detail', url: '/media/second.mp4' }] }, { bank });
  assert.deepEqual(localSelected.map(video => video.role), ['main', 'detail']);
  assert.deepEqual(requireSupportedVideoPlan(multiple, { uploadProductVideos: false }), []);
});

test('source gallery placement wins over JSON-LD and a detail-only clip is not promoted to a main video', () => {
  const detail = { role: 'detail', url: 'https://cloud.video.alibaba.com/6001.mp4', source: 'dom' };
  const json = { role: 'main', url: 'https://play.video.alibaba.com/6001.mp4', source: 'json-ld' };
  const main = { role: 'main', url: 'https://example.test/gallery.mp4', source: 'dom' };
  const all = [json, detail, main], snapshot = structuredClone(all);
  const both = resolveCollectedVideos(all);
  assert.equal(both.videoUrl, main.url);
  assert.deepEqual(productVideoUploads(both).map(video => [video.role, videoResourceKey(video.url)]), [['main', main.url], ['detail', 'alibaba-video:6001']]);
  const detailOnly = resolveCollectedVideos([json, detail]);
  assert.equal(detailOnly.videoUrl, '');
  assert.deepEqual(productVideoUploads(detailOnly).map(video => video.role), ['detail']);
  assert.equal(resolveCollectedVideos([main, { ...json, url: 'https://example.test/unclassified.mp4' }]).videos[1].role, 'unclassified');
  assert.deepEqual(all, snapshot);
});

test('enabled video failures stop the pre-submission flow for both public and local files', async () => {
  for (const url of ['https://example.test/main.mp4', '/media/main.mp4']) {
    let details = 0;
    const publisher = { uploadMainVideo: async () => { throw new Error('transport failed'); }, uploadDetailVideos: async () => { details++; } };
    await assert.rejects(SellerPublisher.prototype.uploadProductVideos.call(publisher, {}, { videoUrl: url }), { code: 'PUBLISH_VIDEO_UPLOAD_FAILED' });
    assert.equal(details, 0);
    await assert.rejects(SellerPublisher.prototype.uploadDetailVideos.call({ downloadProductVideo: async () => { throw new Error('transport failed'); } },
      { evaluate: async () => ({ config: { url: 'https://hz-productposting.alibaba.com/product/videobank/popSelect.htm' } }) },
      { videos: [{ role: 'detail', url }] }, null), /当前商品尚未提交/);
  }
  const forbidden = new Proxy({}, { get() { assert.fail('No video work when disabled'); } });
  assert.deepEqual(await SellerPublisher.prototype.uploadProductVideos.call(forbidden, forbidden, { videoUrl: '/media/video.mp4' }, { uploadProductVideos: false }), { main: null, details: [] });
});

const videoProduct = { videoUrl: 'https://example.test/main.mp4', videos: [{ url: 'https://example.test/detail.mp4', role: 'detail' }],
  title: 'QA product', price: 10, mainImages: ['https://example.test/main.jpg'],
  descriptionHtml: '<p>Product facts</p><video src="https://example.test/detail.mp4"><source src="https://example.test/extra.mp4"></video><iframe src="https://example.test/player"></iframe>',
  structuredDescription: { html: '<video src="https://example.test/detail.mp4"></video><p>Details</p>', videos: ['https://example.test/detail.mp4'] },
  sourceSnapshot: { videoUrl: 'https://example.test/original.mp4' } };

test('disabled videos omit main and embedded detail media without changing the saved product or original snapshot', async () => {
  const original = structuredClone(videoProduct);
  const disabled = preparePublishProduct(videoProduct, { uploadProductVideos: false });
  assert.equal(disabled.videoUrl, ''); assert.deepEqual(disabled.videos, []);
  assert.doesNotMatch(buildLegacyDescriptionHtml(disabled), /<video|<source|<iframe|Product Video|\.mp4/i);
  assert.match(buildLegacyDescriptionHtml(disabled), /Product facts/);
  assert.match(disabled.structuredDescription.html, /Details/);
  assert.doesNotMatch(disabled.structuredDescription.html, /video|mp4/);
  assert.deepEqual(disabled.mainImages, original.mainImages);
  assert.deepEqual(videoProduct, original);
  assert.strictEqual(productForVideoUpload(videoProduct), videoProduct);
  assert.equal(preparePublishProduct(videoProduct, { uploadProductVideos: true }).videoUrl, original.videoUrl);
  assert.doesNotMatch(buildLegacyDescriptionHtml(preparePublishProduct(videoProduct)), /Product Video|View source product video|<video|<source/);
  // No browser probe, download, file selection or bank page may run when off,
  // even for a local video that normally cannot fall back to a public link.
  const forbidden = new Proxy({}, { get() { assert.fail('Disabled video path accessed the browser or downloader'); } });
  for (const videoUrl of [videoProduct.videoUrl, '/media/local-video.mp4']) {
    assert.equal(await SellerPublisher.prototype.uploadMainVideo.call(forbidden, forbidden, { videoUrl }, { uploadProductVideos: false }), 0);
  }
});

test('video setting migrates old workspaces, persists across reopen and reaches draft and submission jobs per product', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-setting-'));
  process.env.DATA_DIR = root; process.env.PORT = '0';
  const store = new JsonStore(path.join(root, 'workspace.json'));
  assert.equal(store.read().settings.uploadProductVideos, true);
  store.update(state => {
    delete state.settings.uploadProductVideos; // Existing installations have no field yet.
    state.collectionFolders = [{ id: 'folder', name: 'QA' }];
    state.products = ['default', 'off-draft', 'off-submit', 'next-item'].map((id, index) => ({ ...structuredClone(videoProduct), id,
      sourceId: String(12345678901 + index), sourcePlatform: 'alibaba.com', categoryId: '201346401',
      collectionFolderId: 'folder', status: 'ready', attributes: [] }));
  });
  const original = SellerPublisher.prototype.publishProduct, received = [];
  SellerPublisher.prototype.publishProduct = async (product, _url, mode, _category, _job, _stage, options) => {
    received.push({ id: product.id, mode, enabled: options.uploadProductVideos });
    assert.equal(product.videoUrl, videoProduct.videoUrl);
    if (product.id === 'off-submit') store.update(state => { state.settings.uploadProductVideos = true; });
    return { status: mode === 'draft' ? 'drafted' : 'published', message: 'fixture receipt', url: 'https://post.alibaba.com/product/success.htm?primaryId=123456' };
  };
  const server = await import('../server/index.js'), listener = await server.serverReady;
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const publish = async (ids, mode) => {
    const { data: job, status } = await api('/api/publish', { ids, collectionFolderId: 'folder', mode });
    assert.equal(status, 202);
    const end = Date.now() + 6000;
    while (store.read().jobs.find(row => row.id === job.id)?.status !== 'completed' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
    const saved = store.read().jobs.find(row => row.id === job.id);
    assert.equal(saved.status, 'completed');
    assert.ok(Object.values(saved.results).every(result => result.status !== 'failed'));
  };
  try {
    assert.equal(store.read().settings.uploadProductVideos, true);
    await publish(['default'], 'draft');
    assert.equal((await api('/api/settings', { uploadProductVideos: false }, 'PATCH')).status, 200);
    for (const value of ['false', 0, null]) assert.equal((await api('/api/settings', { uploadProductVideos: value }, 'PATCH')).status, 400);
    await api('/api/settings', { priceMarkup: 1 }, 'PATCH');
    assert.equal(new JsonStore(store.filePath).read().settings.uploadProductVideos, false);
    await publish(['off-draft'], 'draft');
    await publish(['off-submit', 'next-item'], 'submit');
    assert.deepEqual(received, [
      { id: 'default', mode: 'draft', enabled: true }, { id: 'off-draft', mode: 'draft', enabled: false },
      { id: 'off-submit', mode: 'submit', enabled: false }, { id: 'next-item', mode: 'submit', enabled: true },
    ]);
    assert.equal(new JsonStore(store.filePath).read().settings.uploadProductVideos, true);
    for (const product of store.read().products) {
      assert.equal(product.videoUrl, videoProduct.videoUrl);
      assert.deepEqual(product.videos, videoProduct.videos);
    }
  } finally {
    await server.shutdownServer(); SellerPublisher.prototype.publishProduct = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
