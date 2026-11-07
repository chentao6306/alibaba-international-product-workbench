import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { uploadEditorDetailImages } from '../server/description-image-upload.js';
import { SellerPublisher } from '../server/publisher.js';

async function createEditor(page, scenario) {
  // These URLs identify fixture images; loading a remote server is not part of the test.
  await page.route('https://example.com/**', route => route.abort());
  await page.setContent('<div id="editor" contenteditable="true"><p>Original description</p><img src="https://example.com/original.jpg"></div>');
  await page.evaluate((scenario) => {
    const body = document.querySelector('#editor');
    window.uploads = {};
    window.maxActive = 0;
    let cursorReady = false;
    let groupId = 0;
    const editor = {
      hidden: false, getBody: () => body, save() {}, fire() {}, focus() {},
      selection: {
        select() { cursorReady = true; }, collapse() {}, getBookmark: () => ({}),
      },
      plugins: {},
    };
    const plugin = {
      pendingGroup: {},
      uploader: { cancelUpload() {} },
      checkFilesError: () => false,
      insertAnchorImages(files) {
        if (!cursorReady) return;
        for (const file of files) {
          const node = document.createElement('img');
          node.alt = file.fileUUID;
          node.src = 'https://example.com/loading.gif';
          body.append(node);
        }
      },
      showServerError(error, file) {
        const group = this.pendingGroup[file.groupId];
        if (!group) return;
        for (const item of group.files) body.querySelector(`img[alt="${item.fileUUID}"]`)?.remove();
        delete this.pendingGroup[file.groupId];
      },
      uploadFiles(files) {
        const id = groupId++;
        this.pendingGroup[id] = { files, photoBankXHRs: [] };
        window.maxActive = Math.max(window.maxActive, Object.keys(this.pendingGroup).length);
        for (const file of files) {
          file.groupId = id;
          window.uploads[file.name] = (window.uploads[file.name] || 0) + 1;
          const attempt = window.uploads[file.name];
          if (scenario === 'hang') continue;
          setTimeout(() => {
            if (!this.pendingGroup[id]) return;
            if (['capacity', 'quota', 'auth', 'forbidden'].includes(scenario) || (scenario === 'retry' && file.name === '1.jpg' && attempt === 1)) {
              this.showServerError({ errorCode: ({ capacity: 'noCapacity', quota: 'REQUEST_QUOTA_EXCEEDED', auth: 'UNAUTHORIZED', forbidden: 'FORBIDDEN' })[scenario] || 'UNKNOWN_ERROR', message: 'Platform upload feedback' }, file);
              return;
            }
            file.serverData = { success: true, photobankUrl: `https://example.com/${file.name}`, width: 960, height: 600 };
            const node = body.querySelector(`img[alt="${file.fileUUID}"]`);
            // The platform accepts the image but the editor re-render lost it.
            if (scenario === 'lost-anchor') node?.remove();
            else if (node) { node.src = file.serverData.photobankUrl; node.removeAttribute('alt'); }
            delete this.pendingGroup[id];
          }, 30);
        }
      },
    };
    editor.plugins.alipicpastedrag = plugin;
    window.tinymce = { editors: [editor] };
    window.originalErrorHandler = plugin.showServerError;
  }, scenario);
}

test('ordinary descriptions upload all selected detail images beyond eight and reject incomplete downloads', { skip: !findChromium() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'all-detail-images-'));
  const files = Array.from({ length: 30 }, (_, i) => path.join(root, `${i}.jpg`));
  files.forEach(file => fs.writeFileSync(file, 'fixture'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await createEditor(page, 'normal');
    const publisher = new SellerPublisher(root);
    const product = { detailImages: files.map((_, i) => `https://sc04.alicdn.com/kf/detail-${i}.jpg`) };
    const progress = [];
    publisher.downloadImageSet = async (_product, urls, prefix, limit) => {
      assert.equal(prefix, 'detail');
      assert.deepEqual(urls, product.detailImages);
      return files.slice(0, limit);
    };
    assert.equal(await publisher.uploadLegacyDetailImages(page, product, message => progress.push(message)), 30);
    assert.ok(progress.includes('上传详情图片 30/30'));
    assert.equal(await page.locator('#editor img').count(), 31);
    assert.deepEqual(await page.locator('#editor img').evaluateAll(nodes => nodes.slice(1).map(node => node.src)),
      files.map((_, i) => `https://example.com/${i}.jpg`));
    assert.ok(await page.evaluate(() => window.maxActive <= 3));
    publisher.downloadImageSet = async () => files.slice(0, 29);
    await assert.rejects(publisher.uploadLegacyDetailImages(page, product), { code: 'DETAIL_IMAGE_DOWNLOAD_FAILED' });
    assert.equal(await page.locator('#editor img').count(), 31);
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('detail uploads recover individual failures and lost anchors without duplicating confirmed images', { skip: !findChromium() }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-upload-'));
  const files = Array.from({ length: 8 }, (_, i) => path.join(root, `${i}.jpg`));
  files.forEach((file) => fs.writeFileSync(file, 'fixture'));
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    for (const scenario of ['retry', 'lost-anchor']) await t.test(scenario, async () => {
      const page = await browser.newPage();
      await createEditor(page, scenario);
      assert.equal(await uploadEditorDetailImages(page, files, () => {}, { timeoutMs: 1000, pollMs: 30 }), 8);
      const state = await page.evaluate(() => ({
        urls: [...document.querySelectorAll('#editor img')].map((node) => node.src),
        uploads: window.uploads, maxActive: window.maxActive,
        cleaned: !window.tinymce.editors[0].__workbenchDetailUpload,
        restored: window.tinymce.editors[0].plugins.alipicpastedrag.showServerError === window.originalErrorHandler,
        markers: document.querySelectorAll('[data-workbench-detail-upload]').length
      }));
      assert.equal(state.urls.length, 9);
      assert.equal(new Set(state.urls).size, 9);
      assert.deepEqual(state.urls.slice(1), files.map((file) => `https://example.com/${path.basename(file)}`));
      assert.ok(state.urls.includes('https://example.com/original.jpg'));
      assert.ok(!state.urls.some((url) => url.includes('loading')));
      assert.equal(state.uploads['1.jpg'], scenario === 'retry' ? 2 : 1);
      for (const name of ['0.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg', '7.jpg']) assert.equal(state.uploads[name], 1);
      assert.ok(state.maxActive <= 3);
      assert.ok(state.cleaned && state.restored);
      assert.equal(state.markers, 0);
      await page.close();
    });
    await t.test('permanent capacity errors stop without retrying or counting placeholders', async () => {
      const page = await browser.newPage();
      await createEditor(page, 'capacity');
      await assert.rejects(uploadEditorDetailImages(page, files, () => {}, { timeoutMs: 1000, pollMs: 30 }), (error) => {
        assert.equal(error.code, 'PUBLISH_IMAGE_BANK_FULL');
        assert.equal(error.diagnostics.platformCode, 'noCapacity');
        assert.equal(error.diagnostics.platformMessage, 'Platform upload feedback');
        assert.match(error.message, /完成 0\/8 张.*图片银行空间不足/);
        return true;
      });
      assert.equal(await page.locator('#editor img').count(), 1);
      assert.ok(Object.values(await page.evaluate(() => window.uploads)).every((count) => count === 1));
      assert.ok(Object.keys(await page.evaluate(() => window.uploads)).length <= 3);
      assert.equal(await page.evaluate(() => Object.keys(window.tinymce.editors[0].plugins.alipicpastedrag.pendingGroup).length), 0);
      await page.close();
    });
    for (const scenario of ['quota', 'auth', 'forbidden']) await t.test(`${scenario} retains its diagnostic without claiming storage is full`, async () => {
      const page = await browser.newPage();
      await createEditor(page, scenario);
      await assert.rejects(uploadEditorDetailImages(page, files, () => {}, { timeoutMs: 1000, pollMs: 30 }), (error) => {
        assert.equal(error.code, scenario === 'auth' ? 'LOGIN_REQUIRED' : 'PUBLISH_IMAGE_SERVICE_BLOCKED');
        assert.doesNotMatch(error.message, /空间不足|清理空间/);
        assert.equal(error.diagnostics.completed, 0);
        return true;
      });
      assert.equal(await page.evaluate(() => Object.keys(window.tinymce.editors[0].plugins.alipicpastedrag.pendingGroup).length), 0);
      assert.ok(Object.keys(await page.evaluate(() => window.uploads)).length <= 3);
      await page.close();
    });
    await t.test('hung uploads have bounded retries and cancel their remaining tasks', async () => {
      const page = await browser.newPage();
      await createEditor(page, 'hang');
      await assert.rejects(uploadEditorDetailImages(page, files.slice(0, 1), () => {}, { timeoutMs: 80, maxAttempts: 2, pollMs: 20 }), /完成 0\/1 张.*UPLOAD_TIMEOUT/);
      assert.deepEqual(await page.evaluate(() => window.uploads), { '0.jpg': 2 });
      assert.equal(await page.locator('#editor img').count(), 1);
      assert.equal(await page.evaluate(() => Object.keys(window.tinymce.editors[0].plugins.alipicpastedrag.pendingGroup).length), 0);
      await page.close();
    });
  } finally {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
