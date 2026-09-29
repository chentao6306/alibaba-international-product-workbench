import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchPersistent, waitForHumanVerification } from '../server/browser-runtime.js';
import { alibabaKeywordText, dismissPostingOverlays, fillAndVerify, fillCategoryAttributes, fillProductKeywords, fillOriginCountry, preparePublishProduct, requireCategoryAttributes, recoverPostingClick, switchToLegacyDetails, SellerPublisher } from '../server/publisher.js';
import { ensureSimplifiedChinese } from '../server/posting-language.js';
import { readPrivateSession } from '../server/private-session-storage.js';
import { configurePostingInteractions } from '../server/posting-interaction.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { requirePostingPageAvailable, waitForPostingTitle } from '../server/posting-readiness.js';

const [workspace, productId, outputDirectory] = process.argv.slice(2);
if (!workspace || !productId || !outputDirectory || !process.env.KUA_YIPU_ALIBABA_COOKIES_FILE) throw new Error('Workspace, product ID, output directory and local seller cookies path required');
const product = JSON.parse(fs.readFileSync(workspace, 'utf8')).products.find((item) => item.id === productId);
if (!product?.categoryId || !/^\d+$/.test(product.categoryId)) throw new Error('Product or category unavailable');
const output = path.resolve(outputDirectory);
fs.mkdirSync(output, { recursive: true });
let desktopApp;
async function main() {
  if (process.versions.electron) {
    const { app, safeStorage } = await import('electron');
    desktopApp = app;
    const localState = path.join(path.dirname(process.env.KUA_YIPU_ALIBABA_COOKIES_FILE), 'Local State');
    const desktopData = path.join(output, 'desktop');
    fs.mkdirSync(desktopData, { recursive: true });
    fs.copyFileSync(localState, path.join(desktopData, 'Local State'));
    app.setPath('userData', desktopData);
    app.on('window-all-closed', () => {});
    await app.whenReady();
    globalThis.__KUA_YIPU_SECURE_STORAGE = { decrypt: (value) => safeStorage.decryptString(value) };
  }
  // Do not report a seller login failure when this diagnostic runner cannot
  // decrypt the desktop session at all. Never export plaintext session values.
  if (!readPrivateSession(process.env.KUA_YIPU_ALIBABA_COOKIES_FILE)?.length) throw new Error('Local seller session is empty');
  const context = await launchPersistent(path.join(output, 'isolated-profile'), { headless: true, backgroundPublishing: true });
  const page = context.pages()[0] || await context.newPage();
  try {
    page.setDefaultTimeout(5000);
    if (process.argv.includes('--collect-source')) {
      const collected = await new SellerPublisher(output).readSourceProduct(page, product);
      fs.writeFileSync(path.join(output, 'collected.json'), JSON.stringify(collected, null, 2));
      const result = { result: 'source-collected', sourceId: collected.sourceId, attributes: collected.attributes,
        groups: collected.variantGroups?.map(({ name, options }) => ({ name, options })), skus: collected.skus?.length };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ result: result.result, attributes: result.attributes?.length, skus: result.skus }));
      return;
    }
    configurePostingInteractions(page, { recover: (target) => recoverPostingClick(page, target), onProgress: (stage) => console.log(stage) });
    await page.goto(`https://post.alibaba.com/product/publish.htm?from=common&catId=${product.categoryId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForHumanVerification(page);
    await requirePostingPageAvailable(page);
    await waitForPostingTitle(page, { verify: () => waitForHumanVerification(page) });
    await ensureSimplifiedChinese(page, { beforeSwitch: () => dismissPostingOverlays(page), onProgress: console.log });
    const before = await page.evaluate(readPostingAttributeSchema);
    console.log(JSON.stringify({ categoryId: product.categoryId, fieldsBefore: before.length }));
    if (process.argv.includes('--keywords-origin')) {
      await switchToLegacyDetails(page);
      const title = await waitForPostingTitle(page, { verify: () => waitForHumanVerification(page) });
      await fillAndVerify(title, preparePublishProduct(product).title, '商品标题');
      assert.equal(await fillProductKeywords(page, preparePublishProduct(product)), true);
      await page.waitForTimeout(1500);
      const menus = await page.locator('.next-menu:visible, .next-overlay-inner:visible, [role="listbox"]:visible').evaluateAll((nodes) => nodes.map((node) => ({
        tag: node.tagName, className: node.className, role: node.getAttribute('role'),
        parentClass: node.parentElement?.className, html: node.outerHTML.slice(0, 14000),
      })));
      fs.writeFileSync(path.join(output, 'keyword-menus.json'), JSON.stringify(menus, null, 2));
      await page.screenshot({ path: path.join(output, 'keyword-menu.png') });
      const accepted = await fillOriginCountry(page, preparePublishProduct(product).origin);
      const keywordValue = await page.locator('.posting-field-keywords textarea:visible, #struct-keywords textarea:visible').first().inputValue();
      const recommendations = await page.locator('.posting-field-keywords-overlay:visible').count();
      const guides = await page.locator('.next-balloon[role="tooltip"]:has(.next-balloon-close):visible').count();
      assert.equal(accepted, true);
      assert.equal(keywordValue, alibabaKeywordText(preparePublishProduct(product)));
      assert.equal(recommendations, 0);
      assert.equal(guides, 0);
      const result = { categoryId: product.categoryId, result: 'keywords-origin', accepted, keywordsPreserved: true, recommendations, guides };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      await page.screenshot({ path: path.join(output, 'origin-result.png') });
    } else {
      await fillCategoryAttributes(page, preparePublishProduct(product), (stage) => console.log(stage));
      await requireCategoryAttributes(page, preparePublishProduct(product));
      const after = await page.evaluate(readPostingAttributeSchema);
      console.log(JSON.stringify({ result: 'attributes-readback-passed', fieldsAfter: after.length, filledFields: after.filter((field) => field.hasValue).map((field) => field.label) }));
      await page.screenshot({ path: path.join(output, 'attributes.png') });
    }
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    const fields = await page.locator('textarea, input[name="keywords" i]').evaluateAll((nodes) => nodes.map((node) => ({
      tag: node.tagName, id: node.id, name: node.name, value: node.value, placeholder: node.placeholder,
      readOnly: node.readOnly, disabled: node.disabled, maxLength: node.maxLength, html: node.outerHTML.slice(0, 3000),
    }))).catch(() => []);
    fs.writeFileSync(path.join(output, 'failure-fields.json'), JSON.stringify(fields, null, 2));
    const result = { result: 'not-verified', code: error.code || '', message: String(error.message).split('\n')[0], diagnostics: error.diagnostics || null };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  } finally { await context.close(); desktopApp?.exit(process.exitCode || 0); }
}

main().catch((error) => {
  console.error(String(error.message).split('\n')[0]);
  process.exitCode = 1;
  desktopApp?.exit(1);
});
