// Exercise media controls on an unsaved form, never advertise test service terms.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { customizationFormModel } from '../server/posting-extras.js';
import { hotspotMatches } from '../server/posting-customization-media.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_MEDIA_WORKSPACE && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const data = JSON.parse(fs.readFileSync(process.env.QA_MEDIA_WORKSPACE));
const source = data.products.find(item => item.sourceId === '1601055103979');
assert.ok(source?.mainImages?.length);
const publisher = new SellerPublisher(root), report = { checks: [] };
let page;
try {
  page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto('https://post.alibaba.com/product/publish.htm?from=common&catId=202063712&language=zh_CN', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  const product = { ...source, regionalPricing: {}, certificates: [], services: {
    lightCustomization: ['Packaging', 'Logo/graphic design'], customizationDetails: {
      'lightCustomization:Packaging': { rows: [{ value: 'Test example', surcharge: 0.5, moq: 3000, image: source.mainImages[0] }] },
      'lightCustomization:Logo/graphic design': { rows: [{ value: 'Print', surcharge: 1, moq: 3000 }], baseImage: source.mainImages[0], hotspot: { x: 30, y: 40, width: 20, height: 20 } },
    },
  } };
  for (let pass = 0; pass < 6; pass++) {
    if (pass === 2) product.services.customizationDetails['lightCustomization:Logo/graphic design'].hotspot = { x: 20, y: 35, width: 35, height: 15 };
    if (pass === 3) product.services.customizationDetails['lightCustomization:Logo/graphic design'].baseImage = source.mainImages[1];
    if (pass === 4) product.services.customizationDetails['lightCustomization:Logo/graphic design'].hotspot = { x: 5, y: 10, width: 90, height: 80 };
    if (pass === 5) product.services.customizationDetails['lightCustomization:Logo/graphic design'].baseImage = source.mainImages[0];
    await publisher.fillAdditionalProductFields(page, product);
    const model = await customizationFormModel(page.locator('#lightCustomizedServices'));
    const image = model.flatMap(value => value.hotImages || [])[0];
    assert.ok(hotspotMatches(image, product.services.customizationDetails['lightCustomization:Logo/graphic design'].hotspot));
    report.checks.push({ pass, text: await page.locator('#lightCustomizedServices').innerText(),
      model,
      images: await page.locator('#lightCustomizedServices img').evaluateAll(nodes => nodes.map(n => n.src)) });
  }
  report.ok = true;
} catch (error) { report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally {
  if (page) {
    report.html = await page.locator('#lightCustomizedServices').evaluate(node => node.outerHTML).catch(() => '');
    report.dialogs = await page.locator('.next-dialog:visible, .next-overlay-wrapper:visible').evaluateAll(nodes => nodes.map(node => node.outerHTML));
    report.frameLocations = page.frames().map(frame => frame.url());
    const bank = page.frames().find(frame => /photobank\.alibaba\.com\/popup\.htm/.test(frame.url()));
    if (bank) report.photoBank = await bank.locator('body').innerHTML().catch(() => 'unavailable');
    report.frames = await Promise.all(page.frames().filter(frame => /smart-customization/.test(frame.url())).map(async frame => ({ text: await frame.locator('body').innerText().catch(() => ''), html: await frame.locator('body').innerHTML().catch(() => '') })));
    await page.screenshot({ path: path.join(root, 'customization.png') }).catch(() => {});
  }
  fs.writeFileSync(path.join(root, 'customization.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, error: report.error }));
  await publisher.shutdown();
}
