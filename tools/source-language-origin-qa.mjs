// Compare public product attributes across language surfaces without changing seller settings.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { parseAlibabaDetailDataScript } from '../server/alibaba-source-data.js';
import { extractAlibabaAttributes, readAlibabaAttributeRows } from '../server/category-attributes.js';
import { collectSourceAttributeSections } from '../server/source-attributes.js';
import { waitForHumanVerification } from '../server/browser-runtime.js';
const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_DESKTOP_USER_DATA_DIR);
const state = JSON.parse(fs.readFileSync(path.join(root, 'original-workspace.json')));
const cookieFile = path.join(root, 'locale-cookies.json');
writePrivateSession(cookieFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
// Reuse the source profile in which the user just completed verification.
const publisher = new SellerPublisher(path.join(root, 'source-inspection-browser'));
const report = [];
try {
  let context = await publisher.sourceBrowser();
  for (const sourceId of ['1601005481073', '1600397404733']) for (const locale of (process.env.QA_SOURCE_LOCALES || 'en_US,zh_CN').split(',')) {
    const p = state.products.find(item => item.sourceId === sourceId);
    const row = { sourceId, requestedLocale: locale }; report.push(row);
    let page;
    try {
      await context.addCookies([{ name: 'intl_locale', value: locale, domain: '.alibaba.com', path: '/' },
        { name: '_lang', value: `${locale}:GB18030`, domain: '.alibaba.com', path: '/' }]);
      const localeCookies = (await context.cookies('https://www.alibaba.com')).filter(c => ['sc_g_cfg_f', 'xman_us_f'].includes(c.name));
      await context.addCookies(localeCookies.map(c => ({ ...c, value: c.value.replace(/(sc_b_locale|x_locale)=[^&]*/ig, `$1=${locale}`) })));
      page = await context.newPage();
      await page.setExtraHTTPHeaders({ 'Accept-Language': locale === 'en_US' ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9' });
      const url = new URL(p.sourceUrl); if (locale === 'zh_CN') url.hostname = 'chinese.alibaba.com';
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try { await waitForHumanVerification(page); }
      catch (error) {
        if (error.code !== 'HUMAN_VERIFICATION_REQUIRED') throw error;
        console.log('Waiting for manual verification on the Chinese product page');
        await publisher.completeSourceVerification(error.verificationUrl || url.href);
        context = await publisher.sourceBrowser(); page = await context.newPage();
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForHumanVerification(page);
      }
      await collectSourceAttributeSections(page, { verify: () => waitForHumanVerification(page) });
      row.url = page.url();
      row.language = await page.locator('html').getAttribute('lang');
      row.dom = await page.evaluate(readAlibabaAttributeRows);
      const script = await page.evaluate(() => [...document.scripts].map(s => s.textContent).find(s => /(?:window\.)?detailData\s*=\s*\{/.test(s)) || '');
      const data = parseAlibabaDetailDataScript(script);
      row.structured = extractAlibabaAttributes(data);
      row.rawProduct = data?.globalData?.product;
      row.attributeModules = Object.fromEntries(Object.entries(data?.nodeMap || {}).filter(([name]) => /attribute|specification|packaging/i.test(name) && !/recommend|related/i.test(name)));
      row.origin = [...row.structured, ...row.dom].filter(a => /origin|province|产地|原产|省份/i.test(a.name));
      await page.screenshot({ path: path.join(root, `${sourceId}-${locale}-attributes.png`) });
      console.log(JSON.stringify({ sourceId, requestedLocale: locale, language: row.language, origin: row.origin, rows: row.structured.length }));
    } catch (error) { row.error = { code: error.code, message: error.message }; console.error(JSON.stringify(row.error)); }
    finally { await page?.close().catch(() => {}); fs.writeFileSync(path.join(root, process.env.QA_LANGUAGE_REPORT || 'language-origin.json'), JSON.stringify(report, null, 2)); }
  }
} finally { await publisher.shutdown(); }
