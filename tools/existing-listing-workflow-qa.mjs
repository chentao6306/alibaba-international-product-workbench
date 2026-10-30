// Exercise the normal publisher against one authorized existing listing, then
// reopen it. A confirmed receipt is saved before readback; never replay it.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { SellerPublisher, preparePublishProduct, requireCategoryAttributes, mainImageFormState, distinctAlibabaImageUrls } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { requireCustomAttributes } from '../server/custom-attributes.js';
import { revealDescriptionSection, waitForDescriptionEditor } from '../server/posting-readiness.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const root = process.env.QA_OUTPUT_DIR, prior = process.env.QA_DRAFT_DIR;
assert.ok(root && prior && process.env.QA_WORKSPACE_FILE && process.env.QA_SOURCE_ID && process.env.QA_EXPECTED_ACCOUNT);
const source = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE)).products.find(p => p.sourceId === process.env.QA_SOURCE_ID);
const publishedId = new URL(source.publishResult.url).searchParams.get('primaryId');
assert.match(publishedId, /^\d+$/);
const proof = JSON.parse(fs.readFileSync(path.join(prior, 'performance.json')));
assert.ok(proof.samples.some(row => row.sourceId === source.sourceId && row.attributesAccepted && row.result?.status === 'drafted' && !row.error));
const product = preparePublishProduct(source);
fs.mkdirSync(root, { recursive: true });
const reportFile = path.join(root, 'workflow.json');
const readbackOnly = process.env.QA_READBACK_ONLY === '1';
if (!readbackOnly) assert.equal(fs.existsSync(reportFile), false, 'Inspect the saved receipt; do not repeat a completed or uncertain submission');
const cookieFile = path.join(root, 'session.json');
writePrivateSession(cookieFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const report = readbackOnly ? JSON.parse(fs.readFileSync(reportFile)) : { sourceId: source.sourceId, publishedId, updatingExisting: true, stages: [] };
if (readbackOnly) {
  assert.equal(report.result?.status, 'published');
  assert.equal(new URL(report.result.url).searchParams.get('primaryId'), publishedId);
  if (report.error) (report.priorReadbackErrors ||= []).push(report.error);
  delete report.error;
}
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
try {
  save();
  const initial = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await initial.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, initial.url()));
  const url = `https://post.alibaba.com/product/publish.htm?itemId=${publishedId}&language=zh_CN`;
  if (!readbackOnly) {
    const started = Date.now();
    report.result = await publisher.publishProduct(product, url, 'submit', '', '', stage => {
      report.stages.push({ stage, elapsedMs: Date.now() - started }); save(); console.log(stage);
    }, { uploadProductVideos: false, listingMode: 'auto' });
    report.publicationMs = Date.now() - started;
    save();
  }
  assert.equal(report.result.status, 'published');
  assert.equal(new URL(report.result.url).searchParams.get('primaryId'), publishedId, 'The existing product identity must remain unchanged');
  const page = publisher.page;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 45000 });
  assert.equal(await page.locator('input#productTitle').inputValue(), product.title);
  await requireCategoryAttributes(page, product);
  report.customAttributes = await requireCustomAttributes(page, product);
  await page.locator('#struct-specification').scrollIntoViewIfNeeded();
  report.saleValues = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.saleProp);
  for (const group of product.variantGroups) {
    const values = report.saleValues[`p-${group.id}`] || [];
    assert.equal(values.length, group.options.length, group.name);
    for (const option of group.options) assert.ok(values.some(value => String(value.value) === String(group.optionIds[option])), `${group.name}: ${option}`);
  }
  await page.locator('#struct-scPrice').scrollIntoViewIfNeeded();
  report.prices = await page.locator('[role="input-price"]:visible').evaluateAll(nodes => nodes.map(node => Number(node.value)));
  report.quantities = await page.locator('[role="input-quantity"]:visible').evaluateAll(nodes => nodes.map(node => Number(node.value)));
  assert.deepEqual(report.prices, product.priceTiers.map(tier => Number(tier.price)));
  assert.deepEqual(report.quantities, product.priceTiers.map(tier => Number(tier.minQuantity)));
  report.mainImages = await mainImageFormState(page);
  assert.equal(report.mainImages.occupied, Math.min(6, distinctAlibabaImageUrls(product.mainImages).length));
  await revealDescriptionSection(page);
  const { body } = await waitForDescriptionEditor(page);
  report.descriptionHtml = await body.innerHTML();
  report.detailImages = await body.locator('img[src]').count();
  assert.equal(report.detailImages, distinctAlibabaImageUrls(product.detailImages).length);
  assert.doesNotMatch(report.descriptionHtml, /Available Specifications/);
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const original = load(product.descriptionHtml, null, false), saved = load(report.descriptionHtml, null, false);
  const rows = original('table tr').toArray().map(node => normalize(original(node).text())).filter(Boolean);
  report.sourceTableRows = rows.length;
  assert.ok(rows.every(row => normalize(saved.text()).includes(row)), 'Original description table contents must survive');
  report.readbackPassed = true;
  await page.screenshot({ path: path.join(root, 'readback.png') });
} catch (error) {
  report.error = { code: error.code, message: error.message, diagnostics: error.diagnostics };
  report.failurePage = { url: publisher.page?.url(), text: (await publisher.page?.locator('body').innerText().catch(() => '') || '').slice(0, 2000) };
  process.exitCode = 1;
}
finally { save(); await publisher.shutdown(); console.log(JSON.stringify({ publishedId, result: report.result?.status, readbackPassed: report.readbackPassed, error: report.error })); }
