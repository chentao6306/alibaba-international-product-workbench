import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
const root = process.env.QA_OUTPUT_DIR;
const cookieFile = path.join(root, 'locale-cookies.json');
writePrivateSession(cookieFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
const publisher = new SellerPublisher(path.join(root, 'source-inspection-browser'));
const report = {};
try {
  const context = await publisher.sourceBrowser();
  const page = await context.newPage();
  await page.goto('https://www.alibaba.com/product-detail/Original-Push-Button-Telephone-Mobile-Phone_1601005481073.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.locator('.tnh-languages').hover();
  await page.waitForTimeout(1200);
  report.controls = await page.locator('[role="dialog"], .tnh-languages, [class*="switch-to"], [class*="language-select"]').evaluateAll(nodes => nodes.map(n => n.outerHTML.slice(0, 12000)).slice(0, 15));
  report.text = (await page.locator('body').innerText()).slice(-6500);
  await page.screenshot({ path: path.join(root, 'language-ui.png') });
} catch (error) { report.error = error.message; }
finally { fs.writeFileSync(path.join(root, 'language-ui.json'), JSON.stringify(report, null, 2)); await publisher.shutdown(); }
