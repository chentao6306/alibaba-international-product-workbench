// Inspect actual controls without saving or changing existing products.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPostingVideoState } from '../server/posting-video.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const publisher = new SellerPublisher(root), report = {};
let page;
const save = () => fs.writeFileSync(path.join(root, 'media-country.json'), JSON.stringify(report, null, 2));
try {
  page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto('https://post.alibaba.com/product/publish.htm?from=common&catId=202063712&language=zh_CN', { waitUntil: 'domcontentloaded', timeout: 60000 }); break; }
    catch (error) { (report.navigationErrors ||= []).push(error.message); if (attempt === 2) throw error; await page.waitForTimeout(1500 * (attempt + 1)); }
  }
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  report.video = await page.evaluate(readPostingVideoState);
  await publisher.fillPriceFields(page, { price: 6, moq: 10, priceTiers: [{ minQuantity: 10, price: 6 }, { minQuantity: 100, price: 5 }] });
  await page.locator('#struct-icbuCountryRegion').scrollIntoViewIfNeeded();
  report.countryBefore = await page.locator('#struct-icbuCountryRegion').evaluate(node => node.outerHTML);
  save();
  const add = page.locator('#struct-icbuCountryRegion .editBtn');
  if (await add.count()) {
    await add.click();
    await page.waitForTimeout(1200);
    report.countrySection = await page.locator('#struct-icbuCountryRegion').evaluate(node => node.outerHTML);
    report.countryDialog = await page.locator('[role="dialog"]:visible, .next-overlay-wrapper:visible').evaluateAll(nodes => nodes.map(node => node.outerHTML));
    report.countryBody = await page.locator('body').innerText();
    const countryFrame = page.frames().find(frame => /\/country\/country\.htm/.test(frame.url()));
    if (countryFrame) {
      await countryFrame.locator('input').first().waitFor({ state: 'attached', timeout: 20000 });
      report.countryFrame = await countryFrame.locator('body').innerHTML();
    }
    save();
  }
  if (report.video.config?.url) {
    const bank = await page.context().newPage();
    await bank.goto(report.video.config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await bank.locator('button, input[type="file"], .video-list, .no-data').first().waitFor({ state: 'attached', timeout: 25000 }).catch(() => {});
    report.bank = { url: bank.url(), text: await bank.locator('body').innerText(), html: await bank.locator('body').evaluate(node => { const copy=node.cloneNode(true);copy.querySelectorAll('script').forEach(n=>n.remove());return copy.outerHTML; }) };
    const manage = bank.getByRole('link', { name: 'Manage videos', exact: true });
    if (await manage.count()) {
      await bank.goto(new URL(await manage.getAttribute('href'), bank.url()).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await bank.getByText('Upload Video', { exact: true }).first().waitFor({ timeout: 25000 }).catch(() => {});
      report.videoManagement = { url: bank.url(), text: await bank.locator('body').innerText(), html: await bank.locator('body').evaluate(node => { const copy=node.cloneNode(true);copy.querySelectorAll('script').forEach(n=>n.remove());return copy.outerHTML; }) };
      await bank.getByText('Upload Video', { exact: true }).first().click();
      await bank.waitForTimeout(1500);
      report.videoUpload = { text: await bank.locator('body').innerText(), html: await bank.locator('body').evaluate(node => { const copy=node.cloneNode(true);copy.querySelectorAll('script').forEach(n=>n.remove());return copy.outerHTML; }) };
    }
    await bank.screenshot({ path: path.join(root, 'video-bank.png') });
    await bank.close();
  }
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { save(); console.log(JSON.stringify({ ok: report.ok, error: report.error, video: report.video, bankText: report.bank?.text })); await publisher.shutdown(); }
