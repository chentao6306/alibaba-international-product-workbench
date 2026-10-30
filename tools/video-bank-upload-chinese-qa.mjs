// Upload a source-exposed alternate rendition in the Chinese video bank.
// No product is submitted and no existing video association is replaced.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { prepareBankVideo } from '../server/posting-video-bank.js';
import { ensureSimplifiedChinese } from '../server/posting-language.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_VIDEO_REPORT && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const prior = JSON.parse(fs.readFileSync(process.env.QA_VIDEO_REPORT));
assert.ok(prior.association?.associated); assert.match(prior.productId, /^\d+$/);
const cookie = path.join(root, 'alibaba-cookies.json');
writePrivateSession(cookie, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookie;
const publisher = new SellerPublisher(root), report = {};
const save = () => fs.writeFileSync(path.join(root, 'chinese-upload.json'), JSON.stringify(report, null, 2));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await publisher.readSourceProduct(page, { sourcePlatform: 'alibaba.com', sourceId: prior.productId, sourceUrl: `https://www.alibaba.com/product-detail/product_${prior.productId}.html` });
  const url = await page.evaluate(id => {
    const root = window.detailData?.globalData?.product;
    const seen = new Set();
    const find = value => {
      if (!value || typeof value !== 'object' || seen.has(value)) return '';
      seen.add(value);
      if (String(value.videoId) === id && /^https:\/\//.test(value.videoUrl?.sd?.videoUrl || '')) return value.videoUrl.sd.videoUrl;
      for (const child of Object.values(value)) { const url = find(child); if (url) return url; }
      return '';
    };
    return find(root);
  }, prior.video.id);
  assert.ok(url, 'An exact source-exposed SD rendition is required'); report.sourceVideo = url; save();
  const file = await publisher.downloadProductVideo({ videoUrl: url, sourceUrl: page.url() }, page);
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${prior.productId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  await ensureSimplifiedChinese(page);
  const context = page.context(); let index = 0;
  context.on('page', child => {
    const close = child.close.bind(child), serial = ++index;
    child.close = async (...args) => {
      try { fs.writeFileSync(path.join(root, `upload-page-${serial}.json`), JSON.stringify({ url: child.url(),
        text: (await child.locator('body').innerText({ timeout: 3000 })).slice(0, 16000) }, null, 2)); } catch {}
      return close(...args);
    };
  });
  report.video = await prepareBankVideo(page, file, path.join(root, 'receipts'), 'https://hz-productposting.alibaba.com/product/videobank/popSelect.htm');
  assert.ok(report.video.id); report.ok = true; save();
} catch (error) { report.ok = false; report.error = { message: error.message, code: error.code }; save(); process.exitCode = 1; }
finally { await publisher.shutdown(); fs.rmSync(cookie, { force: true }); console.log(JSON.stringify(report)); }
