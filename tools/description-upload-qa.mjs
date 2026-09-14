import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { buildAlibabaPublishUrl, productCategory } from '../server/category-routing.js';

// Isolated editor/draft check: never directly publishes a product.
const output = process.env.QA_OUTPUT_DIR;
if (!output || !process.env.QA_PRODUCT_FILE) throw new Error('Set QA_OUTPUT_DIR and QA_PRODUCT_FILE');
fs.mkdirSync(output, { recursive: true });
const imported = JSON.parse(fs.readFileSync(process.env.QA_PRODUCT_FILE, 'utf8'));
const product = imported.product || imported;
const publisher = new SellerPublisher(output);
const report = { stages: [], requests: [], errors: [], snapshots: [] };
let page;
async function snapshot(stage) {
  if (!page || page.isClosed()) return;
  const editors = await page.evaluate(() => [...new Set([...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])])].map((editor) => {
    const plugin = editor.plugins?.alipicpastedrag;
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(plugin || {})).filter((key) => key !== 'constructor' && typeof plugin[key] === 'function');
    return { id: editor.id, hidden: editor.hidden, html: editor.getContent(), selection: Object.fromEntries(['select', 'collapse', 'getBookmark', 'moveToBookmark', 'setCursorLocation'].map((key) => [key, String(editor.selection[key])])), plugin: Object.fromEntries(methods.map((key) => [key, String(plugin[key])])) };
  })).catch(() => []);
  const frames = [];
  for (const frame of page.frames()) {
    frames.push({ url: frame.url().split('?')[0], html: await frame.locator('body.mce-content-body').evaluateAll((nodes) => nodes.map((node) => node.innerHTML)).catch(() => []) });
  }
  report.snapshots.push({ stage, editors, frames });
}
try {
  page = await publisher.currentSellerPage();
  if (process.env.QA_FAIL_ONE_DETAIL_UPLOAD === '1') {
    let failed = false;
    await page.route('https://filebroker.alibaba.com/x/upload**', async (route) => {
      if (!failed) { failed = true; report.injectedUploadFailure = true; await route.abort('connectionreset'); }
      else await route.continue();
    });
  }
  if (process.env.QA_FAIL_ONE_PHOTOBANK_SAVE === '1') {
    let failed = false;
    await page.route('https://photobank.alibaba.com/jsonp/photos/uploadImage**', async (route) => {
      if (!failed) { failed = true; report.injectedPhotobankFailure = true; await route.abort('connectionreset'); }
      else await route.continue();
    });
  }
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (/upload|filebroker|photobank/i.test(url.hostname + url.pathname)) report.requests.push({ host: url.hostname, path: url.pathname, status: response.status() });
  });
  await page.goto(buildAlibabaPublishUrl(productCategory(product).id), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('input#productTitle').waitFor({ timeout: 30000 });
  const originalUpload = publisher.uploadLegacyDetailImages.bind(publisher);
  publisher.uploadLegacyDetailImages = async (...args) => {
    await snapshot('before-upload');
    return originalUpload(...args);
  };
  const progress = (stage) => {
    report.stages.push({ stage, at: new Date().toISOString() });
    console.log(stage);
  };
  if (process.env.QA_SAVE_DRAFT === '1') {
    const category = productCategory(product);
    report.result = await publisher.publishProduct(product, buildAlibabaPublishUrl(category.id), 'draft', category.pathText, 'qa-detail', progress);
  } else await publisher.fillLegacyDescription(page, product, progress);
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await snapshot('after-upload');
  if (page) await page.screenshot({ path: path.join(output, 'description.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'description.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ok: report.ok, error: report.error?.split('\n')[0], errors: report.errors }));
  await publisher.shutdown();
}
