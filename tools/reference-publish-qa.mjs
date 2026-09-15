import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const serverRoot = process.env.QA_PACKAGED === '1' ? '../.packaged/server/' : '../server/';
const { SellerPublisher, preparePublishProduct, validateProductData } = await import(`${serverRoot}publisher.js`);
const { ShopCollector } = await import(`${serverRoot}collector.js`);
const { createPublishedReferenceTemplate } = await import(`${serverRoot}publish-reference.js`);
const { applyPublishedProductReference, recordProductMutation, syncProductModel } = await import(`${serverRoot}product-model.js`);
const { buildAlibabaPublishUrl, productCategory } = await import(`${serverRoot}category-routing.js`);

const [action = 'collect'] = process.argv.slice(2);
const output = process.env.QA_OUTPUT_DIR;
if (!output || !process.env.QA_WORKSPACE_DIR || !process.env.QA_EXPECTED_ACCOUNT) throw new Error('Set isolated output, workspace and expected seller account');
if (!['collect', 'reference', 'draft', 'submit'].includes(action)) throw new Error('Unsupported QA action');
if (action === 'submit' && process.env.QA_ALLOW_SUBMIT !== '1') throw new Error('Explicit QA_ALLOW_SUBMIT is required');
fs.mkdirSync(output, { recursive: true });
const publisher = new SellerPublisher(output);
const collector = new ShopCollector(output, (...args) => publisher.enrichSourceProducts(...args));
const reportFile = path.join(output, 'reference-test.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { items: [], stages: [] };
const state = JSON.parse(fs.readFileSync(path.join(process.env.QA_WORKSPACE_DIR, 'workspace.json'), 'utf8'));
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const progress = (stage) => { report.stages.push({ stage, at: new Date().toISOString() }); save(); console.log(stage); };
if (process.env.QA_NO_INTERACTIVE === '1') publisher.completeSourceVerification = async () => {
  throw Object.assign(new Error('Source page requires human verification'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
};
try {
  const page = await publisher.currentSellerPage();
  const matches = matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url());
  report.accountVerified = matches;
  save();
  assert.equal(matches, true, 'The current Alibaba session does not match the requested seller');
  if (action === 'collect') {
    assert.equal(report.items.length, 0, 'Collection already exists; use a fresh QA directory');
    const listing = JSON.parse(fs.readFileSync(process.env.QA_LISTING_FILE, 'utf8'));
    const ids = String(process.env.QA_SOURCE_IDS || '').split(',').filter(Boolean);
    assert.ok(ids.length > 0 && ids.length <= 5);
    const seeds = ids.map((id) => {
      const product = listing.products.find((item) => item.sourceId === id);
      assert.ok(product, `Source ${id} not found`);
      return { platform: 'alibaba.com', sourceId: id, url: product.sourceUrl };
    });
    await collector.collectLinks(seeds, ({ current, product, error, key }) => {
      const item = { key, collectedAt: new Date().toISOString(), error: error || '' };
      if (product) {
        const sourceSnapshot = structuredClone(product);
        product.id = `qa-${product.sourceId}`;
        product.stock = product.stock == null || product.stock === '' ? Number(state.settings.defaultStock ?? 100) : Number(product.stock);
        syncProductModel(product, { captureSource: true, sourceSnapshot });
        item.collected = structuredClone(product);
        const category = productCategory(product);
        const candidates = state.products.filter((candidate) => candidate.status === 'published' && productCategory(candidate).id === category.id);
        const reference = candidates.find((candidate) => candidate.id === process.env.QA_REFERENCE_ID) || candidates[0];
        if (!reference) {
          item.error = `No successful reference for category ${category.id}`;
          process.exitCode = 1;
          report.items.push(item); save();
          console.log(JSON.stringify({ current, key, error: item.error }));
          return;
        }
        const snapshot = (reference.publishHistory || []).find((entry) => ['published', 'submitted', 'success'].includes(entry.result?.status) && entry.data);
        const template = createPublishedReferenceTemplate(reference, snapshot);
        const patch = applyPublishedProductReference(product, template, { fullTemplate: true });
        recordProductMutation(product, { ...patch, status: 'ready' }, { actor: 'user', action: 'reference-published-product' });
        item.reference = { id: reference.id, title: reference.title, receipt: reference.publishResult?.url, fields: Object.keys(patch) };
        item.product = product;
        item.validation = validateProductData(preparePublishProduct(product));
      }
      report.items.push(item); save();
      if (item.error) process.exitCode = 1;
      console.log(JSON.stringify({ current, key, error, before: item.collected?.quality?.score, after: item.product?.quality?.score, validation: item.validation }));
    }, { delaySeconds: 3 });
  } else if (action === 'reference') {
    for (const item of report.items) {
      assert.equal(Boolean(item.submit), false, 'Do not change a product after attempting submission');
      const product = structuredClone(item.collected);
      if (!product) continue;
      const reference = state.products.find((candidate) => candidate.id === item.reference?.id);
      assert.ok(reference && reference.status === 'published');
      const snapshot = (reference.publishHistory || []).find((entry) => ['published', 'submitted', 'success'].includes(entry.result?.status) && entry.data);
      const patch = applyPublishedProductReference(product, createPublishedReferenceTemplate(reference, snapshot), { fullTemplate: true });
      recordProductMutation(product, { ...patch, status: 'ready' }, { actor: 'user', action: 'reference-published-product' });
      if (item.draft) (item.draftHistory ||= []).push(item.draft);
      delete item.draft;
      item.product = product;
      item.reference.fields = Object.keys(patch);
      item.validation = validateProductData(preparePublishProduct(product));
      save();
      console.log(JSON.stringify({ sourceId: product.sourceId, score: product.quality.score, validation: item.validation }));
    }
  } else {
    for (const item of report.items) {
      if (!item.product || item.submit?.result?.status === 'published') continue;
      const filter = process.env.QA_ITEM_ID;
      if (filter && item.product.sourceId !== filter) continue;
      if (action === 'submit') {
        assert.ok(item.draft?.result, 'Verify the current product in a draft before submission');
        assert.equal(Boolean(item.submit), false, 'A submission was already attempted; reconcile its receipt before retrying');
      }
      item.product.stock = item.product.stock == null || item.product.stock === '' ? Number(state.settings.defaultStock ?? 100) : Number(item.product.stock);
      item.validation = validateProductData(preparePublishProduct(item.product));
      const result = { startedAt: new Date().toISOString(), packagedCode: process.env.QA_PACKAGED === '1' };
      item[action] = result; save();
      try {
        const current = await publisher.currentSellerPage();
        assert.equal(matchesAlibabaSession(await current.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, current.url()), true);
        const category = productCategory(item.product);
        result.result = await publisher.publishProduct(item.product, buildAlibabaPublishUrl(category.id), action, category.pathText, `qa-${item.product.sourceId}`, progress);
      } catch (error) { result.error = error.message; result.code = error.code; }
      result.finishedAt = new Date().toISOString(); save();
      if (publisher.page && !publisher.page.isClosed()) {
        await publisher.page.screenshot({ path: path.join(output, `${action}-${item.product.sourceId}.png`), fullPage: true }).catch(() => {});
      }
      console.log(JSON.stringify({ sourceId: item.product.sourceId, action, result }));
      if (result.error) process.exitCode = 1;
    }
  }
} catch (error) { report.error = error.message; console.error(error.message); process.exitCode = 1; }
finally { save(); await publisher.shutdown(); await collector.resetContext(); }
