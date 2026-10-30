import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, fillVariantSpecs, clearSaleAttributeSelections } from '../../server/publisher.js';
import { readPostingAttributeSchema } from '../../server/category-attributes.js';
import { buildAlibabaPublishUrl } from '../../server/category-routing.js';
import { matchesAlibabaSession } from '../../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_DESKTOP_USER_DATA_DIR);
fs.mkdirSync(root, { recursive: true });
const sessionFile = path.join(root, 'session.json');
writePrivateSession(sessionFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = sessionFile;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const report = { submitted: false, startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(root, 'camera-specification.json'), JSON.stringify(report, null, 2));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, 'https://www.alibaba.com/'));
  if (process.env.QA_SOURCE_URL) {
    report.product = await publisher.readSourceProduct(page, { sourceUrl: process.env.QA_SOURCE_URL, sourceId: process.env.QA_SOURCE_URL.match(/_(\d+)\.html/)?.[1], sourcePlatform: 'alibaba' });
    report.ok = Boolean(report.product.sourceOriginalTitle);
  } else if (process.env.QA_CATEGORY_ID) {
    report.categoryId = process.env.QA_CATEGORY_ID;
    await page.goto(buildAlibabaPublishUrl(report.categoryId), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input#productTitle').waitFor({ timeout: 60000 });
    report.before = await page.evaluate(readPostingAttributeSchema);
    report.sales = await page.locator('#saleAttributesItems').innerText().catch(() => '');
    report.saleChoices = await page.locator('#saleAttributesItems input').evaluateAll(nodes => nodes.map(node => ({ id: node.value, text: node.closest('label')?.innerText })));
    save();
    await clearSaleAttributeSelections(page);
    const product = process.env.QA_PRODUCT_FILE ? JSON.parse(fs.readFileSync(process.env.QA_PRODUCT_FILE)).product
      : JSON.parse(process.env.QA_CAMERA_PRODUCT || '{"variantGroups":[]}');
    report.mapping = await fillVariantSpecs(page, product, (stage) => console.log(stage));
    report.after = await page.evaluate(readPostingAttributeSchema);
    report.specificationHtml = await page.locator('#struct-specification').innerHTML();
    await page.screenshot({ path: path.join(root, 'form.png'), fullPage: true });
    report.ok = true;
  } else {
    await page.goto('https://www.alibaba.com/countrysearch/CN/china-tablet-rams_5.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    report.title = await page.title();
    report.url = page.url();
    report.links = await page.locator('a[href*="product-detail"]').evaluateAll(nodes => nodes.map(node => ({ title: node.innerText || node.getAttribute('title'), url: node.href })).filter(row => /S10Ultra|S10 Ultra/i.test(row.title || '')));
    report.body = (await page.locator('body').innerText()).slice(0, 16000);
    report.ok = report.links.length > 0;
  }
} catch (error) { report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally {
  save(); await publisher.shutdown(); fs.rmSync(sessionFile, { force: true });
  console.log(JSON.stringify({ ok: report.ok, categoryId: report.categoryId, links: report.links, error: report.error }));
}
