import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { publicProductVideoUrl, readPostingVideoState, browserVideoResponse, newlyAcceptedVideo, requireAcceptedInlineVideo, combineVideoAssociations } from '../server/posting-video.js';
import { SellerPublisher, buildLegacyDescriptionHtml } from '../server/publisher.js';
import { videoContentName, completePublishedVideo, waitForBankVideoReady, bankVideoAssociation, prepareBankVideo } from '../server/posting-video-bank.js';

test('verified video roles clear their obsolete warnings while pending roles retain the current failure', () => {
  const main = { id: '6001', role: 'main', associated: true, warning: 'old main error' };
  const detail = { id: '6002', role: 'detail', associated: false, warning: 'current detail error' };
  const combined = combineVideoAssociations([main, detail]);
  assert.equal(combined.associated, false);
  assert.equal(combined.warning, detail.warning);
  assert.equal(combined.items[0].warning, '');
  assert.equal(combineVideoAssociations([main]).warning, '');
  assert.equal(main.warning, 'old main error', 'Earlier receipt must remain unchanged');
});

test('an old preview cannot confirm a new upload and later control rebuilds must retain the exact video', () => {
  const old = { id: '10', url: 'https://example.test/old.mp4', status: 'done' };
  const next = { id: '11', url: 'https://example.test/new.mp4', status: 'done' };
  const before = { records: [old], previews: [old.url], accepted: true };
  assert.equal(newlyAcceptedVideo(before, before), null);
  assert.equal(newlyAcceptedVideo(before, { records: [], previews: [next.url], accepted: true }), null);
  assert.equal(newlyAcceptedVideo(before, { records: [next], pending: true }), null);
  assert.equal(newlyAcceptedVideo(before, { records: [{ ...next, status: 'rejected' }] }), null);
  assert.deepEqual(newlyAcceptedVideo(before, { records: [old, next] }), next);
  requireAcceptedInlineVideo({ records: [next] }, next);
  for (const state of [{ records: [old] }, { records: [next], pending: true }, { records: [{ ...next, status: 'error' }] }]) {
    assert.throws(() => requireAcceptedInlineVideo(state, next), { code: 'PUBLISH_VIDEO_BINDING_LOST' });
  }
});

test('inline main upload targets the main media control and waits for a new identity despite an old ready preview', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-video-slot-'));
  try {
    const file = path.join(directory, 'main.mp4'); fs.writeFileSync(file, 'test video');
    const page = await browser.newPage();
    await page.setContent(`<div class="posting-field-media" id="imageMedia"><button class="video-upload-placeholder">Video</button><input id="main" type="file" accept="video/*"></div>
      <div id="detailImage"><input id="detail" type="file" accept="video/*"></div><script>
        const model={id:'imageMedia',value:[{type:'video',videoId:'old',url:'https://example.test/old.mp4',status:'done'}],mediaConfig:{video:{visible:true}}};
        document.querySelector('#imageMedia').__reactFiberTest={memoizedProps:model};
        document.querySelector('#detail').onchange=()=>window.wrongSlot=true;
        document.querySelector('#main').onchange=()=>setTimeout(()=>{model.value=[{type:'video',videoId:'new',url:'https://example.test/new.mp4',status:'done'}];},1000);
      </script>`);
    const result = await SellerPublisher.prototype.uploadMainVideo.call({ downloadProductVideo: async () => file }, page, { videos: [{ role: 'main', url: 'https://example.test/source.mp4' }] });
    assert.equal(result.inline.id, 'new');
    assert.equal(await page.evaluate(() => Boolean(window.wrongSlot)), false);
    requireAcceptedInlineVideo(await page.evaluate(readPostingVideoState), result.inline);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('video association failure preserves the confirmed publication and its exact product receipt', async () => {
  const video = { id: '6001', name: 'video', bankUrl: 'https://hz-productposting.alibaba.com/product/videobank/home.htm' };
  let calls = 0;
  const result = await completePublishedVideo(null, video, 'https://post.alibaba.com/product/success.htm?primaryId=123456', async (_page, received, id) => {
    calls++;
    assert.deepEqual(received, video);
    assert.equal(id, '123456');
    throw new Error('Connection closed');
  });
  assert.equal(calls, 1);
  assert.equal(result.productId, '123456');
  assert.equal(result.associated, false);
  assert.match(result.warning, /商品已发布/);
  assert.equal((await completePublishedVideo(null, video, 'invalid receipt')).associated, false);
  let aborted = false;
  const timedOut = await completePublishedVideo(null, video, 'https://post.alibaba.com/product/success.htm?primaryId=123456', async (_page, _video, _id, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    await new Promise(() => {});
  }, { timeoutMs: 20 });
  assert.equal(aborted, true);
  assert.equal(timedOut.associated, false);
  assert.equal(timedOut.productId, '123456');
  assert.match(timedOut.warning, /商品已发布.*超时/);
});

test('video submission waits for upload completion and usable covers even when Submit is enabled', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://example.test/cover.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64') }));
    await page.setContent('<input id="videoName" value="copyfast-test.mp4"><button>Submit</button><div class="upload-common upload-complete"></div><div class="upload-common upload-cover"></div>');
    assert.equal(await page.getByRole('button', { name: 'Submit' }).isEnabled(), true);
    await assert.rejects(waitForBankVideoReady(page, 'copyfast-test.mp4', 200));
    await page.locator('.upload-complete').evaluate(node => { node.innerHTML = '<img src="https://example.test/cover.png">'; });
    await assert.rejects(waitForBankVideoReady(page, 'copyfast-test.mp4', 200));
    await page.locator('.upload-cover').evaluate(node => { node.innerHTML = '<img src="https://example.test/cover.png">'; });
    await assert.rejects(waitForBankVideoReady(page, 'wrong-file.mp4', 200));
    await waitForBankVideoReady(page, 'copyfast-test.mp4', 3000);
  } finally { await browser.close(); }
});

test('video bank deduplication keys come from bytes rather than filenames', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-bank-'));
  try {
    const first = path.join(directory, 'a.mp4'), second = path.join(directory, 'b.mp4');
    fs.writeFileSync(first, 'same bytes'); fs.writeFileSync(second, 'same bytes');
    assert.equal(await videoContentName(first), await videoContentName(second));
    fs.writeFileSync(second, 'changed bytes');
    assert.notEqual(await videoContentName(first), await videoContentName(second));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('first bank upload submits the confirmed Chinese tag selection and reuses the uploaded file', { skip: !findChromium() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-bank-upload-'));
  const file = path.join(directory, 'source.mp4'); fs.writeFileSync(file, 'bounded fixture video');
  const name = `${await videoContentName(file)}.mp4`;
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const context = await browser.newContext(); let submitted = 0;
  await context.addCookies([{ name: 'xman_us_t', value: 'sign=y&x_lid=fixture-account', domain: '.alibaba.com', path: '/' }]);
  try {
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const row = `<tr><td><span class="list-item-name" title="${name}">${name}</span>VID: 6001<span class="list-item-status-approved">审核通过</span></td></tr>`;
      let body;
      if (url.pathname.endsWith('cover.png')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64') });
      if (url.pathname.endsWith('search')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: submitted ? row : '' });
      if (url.pathname.endsWith('submit')) { submitted++; return route.fulfill({ body: 'ok' }); }
      if (url.pathname.endsWith('popSelect.htm')) body = '<a href="home.htm">管理视频</a>';
      else if (url.pathname.endsWith('home.htm')) body = `<input placeholder="请输入视频名称"><button onclick="fetch('search').then(r=>r.text()).then(html=>document.querySelector('tbody').innerHTML=html)">搜索</button><table><tbody>${submitted ? row : ''}</tbody></table><button onclick="window.open('upload.htm')">上传视频</button>`;
      else body = `<input id="icbu-uploader-input" type="file"><div id="form" hidden><input id="videoName"><div class="upload-common upload-complete"><img src="cover.png"></div><div class="upload-common upload-cover"><img src="cover.png"></div><button onclick="document.querySelector('#tags').textContent='已选 1个标签'">产品展示</button><div id="tags"></div><button onclick="fetch('submit',{method:'POST'}).then(()=>document.querySelector('#done').textContent='视频提交成功')">提交</button><div id="done"></div></div><script>document.querySelector('#icbu-uploader-input').onchange=event=>{document.querySelector('#videoName').value=event.target.files[0].name;document.querySelector('#form').hidden=false;event.target.remove();};</script>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    const page = await context.newPage();
    const first = await prepareBankVideo(page, file, directory, 'https://hz-productposting.alibaba.com/product/videobank/popSelect.htm');
    assert.equal(first.id, '6001'); assert.equal(submitted, 1);
    assert.equal((await prepareBankVideo(page, file, directory, 'https://hz-productposting.alibaba.com/product/videobank/popSelect.htm')).id, first.id);
    assert.equal(submitted, 1, 'An existing matching upload must not submit again');
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('video association accepts link and button actions, preserves duration rejection and verifies exact idempotent readback', { skip: !findChromium() }, async t => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    for (const mode of ['a', 'button', 'delayed-control', 'detail', 'lazy-main', 'lazy-detail', 'grid-main', 'grid-detail', 'chinese-main', 'chinese-detail', 'duration-limit']) {
      await t.test(mode, async () => {
      const chinese = mode.startsWith('chinese-');
      const detail = mode === 'detail' || mode.endsWith('-detail');
      const grid = mode.startsWith('grid-');
      const lazy = mode.startsWith('lazy-') || grid;
      const tag = mode === 'button' ? 'button' : 'a';
      const context = await browser.newContext();
      let linked = false, writes = 0;
      const bankUrl = 'https://hz-productposting.alibaba.com/product/videobank/home.htm';
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        let body;
        if (url.pathname.endsWith('/associate-test')) {
          assert.equal(route.request().postData(), '123456');
          linked = true; writes++;
          await route.fulfill({ body: 'ok' }); return;
        }
        if (url.pathname.endsWith('/linked_products.htm')) {
          body = linked || detail ? `<table><thead><tr><th>Product name</th><th>${chinese ? '展示状态' : 'Display status'}</th></tr></thead><tbody><tr><td><a href="https://www.alibaba.com/product-detail/test_123456.html">Details video</a></td><td><div>${chinese ? '主图视频' : 'Primary video'}</div>${detail && linked ? `<div>${chinese ? '详情视频' : 'Video for product detail'}</div>` : ''}</td></tr></tbody></table>`
            : '<table></table><p>No linked products!</p>';
        } else if (url.pathname.endsWith('/select-test')) {
          body = `<input id="productId"><button>Search</button>
            ${grid ? '<div class="next-row"><div class="next-col"><div class="popup-item">' : '<table><tbody><tr><td>'}<div class="popup-item-img-wrapper" style="width:120px;height:100px" ${lazy ? `onmouseenter="if(!this.querySelector('input'))setTimeout(()=>this.innerHTML='<label><input type=checkbox value=123456>Exact product</label>',100)"` : ''}>${lazy ? 'Product image' : '<label><input type="checkbox" value="123456">Exact product</label>'}</div><div class="popup-item-description"><a href="https://www.alibaba.com/product-detail/test_123456.html">Exact product</a></div>${grid ? '</div></div></div>' : '</td></tr></tbody></table>'}
            <div class="popup-item-img-wrapper"><label><input type="checkbox" value="654321">Other product</label></div>
            <button id="confirm" ${mode === 'delayed-control' ? 'disabled' : ''} onclick="parent.postMessage([...document.querySelectorAll('input:checked')].map(n=>n.value).join(','),'*')">Confirm</button>${mode === 'delayed-control' ? `<script>addEventListener('click', event => { if (event.target.type === 'checkbox') setTimeout(() => document.querySelector('#confirm').disabled = false, 5000); });</script>` : ''}`;
        } else {
          const action = mode === 'duration-limit' ? "document.querySelector('#duration-error').hidden=false;return false"
            : "document.querySelector('.icbu-product-select').hidden=false;return false";
          body = `<input placeholder="${chinese ? '请输入视频名称' : 'Video name'}"><button>${chinese ? '搜索' : 'Search'}</button><table><tbody><tr><td>
            <button class="list-item-name" title="exact.mp4">exact.mp4</button>VID: 6001
            <span class="list-item-status-approved">Approved</span>
            <${tag} href="#" onclick="${detail ? "throw Error('Wrong main action')" : action}">${chinese ? '关联产品主图' : 'Relate Product'}</${tag}>
            <button onclick="${detail ? action : "throw Error('Wrong details action')"}">${chinese ? '关联产品详情' : 'Relate Product Details'}</button>
            </td></tr></tbody></table><div class="icbu-product-select" hidden><iframe src="select-test"></iframe></div>
            <p id="duration-error" hidden>Only the video duration within 45 seconds can be related to the product as the main image video</p>
            <script>addEventListener('message', async event => { await fetch('associate-test',{method:'POST',body:event.data}); document.querySelector('.icbu-product-select').hidden=true; });</script>`;
        }
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
      });
      try {
        const page = await context.newPage();
        const video = { id: '6001', name: 'exact.mp4', bankUrl, role: detail ? 'detail' : 'main' };
        if (mode === 'duration-limit') {
          await assert.rejects(bankVideoAssociation(page, video, '123456'), error => error.code === 'PUBLISH_VIDEO_DURATION_LIMIT' && /45 秒/.test(error.message));
          assert.equal(writes, 0, 'Rejected videos must not alter any product');
          return;
        }
        assert.equal((await bankVideoAssociation(page, video, '123456')).associated, true);
        assert.equal((await bankVideoAssociation(page, video, '123456')).alreadyAssociated, true);
        assert.equal(writes, 1, 'Reading an existing association must not write again');
      } finally { await context.close(); }
      });
    }
  } finally { await browser.close(); }
});

test('description content does not substitute source links for native video placement, including templates', () => {
  for (const videoUrl of ['/media/video.mp4', 'file:///c:/video.mp4', 'http://127.0.0.1/video.mp4', 'javascript:alert(1)', 'https://user:password@example.test/video.mp4']) {
    assert.equal(publicProductVideoUrl({ videoUrl }), '');
    assert.ok(!buildLegacyDescriptionHtml({ title: 'Product', videoUrl }).includes('Product Video:'));
  }
  const product = { title: 'Product', videoUrl: 'https://example.test/source.mp4', descriptionTemplate: { sections: [] } };
  assert.ok(!buildLegacyDescriptionHtml(product).includes('https://example.test/source.mp4'));
  assert.doesNotMatch(buildLegacyDescriptionHtml({ ...product, descriptionTemplate: undefined,
    descriptionHtml: '<p>Original description</p><video src="https://example.test/source.mp4"></video>' }), /video|\.mp4/);
});

test('video receipts do not mistake image, pending or rejected records for accepted uploads', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="posting-field-media" id="imageMedia"></div>');
    const state = async value => {
      await page.evaluate(value => { document.querySelector('#imageMedia').__reactFiberTest = { memoizedProps: { id: 'imageMedia', value, mediaConfig: { video: { visible: true } } } }; }, value);
      return page.evaluate(readPostingVideoState);
    };
    assert.equal((await state([{ type: 'image', id: 1, url: 'https://example.test/main.jpg' }])).accepted, false);
    assert.equal((await state([{ type: 'video', id: 2, status: 'uploading' }])).accepted, false);
    assert.equal((await state([{ type: 'video', id: 2, status: 'error' }])).accepted, false);
    assert.equal((await state([{ type: 'video', id: 2, status: 'done' }])).accepted, true);
    assert.equal((await state([{ videoId: '123', videoUrl: 'https://example.test/video.mp4' }])).accepted, true);
    const wrapped = await state({ itemList: [{ type: 'video', id: 987, mediaStatus: 'approved' }] });
    assert.equal(wrapped.accepted, true);
    assert.equal(wrapped.records[0].id, 987);
    assert.equal((await state({ itemList: [{ type: 'video', id: 987, mediaStatus: 'rejected' }] })).accepted, false);
  } finally { await browser.close(); }
});

test('video download writes bounded chunks and removes partial files on corrupt responses', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posting-video-'));
  const publisher = new SellerPublisher(directory);
  try {
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4', 'content-length': '3' } }));
    const file = await publisher.downloadProductVideo({ videoUrl: 'https://example.test/clip.mp4' });
    assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3]);
    for (const response of [
      new Response('<html>Error</html>', { headers: { 'content-type': 'text/html' } }),
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/mp4', 'content-length': '3' } }),
      new Response('', { headers: { 'content-type': 'video/mp4' } }),
      new Response('', { headers: { 'content-length': String(101 * 1024 * 1024) } }),
    ]) {
      globalThis.fetch.mock.mockImplementation(async () => response);
      await assert.rejects(publisher.downloadProductVideo({ videoUrl: 'https://example.test/bad.mp4' }));
      assert.equal(fs.readdirSync(publisher.videoDir).length, 1);
    }
  } finally { await publisher.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

function browserVideoFixture({ headers = { 'content-type': 'video/mp4', 'content-length': '6' }, status = 200, failRead = false } = {}) {
  const calls = []; let index = 0;
  const session = { async send(method, options) {
    calls.push({ method, options });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'source-frame' } } };
    if (method === 'Network.loadNetworkResource') return { resource: { success: true, httpStatusCode: status, stream: 'video-stream', headers } };
    if (method === 'IO.read') {
      if (failRead && index) throw new Error('Connection interrupted');
      return { data: Buffer.from(index++ ? [4, 5, 6] : [1, 2, 3]).toString('base64'), base64Encoded: true, eof: index === 2 };
    }
    return {};
  }, async detach() { calls.push({ method: 'detach' }); } };
  return { calls, page: { context: () => ({ newCDPSession: async () => session }) } };
}

test('video transport recovers through bounded browser streaming and releases handles on rejected or partial downloads', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-video-'));
  const publisher = new SellerPublisher(directory);
  const product = { videoUrl: 'https://example.test/clip.mp4', sourceUrl: 'https://example.test/product' };
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  try {
    const fixture = browserVideoFixture();
    const file = await publisher.downloadProductVideo(product, fixture.page);
    assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3, 4, 5, 6]);
    const request = fixture.calls.find(call => call.method === 'Network.loadNetworkResource').options;
    assert.equal(request.url, product.videoUrl);
    assert.equal(request.options.includeCredentials, false);
    assert.ok(fixture.calls.filter(call => call.method === 'IO.read').every(call => call.options.size <= 256 * 1024));
    assert.equal(fixture.calls.filter(call => call.method === 'IO.close').length, 1);
    assert.equal(fixture.calls.filter(call => call.method === 'detach').length, 1);
    for (const options of [
      { status: 403 }, { headers: { 'content-type': 'text/html' } },
      { headers: { 'content-length': String(101 * 1024 * 1024) } },
      { headers: { 'content-length': '7' } }, { failRead: true },
    ]) {
      const bad = browserVideoFixture(options);
      await assert.rejects(publisher.downloadProductVideo(product, bad.page));
      assert.equal(fs.readdirSync(publisher.videoDir).length, 1, 'Only the complete first video may remain');
      assert.equal(bad.calls.filter(call => call.method === 'IO.close').length, 1);
      assert.equal(bad.calls.filter(call => call.method === 'detach').length, 1);
      if (options.status || options.headers?.['content-type'] === 'text/html' || Number(options.headers?.['content-length']) > 100 * 1024 * 1024) {
        assert.equal(bad.calls.some(call => call.method === 'IO.read'), false);
      }
    }
  } finally { await publisher.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('aborting a browser video stream closes its handle without reading further chunks', async () => {
  const controller = new AbortController();
  const fixture = browserVideoFixture();
  const response = await browserVideoResponse(fixture.page, 'https://example.test/video.mp4', { signal: controller.signal });
  const first = await response.body.next(); assert.equal(first.value.length, 3);
  controller.abort();
  await assert.rejects(response.body.next(), { name: 'AbortError' });
  assert.equal(fixture.calls.filter(call => call.method === 'IO.read').length, 1);
  assert.equal(fixture.calls.filter(call => call.method === 'IO.close').length, 1);
  assert.equal(fixture.calls.filter(call => call.method === 'detach').length, 1);
});
