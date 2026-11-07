// Authorized live draft validation. Receipts survive readback failure so an
// ambiguous or successful save is never automatically resubmitted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, preparePublishProduct, requireCategoryAttributes, mainImageFormState, dismissPostingOverlays } from '../../server/publisher.js';
import { requireCustomAttributes } from '../../server/custom-attributes.js';
import { openStructuredEditor, finishStructuredEditor, requireDescriptionMatch } from '../../server/structured-description.js';
import { revealDescriptionSection } from '../../server/posting-readiness.js';
import { readPrivateSession, writePrivateSession } from '../../server/private-session-storage.js';
import { matchesAlibabaSession } from '../../electron/alibaba-identity.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && !fs.existsSync(root) && process.env.QA_SOURCE_FILE && process.env.QA_EXPECTED_ACCOUNT);
const source = JSON.parse(fs.readFileSync(process.env.QA_SOURCE_FILE));
const product = preparePublishProduct(source);
delete product.publishResult;
fs.mkdirSync(root, { recursive: true });
const report = { sourceId: product.sourceId, stages: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
const session = path.join(root, 'session.json');
writePrivateSession(session, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = session;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const targetId = process.env.QA_TARGET_ID || '';
assert.ok(!targetId || /^\d+$/.test(targetId));
const reads = [];
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/product/submitDraft.json') return;
    reads.push((async () => {
      const body = await response.json();
      report.receipt = { success: body.success, data: body.data }; save();
    })().catch(() => {}));
  });
  const started = Date.now();
  const targetUrl = targetId ? `https://post.alibaba.com/product/publish.htm?itemId=${targetId}&pubAction=draft&language=zh_CN` : 'https://post.alibaba.com/product/publish.htm?catId=201905202&language=zh_CN';
  report.result = await publisher.publishProduct(product, targetUrl, 'draft', '', '', stage => {
    report.stages.push({ stage, elapsedMs: Date.now() - started }); save();
  }, { uploadProductVideos: false, listingMode: 'auto' });
  report.durationMs = Date.now() - started; save();
  await Promise.allSettled(reads);
  assert.equal(report.result.status, 'drafted');
  await page.waitForURL(url => url.searchParams.get('pubAction') === 'draft' && /^\d+$/.test(url.searchParams.get('itemId') || ''), { timeout: 20000 });
  report.draftId = new URL(page.url()).searchParams.get('itemId'); save();
  if (targetId) assert.equal(report.draftId, targetId);
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${report.draftId}&pubAction=draft&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 45000 });
  await dismissPostingOverlays(page);
  await requireCategoryAttributes(page, product);
  report.customAttributes = await requireCustomAttributes(page, product);
  report.mainImages = await mainImageFormState(page);
  await revealDescriptionSection(page);
  await dismissPostingOverlays(page);
  report.formDetails = await page.evaluate(() => {
    const values = window.GlobalStore?.engine?.getModels()?.formValues || {};
    return Object.fromEntries(Object.entries(values).filter(([key]) => /desc|detail|pkg|package|^length$|^width$|^height$/i.test(key)));
  });
  const frame = await openStructuredEditor(page);
  await frame.locator('.comp-singletext-text [contenteditable="true"]').waitFor({ timeout: 25000 });
  report.savedHtml = await frame.locator('.comp-singletext-text [contenteditable="true"]').innerHTML();
  assert.doesNotMatch(report.savedHtml, /Available Specifications/);
  assert.equal((report.savedHtml.match(/<img\b/g) || []).length, product.detailImages.length);
  report.savedEditorPageIds = await frame.evaluate(() => ({ pc: window.data?.baseInfo?.pcPageId, mobile: window.data?.baseInfo?.wirelessPageId }));
  await finishStructuredEditor(page, frame);
  await page.screenshot({ path: path.join(root, 'draft.png') });
  report.ok = true;
} catch (error) {
  report.error = { message: error.message, code: error.code, diagnostics: error.diagnostics };
  await publisher.page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await Promise.allSettled(reads); save(); await publisher.shutdown();
  console.log(JSON.stringify({ ok: report.ok, result: report.result?.status, error: report.error }));
}
