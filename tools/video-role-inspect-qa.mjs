// Read a verified video's current bank state and open the details selector.
// Does not confirm a selection, submit a product or change source data.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_VIDEO_REPORT && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const prior = JSON.parse(fs.readFileSync(process.env.QA_VIDEO_REPORT));
assert.ok(prior.association?.associated); assert.match(prior.productId, /^\d+$/);
const report = { sourceId: prior.sourceId, productId: prior.productId, videoId: prior.video.id };
const cookie = path.join(root, 'alibaba-cookies.json');
writePrivateSession(cookie, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookie;
const publisher = new SellerPublisher(root);
const save = () => fs.writeFileSync(path.join(root, 'video-role-inspect.json'), JSON.stringify(report, null, 2));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  try {
    const publicPage = await page.context().newPage();
    try {
      const product = await publisher.readSourceProduct(publicPage, { sourcePlatform: 'alibaba.com', sourceId: prior.productId,
        sourceUrl: `https://www.alibaba.com/product-detail/product_${prior.productId}.html` });
      report.publicProduct = { title: product.title, videoUrl: product.videoUrl, videos: product.videos };
    } finally { await publicPage.close(); }
  } catch (error) { report.publicError = { message: error.message, code: error.code }; }
  save();
  await page.goto(prior.video.bankUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input[placeholder="Video name"]').fill(prior.video.name);
  await page.locator('button').filter({ hasText: /^(?:Search|搜索)$/i }).click({ timeout: 15000 });
  await page.locator('.next-loading.next-open').waitFor({ state: 'hidden' });
  const row = page.locator('.list-item-name').filter({ hasText: prior.video.name }).locator('xpath=ancestor::tr[1]');
  report.row = await row.innerText();
  assert.match(report.row, new RegExp(`VID: ${prior.video.id}`));
  await row.getByText(/^(?:Relate Product Details|关联产品详情|关联详情)$/i).click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  report.text = await page.locator('body').innerText();
  report.frames = [];
  for (const frame of page.frames().slice(1)) {
    report.frames.push({ url: frame.url(), text: await frame.locator('body').innerText().catch(() => ''),
      html: await frame.locator('body').innerHTML().catch(() => '') });
  }
  await page.screenshot({ path: path.join(root, 'detail-selector.png') }); save();
} catch (error) { report.error = { message: error.message, code: error.code }; report.failureText = await publisher.page?.locator('body').innerText().catch(() => ''); save(); process.exitCode = 1; }
finally { await publisher.shutdown(); fs.rmSync(cookie, { force: true }); console.log(JSON.stringify({ reportFile: path.join(root, 'video-role-inspect.json'), error: report.error })); }
