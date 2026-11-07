// Real source video, real bank upload and exact-product association; no listing
// is created or republished. The caller must identify a prior verified listing.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { prepareBankVideo, bankVideoAssociation } from '../server/posting-video-bank.js';
import { readPostingVideoState } from '../server/posting-video.js';
import { revealDescriptionSection, waitForDescriptionEditor } from '../server/posting-readiness.js';
import { ensureSimplifiedChinese } from '../server/posting-language.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT);
const sourceId = process.env.QA_VIDEO_SOURCE_ID, productId = process.env.QA_VIDEO_PUBLISHED_ID;
assert.match(sourceId || '', /^\d+$/); assert.match(productId || '', /^\d+$/);
fs.mkdirSync(root, { recursive: true });
const reportFile = path.join(root, 'video-bank-live.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : { sourceId, productId, checks: [] };
assert.equal(report.sourceId, sourceId); assert.equal(report.productId, productId);
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
let isolatedSession;
if (process.env.QA_DESKTOP_USER_DATA_DIR) {
  isolatedSession = path.join(root, 'alibaba-cookies.json');
  writePrivateSession(isolatedSession, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
  process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = isolatedSession;
}
if (process.env.QA_REPORT_FILE) {
  const ledger = JSON.parse(fs.readFileSync(process.env.QA_REPORT_FILE));
  assert.ok((Array.isArray(ledger) ? ledger : ledger.publications).some(row => row.sourceId === sourceId && row.mode === 'submit'
    && row.result?.status === 'published' && new URL(row.result.url).searchParams.get('primaryId') === productId), 'Exact publication receipt required');
}
const publisher = new SellerPublisher(root);
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  if (process.env.QA_BANK_CHINESE === '1') {
    await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${productId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input#productTitle').waitFor({ timeout: 60000 });
    await ensureSimplifiedChinese(page);
  }
  const context = page.context(), newPage = context.newPage.bind(context);
  let diagnosticIndex = 0;
  context.newPage = async () => {
    const child = await newPage(), close = child.close.bind(child);
    const index = ++diagnosticIndex;
    child.close = async (...args) => {
      try {
        const diagnostic = { url: child.url(), text: (await child.locator('body').innerText({ timeout: 3000 })).slice(0, 12000),
          frames: await child.locator('iframe').evaluateAll(nodes => nodes.map(node => ({ src: node.src, parent: { tag: node.parentElement.tagName, id: node.parentElement.id, className: node.parentElement.className } }))),
          actions: await child.locator('.list-item-name').evaluateAll(nodes => nodes.map(node => node.closest('tr')?.outerHTML.slice(0, 15000))),
          controls: await child.locator('input, button').evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, id: node.id, placeholder: node.getAttribute('placeholder'), text: node.tagName === 'BUTTON' ? node.textContent : undefined }))) };
        fs.writeFileSync(path.join(root, `bank-document-${index}.json`), JSON.stringify(diagnostic, null, 2));
      } catch {}
      return close(...args);
    };
    return child;
  };
  if (!report.video) {
    const sourcePage = await page.context().newPage();
    try {
      const source = process.env.QA_WORKSPACE_FILE
        ? JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE)).products.find(product => product.sourceId === sourceId)
        : await publisher.readSourceProduct(sourcePage, { sourceId, sourcePlatform: 'alibaba.com', sourceUrl: `https://www.alibaba.com/product-detail/product_${sourceId}.html` });
      assert.equal(source?.sourceId, sourceId);
      assert.ok(source.videoUrl, 'Collected source video required');
      fs.writeFileSync(path.join(root, 'collected-source.json'), JSON.stringify(source, null, 2));
      if (process.env.QA_USE_PUBLISH_UPLOADER === '1') {
        await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${productId}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('input#productTitle').waitFor({ timeout: 60000 });
        assert.equal(await page.locator('input#productTitle').inputValue(), source.title);
        const uploaded = process.env.QA_VIDEO_ROLE === 'detail'
          ? (await publisher.uploadDetailVideos(page, { ...source, videoUrl: '', videos: source.videos.filter(video => video.role === 'detail') }, null, { uploadProductVideos: true }))[0]
          : await publisher.uploadMainVideo(page, source, { uploadProductVideos: true });
        assert.ok(uploaded.bank, 'This bounded check requires the video bank flow; do not save or republish the listing');
        report.video = uploaded.bank; report.checks.push(`production-${process.env.QA_VIDEO_ROLE || 'main'}-uploader-enabled`); save();
      }
      const file = await publisher.downloadProductVideo(source);
      report.video ||= await prepareBankVideo(page, file, path.join(root, 'video-bank-receipts'), 'https://hz-productposting.alibaba.com/product/videobank/popSelect.htm');
      report.checks.push('source-collected-and-bank-upload-confirmed'); save();
      const reused = await prepareBankVideo(page, file, path.join(root, 'video-bank-receipts'), 'https://hz-productposting.alibaba.com/product/videobank/popSelect.htm');
      assert.equal(reused.id, report.video.id); report.checks.push('same-video-reused-without-upload'); save();
    } finally { await sourcePage.close(); }
  }
  report.association = await bankVideoAssociation(page, report.video, productId);
  assert.equal(report.association.associated, true); report.checks.push(`${report.video.role || 'main'}-video-associated-and-read-back`); save();
  const again = await bankVideoAssociation(page, report.video, productId);
  assert.equal(again.alreadyAssociated, true); report.checks.push('repeated-association-does-not-resubmit');
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${productId}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  const until = Date.now() + 15000;
  do {
    report.publishedVideoState = await page.evaluate(readPostingVideoState);
    if (report.publishedVideoState.accepted) break;
    await page.waitForTimeout(500);
  } while (Date.now() < until);
  save();
  if (report.video.role === 'detail') {
    await revealDescriptionSection(page);
    const { body } = await waitForDescriptionEditor(page, { switchMode: () => revealDescriptionSection(page) });
    report.detailHtml = await body.innerHTML(); save();
    // Alibaba also persists a dedicated detail-video module outside the rich
    // text editor. Verify that module on the product's actual public page.
    const publicProduct = await publisher.readSourceProduct(page, { sourcePlatform: 'alibaba.com', sourceId: productId,
      sourceUrl: `https://www.alibaba.com/product-detail/product_${productId}.html` });
    report.publicVideos = publicProduct.videos;
    assert.ok(publicProduct.videos.some(video => video.role === 'detail' && video.url.includes(`/${report.video.id}.mp4`)), 'Published detail module must contain the exact linked video');
    report.checks.push('published-detail-video-present-in-live-product-module');
  } else if (report.publishedVideoState.available !== false) {
    assert.equal(report.publishedVideoState.accepted, true, 'Visible video editor must contain the linked video');
    report.checks.push('published-editor-video-present-after-reopen');
  } else {
    report.checks.push('primary-video-confirmed-in-bank-linked-products-editor-slot-hidden');
  }
  report.ok = true; delete report.error; save();
} catch (error) { report.ok = false; report.error = { message: error.message, code: error.code }; save(); process.exitCode = 1; }
finally { console.log(JSON.stringify(report)); await publisher.shutdown(); if (isolatedSession) fs.rmSync(isolatedSession, { force: true }); }
