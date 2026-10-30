import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';
import { readSellerGroups, applySellerGroup } from '../server/seller-groups.js';

const root = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'seller-groups-qa-'));
fs.mkdirSync(root, { recursive: true });
const publisher = new SellerPublisher(root);
try {
  const loaded = await publisher.listSellerGroups('201346401');
  const page = await publisher.currentSellerPage(buildAlibabaPublishUrl('201346401'));
  await page.goto(buildAlibabaPublishUrl('201346401'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('input#productTitle').waitFor({ state: 'visible', timeout: 60000 });
  const groups = await readSellerGroups(page);
  const selected = groups[0] ? await applySellerGroup(page, groups[0]) : null;
  await page.screenshot({ path: path.join(root, 'groups.png'), fullPage: true });
  const report = { root, url: page.url(), loaded, groups, selected };
  fs.writeFileSync(path.join(root, 'groups.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await publisher.shutdown(); }
