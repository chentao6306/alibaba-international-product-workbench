import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher, recoverRequiredAttributes } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';

const output = process.env.QA_OUTPUT_DIR;
if (!output) throw new Error('Set QA_OUTPUT_DIR for isolated inspection');
fs.mkdirSync(output, { recursive: true });
const publisher = new SellerPublisher(output);
let page;
try {
  page = await publisher.currentSellerPage();
  await page.goto(buildAlibabaPublishUrl(process.argv[2] || '201346401'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (/login|passport/i.test(page.url())) throw new Error('Seller session requires login');
  await page.locator('input#productTitle').waitFor({ timeout: 30000 });
  await page.locator('.sell-catProp-item').first().waitFor({ timeout: 30000 });
  const rows = page.locator('[id="p-200399262"]');
  const before = await rows.evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
  await page.waitForTimeout(500);
  const options = await page.locator('.sell-o-select-options:visible, [role="listbox"]:visible, .next-select-popup:visible').evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
  const labels = await rows.locator('.normal-content').allTextContents();
  await page.keyboard.press('Escape');
  let recovered = [];
  if (process.env.QA_TYPE_VALUE) recovered = await recoverRequiredAttributes(page, { attributes: [{ name: 'Type', value: process.env.QA_TYPE_VALUE }] }, ['类型']);
  const after = await rows.evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
  fs.writeFileSync(path.join(output, 'form.json'), JSON.stringify({ before, options, labels, recovered, after, diagnostics: await publisher.inspectCurrentForm() }, null, 2));
  await page.screenshot({ path: path.join(output, 'form.png') });
  console.log(JSON.stringify({ output, url: page.url(), labels, recovered }));
} finally {
  if (page && !page.isClosed()) {
    fs.writeFileSync(path.join(output, 'page.html'), await page.content());
    await page.screenshot({ path: path.join(output, 'form.png') });
  }
  await publisher.shutdown();
}
