// Exercise the shared media uploader in an authorized, unsaved form. This is
// not proof of publishing permission for the source product's own category.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, distinctAlibabaImageUrls, preparePublishProduct, mainImageFormState } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_SOURCE_DIR && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_MEDIA_CATEGORY_ID);
fs.mkdirSync(root, { recursive: true });
const cases = JSON.parse(fs.readFileSync(path.join(process.env.QA_SOURCE_DIR, 'cases.json'), 'utf8').replace(/^\uFEFF/, ''));
const sourceReport = JSON.parse(fs.readFileSync(path.join(process.env.QA_SOURCE_DIR, 'report.json')));
const publisher = new SellerPublisher(root);
const reportPath = path.join(root, 'report.json');
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath))
  : { saved: false, submitted: false, sharedUploaderOnly: true, targetCategoryId: process.env.QA_MEDIA_CATEGORY_ID, cases: [] };
try {
  for (const sample of cases.filter(sample => !process.env.QA_CASE_FILTER || process.env.QA_CASE_FILTER.split(',').includes(sample.kind))) {
    const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
    assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
    const captured = sourceReport.cases.find(item => item.url === sample.url);
    const product = preparePublishProduct(JSON.parse(fs.readFileSync(path.join(process.env.QA_SOURCE_DIR, `${captured.sourceId}-source.json`))).product);
    const entry = { kind: sample.kind, sourceId: product.sourceId, sourceCategoryId: product.categoryId };
    report.cases.push(entry);
    try {
      await page.goto(`${buildAlibabaPublishUrl(process.env.QA_MEDIA_CATEGORY_ID)}&language=zh_CN`, { waitUntil: 'domcontentloaded' });
      await page.locator('input#productTitle').waitFor({ timeout: 60000 });
      const progress = message => console.log(`${sample.kind}：${message}`);
      await publisher.fillLegacyDescription(page, product, progress);
      entry.expectedDetail = distinctAlibabaImageUrls(product.detailImages || []).length;
      entry.detailImages = [];
      for (const frame of page.frames()) {
        const body = frame.locator('body.mce-content-body, body[contenteditable="true"]');
        if (await body.isVisible().catch(() => false)) {
          entry.detailImages.push(...await body.locator('img[src]').evaluateAll(nodes => nodes.map(node => ({ src: node.src, loaded: node.complete && node.naturalWidth > 0 }))));
        }
      }
      assert.equal(entry.detailImages.length, entry.expectedDetail);
      assert.ok(entry.detailImages.every(image => /^https:\/\//.test(image.src) && !/loading|blob:|data:/.test(image.src)));
      await publisher.uploadMainImages(page, product, progress);
      entry.mainImages = await mainImageFormState(page);
      assert.equal(entry.mainImages.occupied, distinctAlibabaImageUrls(product.mainImages || []).length);
      try { await publisher.uploadMainVideo(page, product); entry.mainVideoUploaded = true; }
      catch (error) { entry.videoWarning = error.message; }
      entry.ok = true;
      await page.screenshot({ path: path.join(root, `${product.sourceId}-media.png`) });
    } catch (error) { entry.error = error.message; process.exitCode = 1; }
    finally { await page.close(); }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(entry));
  }
} finally { await publisher.shutdown(); fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); }
