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
const publisher = new SellerPublisher(path.join(output, 'source-inspection-browser'));
try {
  let page = await (await publisher.sourceBrowser()).newPage();
  for (const sourceId of process.env.QA_SOURCE_IDS.split(',')) {
    const base = workspace.products.find(p => p.sourceId === sourceId)
      || (process.env.QA_SOURCE_URL ? { sourceUrl: process.env.QA_SOURCE_URL } : null);
    assert.ok(base);
    const sourceUrl = new URL(base.sourceUrl);
    assert.ok(/(^|\.)alibaba\.com$/i.test(sourceUrl.hostname) && sourceUrl.pathname.includes('/product-detail/') && sourceUrl.pathname.includes(sourceId));
    const report = { sourceId };
    try {
      try { report.product = await publisher.readSourceProduct(page, { sourceId, sourceUrl: base.sourceUrl }); }
      catch (error) {
        if (error.code !== 'HUMAN_VERIFICATION_REQUIRED') throw error;
        console.log('Waiting for manual verification');
        await publisher.completeSourceVerification(error.verificationUrl || base.sourceUrl);
        page = await (await publisher.sourceBrowser()).newPage();
        report.product = await publisher.readSourceProduct(page, { sourceId, sourceUrl: base.sourceUrl });
      }
      report.pageText = await page.locator('body').innerText();
      console.log(JSON.stringify({ sourceId, origin: report.product.origin, custom: report.product.attributes?.filter(a => a.isCustom).length,
        specs: report.product.variantGroups?.map(g => ({ name: g.name, options: g.options, images: g.optionImages })) }));
    } catch (error) { report.error = { code: error.code, message: error.message }; console.error(JSON.stringify(report.error)); }
    fs.writeFileSync(path.join(output, `${sourceId}-fresh-source.json`), JSON.stringify(report, null, 2));
    if (report.error?.code === 'HUMAN_VERIFICATION_REQUIRED') break;
  }
} finally { await publisher.shutdown(); }
