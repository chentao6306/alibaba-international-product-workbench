import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { assignStructuredImageFiles, prepareStructuredInteraction, uploadStructuredImages } from '../server/structured-description.js';

const galleryHtml = `<div id="detailImage"><label><input type="checkbox" value="350">Other product images</label>
  <div class="gallery-item-container"><span class="gallery-item-header-en-name">Other product images</span><input type="file" multiple hidden><div class="images"></div></div></div>
  <div id="companyImage"><label><input type="checkbox" value="400">Company overview</label>
  <div class="gallery-item-container"><span class="gallery-item-header-en-name">Company overview</span><input type="file" multiple hidden><div class="images"></div></div></div>`;

function fixture() {
  window.uploads = [];
  document.addEventListener('change', event => {
    if (event.target.type !== 'file') return;
    const root = event.target.closest('[id]');
    for (const file of event.target.files) {
      window.uploads.push({ root: root.id, name: file.name });
      const row = document.createElement('div'); row.className = 'gallery-item-image';
      const image = document.createElement('img'); image.alt = file.name; image.src = `https://sc04.alicdn.com/kf/${file.name}`;
      row.append(image); root.querySelector('.images').append(row);
    }
    const gallery = root.querySelector('.gallery-item-container');
    // Native React galleries can replace the container after each upload.
    gallery.replaceWith(gallery.cloneNode(true));
  });
}

test('re-resolves a detached company gallery before uploading each file once to its exact root', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-rerender-'));
  try {
    const page = await browser.newPage(); await page.setContent(galleryHtml); await page.evaluate(fixture);
    const files = ['first.jpg', 'second.jpg'].map(name => { const file = path.join(directory, name); fs.writeFileSync(file, 'fixture'); return file; });
    let raced = false;
    const urls = await uploadStructuredImages(page, files, () => {}, {
      rootId: 'companyImage', galleryValue: '400', galleryName: 'Company overview', reset: false, ordered: true,
      beforeInteraction: async target => {
        if (raced) return prepareStructuredInteraction(page, target);
        raced = true;
        const old = await target.elementHandle();
        await old.evaluate(node => node.replaceWith(node.cloneNode(true)));
        let first = true;
        const relocating = {
          count: () => target.count(), evaluate: (...args) => target.evaluate(...args),
          scrollIntoViewIfNeeded: options => {
            if (first) { first = false; return old.scrollIntoViewIfNeeded(options); }
            return target.scrollIntoViewIfNeeded(options);
          }, toString: () => String(target),
        };
        await prepareStructuredInteraction(page, relocating);
      },
    });
    assert.deepEqual(urls, ['https://sc04.alicdn.com/kf/first.jpg', 'https://sc04.alicdn.com/kf/second.jpg']);
    assert.deepEqual(await page.evaluate(() => window.uploads), [
      { root: 'companyImage', name: 'first.jpg' }, { root: 'companyImage', name: 'second.jpg' },
    ]);
    assert.equal(await page.locator('#detailImage .gallery-item-image').count(), 0);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('preparation waits for a temporarily unmounted gallery but rejects ambiguous and missing identities before upload', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage(); await page.setContent('<div id="host"></div>');
    await page.evaluate(() => setTimeout(() => document.querySelector('#host').innerHTML = '<div id="target">Gallery</div>', 150));
    await prepareStructuredInteraction(page, page.locator('#target'));
    await page.locator('#host').evaluate(node => { node.innerHTML = '<div id="target">First</div><div id="target">Second</div>'; });
    await assert.rejects(prepareStructuredInteraction(page, page.locator('#target')), error => error.diagnostics.stage === 'control-identity');
    await page.locator('#host').evaluate(node => { node.innerHTML = ''; });
    await assert.rejects(prepareStructuredInteraction(page, page.locator('#target'), { timeoutMs: 200 }), error =>
      error.code === 'PUBLISH_EDITOR_NOT_READY' && error.diagnostics.stage === 'control-rerender' && error.diagnostics.dispatched === false);
    await page.setContent('<div id="target">Gallery</div>');
    const paused = Object.assign(new Error('paused'), { code: 'PUBLISH_PAUSED' });
    await assert.rejects(prepareStructuredInteraction(page, page.locator('#target'), { clearOverlays: () => { throw paused; } }), error => error === paused);
  } finally { await browser.close(); }
});

test('a checked gallery can mount its matching upload container on a later render', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-delayed-mount-'));
  try {
    const page = await browser.newPage(); await page.setContent(galleryHtml); await page.evaluate(fixture);
    await page.evaluate(() => {
      const root = document.querySelector('#companyImage');
      const container = root.querySelector('.gallery-item-container'); container.remove();
      root.querySelector('input[type=checkbox]').addEventListener('change', () => setTimeout(() => root.append(container), 250));
    });
    const file = path.join(directory, 'mounted.jpg'); fs.writeFileSync(file, 'fixture');
    assert.deepEqual(await uploadStructuredImages(page, [file], () => {}, {
      rootId: 'companyImage', galleryValue: '400', galleryName: 'Company overview', reset: false,
    }), ['https://sc04.alicdn.com/kf/mounted.jpg']);
    assert.deepEqual(await page.evaluate(() => window.uploads), [{ root: 'companyImage', name: 'mounted.jpg' }]);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an uncertain upload reads accepted images after rerender without scrolling or dispatching again', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-receipt-rerender-'));
  try {
    const page = await browser.newPage(); await page.setContent(galleryHtml); await page.evaluate(fixture);
    const file = path.join(directory, 'company.jpg'); fs.writeFileSync(file, 'fixture');
    const gallery = page.locator('#companyImage .gallery-item-container');
    const real = gallery.locator('input[type=file]');
    let dispatches = 0, preparations = 0;
    const input = {
      setInputFiles: async files => { dispatches++; await real.setInputFiles(files); throw Object.assign(new Error('Timeout after file input changed'), { name: 'TimeoutError' }); },
      evaluate: (...args) => real.evaluate(...args),
    };
    await assignStructuredImageFiles(page, input, [file], {
      gallery, label: 'Company overview', receiptTimeoutMs: 250,
      beforeInteraction: async target => { preparations++; assert.equal(preparations, 1); await prepareStructuredInteraction(page, target); },
    });
    assert.equal(dispatches, 1); assert.equal(preparations, 1);
    assert.equal(await page.locator('#companyImage .gallery-item-image').count(), 1);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an uncertain upload cannot use another gallery image receipt or repeat its dispatch', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-receipt-identity-'));
  try {
    const page = await browser.newPage(); await page.setContent(galleryHtml);
    const file = path.join(directory, 'company.jpg'); fs.writeFileSync(file, 'fixture');
    await page.locator('#detailImage .images').evaluate(node => { node.innerHTML = '<div class="gallery-item-image"><img alt="company.jpg" src="https://sc04.alicdn.com/kf/company.jpg"></div>'; });
    let dispatches = 0;
    const input = { setInputFiles: async () => { dispatches++; throw Object.assign(new Error('Timeout waiting for upload'), { name: 'TimeoutError' }); }, evaluate: async () => [] };
    await assert.rejects(assignStructuredImageFiles(page, input, [file], {
      gallery: page.locator('#companyImage .gallery-item-container'), label: 'Company overview', receiptTimeoutMs: 200,
    }), error => error.code === 'PUBLISH_IMAGE_RECEIPT_UNKNOWN' && error.diagnostics.repeatedUpload === false);
    assert.equal(dispatches, 1);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an empty rerender with a required hint waits for a late upload instead of sending the files twice', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-late-receipt-'));
  try {
    const page = await browser.newPage(); await page.setContent(galleryHtml);
    const file = path.join(directory, 'late.jpg'); fs.writeFileSync(file, 'fixture');
    await page.evaluate(() => {
      window.uploads = 0;
      const root = document.querySelector('#companyImage');
      root.insertAdjacentHTML('beforeend', '<div class="sell-error-message">勾选该图集后至少上传一张图片</div>');
      document.addEventListener('change', event => {
        if (event.target.type !== 'file') return;
        window.uploads++;
        setTimeout(() => {
          root.querySelector('.images').innerHTML = '<div class="gallery-item-image"><img alt="late.jpg" src="https://sc04.alicdn.com/kf/late.jpg"></div>';
          root.querySelector('.sell-error-message').remove();
        }, 11000);
      });
    });
    assert.deepEqual(await uploadStructuredImages(page, [file], () => {}, {
      rootId: 'companyImage', galleryValue: '400', galleryName: 'Company overview', reset: false,
    }), ['https://sc04.alicdn.com/kf/late.jpg']);
    assert.equal(await page.evaluate(() => window.uploads), 1);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
