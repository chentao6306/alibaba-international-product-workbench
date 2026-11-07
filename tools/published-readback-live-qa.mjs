// Reopens a confirmed test publication without editing or saving it.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, mainImageFormState, attributeFieldMatchesValue, distinctAlibabaImageUrls, requireCategoryAttributes } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { revealDescriptionSection, waitForDescriptionEditor } from '../server/posting-readiness.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { usesSkuPricing, resolveReferencedSkuRows, SKU_PRICE_INPUT } from '../server/sku-reference.js';
import { customizationGroups } from '../server/product-services.js';
import { regionalPriceRows, customizationFormModel } from '../server/posting-extras.js';
import { requiredAttributeKey } from '../server/publish-reference.js';
import { currentDescriptionStructure } from '../server/description-structure.js';
import { compileNativeDescription, nativeDescriptionSchemas, readNativeDescriptionFields, requireNativeDescriptionFields, requireNativeDescriptionAccepted } from '../server/native-description-fields.js';
import { prepareStructuredDescriptionImages } from '../server/structured-description-images.js';
import sharp from 'sharp';

const directory = process.env.QA_LEDGER_DIR;
assert.ok(directory && process.env.QA_EXPECTED_ACCOUNT);
const loaded = JSON.parse(fs.readFileSync(process.env.QA_REPORT_FILE || path.join(directory, 'ledger.json')));
const ledger = loaded.publications || loaded;
const receipt = ledger.findLast((row) => row.mode === 'submit' && row.result?.status === 'published'
  && (!process.env.QA_SOURCE_ID || row.sourceId === process.env.QA_SOURCE_ID));
assert.ok(receipt, 'A confirmed publication receipt is required');
const id = new URL(receipt.result.url).searchParams.get('primaryId');
assert.match(id, /^\d+$/);
const state = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE || path.join(directory, 'workspace/workspace.json')));
const product = state.products.find((item) => item.sourceId === receipt.sourceId);
assert.ok(product);
let isolatedSession;
if (process.env.QA_DESKTOP_USER_DATA_DIR) {
  isolatedSession = path.join(directory, `readback-${receipt.sourceId}-cookies.json`);
  writePrivateSession(isolatedSession, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
  process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = isolatedSession;
}
const publisher = new SellerPublisher(path.join(directory, 'readback-browser'));
const result = { publishedId: id, sourceId: product.sourceId, readOnly: true };
const outputName = process.env.QA_SOURCE_ID ? `${product.sourceId}-published-readback` : 'published-readback';
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${id}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('input#productTitle')
    || /您的产品目前正在审核中|product.*currently.*under review/i.test(document.body?.innerText || ''), undefined, { timeout: 60000 });
  if (/您的产品目前正在审核中|product.*currently.*under review/i.test(await page.locator('body').innerText())) {
    throw Object.assign(new Error('平台正在审核该商品，暂未开放编辑页；未重复提交'), { code: 'PUBLISH_REVIEW_PENDING' });
  }
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  result.title = await page.locator('input#productTitle').inputValue();
  assert.equal(result.title, product.title);
  const deadline = Date.now() + 30000;
  do {
    result.images = await mainImageFormState(page);
    if (result.images.occupied >= product.mainImages.length && !result.images.uploading) break;
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  assert.equal(result.images.occupied, product.mainImages.length);
  result.mainImageUrls = await page.locator('.image-uploader .image-upload-list-item').evaluateAll(slots => slots.flatMap(slot => {
    const key = Object.getOwnPropertyNames(slot).find(key => key.startsWith('__reactFiber'));
    for (let fiber = key && slot[key], depth = 0; fiber && depth < 24; fiber = fiber.return, depth++) {
      if (fiber.memoizedProps?.file?.fileURL) return [fiber.memoizedProps.file.fileURL];
    }
    const src = slot.querySelector('img')?.src;
    return src ? [src] : [];
  }));
  if (usesSkuPricing(product)) {
    result.minimumOrder = Number(await page.locator('input#minOrderQuantity:visible').inputValue());
    assert.equal(result.minimumOrder, Number(product.minOrder || product.moq || 1), 'SKU minimum order must survive a fresh page load');
    const skuRoot = page.locator('#sku');
    await skuRoot.scrollIntoViewIfNeeded();
    await skuRoot.locator('[data-name="skuOuterId"][data-row]').first().waitFor({ timeout: 30000 });
    const groups = await skuRoot.locator('.sku-header th').evaluateAll(nodes => nodes.map(node => ({
      name: node.querySelector('.th-saleProps-label > span')?.textContent?.trim(),
      options: [...node.querySelectorAll('.checkSelectBabel .labelText')].map(option => option.textContent.trim()),
    })).filter(group => group.name && group.options.length));
    const expected = resolveReferencedSkuRows(product, groups);
    result.skuPrices = [];
    const seen = new Set();
    const scroll = skuRoot.locator('.virtualized-table-scroll-wrapper');
    await scroll.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    let stagnant = 0;
    while (seen.size < expected.length) {
      const before = seen.size;
      const indices = await skuRoot.locator('[data-name="skuOuterId"][data-row]').evaluateAll(nodes => [...new Set(nodes.map(node => Number(node.dataset.row)))]);
      for (const index of indices) {
        if (seen.has(index)) continue;
        const expectedSku = expected[index];
        assert.ok(expectedSku, 'Unexpected saved SKU row');
        const row = skuRoot.locator(`[data-name="skuOuterId"][data-row="${index}"]`).locator('xpath=..');
        if (expectedSku.sku?.enabled !== false && expectedSku.sku) {
          const price = Number(await row.locator(SKU_PRICE_INPUT).filter({ visible: true }).first().inputValue());
          assert.equal(price, Number(expectedSku.sku.price), `Saved SKU price changed: ${JSON.stringify(expectedSku.attributes)}`);
          result.skuPrices.push({ attributes: expectedSku.attributes, price });
        }
        seen.add(index);
      }
      if (seen.size === expected.length) break;
      stagnant = seen.size === before ? stagnant + 1 : 0;
      assert.ok(stagnant < 4, 'Not every saved SKU could be read');
      await scroll.evaluate(node => { node.scrollTop += Math.max(48, node.clientHeight - 48); node.dispatchEvent(new Event('scroll')); });
      await page.waitForTimeout(180);
    }
  } else {
    await page.locator('input[role="input-price"]:visible').first().waitFor({ timeout: 30000 });
    result.prices = await page.locator('input[role="input-price"]:visible').evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
    assert.ok(result.prices.includes(Number(product.price)), 'Saved price must survive a fresh page load');
    if (product.priceTiers?.length > 1) {
      result.quantities = await page.locator('input[role="input-quantity"]:visible').evaluateAll((inputs) => inputs.map(input => Number(input.value)));
      assert.deepEqual(result.prices, product.priceTiers.map(tier => Number(tier.price)), 'Every quantity-tier price must survive a fresh page load');
      assert.deepEqual(result.quantities, product.priceTiers.map(tier => Number(tier.minQuantity)), 'Every price break must survive a fresh page load');
    }
  }
  result.specifications = await page.locator('#struct-specification input[role="colorCombobox"]').evaluateAll((inputs) => inputs.map((input) => input.value));
  const colors = product.variantGroups?.find((group) => /^colou?r$|^颜色$/i.test(group.name))?.options || [];
  for (const color of colors) assert.ok(result.specifications.includes(color), `Saved color missing: ${color}`);
  result.fields = await page.evaluate(readPostingAttributeSchema);
  await requireCategoryAttributes(page, product);
  for (const expected of receipt.result.requiredAttributes || []) {
    const field = result.fields.find(field => field.label === expected.name);
    if (!field || field.saleSpecification) continue;
    assert.ok(field.hasValue && attributeFieldMatchesValue(field, expected.value), `Saved attribute changed: ${expected.name}`);
  }
  result.emptyRequired = result.fields.filter(field => field.required && !field.disabled && !field.hasValue).map(field => field.label);
  assert.deepEqual(result.emptyRequired, []);
  result.services = [];
  for (const group of customizationGroups(product.services)) {
    const root = page.locator(group.kind === 'lightCustomization' ? '#lightCustomizedServices' : '#newCustomizedServices');
    const names = await root.locator('.itemList-title').allTextContents();
    const model = await customizationFormModel(root);
    const source = product.attributes.find(row => row.name === group.name);
    const saved = model.find(row => source?.id && String(row.customPropId) === String(source.id) || requiredAttributeKey(row.customType || row.customPropText) === requiredAttributeKey(group.name));
    const index = names.findIndex(name => [group.name, saved?.customPropText].filter(Boolean).some(wanted => requiredAttributeKey(name.replace(/\(\d+\/\d+\)/g, '').trim()) === requiredAttributeKey(wanted)));
    assert.ok(index >= 0, `Saved customization missing: ${group.name}`);
    const values = await root.locator('.itemList').nth(index).locator('.cardItem').evaluateAll(cards => cards.map(card => [...card.querySelectorAll('input')].map(input => input.value)));
    assert.deepEqual(values, group.rows.map(row => [String(row.value), row.surcharge == null ? '' : String(row.surcharge), String(row.moq)]));
    result.services.push({ name: group.name, values });
  }
  result.regionalPrices = [];
  for (const country of regionalPriceRows(product)) {
    assert.equal(await page.locator(`#struct-icbuCountryRegion input[value="${country.code}"]`).isChecked(), true);
    const root = page.locator('#struct-countryLadderPrice:visible, #struct-countrySku:visible').filter({ has: page.locator('input[type="radio"]') }).first();
    const header = root.locator('th .next-table-cell-wrapper[data-next-table-col]').filter({ hasText: country.label }).filter({ visible: true });
    assert.equal(await header.count(), 1);
    const column = await header.getAttribute('data-next-table-col');
    const values = await root.locator(`tbody td[data-next-table-col="${column}"]`).evaluateAll(cells => cells.map(cell => ({
      value: cell.querySelector('input')?.value, sign: cell.querySelector('.subtract-change-price .next-select em')?.textContent,
      preview: cell.querySelector('.price-preview, .super-price-value')?.textContent,
    })));
    assert.equal(values.length, usesSkuPricing(product) ? product.skus.filter(sku => sku.enabled !== false).length : product.priceTiers.length || 1);
    // Alibaba persists calculated country prices, reopening them in direct-price
    // mode even when the merchant used an amount/percentage helper when posting.
    for (const [index, row] of values.entries()) {
      if (row.sign) {
        assert.equal(Number(row.value), Math.abs(country.value));
        assert.equal(row.sign.trim(), country.value < 0 ? '-' : '+');
      } else {
        const base = usesSkuPricing(product) ? result.skuPrices[index].price : result.prices[index];
        const expected = country.mode === 'fixed' ? country.value : country.mode === 'amount' ? base + country.value : base * (1 + country.value / 100);
        assert.equal(Number(row.value), Math.round((expected + Number.EPSILON) * 10000) / 10000);
      }
    }
    result.regionalPrices.push({ country: country.code, values });
  }
  await revealDescriptionSection(page);
  const structure = currentDescriptionStructure(product);
  if (structure) {
    await page.locator('#detailImage').waitFor({ state: 'visible', timeout: 30000 });
    const mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
    assert.equal(mode, 4, 'Published native description must not fall back to a rich-text editor');
    const plan = compileNativeDescription(structure, await nativeDescriptionSchemas(page));
    const fields = await readNativeDescriptionFields(page);
    assert.ok(fields);
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    for (const key of ['textDesc', 'companyDesc']) assert.equal(clean(fields[key]), clean(plan[key]), `Saved ${key} must retain the source text`);
    result.nativeDescription = { mode, fields, imageChecks: [] };
    const imageDirectory = path.join(directory, `${product.sourceId}-image-readback`);
    fs.mkdirSync(imageDirectory, { recursive: true });
    const download = async url => {
      const parsed = new URL(url, 'https://www.alibaba.com/');
      assert.equal(parsed.protocol, 'https:');
      assert.match(parsed.hostname, /(?:^|\.)alicdn\.com$/);
      const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 0 && bytes.length <= 20 * 1024 * 1024);
      return bytes;
    };
    for (const rootId of ['detailImage', 'companyImage']) {
      const expectedGroups = plan.galleries.filter(group => group.rootId === rootId);
      const actualGroups = fields[rootId] || [];
      assert.equal(actualGroups.length, expectedGroups.length, `${rootId}: gallery count changed`);
      for (const [groupIndex, group] of expectedGroups.entries()) {
        const saved = actualGroups[groupIndex];
        assert.equal(saved.enName, group.name, `${rootId}: gallery name/order changed`);
        if (group.custom) group.value = saved.value;
        else assert.equal(String(saved.value), String(group.value));
        assert.equal(saved.imageList.length, group.images.length, `${rootId}: image count changed`);
        group.urls = saved.imageList.map(image => image.imgURL);
        for (const [index, image] of group.images.entries()) {
          const sourceFile = path.join(imageDirectory, `${rootId}-${groupIndex}-${index}-source`);
          fs.writeFileSync(sourceFile, await download(image.url));
          const prepared = await prepareStructuredDescriptionImages([sourceFile]);
          const expectedBytes = fs.readFileSync(prepared.files[0]);
          // Saved gallery models expose a thumbnail in imgURL and the actual
          // uploaded asset in fileURL. Verify the latter without guessing a URL.
          const actualBytes = await download(saved.imageList[index].fileURL || group.urls[index]);
          const options = { limitInputPixels: 40000000 };
          const expected = await sharp(expectedBytes, options).metadata();
          const actual = await sharp(actualBytes, options).metadata();
          assert.ok(actual.width >= 600 && actual.height >= 600 && actualBytes.length <= 5 * 1024 * 1024);
          assert.ok(Math.abs(actual.width / actual.height - expected.width / expected.height) < 0.02, 'Native image aspect ratio changed');
          const pixels = bytes => sharp(bytes, options).rotate().flatten({ background: '#ffffff' }).resize(256, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer();
          const [a, b] = await Promise.all([pixels(actualBytes), pixels(expectedBytes)]);
          assert.equal(a.length, b.length);
          let sum = 0;
          for (let pixel = 0; pixel < a.length; pixel++) sum += Math.abs(a[pixel] - b[pixel]);
          const meanAbsoluteDifference = sum / a.length;
          result.nativeDescription.imageChecks.push({ rootId, groupIndex, index, width: actual.width, height: actual.height, bytes: actualBytes.length, meanAbsoluteDifference });
          assert.ok(meanAbsoluteDifference < 8, `${rootId} image ${index + 1}: saved pixels differ from the prepared source`);
        }
      }
    }
    requireNativeDescriptionFields(plan, fields);
    await requireNativeDescriptionAccepted(page);
    result.detailImages = ['detailImage', 'companyImage'].flatMap(key => (fields[key] || [])
      .flatMap(group => group.imageList.map(image => new URL(image.fileURL || image.imgURL, 'https://www.alibaba.com/').href)));
  } else {
    const { body } = await waitForDescriptionEditor(page, { switchMode: () => revealDescriptionSection(page) });
    result.detailImages = await body.locator('img[src]').evaluateAll(nodes => nodes.map(node => node.src));
  }
  result.expectedDetailImages = distinctAlibabaImageUrls(product.detailImages || []).length;
  assert.equal(result.detailImages.length, result.expectedDetailImages, 'Every uploaded detail image must survive a fresh page load');
  assert.ok(result.detailImages.every(url => /^https:\/\//.test(url) && !/loading|blob:|data:/.test(url)), 'Saved detail images must be remote image URLs');
  if (process.env.QA_VERIFY_WATERMARK_PIXELS === '1') {
    const { verifyWatermarkedReadback } = await import('./qa/watermark-readback.mjs');
    result.watermarkPixels = await verifyWatermarkedReadback(product, { mainImages: result.mainImageUrls, detailImages: result.detailImages },
      path.dirname(process.env.QA_WORKSPACE_FILE || path.join(directory, 'workspace/workspace.json')));
  }
  result.ok = true;
  await page.screenshot({ path: path.join(directory, `${outputName}.png`) });
} catch (error) {
  result.error = error.message;
  result.code = error.code;
  result.currentUrl = publisher.page?.url();
  result.pageText = await publisher.page?.locator('body').innerText().then(text => text.slice(0, 5000)).catch(() => '');
  await publisher.page?.screenshot({ path: path.join(directory, `${outputName}-failure.png`) }).catch(() => {});
  process.exitCode = 1;
}
finally {
  await publisher.shutdown();
  if (isolatedSession) fs.rmSync(isolatedSession, { force: true });
  fs.writeFileSync(path.join(directory, `${outputName}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
