import { fillReferencedSkuRows } from '../server/sku-reference.js';
import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher, clearSaleAttributeSelections, ensureColorSpecificationReady, fillColorSpec, fillVariantSpecs, fillAndVerify } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
const root = process.env.QA_OUTPUT_DIR;
if (!root || !process.env.QA_PRODUCT_FILE) throw new Error('Specify isolated output and QA product file');
fs.mkdirSync(root, { recursive: true });
const product = JSON.parse(fs.readFileSync(process.env.QA_PRODUCT_FILE, 'utf8')).product;
const publisher = new SellerPublisher(root);
try {
  const page = await publisher.currentSellerPage(buildAlibabaPublishUrl(product.categoryId));
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  await clearSaleAttributeSelections(page);
  await ensureColorSpecificationReady(page);
  await fillColorSpec(page, product.variantGroups.find((group) => /color/i.test(group.name)).options);
  await fillVariantSpecs(page, product);
  await publisher.fillPriceFields(page, product);
  await page.waitForTimeout(1000);
  console.log(await fillReferencedSkuRows(page, product, fillAndVerify, console.log));
  const tables = await page.locator('table, .next-table, [role=table], [role=grid]').evaluateAll((tables) => tables.filter((table) => /Commodity code|商品编码|Available quantity|可售数量/i.test(table.innerText)).map((table) => ({ html: table.outerHTML, parent: table.closest('[id]')?.outerHTML || table.parentElement.parentElement.outerHTML })));
  fs.writeFileSync(path.join(root, 'sku-tables.json'), JSON.stringify(tables));
  console.log(JSON.stringify(tables.map((table) => ({ length: table.html.length }))));
} finally { await publisher.shutdown(); }
