// Inspect optional controls in fresh unsaved forms; never submit the form.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const publisher = new SellerPublisher(root);
const report = { stages: [] };
let page;
async function capture(stage) {
  const sections = await page.locator('#struct-newCustomizedServices, #struct-scImages, #struct-imageMedia, #struct-designAndSampleService').evaluateAll(nodes => nodes.map(node => ({ id: node.id, html: node.outerHTML })));
  const visible = await page.locator('body').innerText();
  report.stages.push({ stage, sections, visible: visible.slice(-30000) });
  fs.writeFileSync(path.join(root, 'extras-inspection.json'), JSON.stringify(report, null, 2));
}
try {
  page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`${buildAlibabaPublishUrl(process.env.QA_CATEGORY_ID || '202063712')}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  await capture('initial');
  report.mediaProps = await page.locator('.posting-field-media').evaluateAll(nodes => nodes.map(node => {
    let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
    const entries = [];
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (props.id === 'imageMedia' || props.dataSource || props.mediaType) entries.push(JSON.parse(JSON.stringify(props, (key, value) => /children|store|context/i.test(key) || typeof value === 'function' ? undefined : value)));
    }
    return entries;
  }));
  const image = page.locator('#struct-scImages #image-placeholder').first();
  await image.hover();
  await page.waitForTimeout(500);
  report.imageMenus = await page.locator('[role="menu"]:visible, .next-overlay-wrapper:visible').evaluateAll(nodes => nodes.map(node => node.outerHTML));
  await page.keyboard.press('Escape');
  for (const [name, selector] of [['logo', '#lightCustomizedServices input[value="379198062"]'], ['packaging', '#lightCustomizedServices input[value="210194818"]'], ['deep', '#newCustomizedServices input[value="262774178"]']]) {
    const input = page.locator(selector);
    if (await input.count() && await input.isVisible()) {
      await input.check();
      await page.waitForTimeout(600);
      await capture(name);
      if (name === 'logo') {
        await page.locator('#lightCustomizedServices .base-map .hot-area').first().click();
        await page.locator('#smartCustomization').waitFor({ timeout: 20000 });
        report.logoDialog = await page.locator('.next-overlay-wrapper.opened').evaluateAll(nodes => nodes.map(node => node.outerHTML));
        const frame = await page.locator('#smartCustomization').elementHandle().then(node => node.contentFrame());
        await frame.locator('body').waitFor();
        await frame.waitForTimeout(3000);
        report.logoFrame = await frame.locator('body').innerHTML();
        if (process.env.QA_MEDIA_WORKSPACE) {
          const data = JSON.parse(fs.readFileSync(process.env.QA_MEDIA_WORKSPACE));
          const product = data.products.find(item => item.sourceId === '1601055103979');
          assert.ok(product?.mainImages?.length);
          const [file] = await publisher.downloadImageSet(product, [product.mainImages[0]], 'qa-customization', 1);
          await frame.locator('input[type="file"]').setInputFiles(file);
          await frame.waitForTimeout(5000);
          const continueButton = frame.getByText('Continue editing hotspot', { exact: true });
          if (await continueButton.isVisible().catch(() => false)) await continueButton.click();
          await frame.waitForTimeout(1000);
          report.logoUploadedFrame = await frame.locator('body').innerHTML();
          await page.screenshot({ path: path.join(root, 'logo-uploaded.png') });
        }
        await page.goto(`${buildAlibabaPublishUrl(process.env.QA_CATEGORY_ID || '202063712')}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('input#productTitle').waitFor({ timeout: 60000 });
        continue;
      }
      await input.uncheck();
    }
  }
  await page.goto(`${buildAlibabaPublishUrl(process.env.QA_CATEGORY_ID || '202063712')}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  await publisher.fillPriceFields(page, { price: 6, moq: 10, priceTiers: [{ minQuantity: 10, price: 6 }, { minQuantity: 100, price: 5 }] });
  report.countryBefore = await page.locator('#struct-icbuCountryRegion').evaluateAll(nodes => nodes.map(node => ({ html: node.outerHTML, visible: Boolean(node.getClientRects().length) })));
  const addCountry = page.locator('#struct-icbuCountryRegion').getByText('添加国家/地区', { exact: true });
  await addCountry.waitFor({ timeout: 15000 });
  if (await addCountry.count()) {
    await addCountry.click();
    await page.waitForTimeout(2000);
    report.countrySection = await page.locator('#struct-icbuCountryRegion').evaluate(node => node.outerHTML);
    report.countryBody = await page.locator('body').innerText();
    report.countryDialog = await page.locator('[role="dialog"]:visible, .next-overlay-wrapper:visible').evaluateAll(nodes => nodes.map(node => node.outerHTML));
    await page.keyboard.press('Escape');
  }
  await page.screenshot({ path: path.join(root, 'extras.png'), fullPage: true });
  report.ok = true;
  console.log(JSON.stringify({ ok: true, stages: report.stages.map(row => row.stage) }));
} catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
finally {
  fs.writeFileSync(path.join(root, 'extras-inspection.json'), JSON.stringify(report, null, 2));
  await publisher.shutdown();
}
