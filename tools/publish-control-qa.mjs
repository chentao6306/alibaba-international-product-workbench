import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher, fillChoice } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';

const output = process.env.QA_OUTPUT_DIR;
if (!output) throw new Error('Set QA_OUTPUT_DIR');
fs.mkdirSync(output, { recursive: true });
const publisher = new SellerPublisher(output);
const result = [];
try {
  const page = await publisher.currentSellerPage();
  page.setDefaultTimeout(5000);
  await page.goto(buildAlibabaPublishUrl('201896803'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('#struct-p-3 input').first().waitFor({ timeout: 30000 });
  for (const [selector, value] of [['#struct-p-3', 'S25Ultra'], ['#struct-p-2', 'Other'], ['#struct-p-191284141', 'Gaming, Beauty Camera, Dual SIM Card, Fingerprint, Face Recognition'], ['#struct-p-406736640', '3G: WCDMA850/2100MHz']]) {
    const row = page.locator(selector);
    const input = row.locator('input:not([type="hidden"]), textarea').first();
    const before = await row.evaluate((node) => node.outerHTML);
    const started = Date.now();
    const filled = await fillChoice(page, input, value);
    const after = await row.evaluate((node) => node.outerHTML);
    const details = await input.evaluate((node) => {
      const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith('__reactFiber'));
      const list = [];
      for (let fiber = node[key], depth = 0; fiber && depth < 16; fiber = fiber.return, depth++) {
        const props = fiber.stateNode?.props || fiber.memoizedProps || {};
        list.push({ depth, type: fiber.stateNode?.constructor?.name || '', props: Object.fromEntries(Object.entries(props).filter(([key, value]) => /change|blur|key|value|custom|commit/i.test(key) && (typeof value === 'function' || typeof value === 'string' || Array.isArray(value))).map(([key,value]) => [key, typeof value === 'function' ? String(value).slice(0,3000) : value])) });
      }
      return list;
    });
    result.push({ selector, value, filled, elapsedMs: Date.now() - started, before, after, details });
    console.log(JSON.stringify({ selector, filled, elapsedMs: Date.now() - started }));
  }
} finally {
  fs.writeFileSync(path.join(output, 'controls.json'), JSON.stringify(result, null, 2));
  await publisher.shutdown();
}
