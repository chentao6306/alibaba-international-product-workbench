import fs from 'node:fs';
import path from 'node:path';
import { ShopCollector } from '../server/collector.js';

const output = process.env.QA_OUTPUT_DIR;
if (!output) throw new Error('Set QA_OUTPUT_DIR for isolated listing inspection');
fs.mkdirSync(output, { recursive: true });
const report = { pages: [] };
const collector = new ShopCollector(output, async (products) => products);
const originalWithPage = collector.withPage.bind(collector);
collector.withPage = (callback) => originalWithPage(async (page) => {
  try { return await callback(page); }
  finally {
    report.lastPage = { url: page.url(), text: (await page.locator('body').innerText().catch(() => '')).slice(0, 5000), modules: await page.locator('[module-data]').count() };
  }
});
try {
  report.products = await collector.collectGroup(process.argv[2], (progress) => {
    if (progress.stage !== 'listing') return;
    report.pages.push(progress);
    console.log(JSON.stringify(progress));
  }, { allPages: process.env.QA_ALL_PAGES === '1', startPage: Number(process.env.QA_START_PAGE || 1), endPage: Number(process.env.QA_END_PAGE || 11), delaySeconds: Number(process.env.QA_DELAY_SECONDS || 0) });
  console.log(JSON.stringify({ count: report.products.length, matches: report.products.filter((item) => /30KGF|VL8020|H15 Plus|MN1315|H11M/i.test(item.title)).map(({ sourceId, sourceUrl, title }) => ({ sourceId, sourceUrl, title })) }));
} catch (error) { report.error = error.stack; console.error(error.message); process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(output, 'listing.json'), JSON.stringify(report, null, 2));
  await collector.resetContext();
}
