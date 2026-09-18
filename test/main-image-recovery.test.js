import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher, mainImageUploadRecords, restoreMainImageOrder } from '../server/publisher.js';

test('re-enters a delayed main-image hover menu without opening the image bank', { skip: !findChromium(), timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-image-hover-'));
  const files = ['one', 'two', 'three', 'four'].map(name => {
    const file = path.join(directory, name + '.jpg'); fs.writeFileSync(file, 'fixture'); return file;
  });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="image-uploader" style="height:80px"></div><div style="height:2400px"></div><div id="logistics">物流</div><div class="sc-images-upload-dropdown" style="display:none;position:fixed"><input type="file" multiple accept="image/jpeg"></div>');
    await page.evaluate(() => {
      window.entries = 0; window.bankOpened = false;
      const root = document.querySelector('.image-uploader'), portal = document.querySelector('.sc-images-upload-dropdown');
      for (let i = 0; i < 6; i++) {
        const slot = document.createElement('div'); slot.className = 'image-upload-list-item'; slot.style.cssText = 'display:inline-block;width:90px;height:80px';
        slot.innerHTML = '<span id="image-placeholder-span">上传图片</span>';
        slot.onmouseenter = () => {
          if (++window.entries < 2) return;
          const box = slot.getBoundingClientRect(); portal.style.left = box.x + 'px'; portal.style.top = box.bottom + 'px'; portal.style.display = 'block';
        };
        slot.onclick = () => { window.bankOpened = true; };
        root.append(slot);
      }
      portal.querySelector('input').onchange = event => {
        [...event.target.files].forEach((file, i) => {
          root.children[i].innerHTML = '<img src="https://example.com/' + file.name + '" width="30" height="30">';
        }); portal.style.display = 'none';
      };
    });
    await page.locator('#logistics').scrollIntoViewIfNeeded();
    const publisher = new SellerPublisher(directory);
    publisher.waitForMainImageUploads = async () => 4;
    assert.equal(await publisher.uploadMainImageBatch(page, files), 4);
    assert.equal(await page.evaluate(() => window.bankOpened), false);
    assert.ok(await page.evaluate(() => window.entries >= 2));
    assert.equal(await page.locator('.image-uploader img').count(), 4);
  } finally {
    await browser.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('failed main-image records can be removed and source order restored without removing accepted files', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="image-uploader"><ul></ul></div><div id="unrelated">Unrelated image</div>');
    await page.evaluate(() => {
      const files = [
        { uid: 'a', fileName: 'first.jpg', status: 'error', error: { code: 0, isRequestError: true } },
        { uid: 'b', fileName: 'second.jpg', status: 'done', fileURL: 'https://example.com/second.jpg' },
        { uid: 'c', fileName: 'private.jpg', status: 'error', error: { code: 403, isRequestError: true } },
      ];
      window.removed = [];
      window.files = files;
      window.render = () => {
        const list = document.querySelector('.image-uploader ul');
        list.replaceChildren();
        const props = {
          fileList: window.files,
          onRemove: (file) => { window.removed.push(file.uid); window.files = window.files.filter((item) => item.uid !== file.uid); window.render(); },
          onSort: (sorted) => { window.files = sorted; window.render(); }
        };
        for (const file of window.files) {
          const node = document.createElement('li'); node.className = 'image-upload-list-item'; node.textContent = file.fileName;
          node.__reactFiber$test = { memoizedProps: { file }, return: { memoizedProps: props } };
          list.append(node);
        }
      };
      window.render();
    });
    const publisher = new SellerPublisher('.');
    await assert.rejects(publisher.waitForMainImageUploads(page, 3), { code: 'MAIN_IMAGE_UPLOAD_FAILED' });
    const records = await mainImageUploadRecords(page, ['first.jpg', 'second.jpg', 'private.jpg']);
    assert.equal(records.filter((file) => file.removed).length, 1);
    assert.deepEqual(await page.evaluate(() => window.removed), ['a']);
    await page.evaluate(() => {
      window.files = window.files.filter((file) => file.uid !== 'c');
      window.files.push({ uid: 'a2', fileName: 'first.jpg', status: 'done', fileURL: 'https://example.com/first.jpg' });
      window.render();
    });
    assert.equal(await restoreMainImageOrder(page, ['first.jpg', 'second.jpg']), true);
    assert.deepEqual((await mainImageUploadRecords(page)).map((file) => file.name), ['first.jpg', 'second.jpg']);
    assert.equal(await restoreMainImageOrder(page, ['other.jpg', 'second.jpg']), false);
    assert.equal(await page.locator('#unrelated').innerText(), 'Unrelated image');
    await page.evaluate(() => {
      window.files = ['first', 'second', 'third', 'fourth'].map((name, index) => ({
        uid: name, fileName: `${name}.jpg`, status: index < 2 ? 'error' : 'done',
        ...(index < 2 ? { error: { code: 0, isRequestError: true } } : { fileURL: `https://example.com/${name}.jpg` })
      }));
      window.render();
    });
    const filenames = ['first.jpg', 'second.jpg', 'third.jpg', 'fourth.jpg'];
    publisher.downloadImageSet = async () => filenames;
    let batches = 0;
    publisher.uploadMainImageBatch = async () => {
      batches++;
      if (batches === 1) return publisher.waitForMainImageUploads(page, 4);
      assert.deepEqual((await mainImageUploadRecords(page)).map((file) => file.name), ['third.jpg', 'fourth.jpg']);
      await page.evaluate(() => {
        window.files.push(...['first', 'second'].map((name) => ({ uid: `${name}-retry`, fileName: `${name}.jpg`, status: 'done', fileURL: `https://example.com/${name}.jpg` })));
        window.render();
      });
      return 2;
    };
    await publisher.uploadMainImages(page, {});
    assert.equal(batches, 2);
    assert.deepEqual((await mainImageUploadRecords(page)).map((file) => file.name), filenames);
    assert.deepEqual(await page.evaluate(() => window.files.slice(2).map((file) => file.uid)), ['third', 'fourth']);
  } finally { await browser.close(); }
});
