// Reopen the earlier confirmed edit; no save, submit or repeat publication.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { SellerPublisher, distinctAlibabaImageUrls } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { requireCustomAttributes } from '../server/custom-attributes.js';
import { revealDescriptionSection, waitForDescriptionEditor } from '../server/posting-readiness.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
const root = process.env.QA_OUTPUT_DIR;
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'existing-publication-3/existing-publication.json')));
assert.equal(receipt.result.status, 'published');
const id = new URL(receipt.result.url).searchParams.get('primaryId');
const product = JSON.parse(fs.readFileSync(path.join(root, 'original-workspace.json'))).products.find(p => p.sourceId === receipt.sourceId);
const cookies = path.join(root, 'readback-cookies.json');
writePrivateSession(cookies, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookies;
const publisher = new SellerPublisher(path.join(root, 'readback-browser'));
const report = { publishedId: id, sourceId: product.sourceId, readOnly: true };
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${id}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 30000 });
  report.title = await page.locator('input#productTitle').inputValue();
  assert.equal(report.title, product.title);
  report.custom = await requireCustomAttributes(page, product);
  await revealDescriptionSection(page);
  const { body } = await waitForDescriptionEditor(page);
  report.descriptionHtml = await body.innerHTML();
  report.images = await body.locator('img[src]').evaluateAll(nodes => nodes.map(n => n.src));
  assert.equal(report.images.length, distinctAlibabaImageUrls(product.detailImages).length);
  assert.doesNotMatch(report.descriptionHtml, /Available Specifications/);
  const original = load(product.descriptionHtml, null, false), saved = load(report.descriptionHtml, null, false);
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const originalRows = original('table tr').toArray().map(n => normalize(original(n).text())).filter(Boolean);
  report.sourceTableRows = originalRows.length;
  report.savedTableRows = saved('table tr').length;
  assert.ok(originalRows.every(row => normalize(saved.text()).includes(row)), 'All original table rows must remain');
  await page.screenshot({ path: path.join(root, 'fidelity-readback.png') });
  report.ok = true;
} catch (error) { report.error = { code: error.code, message: error.message }; report.pageText = (await publisher.page?.locator('body').innerText().catch(() => '') || '').slice(0, 1500); }
finally { fs.writeFileSync(path.join(root, 'fidelity-readback.json'), JSON.stringify(report, null, 2)); await publisher.shutdown(); console.log(JSON.stringify({ ok: report.ok, error: report.error })); }
