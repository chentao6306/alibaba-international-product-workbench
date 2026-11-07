import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher, fillOriginCountry } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
import { readSellerGroups, applySellerGroup } from '../server/seller-groups.js';
import { readPrivateSession } from '../server/private-session-storage.js';
import assert from 'node:assert/strict';
import { ORIGIN_COUNTRIES } from '../server/origin-country.js';

const root = process.env.QA_OUTPUT_DIR;
if (!root) throw new Error('Set QA_OUTPUT_DIR');
fs.mkdirSync(root, { recursive: true });
const cookies = readPrivateSession(process.env.KUA_YIPU_ALIBABA_COOKIES_FILE);
console.log(JSON.stringify({ cookieCount: cookies.length, authCookiePresent: cookies.some((cookie) => cookie.name === 'xman_us_t'), modified: fs.statSync(process.env.KUA_YIPU_ALIBABA_COOKIES_FILE).mtime }));
const publisher = new SellerPublisher(root);
try {
  const page = await publisher.currentSellerPage(buildAlibabaPublishUrl('201346401'));
  await page.goto(buildAlibabaPublishUrl('201346401'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  try { await page.locator('input#productTitle').waitFor({ state: 'visible', timeout: 30000 }); }
  catch (error) {
    console.log(JSON.stringify({ url: page.url(), title: await page.title(), content: (await page.locator('body').innerText()).slice(0, 400) }));
    await page.screenshot({ path: path.join(root, 'page.png') });
    throw error;
  }
  const origin = page.locator('.sell-catProp-item').filter({ has: page.locator('.label', { hasText: /^\s*\*?\s*(产地|Place of Origin)\s*$/i }) }).first();
  const before = await origin.evaluate((node) => node.outerHTML);
  const countryData = await origin.evaluate((node) => {
    const data = [];
    for (const element of [node, ...node.querySelectorAll('*')]) {
      const key = Object.keys(element).find((name) => /^__react(?:Fiber|InternalInstance)/.test(name));
      let fiber = element[key];
      for (let depth = 0; fiber && depth < 8; depth++, fiber = fiber.return) {
        for (const [name, value] of Object.entries(fiber.memoizedProps || {})) {
          if (!Array.isArray(value) || value.length < 20 || !value.every((item) => item && typeof item === 'object' && ('label' in item || 'name' in item))) continue;
          data.push({ name, items: value.map((item) => ({ label: item.label, name: item.name, value: item.value })) });
        }
      }
    }
    return data;
  });
  await origin.locator('input').first().click();
  await page.waitForTimeout(700);
  const countries = await page.locator('.sell-o-select-options:visible').evaluateAll((nodes) => nodes.map((node) => ({ html: node.outerHTML, text: node.innerText })));
  const countryNames = new Set();
  const viewport = page.locator('.sell-o-select-options:visible .options-content');
  await page.waitForTimeout(1200);
  for (let step = 0; step < 100; step++) {
    for (const text of await page.locator('.sell-o-select-options:visible .options-item').allTextContents()) countryNames.add(text.trim());
    const moved = await viewport.evaluate((root) => { const node = [root, ...root.querySelectorAll('*')].find((element) => element.scrollHeight > element.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(element).overflowY)); if (!node) return false; const previous = node.scrollTop; node.scrollTop += node.clientHeight - 20; node.dispatchEvent(new Event('scroll', { bubbles: true })); return node.scrollTop !== previous; });
    if (!moved) break;
    await page.waitForTimeout(100);
  }
  await page.keyboard.press('Escape');
  const originFilled = await fillOriginCountry(page, 'Guangdong, China');
  const originAfter = await origin.evaluate((node) => node.outerHTML);
  const groups = await readSellerGroups(page);
  const group = groups.find((item) => item.name === '照相机') || groups[0];
  let selected;
  try { selected = [await applySellerGroup(page, group), await applySellerGroup(page, group)]; } catch (error) { selected = { error: error.message }; }
  await page.waitForTimeout(800);
  await page.locator('#struct-productGroup .product-group-select').click();
  const groupState = await page.locator('#struct-productGroup').evaluate((node) => node.outerHTML);
  const groupPopup = await page.locator('.posting-field-group:visible').evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
  fs.writeFileSync(path.join(root, 'fields.json'), JSON.stringify({ before, countries, countryData, countryNames: [...countryNames], originFilled, originAfter, groups, selected, groupState, groupPopup }, null, 2));
  assert.equal(originFilled, true);
  assert.ok(Array.isArray(selected) && selected.length === 2 && selected.every((item) => item.id === group.id));
  if (countryData.length) assert.deepEqual(countryData[0].items.map((item) => item.label).sort(), ORIGIN_COUNTRIES.map((item) => item.name).sort());
  console.log(JSON.stringify({ root, groups: groups.length, selected, originFilled, countryPopups: countries.length }));
} finally { await publisher.shutdown(); }
