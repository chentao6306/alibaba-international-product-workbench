// Inspect actual advertised video-bank actions without uploads or associations.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { readPostingVideoState } from '../server/posting-video.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && !fs.existsSync(root) && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_DESKTOP_USER_DATA_DIR);
assert.match(process.env.QA_CATEGORY_ID || '', /^\d+$/);
fs.mkdirSync(root, { recursive: true });
const cookieFile = path.join(root, 'cookies.json');
writePrivateSession(cookieFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const report = { readOnly: true };
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`https://post.alibaba.com/product/publish.htm?catId=${process.env.QA_CATEGORY_ID}&language=zh_CN`, { waitUntil: 'domcontentloaded' });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  report.form = await page.evaluate(readPostingVideoState);
  const entry = new URL(report.form.config.url);
  assert.equal(entry.origin + entry.pathname, 'https://hz-productposting.alibaba.com/product/videobank/popSelect.htm');
  await page.goto(entry.href, { waitUntil: 'domcontentloaded' });
  const link = page.getByRole('link', { name: /^(?:Manage videos|管理视频)$/i });
  await link.waitFor({ timeout: 30000 });
  const bank = new URL(await link.getAttribute('href'), page.url());
  assert.equal(bank.origin + bank.pathname, 'https://hz-productposting.alibaba.com/product/videobank/home.htm');
  await page.goto(bank.href, { waitUntil: 'domcontentloaded' });
  await page.locator('.list-item-name').first().waitFor({ timeout: 30000 });
  report.actions = await page.locator('button,a').filter({ visible: true }).allTextContents();
  report.actions = [...new Set(report.actions.map(value => value.trim()).filter(value => /关联|Relate|Upload Video|上传视频/i.test(value)))];
  report.ok = true;
} catch (error) { report.error = { code: error.code, message: error.message }; process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(root, 'capabilities.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await publisher.shutdown(); fs.rmSync(cookieFile, { force: true });
}
