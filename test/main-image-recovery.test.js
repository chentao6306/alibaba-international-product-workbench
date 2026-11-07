import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { SellerPublisher, mainImageUploadRecords, restoreMainImageOrder } from '../server/publisher.js';
import { publishEnvironmentBlockCode } from '../server/publish-recovery.js';
import { userFacingError } from '../server/browser-error.js';

test('recovers a partial two-image receipt by uploading only missing files and preserving accepted IDs', { skip: !findChromium(), timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-image-partial-'));
  const files = ['one', 'two', 'three', 'four'].map((name) => {
    const file = path.join(directory, `${name}.jpg`); fs.writeFileSync(file, 'fixture'); return file;
  });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="image-uploader"></div>');
    await page.evaluate(() => {
      window.files = []; window.dispatched = [];
      window.render = () => {
        const root = document.querySelector('.image-uploader'); root.replaceChildren();
        const props = { fileList: window.files, onRemove: () => { throw new Error('Accepted images must remain'); },
          onSort: (sorted) => { window.files = sorted; window.render(); } };
        for (let i = 0; i < 6; i++) {
          const slot = document.createElement('div'); slot.className = 'image-upload-list-item';
          slot.style.cssText = 'display:inline-block;width:100px;height:100px';
          const file = window.files[i];
          slot.__reactFiber$test = { memoizedProps: { file }, return: { memoizedProps: props } };
          if (file) slot.innerHTML = `<img src="${file.fileURL}" width="80" height="80">`;
          else {
            slot.innerHTML = '<span id="image-placeholder-span">上传图片</span><input type="file" accept="image/jpeg" multiple>';
            slot.querySelector('input').onchange = (event) => {
              const names = [...event.target.files].map((file) => file.name); window.dispatched.push(names);
              // First dispatch silently loses the last two files. Alibaba only
              // accepts the first pair; the next dispatch must not resend them.
              for (const name of names.slice(0, 2)) window.files.push({ uid: `accepted-${name}`, name, status: 'done', fileURL: `https://example.test/${name}` });
              window.render();
            };
          }
          root.append(slot);
        }
      };
      window.render();
    });
    const publisher = new SellerPublisher(directory);
    publisher.downloadImageSet = async () => files;
    const wait = publisher.waitForMainImageUploads.bind(publisher);
    publisher.waitForMainImageUploads = (page, count, slots) => wait(page, count, slots, { timeoutMs: 100 });
    await publisher.uploadMainImages(page, { mainImages: files });
    assert.deepEqual(await page.evaluate(() => window.dispatched), [files.map((file) => path.basename(file)), ['three.jpg', 'four.jpg']]);
    assert.deepEqual(await page.evaluate(() => window.files.map((file) => file.uid)), files.map((file) => `accepted-${path.basename(file)}`));
    assert.equal((await mainImageUploadRecords(page)).filter((file) => file.status === 'done').length, 4);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('stalled image receipts stop retrying after three attempts without claiming success', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="image-uploader">Pending uploads</div>');
    const publisher = new SellerPublisher('.');
    publisher.downloadImageSet = async () => ['1.jpg', '2.jpg', '3.jpg', '4.jpg'];
    let attempts = 0;
    publisher.uploadMainImageBatch = async () => {
      attempts++;
      throw Object.assign(new Error('主图尚未完成接收（已确认 2 张）'), { code: 'MAIN_IMAGE_UPLOAD_PENDING' });
    };
    await assert.rejects(publisher.uploadMainImages(page, {}), { code: 'MAIN_IMAGE_UPLOAD_PENDING' });
    assert.equal(attempts, 3);
  } finally { await browser.close(); }
});

test('uploads from moving inline labels inside a scroller after a late dismissible notice without touching another uploader', { skip: !findChromium(), timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-image-moving-'));
  const files = ['one', 'two', 'three', 'four'].map((name) => {
    const file = path.join(directory, `${name}.jpg`); fs.writeFileSync(file, 'fixture'); return file;
  });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      @keyframes moving { from { transform:translateX(0) } to { transform:translateX(30px) } }
      #image-placeholder-span { display:inline-block; animation:moving .7s linear infinite alternate }
      .image-upload-list-item { display:inline-block; width:160px; height:90px }
      .next-dialog { position:fixed; inset:0; background:white; z-index:100 }
    </style><div id="scroller" style="height:400px;overflow:auto"><div style="height:1200px"></div>
      <div class="image-uploader"></div><div style="height:1200px"></div></div>
      <div class="sc-images-upload-dropdown" style="display:none;position:fixed"><input type="file" multiple accept="image/jpeg"></div>
      <input id="unrelated" type="file" multiple><script>
      window.uploads=0;window.wrongUploads=0;window.bankOpened=0;window.closedNotice=0;window.prompted=false;
      document.querySelector('#unrelated').onchange=()=>window.wrongUploads++;
      const root=document.querySelector('.image-uploader'), portal=document.querySelector('.sc-images-upload-dropdown');
      for(let i=0;i<6;i++){
        const slot=document.createElement('div');slot.className='image-upload-list-item';
        slot.innerHTML='<span id="image-placeholder-span">上传图片</span>';
        slot.onmouseenter=()=>{
          if(!window.prompted){
            window.prompted=true;
            const notice=document.createElement('div');notice.className='next-dialog';notice.setAttribute('role','dialog');
            notice.innerHTML='<p>上传图片操作提示</p><button>我知道了</button>';
            notice.querySelector('button').onclick=()=>{
              window.closedNotice++;notice.remove();
              const label=slot.querySelector('span');label.replaceWith(label.cloneNode(true));
            };document.body.append(notice);return;
          }
          if(document.querySelector('.next-dialog'))return;
          const box=slot.getBoundingClientRect();portal.style.left=box.x+'px';portal.style.top=box.bottom+'px';portal.style.display='block';
        };
        slot.onclick=()=>window.bankOpened++;root.append(slot);
      }
      portal.querySelector('input').onchange=event=>{
        window.uploads++;
        [...event.target.files].forEach((file,i)=>{root.children[i].innerHTML='<img src="https://example.test/'+file.name+'" width="80" height="80">'});
        portal.style.display='none';
      };
    </script>`);
    const publisher = new SellerPublisher(directory);
    publisher.downloadImageSet = async () => files;
    assert.equal(await publisher.uploadMainImages(page, { mainImages: files }), 4);
    assert.deepEqual(await page.evaluate(() => [window.uploads, window.wrongUploads, window.bankOpened, window.closedNotice]), [1, 0, 0, 1]);
    assert.equal(await page.locator('.image-uploader img').count(), 4);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bounds repeated main-image control failures and reports an actionable per-product error', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="image-uploader">Waiting for upload control</div>');
    const publisher = new SellerPublisher('.');
    publisher.downloadImageSet = async () => ['one.jpg', 'two.jpg', 'three.jpg', 'four.jpg'];
    let attempts = 0;
    publisher.uploadMainImageBatch = async () => {
      attempts++;
      throw new Error('locator.scrollIntoViewIfNeeded: Timeout 3000ms exceeded. Call log: waiting for image-placeholder-span');
    };
    await assert.rejects(publisher.uploadMainImages(page, {}), (error) => {
      assert.equal(error.code, 'MAIN_IMAGE_CONTROL_NOT_READY');
      assert.equal(publishEnvironmentBlockCode(error), error.code);
      assert.match(error.cause.message, /scrollIntoViewIfNeeded/);
      assert.doesNotMatch(userFacingError(error), /locator\.|Timeout|Call log/);
      return true;
    });
    assert.equal(attempts, 3);
  } finally { await browser.close(); }
});

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
    // A portal can disappear before receiving files while previously uploaded
    // records remain valid. Re-enter it without deleting those server records.
    await page.evaluate(() => { window.files = window.files.slice(0, 2); window.render(); });
    let attempts = 0;
    publisher.uploadMainImageBatch = async () => {
      if (++attempts === 1) throw Object.assign(new Error('Portal remounted'), { code: 'IMAGE_UPLOAD_TIMEOUT' });
      if (attempts === 2) throw new Error('locator.scrollIntoViewIfNeeded: Timeout 3000ms exceeded. Call log: waiting for image-placeholder-span');
      assert.deepEqual((await mainImageUploadRecords(page)).map((file) => file.name), ['first.jpg', 'second.jpg']);
      await page.evaluate(() => {
        window.files.push(...['third', 'fourth'].map((name) => ({ uid: `${name}-fresh`, fileName: `${name}.jpg`, status: 'done', fileURL: `https://example.com/${name}.jpg` })));
        window.render();
      });
      return 2;
    };
    await publisher.uploadMainImages(page, {});
    assert.equal(attempts, 3);
    assert.deepEqual((await mainImageUploadRecords(page)).map((file) => file.name), filenames);
  } finally { await browser.close(); }
});
