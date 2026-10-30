// Inspect native pricing choices without saving or submitting a listing.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, fillAndVerify, fillVariantSpecs, fillColorSpec } from '../server/publisher.js';
import { selectSkuPricing } from '../server/sku-reference.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const output = process.env.QA_OUTPUT_DIR;
assert.ok(output && process.env.QA_DESKTOP_USER_DATA_DIR && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(output, { recursive: true });
const cookies = path.join(output, 'session.json');
writePrivateSession(cookies, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookies;
const publisher = new SellerPublisher(path.join(output, 'browser'));
const report = { submitted: false, cases: [] };
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  for (const categoryId of (process.env.QA_CATEGORY_IDS || '201905202,1355').split(',')) {
    assert.match(categoryId, /^\d+$/);
    await page.goto(`https://post.alibaba.com/product/publish.htm?catId=${categoryId}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input#productTitle').waitFor({ timeout: 45000 });
    await page.locator('#struct-scPrice').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    const item = { categoryId };
    if (process.env.QA_WORKSPACE_FILE) {
      const workspace = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE));
      const product = workspace.products.find(p => p.sourceId === process.env.QA_SOURCE_ID);
      assert.ok(product && product.categoryId === categoryId);
      item.color = await fillColorSpec(page, product.variantGroups.find(g => /color/i.test(g.name))?.options || []);
      item.specifications = await fillVariantSpecs(page, product);
    }
    item.form = await page.evaluate(() => ({
      fields: Object.fromEntries(['priceType', 'scPrice', 'sku', 'minOrderQuantity', 'priceAndInventory'].map(id => [id, {
        props: window.Json?.components?.[id]?.props,
        html: document.getElementById(id)?.outerHTML?.slice(0, 18000),
      }])),
      switches: Object.fromEntries(Object.entries(window.Json?.models?.global?.globalSwitcher || {}).filter(([key]) => /price|sku|trade|transaction/i.test(key))),
      skuRows: window.GlobalStore?.engine?.getModels()?.formValues?.sku?.length,
    }));
    const started = Date.now();
    try { await selectSkuPricing(page, { minOrder: 1 }, fillAndVerify, { timeoutMs: 5000 }); item.selected = true; }
    catch (error) { item.error = { code: error.code, message: error.message, diagnostics: error.diagnostics }; }
    item.elapsedMs = Date.now() - started;
    item.after = await page.evaluate(() => ({ skuRows: window.GlobalStore?.engine?.getModels()?.formValues?.sku?.length,
      modes: [...document.querySelectorAll('#scPrice .item-label')].map(n => n.textContent),
      priceMode: window.GlobalStore?.engine?.getModels()?.formValues?.scPrice,
    }));
    report.cases.push(item);
    console.log(JSON.stringify({ categoryId, selected: item.selected, error: item.error, elapsedMs: item.elapsedMs }));
  }
} catch (error) { report.error = { code: error.code, message: error.message }; process.exitCode = 1; }
finally { fs.writeFileSync(path.join(output, 'pricing.json'), JSON.stringify(report, null, 2)); await publisher.shutdown(); }
