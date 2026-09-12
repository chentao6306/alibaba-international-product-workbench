import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher, clearSaleAttributeSelections, fillModelNumber, fillOriginCountry } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';

const output = process.env.QA_OUTPUT_DIR;
if (!output) throw new Error('Set QA_OUTPUT_DIR');
fs.mkdirSync(output, { recursive: true });
const publisher = new SellerPublisher(output);
const report = { operations: [] };
try {
  const page = await publisher.currentSellerPage();
  page.setDefaultTimeout(5000);
  await page.goto(buildAlibabaPublishUrl('201896803'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('#struct-p-3').waitFor({ timeout: 30000 });
  await clearSaleAttributeSelections(page);
  await fillOriginCountry(page, 'Mozambique');
  report.before = await page.locator('#struct-p-3').evaluate((node) => node.outerHTML);
  const prototype = Object.getPrototypeOf(page.locator('body'));
  for (const method of ['click', 'fill', 'evaluate', 'dispatchEvent', 'getAttribute', 'inputValue']) {
    const original = prototype[method];
    prototype[method] = async function (...args) {
      const started = Date.now();
      try { return await original.apply(this, args); }
      catch (error) { report.operations.push({ method, locator: this.toString(), error: error.message.slice(0, 300) }); throw error; }
      finally { if (Date.now() - started > 500) report.operations.push({ method, locator: this.toString(), elapsedMs: Date.now() - started }); }
    };
  }
  const started = Date.now();
  report.filled = await fillModelNumber(page, 'S25 Ultra');
  report.elapsedMs = Date.now() - started;
  report.after = await page.locator('#struct-p-3').evaluate((node) => node.outerHTML);
  console.log(JSON.stringify(report));
} finally {
  fs.writeFileSync(path.join(output, 'model.json'), JSON.stringify(report, null, 2));
  await publisher.shutdown();
}
