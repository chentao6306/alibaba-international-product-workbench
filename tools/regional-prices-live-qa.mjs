// Changes only a fresh, unsaved seller form; no synthetic prices are submitted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, fillAndVerify, fillVariantSpecs, ensureColorSpecificationReady, fillColorSpec } from '../server/publisher.js';
import { fillReferencedSkuRows } from '../server/sku-reference.js';
import { fillRegionalPrices } from './qa/posting-extras.mjs';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const publisher = new SellerPublisher(root), report = { checks: [] };
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`${buildAlibabaPublishUrl('202063712')}&language=zh_CN`, { waitUntil: 'domcontentloaded' });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  const product = { price: 6, moq: 10, priceTiers: [{ minQuantity: 10, price: 6 }, { minQuantity: 100, price: 5 }] };
  await publisher.fillPriceFields(page, product);
  for (const [mode, us, ca] of [['fixed', 8, 9], ['amount', -1, 2], ['percent', 10, -10], ['amount', 0, 0]]) {
    product.regionalPricing = { mode, rows: [{ country: 'United States', value: us }, { country: 'Canada', value: ca }] };
    for (let pass = 0; pass < 2; pass++) {
      await fillRegionalPrices(page, product, fillAndVerify);
      const cells = await page.locator('#struct-countryLadderPrice tbody td[data-next-table-col]:visible').evaluateAll((nodes) => nodes.filter((node) => node.querySelector('input')).map((node) => ({
        col: node.getAttribute('data-next-table-col'), row: node.getAttribute('data-next-table-row'),
        value: node.querySelector('input:not([readonly])')?.value, sign: node.querySelector('em')?.textContent,
        preview: node.querySelector('.price-preview')?.textContent,
      })));
      assert.equal(cells.length, 4);
      for (const cell of cells) {
        const delta = cell.col === '1' ? us : ca;
        assert.equal(Number(cell.value), Math.abs(delta));
        if (mode !== 'fixed') {
          assert.equal(cell.sign, delta < 0 ? '-' : '+');
          const base = Number(cell.row) === 0 ? 6 : 5;
          const expected = mode === 'amount' ? base + delta : base * (1 + delta / 100);
          assert.ok(Math.abs(Number(cell.preview.replace(/[^\d.\-]/g, '')) - expected) < 0.0001);
        }
      }
      report.checks.push({ mode, pass, cells });
    }
  }
  if (process.env.QA_SKU_REGIONAL === '1') {
    const colors = JSON.parse(process.env.QA_SKU_REGIONAL_COLORS || '["White","Black"]');
    const skuProduct = { price: 6, moq: 10, priceMode: 'sku', variantGroups: [{ name: 'Color', options: colors }],
      skus: colors.map((color, index) => ({ attributes: { Color: color }, price: 6 + index, stock: 100 })) };
    const variants = await fillVariantSpecs(page, skuProduct);
    await ensureColorSpecificationReady(page);
    await fillColorSpec(page, colors);
    await publisher.fillPriceFields(page, skuProduct);
    await fillReferencedSkuRows(page, skuProduct, fillAndVerify, () => {}, { appliedGroups: variants.groups });
    report.skuRegional = [];
    try {
      for (const [mode, us, ca] of [['amount', 2, -1], ['percent', -10, 10], ['fixed', 8, 9]]) {
        skuProduct.regionalPricing = { mode, rows: [{ country: 'United States', value: us }, { country: 'Canada', value: ca }] };
        await fillRegionalPrices(page, skuProduct, fillAndVerify);
        const cells = await page.locator('#struct-countrySku tbody td[data-next-table-col]:visible').evaluateAll((nodes) => nodes.filter((node) => node.querySelector('input')).map((node) => ({
          col: node.getAttribute('data-next-table-col'), row: node.getAttribute('data-next-table-row'), value: node.querySelector('input:not([readonly])')?.value,
          preview: node.querySelector('.super-price-value')?.textContent,
        })));
        assert.equal(cells.length, colors.length * 2);
        for (const cell of cells) {
          const delta = cell.col === '1' ? us : ca;
          assert.equal(Number(cell.value), Math.abs(delta));
          if (mode !== 'fixed') {
            const base = 6 + Number(cell.row);
            const expected = mode === 'amount' ? base + delta : base * (1 + delta / 100);
            assert.ok(Math.abs(Number(cell.preview.replace(/[^\d.\-]/g, '')) - expected) < 0.0001);
          }
        }
        report.skuRegional.push({ mode, cells });
      }
    }
    finally { report.skuHtml = await page.locator('#struct-countrySku, #struct-countryLadderPrice').evaluateAll((nodes) => nodes.map((node) => node.outerHTML)); }
  }
  report.ok = true; console.log(JSON.stringify({ ok: true, checks: report.checks.length }));
} catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
finally { fs.writeFileSync(path.join(root, 'regional-prices.json'), JSON.stringify(report, null, 2)); await publisher.shutdown(); }
