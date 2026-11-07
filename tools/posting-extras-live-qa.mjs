import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const publisher = new SellerPublisher(root), report = { checks: [] };
let page;
try {
  page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`${buildAlibabaPublishUrl('202063712')}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  const product = { price: 6, moq: 3000, priceTiers: [{ minQuantity: 3000, price: 6 }, { minQuantity: 5000, price: 5 }],
    attributes: [{ id: '262774178', name: 'chipset', value: 'JL' }],
    services: { deepCustomization: ['chipset'], customizationDetails: { 'deepCustomization:chipset': { value: 'JL', surcharge: 0.5, moq: 3000 } } },
    regionalPricing: { mode: 'amount', rows: [{ country: 'United States', value: 1 }, { country: 'Canada', value: -1 }] } };
  await publisher.fillPriceFields(page, product);
  for (let pass = 0; pass < 2; pass++) {
    const result = await publisher.fillAdditionalProductFields(page, product);
    report.checks.push({ pass, result, inputs: await page.locator('#newCustomizedServices .cardItem input').evaluateAll(nodes => nodes.map(node => node.value)),
      countries: await page.locator('#struct-icbuCountryRegion input:checked').evaluateAll(nodes => nodes.map(node => node.value)) });
    assert.deepEqual(report.checks.at(-1).inputs, ['JL', '0.5', '3000']);
    assert.deepEqual(report.checks.at(-1).countries.sort(), ['CA', 'US']);
  }
  report.ok = true;
} catch (error) { report.error = { message: error.message, code: error.code }; process.exitCode = 1; console.error(error.message); }
finally {
  if (page) {
    report.html = await page.locator('#struct-newCustomizedServices, #struct-countryLadderPrice').evaluateAll(nodes => nodes.map(node => node.outerHTML)).catch(() => []);
    await page.screenshot({ path: path.join(root, 'extras-live.png') }).catch(() => {});
  }
  fs.writeFileSync(path.join(root, 'extras-live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, error: report.error }));
  await publisher.shutdown();
}
