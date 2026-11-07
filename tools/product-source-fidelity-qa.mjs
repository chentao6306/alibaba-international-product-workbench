import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
const output = process.env.QA_OUTPUT_DIR;
assert.ok(output && process.env.QA_SOURCE_IDS);
const workspace = JSON.parse(fs.readFileSync(path.join(output, 'original-workspace.json')));
const file = path.join(output, 'source-inspection-cookies.json');
writePrivateSession(file, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = file;
const publisher = new SellerPublisher(process.env.QA_SOURCE_PROFILE_DIR || path.join(output, 'source-inspection-browser'));
let pageText = '';
const readSource = publisher.readSourceProduct.bind(publisher);
publisher.readSourceProduct = async (page, ...args) => {
  const product = await readSource(page, ...args);
  pageText = await page.locator('body').innerText();
  return product;
};
try {
  for (const sourceId of process.env.QA_SOURCE_IDS.split(',')) {
    const base = workspace.products.find(p => p.sourceId === sourceId)
      || (process.env.QA_SOURCE_URL ? { sourceUrl: process.env.QA_SOURCE_URL } : null);
    assert.ok(base);
    const sourceUrl = new URL(base.sourceUrl);
    assert.ok(/(^|\.)alibaba\.com$/i.test(sourceUrl.hostname) && sourceUrl.pathname.includes('/product-detail/') && sourceUrl.pathname.includes(sourceId));
    const report = { sourceId };
    try {
      // Match the production collection entry, including locale isolation,
      // verification recovery and whole-document retry. A direct low-level
      // read can inherit the seller's Chinese browsing preference instead.
      [report.product] = await publisher.enrichSourceProducts([{ sourceId, sourceUrl: base.sourceUrl }]);
      report.pageText = pageText;
      console.log(JSON.stringify({ sourceId, origin: report.product.origin, custom: report.product.attributes?.filter(a => a.isCustom).length,
        specs: report.product.variantGroups?.map(g => ({ name: g.name, options: g.options, images: g.optionImages })) }));
    } catch (error) { report.error = { code: error.code, message: error.message }; console.error(JSON.stringify(report.error)); }
    fs.writeFileSync(path.join(output, `${sourceId}-fresh-source.json`), JSON.stringify(report, null, 2));
    if (report.error?.code === 'HUMAN_VERIFICATION_REQUIRED') break;
  }
} finally { await publisher.shutdown(); fs.rmSync(file, { force: true }); }
