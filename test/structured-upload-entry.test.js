import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { uploadStructuredImages } from '../server/structured-description.js';
import { userFacingError } from '../server/browser-error.js';

const options = { rootId: 'companyImage', galleryValue: '400', galleryName: 'Company overview', reset: false, ordered: true, entryTimeoutMs: 150 };
const galleryHtml = `<div id="companyImage"><label><input type="checkbox" value="400">Company overview</label>
  <div class="gallery-item-container"><span class="gallery-item-header-en-name">Company overview</span>
  <div class="upload-button-container"><div class="image-upload-wrapper" style="display:none">Upload</div></div><div id="files"></div><div id="images"></div></div></div>`;
const mountInput = () => {
  document.querySelector('#files').innerHTML = '<input type="file" multiple hidden>';
  document.querySelector('input[type=file]').onchange = event => {
    window.uploads = (window.uploads || 0) + 1;
    for (const file of event.target.files) {
      const row = document.createElement('div'); row.className = 'gallery-item-image';
      const img = document.createElement('img'); img.alt = file.name; img.src = `https://sc01.alicdn.com/kf/${file.name}`;
      row.append(img); document.querySelector('#images').append(row);
    }
  };
};

test('company images use a mounted native file input even when the hover wrapper is hidden', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-image-input-'));
  try {
    const page = await browser.newPage(); await page.setContent(galleryHtml); await page.evaluate(mountInput);
    const file = path.join(directory, 'company.jpg'); fs.writeFileSync(file, 'fixture');
    const progress = [];
    const urls = await uploadStructuredImages(page, [file], value => progress.push(value), options);
    assert.deepEqual(urls, ['https://sc01.alicdn.com/kf/company.jpg']);
    assert.equal(await page.evaluate(() => window.uploads), 1);
    assert.ok(progress.some(value => /公司图片.*Company overview/.test(value)));
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('company image entry recovers a delayed input and reports the exact gallery if it never mounts', { skip: !findChromium(), timeout: 40000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-image-retry-'));
  try {
    const page = await browser.newPage(); await page.setContent(galleryHtml);
    const file = path.join(directory, 'company.jpg'); fs.writeFileSync(file, 'fixture');
    let checks = 0;
    await uploadStructuredImages(page, [file], () => {}, { ...options, beforeInteraction: async () => { if (++checks === 2) await page.evaluate(mountInput); } });
    assert.equal(await page.evaluate(() => window.uploads), 1);
    await page.setContent(galleryHtml);
    await assert.rejects(uploadStructuredImages(page, [file], () => {}, options), error => {
      assert.equal(error.code, 'PUBLISH_EDITOR_NOT_READY'); assert.equal(error.diagnostics.stage, 'image-entry');
      assert.match(userFacingError(error), /公司图片.*Company overview.*上传入口未就绪/); return true;
    });
    const stopped = Object.assign(new Error('paused'), { code: 'PUBLISH_PAUSED' });
    await assert.rejects(uploadStructuredImages(page, [file], () => {}, { ...options, beforeInteraction: () => { throw stopped; } }), error => error === stopped);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
