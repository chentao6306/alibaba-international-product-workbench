// Exercise the real medical leaf's controls without saving or publishing a
// medical listing on an account whose authorized publication scope is CE.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, preparePublishProduct, enterPostingForm, fillCategoryAttributes,
  requireCategoryAttributes, requirePublicAttributeTransfer, mainImageFormState, recoverPostingClick } from '../server/publisher.js';
import { buildAlibabaPublishUrl, categoryIdFromUrl } from '../server/category-routing.js';
import { readPostingAttributeSchema, bindSourceAttributesToPostingSchema } from '../server/category-attributes.js';
import { configurePostingInteractions } from '../server/posting-interaction.js';
import { requirePostingPageAvailable } from '../server/posting-readiness.js';
import { ensureSimplifiedChinese } from '../server/posting-language.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { readNativeDescriptionFields, requireNativeDescriptionAccepted } from '../server/native-description-fields.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_SOURCE_CAPTURE && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_DESKTOP_USER_DATA_DIR);
assert.equal(fs.existsSync(root), false);
const relative = path.relative(path.resolve('.'), path.resolve(root));
assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
fs.mkdirSync(root, { recursive: true });
const source = JSON.parse(fs.readFileSync(process.env.QA_SOURCE_CAPTURE, 'utf8')).product;
assert.equal(source.categoryId, '201330916');
let product = preparePublishProduct({ ...source, title: source.sourceOriginalTitle, sourcePlatform: 'alibaba.com' }, { uploadProductVideos: false });
const report = { sourceId: source.sourceId, categoryId: product.categoryId, saved: false, submitted: false,
  startedAt: new Date().toISOString(), stages: [], checks: {}, blockedWrites: [] };
const save = () => fs.writeFileSync(path.join(root, 'medical-form.json'), JSON.stringify(report, null, 2));
const progress = stage => { report.stages.push({ at: new Date().toISOString(), stage }); save(); };
const cookieFile = path.join(root, 'cookies.json');
writePrivateSession(cookieFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
const publisher = new SellerPublisher(path.join(root, 'browser'));
let page;
try {
  page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.context().route('https://post.alibaba.com/**', async route => {
    const url = new URL(route.request().url());
    if (/^\/product\/(?:submit|submitDraft|save)[^/]*\.(?:json|htm)$/i.test(url.pathname)) {
      report.blockedWrites.push({ path: url.pathname, method: route.request().method() }); save(); await route.abort();
    } else await route.continue();
  });
  page.setDefaultTimeout(5000);
  configurePostingInteractions(page, { recover: target => recoverPostingClick(page, target), onProgress: progress });
  const url = `${buildAlibabaPublishUrl(product.categoryId)}&language=zh_CN`;
  progress('打开医疗器械原始叶类目，禁止保存和提交');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await enterPostingForm(page, url, product.categoryId);
  await page.locator('input#productTitle:visible').waitFor({ timeout: 60000 });
  assert.equal(categoryIdFromUrl(page.url()), product.categoryId);
  try { await requirePostingPageAvailable(page); }
  catch (error) {
    if (error.code !== 'PUBLISH_CATEGORY_NOT_AUTHORIZED') throw error;
    report.categoryRestriction = error.message;
  }
  try { await ensureSimplifiedChinese(page, { onProgress: progress, reloadOnMismatch: true }); }
  catch (error) {
    if (error.code !== 'PUBLISH_CATEGORY_NOT_AUTHORIZED') throw error;
    // This explicit unsaved-control probe can inspect the accessible form;
    // the normal publisher stops at this restriction and is not bypassed.
    report.languageCheckBlockedByCategory = true;
  }
  product = bindSourceAttributesToPostingSchema(product, await page.evaluate(readPostingAttributeSchema));
  const check = async (name, action) => {
    progress(name);
    try { report.checks[name] = { ok: true, result: await action() }; }
    catch (error) {
      report.checks[name] = { ok: false, error: { message: error.message, code: error.code, diagnostics: error.diagnostics } };
      await page.screenshot({ path: path.join(root, `${name}-failure.png`) }).catch(() => {});
      if (name === 'structured-description') report.descriptionControls = await page.evaluate(() => ({
        mode: window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value,
        controls: [...document.querySelectorAll('button,[role="button"],[role="tab"]')]
          .filter(node => node.getClientRects().length && /新版|旧版|老版|structured|version|editor/i.test(node.textContent))
          .map(node => ({ text: node.textContent.trim(), role: node.getAttribute('role'), tag: node.tagName })),
      }));
    }
    save();
  };
  await check('structured-description', async () => {
    await publisher.fillLegacyDescription(page, product, progress);
    await requireNativeDescriptionAccepted(page);
    return readNativeDescriptionFields(page);
  });
  await check('category-and-specifications', async () => {
    await fillCategoryAttributes(page, product, progress);
    const mapping = await publisher.fillProductFields(page, product, progress);
    await fillCategoryAttributes(page, product, progress);
    await requireCategoryAttributes(page, product);
    const transfer = await requirePublicAttributeTransfer(page, product);
    return { mapping, transfer, fields: await page.evaluate(readPostingAttributeSchema) };
  });
  await check('main-images', async () => {
    await publisher.uploadMainImages(page, product, progress);
    await publisher.reconcileMainImages(page, product, progress);
    return mainImageFormState(page);
  });
  assert.deepEqual(report.blockedWrites, []);
  report.ok = Object.values(report.checks).every(check => check.ok);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.error = { message: error.message, code: error.code, diagnostics: error.diagnostics };
  report.ok = false; process.exitCode = 1;
} finally {
  if (page && !page.isClosed()) {
    report.fields = await page.evaluate(readPostingAttributeSchema).catch(() => []);
    await page.screenshot({ path: path.join(root, 'medical-form.png') }).catch(() => {});
  }
  await publisher.shutdown(); fs.rmSync(cookieFile, { force: true });
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ root, ok: report.ok, restriction: report.categoryRestriction,
    checks: Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, { ok: check.ok, error: check.error }])) , error: report.error }));
}
