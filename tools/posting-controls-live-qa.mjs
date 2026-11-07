// Read-only inspection of the current seller form. No submission or fake media.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readSellerGroups, applySellerGroup } from '../server/seller-groups.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT && process.env.KUA_YIPU_ALIBABA_COOKIES_FILE);
fs.mkdirSync(root, { recursive: true });
const publisher = new SellerPublisher(root); const result = {};
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`${buildAlibabaPublishUrl('202063712')}&language=zh_CN`, { waitUntil: 'domcontentloaded' });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  if (process.env.QA_SKU_CONTROLS === '1') {
    await publisher.fillPriceFields(page, { priceMode: 'sku', minOrder: 3000, skus: [{ price: 5.1 }] });
    result.skuMinimumControls = await page.locator('.com-struct[id]').evaluateAll(nodes => nodes.filter(node => /最小起订量|minimum order/i.test(node.innerText)).map(node => ({ id: node.id, html: node.outerHTML })));
  }
  try {
    result.groups = await readSellerGroups(page);
    if (result.groups.length) result.selected = await applySellerGroup(page, result.groups[0]);
  } catch (error) { result.groupError = error.message; }
  result.groupControls = await page.locator('#struct-productGroup, .posting-field-group:visible').evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
  await page.keyboard.press('Escape');
  result.sections = await page.locator('.com-struct[id]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.id, text: node.innerText?.slice(0, 1500),
    controls: [...node.querySelectorAll('input, select, button')].map((item) => ({ tag: item.tagName, id: item.id, type: item.type, label: item.getAttribute('aria-label'), text: item.textContent?.slice(0, 100) })),
  })));
  result.optionalHtml = await page.locator('.com-struct[id]').evaluateAll((nodes) => nodes.filter((node) => /custom|service|cert|country|region|imageMedia|scImages/i.test(node.id)).map((node) => ({ id: node.id, html: node.outerHTML.slice(0, 90000) })));
  result.video = await page.locator('[id*="video" i], [class*="video" i], input[type="file"]').evaluateAll((nodes) => nodes.map((node) => ({
    tag: node.tagName, id: node.id, class: node.className, text: node.innerText?.slice(0, 500), accept: node.getAttribute('accept'),
    visible: !!node.getClientRects().length, html: node.outerHTML.slice(0, 3500),
  })).slice(0, 65));
  await page.screenshot({ path: path.join(root, 'form.png') });
  if (process.env.QA_OPTIONAL_CONTROLS === '1') {
    await publisher.fillPriceFields(page, { price: 6, moq: 10, priceTiers: [{ minQuantity: 10, price: 6 }, { minQuantity: 100, price: 5 }] });
    await page.locator('#struct-icbuCountryRegion input[value="US"]').check();
    await page.locator('#struct-countryLadderPrice').waitFor({ state: 'visible' });
    result.regionalHtml = await page.locator('#struct-countryLadderPrice').evaluate((node) => node.outerHTML);
    for (const [key, text] of [['amount', '基础价加减金额'], ['percent', '基础价调整比例']]) {
      await page.locator('#struct-countryLadderPrice').getByLabel(text, { exact: true }).check();
      result[`regional${key}Html`] = await page.locator('#struct-countryLadderPrice').evaluate((node) => node.outerHTML);
    }
    await page.locator('#struct-certificate .certificate-empty-link').click();
    const dialog = page.locator('[role="dialog"]:visible').last();
    await dialog.waitFor();
    result.certificateDialog = await dialog.evaluate((node) => node.outerHTML);
    await page.screenshot({ path: path.join(root, 'certificate-dialog.png') });
    await page.keyboard.press('Escape');
  }
  console.log(JSON.stringify({ groups: result.groups?.length, groupError: result.groupError, videoNodes: result.video.length }));
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally { fs.writeFileSync(path.join(root, 'controls.json'), JSON.stringify(result, null, 2)); await publisher.shutdown(); }
