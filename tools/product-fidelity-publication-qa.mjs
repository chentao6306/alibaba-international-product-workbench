// Update the same authorized listing after an accepted draft; never create a duplicate.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, fillAndVerify, fillProductKeywords, waitForActionResult, captureCategoryAttributes } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { fillCustomAttributes, requireCustomAttributes } from '../server/custom-attributes.js';
import { revealDescriptionSection, waitForDescriptionEditor } from '../server/posting-readiness.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
const root = process.env.QA_OUTPUT_DIR, prior = process.env.QA_DRAFT_DIR;
assert.ok(root && prior && process.env.QA_SOURCE_ID && /^\d+$/.test(process.env.QA_PUBLISHED_ID || ''));
fs.mkdirSync(root, { recursive: true });
const file = path.join(root, 'existing-publication.json');
assert.equal(fs.existsSync(file), false, 'Inspect existing receipts before retrying');
const proof = JSON.parse(fs.readFileSync(path.join(prior, 'performance.json')));
assert.ok(proof.ok && proof.samples.find(p => p.sourceId === process.env.QA_SOURCE_ID)?.attributesAccepted);
const workspace = JSON.parse(fs.readFileSync(path.join(prior, 'workspace/workspace.json')));
const product = workspace.products.find(p => p.sourceId === process.env.QA_SOURCE_ID);
assert.ok(product);
const id = process.env.QA_PUBLISHED_ID;
const original = JSON.parse(fs.readFileSync(process.env.QA_ORIGINAL_WORKSPACE)).products.find(p => p.sourceId === product.sourceId);
assert.equal(new URL(original.publishResult.url).searchParams.get('primaryId'), id);
const cookies = path.join(root, 'cookies.json');
writePrivateSession(cookies, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookies;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const report = { sourceId: product.sourceId, publishedId: id, mode: 'submit', updatingExisting: true, stages: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
try {
  save();
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const url = `https://post.alibaba.com/product/publish.htm?itemId=${id}&language=zh_CN`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 45000 });
  const before = await captureCategoryAttributes(page);
  const prices = await page.locator('input[role="input-price"]').evaluateAll(nodes => nodes.map(n => n.value));
  await publisher.fillLegacyDescription(page, product, stage => { report.stages.push({ stage, at: new Date().toISOString() }); save(); });
  await fillCustomAttributes(page, product, fillAndVerify);
  await fillProductKeywords(page, product);
  await requireCustomAttributes(page, product);
  assert.deepEqual(await captureCategoryAttributes(page), before, 'Existing native attributes must remain unchanged');
  assert.deepEqual(await page.locator('input[role="input-price"]').evaluateAll(nodes => nodes.map(n => n.value)), prices);
  const button = page.getByRole('button', { name: /^(?:发布商品|提交|Submit|Publish)$/ }).last();
  const verification = await waitForActionResult(page, button, 'submit', page.url());
  report.result = { status: 'published', url: page.url(), verifiedBy: verification.verifiedBy };
  save();
  assert.equal(new URL(report.result.url).searchParams.get('primaryId'), id);
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${id}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 45000 });
  report.savedCustomAttributes = await requireCustomAttributes(page, product);
  report.savedKeywords = await page.locator('#productKeywords').inputValue();
  await revealDescriptionSection(page);
  await waitForDescriptionEditor(page);
  report.savedDescription = await page.evaluate(() => {
    const editor = window.tinymce?.editors?.find(e => e.getBody?.());
    return editor?.getContent() || document.querySelector('textarea#detail')?.value || '';
  });
  if (!report.savedDescription) for (const frame of page.frames().slice(1)) {
    const body = frame.locator('body[contenteditable="true"]');
    if (await body.count()) { report.savedDescription = await body.innerHTML(); break; }
  }
  assert.ok(report.savedDescription.length > 100);
  assert.doesNotMatch(report.savedDescription, /Available Specifications/);
  report.ok = true;
} catch (error) { report.error = { code: error.code, message: error.message, diagnostics: error.diagnostics }; process.exitCode = 1; }
finally { save(); await publisher.shutdown(); console.log(JSON.stringify({ ok: report.ok, publishedId: id, status: report.result?.status, error: report.error })); }
