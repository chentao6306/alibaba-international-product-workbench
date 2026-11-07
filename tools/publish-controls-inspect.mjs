import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher, clearSaleAttributeSelections } from '../server/publisher.js';
import { buildAlibabaPublishUrl } from '../server/category-routing.js';

const output = process.env.QA_OUTPUT_DIR;
if (!output) throw new Error('Set QA_OUTPUT_DIR for isolated inspection');
fs.mkdirSync(output, { recursive: true });
const publisher = new SellerPublisher(output);
const report = { snapshots: [] };
let page;
async function snapshot(stage) {
  const state = await page.evaluate(() => {
    const root = document.querySelector('#saleAttributesItems');
    const fiberKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey && root[fiberKey];
    const components = [];
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (props?.id !== 'saleAttributesItems') continue;
      components.push({ keys: Object.keys(props), value: props.value, dataSource: props.dataSource, maxItem: props.maxItem, hide: props.hide });
    }
    const imageRequirements = [];
    for (const id of ['saleAttributesSupportImage', 'p-210190015']) {
      const node = document.getElementById(id);
      const key = node && Object.getOwnPropertyNames(node).find(key => key.startsWith('__reactFiber'));
      let current = key && node[key];
      for (let depth = 0; current && depth < 12; depth++, current = current.return) {
        const props = current.memoizedProps || current.stateNode?.props;
        if (props?.id !== id) continue;
        const selected = Object.fromEntries(Object.entries(props).filter(([key]) => !/children|change|context|store|schema/i.test(key)));
        imageRequirements.push({ id, props: JSON.parse(JSON.stringify(selected, (key, value) => typeof value === 'function' ? String(value).slice(0, 7000) : value)) });
      }
    }
    return { html: root?.outerHTML, components, imageRequirements, rows: [...document.querySelectorAll('#struct-specification [id^="p-"]')].map((node) => ({ id: node.id, visible: Boolean(node.getClientRects().length), text: node.textContent.slice(0, 300), html: node.outerHTML.slice(0, 16000) })) };
  });
  report.snapshots.push({ stage, ...state });
}
try {
  page = await publisher.currentSellerPage();
  await page.goto(buildAlibabaPublishUrl(process.argv[2] || '201346401'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('input#productTitle').waitFor({ timeout: 30000 });
  await page.locator('#saleAttributesItems').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await snapshot('loaded');
  report.cleared = await clearSaleAttributeSelections(page);
  await snapshot('cleared');
  if (process.env.QA_PRODUCT_FILE) {
    const source = JSON.parse(fs.readFileSync(process.env.QA_PRODUCT_FILE, 'utf8'));
    try { report.mapping = await publisher.fillProductFields(page, source.product || source, (stage) => console.log(stage)); }
    catch (error) { report.fillError = error.message; }
    await snapshot('filled');
  }
  const trigger = page.locator('.image-uploader #image-placeholder-span').first();
  await trigger.hover();
  await page.waitForTimeout(1000);
  report.uploadMenus = await page.locator('[class*="menu"], [class*="popup"], [class*="overlay"]').evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length).map((node) => node.outerHTML.slice(0, 16000)));
  await page.screenshot({ path: path.join(output, 'controls.png') });
  console.log(JSON.stringify({ output, cleared: report.cleared, fillError: report.fillError, components: report.snapshots.map((s) => ({ stage: s.stage, components: s.components })) }));
} finally {
  fs.writeFileSync(path.join(output, 'controls.json'), JSON.stringify(report, null, 2));
  await publisher.shutdown();
}
