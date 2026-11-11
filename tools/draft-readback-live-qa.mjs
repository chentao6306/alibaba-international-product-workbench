// Read a confirmed draft after a fresh navigation. Never save, submit, switch
// description mode or infer a draft ID from a source/published product ID.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import sharp from 'sharp';
import { SellerPublisher, preparePublishProduct, mainImageFormState, distinctAlibabaImageUrls,
  requireCategoryAttributes, requirePublicAttributeTransfer, buildLegacyDescriptionHtml } from '../server/publisher.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { readCustomAttributes } from '../server/custom-attributes.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { usesSkuPricing, resolveReferencedSkuRows, requireSkuMinimumOrder, SKU_PRICE_INPUT } from '../server/sku-reference.js';
import { revealDescriptionSection, waitForDescriptionEditor } from '../server/posting-readiness.js';
import { currentDescriptionStructure } from '../server/description-structure.js';
import { descriptionFingerprint } from '../server/structured-description.js';
import { compatibleLegacyDescriptionHtml, compatibleDescriptionFingerprint } from '../server/description-compatibility.js';
import { compileNativeDescription, nativeDescriptionSchemas, readNativeDescriptionFields,
  requireNativeDescriptionFields, requireNativeDescriptionAccepted } from '../server/native-description-fields.js';
import { prepareStructuredDescriptionImages } from '../server/structured-description-images.js';
import { bindReadbackSkuGroups } from './qa/sku-readback-identity.mjs';

const root = process.env.QA_OUTPUT_DIR, prior = process.env.QA_DRAFT_DIR;
assert.ok(root && prior && process.env.QA_SOURCE_IDS && process.env.QA_DESKTOP_USER_DATA_DIR && process.env.QA_EXPECTED_ACCOUNT);
assert.equal(fs.existsSync(root), false, 'Use a new evidence directory; do not overwrite previous checks');
const relative = path.relative(path.resolve('.'), path.resolve(root));
assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Private QA output must remain outside the source repository');
fs.mkdirSync(root, { recursive: true });
const reportFile = path.join(root, 'draft-readback.json');
const report = { readOnly: true, kind: 'draft-reopen', startedAt: new Date().toISOString(), samples: [], blockedWrites: [] };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const proof = JSON.parse(fs.readFileSync(path.join(prior, 'performance.json'), 'utf8'));
const workspace = JSON.parse(fs.readFileSync(path.join(prior, 'workspace/workspace.json'), 'utf8'));
const ids = process.env.QA_SOURCE_IDS.split(',');
assert.ok(ids.length && ids.length <= 10 && new Set(ids).size === ids.length);
const sessionFile = path.join(root, 'cookies.json');
let publisher;

function renderedDescriptionFingerprint(html) {
  const $ = load(html, null, false);
  // Alibaba trims text-node whitespace and removes redundant spans when it
  // persists legacy HTML. Block boundaries still separate rendered words.
  // Preserve inline spaces, table cells, links and image order in the check.
  $('div,p,h1,h2,h3,h4,h5,h6,li,ul,ol,table,thead,tbody,tfoot,tr,td,th,section,article,blockquote')
    .each((_, node) => { $(node).prepend(' '); $(node).append(' '); });
  $('br').replaceWith('<br> ');
  return descriptionFingerprint($.root().html());
}

function savedDraftIdentity(evidence) {
  const candidates = new Set();
  // This URL form was observed and exercised in native-draft-readback.mjs.
  // Only an actual platform redirect carrying pubAction=draft proves identity.
  for (const value of [evidence.savedDraftUrl, evidence.result?.url]) {
    let url;
    try { url = new URL(value); } catch { continue; }
    if (url.protocol === 'https:' && url.hostname === 'post.alibaba.com' && url.pathname === '/product/publish.htm'
      && url.searchParams.get('pubAction') === 'draft' && /^\d{10,16}$/.test(url.searchParams.get('itemId') || '')) {
      candidates.add(url.searchParams.get('itemId'));
    }
  }
  for (const receipt of evidence.apiReceipts || []) {
    if (receipt.path !== '/product/submitDraft.json' || receipt.status !== 200 || receipt.success === false) continue;
    for (const item of receipt.ids || []) {
      // Bare id can belong to a recommendation, property or media record.
      if (/^(?:draftId|itemId|productId|primaryId|data)$/.test(item.key) && /^\d{10,16}$/.test(item.value)) candidates.add(item.value);
    }
  }
  assert.equal(candidates.size, 1, `${evidence.sourceId}: no unique recorded draft identity; inspect the existing draft list, never save again to recover an ID`);
  const [id] = candidates;
  if (evidence.draftId) assert.equal(evidence.draftId, id);
  return id;
}

async function checkSkuRows(page, product) {
  if (!product.skus?.length || !product.variantGroups?.some(group => group.options?.length)) return { applicable: false };
  const root = page.locator('#sku:visible');
  await root.scrollIntoViewIfNeeded();
  await root.locator('[data-name="skuOuterId"][data-row]').first().waitFor({ timeout: 30000 });
  const headers = await root.locator('.sku-header th').evaluateAll(nodes => nodes.map(node => ({
    name: node.querySelector('.th-saleProps-label > span')?.textContent?.trim(),
    options: [...node.querySelectorAll('.checkSelectBabel .labelText')].map(option => option.textContent.trim()),
  })).filter(group => group.name && group.options.length));
  const { groups, appliedGroups } = bindReadbackSkuGroups(product, headers, await page.evaluate(readPostingAttributeSchema));
  const expected = resolveReferencedSkuRows(product, groups, { appliedGroups });
  const rows = new Map(), scroll = root.locator('.virtualized-table-scroll-wrapper');
  await scroll.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  let stagnant = 0;
  while (rows.size < expected.length) {
    const before = rows.size;
    const indices = await root.locator('[data-name="skuOuterId"][data-row]').evaluateAll(nodes => [...new Set(nodes.map(node => Number(node.dataset.row)))]);
    for (const index of indices) {
      if (rows.has(index)) continue;
      assert.ok(expected[index], `Unexpected draft SKU row ${index}`);
      const { sku, attributes } = expected[index];
      const row = root.locator(`[data-name="skuOuterId"][data-row="${index}"]`).locator('xpath=..');
      const toggle = row.locator('[data-name="operate"] [role="switch"]');
      const enabled = await toggle.count() ? await toggle.getAttribute('aria-checked') === 'true' : true;
      assert.equal(enabled, Boolean(sku && sku.enabled !== false), `Draft SKU enabled state changed: ${index}`);
      const actual = { index, attributes, enabled };
      if (sku) {
        actual.code = await row.locator('[data-name="skuOuterId"] input').inputValue();
        actual.stock = await row.locator('[data-name="skuStock"] input').first().inputValue();
        assert.equal(actual.code, String(sku.code || sku.skuCode || ''), `Draft SKU code changed: ${index}`);
        if (sku.stock == null || sku.stock === '') assert.equal(actual.stock, '');
        else assert.equal(Number(actual.stock.replaceAll(',', '')), Number(sku.stock), `Draft SKU stock changed: ${index}`);
        if (usesSkuPricing(product) && (enabled || Number(sku.price) > 0)) {
          actual.price = Number(await row.locator(SKU_PRICE_INPUT).filter({ visible: true }).first().inputValue());
          assert.equal(actual.price, Number(Number(sku.price).toFixed(2)), `Draft SKU price changed: ${index}`);
        }
      }
      rows.set(index, actual);
    }
    if (rows.size === expected.length) break;
    stagnant = before === rows.size ? stagnant + 1 : 0;
    assert.ok(stagnant < 4, `Only ${rows.size}/${expected.length} draft SKU rows could be read`);
    await scroll.evaluate(node => { node.scrollTop += Math.max(48, node.clientHeight - 48); node.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(180);
  }
  return { applicable: true, groups, appliedGroups, rows: [...rows.values()].sort((a, b) => a.index - b.index) };
}

async function imageBytes(page, value) {
  const url = new URL(value, 'https://www.alibaba.com/');
  assert.equal(url.protocol, 'https:');
  assert.match(url.hostname, /(?:^|\.)alicdn\.com$/, 'Only observed Alibaba image CDN assets are read');
  const response = await page.request.get(url.href, { timeout: 30000, maxRedirects: 0 });
  try {
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'] || '', /^image\//);
    const bytes = await response.body();
    assert.ok(bytes.length && bytes.length <= 20 * 1024 * 1024);
    return bytes;
  } finally { await response.dispose(); }
}

async function compareImage(page, sourceUrl, savedUrl, name, native) {
  let expected = await imageBytes(page, sourceUrl);
  if (native) {
    const sourceFile = path.join(root, `${name}-source`);
    fs.writeFileSync(sourceFile, expected);
    const prepared = await prepareStructuredDescriptionImages([sourceFile]);
    expected = fs.readFileSync(prepared.files[0]);
  }
  const actual = await imageBytes(page, savedUrl);
  const options = { limitInputPixels: 40000000 };
  const [before, after] = await Promise.all([sharp(expected, options).metadata(), sharp(actual, options).metadata()]);
  if (native) assert.ok(after.width >= 600 && after.height >= 600 && actual.length <= 5 * 1024 * 1024);
  assert.ok(Math.abs(before.width / before.height - after.width / after.height) < 0.02, `${name}: aspect ratio changed`);
  const pixels = bytes => sharp(bytes, options).rotate().flatten({ background: '#fff' }).resize(256, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([pixels(expected), pixels(actual)]);
  assert.equal(a.length, b.length);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference += Math.abs(a[index] - b[index]);
  const meanAbsoluteDifference = difference / a.length;
  if (meanAbsoluteDifference >= 8) {
    fs.writeFileSync(path.join(root, `${name}-source-image`), expected);
    fs.writeFileSync(path.join(root, `${name}-saved-image`), actual);
    fs.writeFileSync(path.join(root, `${name}-image-difference.json`), JSON.stringify({
      sourceUrl, savedUrl, before, after, meanAbsoluteDifference,
    }, null, 2));
  }
  assert.ok(meanAbsoluteDifference < 8, `${name}: saved image differs from source`);
  return { name, width: after.width, height: after.height, bytes: actual.length, meanAbsoluteDifference };
}

async function checkDescription(page, product, compatibility) {
  await revealDescriptionSection(page);
  const structure = currentDescriptionStructure(product);
  const converted = compatibility?.sourceFormat === 'structured' && compatibility.targetFormat === 'legacy';
  const result = { native: Boolean(structure) && !converted, compatibility, imageChecks: [] };
  if (structure && !converted) {
    await page.locator('#detailImage:visible').waitFor({ timeout: 30000 });
    result.mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
    assert.equal(result.mode, 4, 'Native source details must remain native in the draft');
    const plan = compileNativeDescription(structure, await nativeDescriptionSchemas(page));
    const fields = await readNativeDescriptionFields(page);
    assert.ok(fields);
    for (const rootId of ['detailImage', 'companyImage']) {
      const expected = plan.galleries.filter(group => group.rootId === rootId);
      const actual = fields[rootId] || [];
      assert.equal(actual.length, expected.length, `${rootId}: gallery count changed`);
      for (const [groupIndex, group] of expected.entries()) {
        const saved = actual[groupIndex];
        assert.equal(saved.enName, group.name, `${rootId}: gallery name/order changed`);
        if (group.custom) group.value = saved.value;
        assert.equal(String(saved.value), String(group.value));
        assert.equal(saved.imageList.length, group.images.length);
        group.urls = saved.imageList.map(image => image.imgURL);
        for (const [index, image] of group.images.entries()) result.imageChecks.push(await compareImage(page, image.url,
          saved.imageList[index].fileURL || group.urls[index], `${product.sourceId}-${rootId}-${groupIndex}-${index}`, true));
      }
    }
    requireNativeDescriptionFields(plan, fields);
    await requireNativeDescriptionAccepted(page);
    result.fields = fields;
  } else {
    // Scroll for lazy mounting only; never switch the saved description mode.
    const { body } = await waitForDescriptionEditor(page, { switchMode: () => revealDescriptionSection(page) });
    const html = await body.innerHTML();
    const expectedUrls = distinctAlibabaImageUrls(product.detailImages || []);
    // The publisher already replaces source images with indexed slots.
    // Running that transform twice appends a second set of unused images.
    const expectedHtml = converted ? compatibleLegacyDescriptionHtml(product, buildLegacyDescriptionHtml(product)) : buildLegacyDescriptionHtml(product);
    const expected = load(expectedHtml, null, false), saved = load(html, null, false);
    const actualImages = saved('img[src]').toArray().map(node => saved(node).attr('src'));
    const slots = expected('[data-workbench-source-image]').toArray();
    assert.equal(actualImages.length, slots.length, 'Draft detail image count changed');
    for (const [index, node] of slots.entries()) {
      const sourceIndex = Number(expected(node).attr('data-workbench-source-image'));
      expected(node).replaceWith(expected('<img>').attr('src', actualImages[index]));
      result.imageChecks.push(await compareImage(page, expectedUrls[sourceIndex], actualImages[index], `${product.sourceId}-legacy-${index}`, false));
    }
    fs.writeFileSync(path.join(root, `${product.sourceId}-expected-description.html`), expected.root().html());
    fs.writeFileSync(path.join(root, `${product.sourceId}-saved-description.html`), html);
    const fingerprint = converted ? compatibleDescriptionFingerprint : renderedDescriptionFingerprint;
    assert.deepEqual(fingerprint(html), fingerprint(expected.root().html()), 'Draft text, tables, links and image order must survive a fresh load');
    result.imageCount = actualImages.length;
    result.textAndTablesVerified = true;
  }
  return result;
}

try {
  save();
  const samples = ids.map(sourceId => {
    const evidence = proof.samples.findLast(row => row.sourceId === sourceId);
    assert.ok(evidence && evidence.result?.status === 'drafted' && evidence.attributesAccepted && !evidence.error, `${sourceId}: successful validated draft required`);
    const source = workspace.products.find(row => row.sourceId === sourceId);
    assert.ok(source);
    return { evidence, product: preparePublishProduct(source, { uploadProductVideos: evidence.result.videoUploadEnabled !== false && proof.videos !== false }), draftId: savedDraftIdentity(evidence) };
  });
  writePrivateSession(sessionFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
  process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = sessionFile;
  publisher = new SellerPublisher(path.join(root, 'browser'));
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()), 'Expected seller session is required');
  await page.context().route('https://post.alibaba.com/**', async route => {
    const url = new URL(route.request().url());
    if (/^\/product\/(?:submit|submitDraft|save)[^/]*\.(?:json|htm)$/i.test(url.pathname)) {
      report.blockedWrites.push({ path: url.pathname, method: route.request().method() }); save();
      await route.abort();
    } else await route.continue();
  });
  for (const { evidence, product, draftId } of samples) {
    const row = { sourceId: product.sourceId, draftId, startedAt: new Date().toISOString() };
    report.samples.push(row); save();
    try {
      await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${draftId}&pubAction=draft&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('input#productTitle:visible').waitFor({ timeout: 60000 });
      row.url = page.url();
      assert.equal(new URL(row.url).searchParams.get('itemId'), draftId);
      assert.equal(new URL(row.url).searchParams.get('pubAction'), 'draft');
      row.title = await page.locator('input#productTitle:visible').inputValue();
      assert.equal(row.title, product.title);
      row.images = await mainImageFormState(page);
      assert.equal(row.images.occupied, Math.min(6, distinctAlibabaImageUrls(product.mainImages).length));
      assert.equal(row.images.uploading, 0);
      await requireCategoryAttributes(page, product);
      row.fields = await page.evaluate(readPostingAttributeSchema);
      row.attributeTransfer = await requirePublicAttributeTransfer(page, product);
      row.customAttributes = await readCustomAttributes(page);
      row.emptyRequired = row.fields.filter(field => field.required && !field.disabled && !field.hasValue).map(field => field.label);
      assert.deepEqual(row.emptyRequired, []);
      if (usesSkuPricing(product)) row.minimumOrder = await requireSkuMinimumOrder(page, product);
      else {
        await page.locator('input[role="input-price"]:visible').first().waitFor({ timeout: 30000 });
        row.prices = await page.locator('input[role="input-price"]:visible').evaluateAll(nodes => nodes.map(node => Number(node.value)));
        row.quantities = await page.locator('input[role="input-quantity"]:visible').evaluateAll(nodes => nodes.map(node => Number(node.value)));
        const tiers = (product.priceMode === 'fob-tier' ? product.fobPrice?.tiers : product.priceTiers) || [];
        const expected = tiers.filter(tier => Number(tier.price) > 0 && Number(tier.minQuantity) > 0).sort((a, b) => Number(a.minQuantity) - Number(b.minQuantity));
        if (!expected.length) expected.push({ price: product.priceMode === 'fob-range' ? product.fobPrice?.minPrice : product.price, minQuantity: product.minOrder || product.moq || 1 });
        assert.deepEqual(row.prices, expected.map(tier => Number(tier.price)));
        assert.deepEqual(row.quantities, expected.map(tier => Number(tier.minQuantity)));
      }
      row.skus = await checkSkuRows(page, product);
      row.description = await checkDescription(page, product, evidence.result.descriptionCompatibility);
      assert.deepEqual(report.blockedWrites, [], 'Readback unexpectedly attempted a save or submission');
      row.videoUploadEnabled = evidence.result.videoUploadEnabled;
      row.unverified = ['video playback and association', 'public listing visibility', 'main image pixels', 'logistics and optional services'];
      row.ok = true;
      await page.screenshot({ path: path.join(root, `${product.sourceId}-draft-readback.png`) });
    } catch (error) {
      row.error = { message: error.message, code: error.code, diagnostics: error.diagnostics };
      row.currentUrl = page.url();
      await page.screenshot({ path: path.join(root, `${product.sourceId}-failure.png`) }).catch(() => {});
    } finally { row.finishedAt = new Date().toISOString(); save(); }
  }
  report.ok = report.samples.length === ids.length && report.samples.every(row => row.ok);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.ok = false; report.error = error.message; process.exitCode = 1;
} finally {
  await publisher?.shutdown();
  fs.rmSync(sessionFile, { force: true });
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ reportFile, ok: report.ok, error: report.error,
    samples: report.samples.map(row => ({ sourceId: row.sourceId, draftId: row.draftId, ok: row.ok, error: row.error })) }));
}
