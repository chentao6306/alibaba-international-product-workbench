import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SellerPublisher, validateProductData, requiredLabelsFromError } from '../server/publisher.js';
import { findPublishedReferenceRepair, requiredAttributeKey } from '../server/publish-reference.js';
import { launchPersistent } from '../server/browser-runtime.js';
import { buildAlibabaPublishUrl, productCategory } from '../server/category-routing.js';
import { ShopCollector } from '../server/collector.js';

// Run explicitly against a local workspace; reports never contain session data.
const [action = 'inspect', query = '201346401'] = process.argv.slice(2);
const workspaceDir = process.env.QA_WORKSPACE_DIR;
if (!workspaceDir) throw new Error('Set QA_WORKSPACE_DIR to the workspace data directory');
const outputDir = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'alibaba-publish-qa-'));
fs.mkdirSync(outputDir, { recursive: true });
const state = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'));
const publisher = new SellerPublisher(outputDir);
const report = { action, query, outputDir, stages: [] };
const cpuSlowdown = Number(process.env.QA_CPU_SLOWDOWN || 1);
if (cpuSlowdown > 1) {
  const currentSellerPage = publisher.currentSellerPage.bind(publisher);
  const configured = new WeakSet();
  publisher.currentSellerPage = async (...args) => {
    const page = await currentSellerPage(...args);
    if (!configured.has(page)) {
      const session = await page.context().newCDPSession(page);
      await session.send('Emulation.setCPUThrottlingRate', { rate: Math.min(cpuSlowdown, 8) });
      configured.add(page);
    }
    return page;
  };
  report.cpuSlowdown = Math.min(cpuSlowdown, 8);
}
const progress = (stage) => {
  report.stages.push({ stage, at: new Date().toISOString(), url: publisher.page?.url() });
  console.log(stage);
  if (process.env.QA_STOP_STAGE === stage) throw new Error(`QA stopped at ${stage}`);
};
const waitForForm = async (page) => {
  await page.locator('input#productTitle').waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('.sell-catProp-item').first().waitFor({ state: 'visible', timeout: 30000 });
};
let page;
let collector;
// Real Alibaba submissions can spend several minutes uploading media and
// waiting for server-side validation. Keep the watchdog long enough to reach
// the platform response while still preventing an abandoned browser session.
const deadline = setTimeout(() => {
  progress('QA deadline reached');
  publisher.shutdown().catch(() => {});
  collector?.resetContext().catch(() => {});
}, 600000);
try {
  if (action === 'collect-group') {
    collector = new ShopCollector(outputDir, (products, onProgress, options) => publisher.enrichSourceProducts(products.slice(0, 1), onProgress, options));
    report.products = await collector.collectGroup(query, ({ stage }) => progress(stage), { startPage: 1, endPage: 1 });
    report.validation = report.products.map((product) => ({ id: product.sourceId, errors: validateProductData(product) }));
  } else if (['inspect', 'menus'].includes(action)) {
    publisher.context = await launchPersistent(path.join(outputDir, 'seller-profile'), { headless: true });
    page = publisher.context.pages()[0] || await publisher.context.newPage();
    publisher.page = page;
    await page.goto(buildAlibabaPublishUrl(query), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForForm(page);
    if (action === 'menus') {
      report.menus = [];
      const rows = page.locator('.sell-catProp-item').filter({ has: page.locator('.label', { hasText: /^(电池容量|屏幕|蜂窝网络)\s*$/ }) });
      for (let index = 0; index < await rows.count(); index += 1) {
        const row = rows.nth(index);
        const control = row.locator('.next-select').first();
        await control.click({ timeout: 5000 });
        await page.waitForTimeout(500);
        const scrollSnapshots = [];
        const optionViewport = page.locator('.sell-o-select-options:visible .options-content').last();
        for (let step = 0; step < 12 && await optionViewport.count().catch(() => 0); step += 1) {
          scrollSnapshots.push(await page.locator('.sell-o-select-options:visible .options-item')
            .allTextContents().catch(() => []));
          const position = await optionViewport.evaluate((node) => {
            const previous = node.scrollTop;
            node.scrollTop = Math.min(node.scrollHeight, previous + Math.max(120, node.clientHeight - 30));
            node.dispatchEvent(new Event('scroll', { bubbles: true }));
            return { previous, current: node.scrollTop, height: node.scrollHeight, client: node.clientHeight };
          }).catch(() => null);
          if (!position || position.current === position.previous) break;
          await page.waitForTimeout(200);
        }
        report.menus.push({
          row: await row.evaluate((node) => node.outerHTML),
          options: await page.locator('[role="option"]:visible, .next-menu-item:visible').evaluateAll((nodes) => nodes.map((node) => ({ text: node.innerText, html: node.outerHTML }))),
          scrollSnapshots,
          overlays: await page.locator('.next-overlay-wrapper:visible').evaluateAll((nodes) => nodes.map((node) => node.outerHTML.slice(0, 40000))),
          menuLike: await page.evaluate(() => [...document.querySelectorAll('[class*="menu"], [class*="option"], [role="listbox"], [role="option"]')]
            .filter((node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length))
            .map((node) => ({ tag: node.tagName, className: node.className, role: node.getAttribute('role'), text: String(node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000), html: node.outerHTML.slice(0, 12000) })).slice(-50))
        });
        await page.keyboard.press('Escape');
      }
    }
  } else {
    const imported = process.env.QA_PRODUCT_FILE ? JSON.parse(fs.readFileSync(process.env.QA_PRODUCT_FILE, 'utf8')) : null;
    let product = structuredClone((imported?.products || state.products).find((item) => item.id === query || item.sourceId === query) || imported?.product);
    if (!product) throw new Error('Product not found in QA workspace');
    if (process.argv.includes('--original')) {
      const source = product.source?.snapshot;
      if (!source) throw new Error('Original source snapshot is unavailable');
      product = { ...product, ...source, price: source.sourcePrice ?? product.price };
    }
    if (action === 'collect') {
      [product] = await publisher.enrichSourceProducts([product], () => progress('Collected source detail'));
      report.product = product;
      report.validation = validateProductData(product);
    } else {
      const category = productCategory(product);
      const missingField = process.env.QA_MISSING_FIELD;
      if (missingField) {
        for (const field of ['attributes', 'customAttributes']) {
          product[field] = (product[field] || []).filter((item) => requiredAttributeKey(item.name) !== requiredAttributeKey(missingField));
        }
        report.simulatedMissingField = missingField;
      }
      report.product = structuredClone(product);
      if (action === 'fields') {
        await publisher.open({ startUrl: buildAlibabaPublishUrl(category.id) });
        page = publisher.page;
        page.setDefaultTimeout(5000);
        await waitForForm(page);
        report.mapping = await publisher.fillProductFields(page, product, progress);
        await publisher.fillPriceFields(page, product);
      } else if (['draft', 'submit'].includes(action)) {
        try {
          const sellerGroup = process.env.QA_SELLER_GROUP_ID ? { id: process.env.QA_SELLER_GROUP_ID, name: process.env.QA_SELLER_GROUP_NAME || '' } : null;
          report.result = await publisher.publishProduct(product, buildAlibabaPublishUrl(category.id), action, category.pathText, 'qa', progress, { sellerGroup });
        } catch (error) {
          if (!process.env.QA_REFERENCE_FILE) throw error;
          const reference = JSON.parse(fs.readFileSync(process.env.QA_REFERENCE_FILE, 'utf8'));
          const fields = [...new Set([...(error.requiredFields || []), ...requiredLabelsFromError(error.message)])];
          const repair = findPublishedReferenceRepair(product, [reference], fields);
          if (!repair) throw error;
          report.initialFailure = { message: error.message, requiredFields: fields };
          report.referenceRepair = repair;
          product = { ...product, ...repair.patch };
          report.repairedProduct = structuredClone(product);
          progress(`引用成功商品补齐：${repair.fields.join('、')}`);
          report.result = await publisher.publishProduct(product, buildAlibabaPublishUrl(category.id), action, category.pathText, 'qa-retry', progress);
        }
      } else throw new Error('Unknown QA action');
    }
  }
} catch (error) {
  report.error = String(error?.stack || error);
  console.error(String(error?.message || error));
  process.exitCode = 1;
} finally {
  page ||= publisher.page;
  if (page && !page.isClosed()) {
    report.url = page.url();
    report.text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    report.form = await publisher.inspectCurrentForm().catch(() => null);
    report.fields = await page.locator('[id^="p-"], .sell-catProp-item').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.id,
      text: node.innerText,
      inputs: [...node.querySelectorAll('input,select,textarea')].map((item) => ({ type: item.type, value: item.value, checked: item.checked })),
      html: node.outerHTML.slice(0, 18000)
    }))).catch(() => []);
    report.attributeRows = await page.locator('label').evaluateAll((nodes) => nodes
      .filter((node) => /电池容量|手机中央处理器|蜂窝|操作系统|屏幕/.test(node.textContent))
      .map((node) => ({ label: node.textContent, html: node.parentElement?.parentElement?.outerHTML.slice(0, 14000) }))).catch(() => []);
    report.attributeCandidates = await page.evaluate(() => {
      const wanted = /电池容量|手机中央处理器|蜂窝|操作系统|屏幕/;
      const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
      return [...document.querySelectorAll('input:not([type="hidden"]),select,textarea,[contenteditable="true"]')]
        .filter(visible)
        .map((node) => {
          let parent = node;
          for (let level = 0; parent && level < 6; level += 1, parent = parent.parentElement) {
            const text = String(parent.innerText || parent.textContent || '').replace(/\\s+/g, ' ').trim();
            if (wanted.test(text)) return { tag: node.tagName, type: node.type || '', name: node.name || '', value: node.value || '', placeholder: node.placeholder || '', text: text.slice(0, 500), html: parent.outerHTML.slice(0, 16000) };
          }
          return null;
        }).filter(Boolean).slice(0, 40);
    }).catch(() => []);
    report.requiredInputs = await page.evaluate(() => {
      const wanted = /发货期|预计时间|重量|毛重|体积|物流属性|物流提供方式|HS\s*编码|清关|delivery|lead\s*time|weight|volume|logistic|shipping|customs|pkg|input-quantity|input-day/i;
      const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
      return [...document.querySelectorAll('input:not([type="hidden"]),select,textarea,button,[role="button"],[role="combobox"]')]
        .filter((node) => visible(node) && (wanted.test(`${node.name || ''} ${node.id || ''} ${node.getAttribute('role') || ''} ${node.placeholder || ''} ${node.parentElement?.textContent || ''}`) || /^pkg/i.test(String(node.name || node.id || ''))))
        .map((node) => {
          let parent = node;
          for (let level = 0; parent && level < 7; level += 1, parent = parent.parentElement) {
            const text = String(parent.innerText || parent.textContent || '').replace(/\s+/g, ' ').trim();
            if (!wanted.test(`${node.name || ''} ${node.id || ''} ${node.getAttribute('role') || ''} ${node.placeholder || ''} ${text}`)) continue;
            return {
              tag: node.tagName,
              type: node.type || '',
              name: node.name || '',
              id: node.id || '',
              role: node.getAttribute('role') || '',
              value: node.value || '',
              placeholder: node.placeholder || '',
              text: text.slice(0, 600),
              html: parent.outerHTML.slice(0, 12000)
            };
          }
          return null;
        }).filter(Boolean);
    }).catch(() => []);
    await page.screenshot({ path: path.join(outputDir, `${action}-${query}.png`), fullPage: true }).catch(() => {});
  }
  fs.writeFileSync(path.join(outputDir, `${action}-${query.replace(/[^A-Za-z0-9_-]/g, '_').slice(-80)}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputDir, url: report.url, error: Boolean(report.error), validation: report.validation, result: report.result }));
  await publisher.shutdown();
  await collector?.resetContext();
  clearTimeout(deadline);
}
