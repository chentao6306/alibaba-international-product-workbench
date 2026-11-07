// Real public collection and seller drafts, operated through the normal UI.
// Every output goes to an isolated workspace; submissions require a prior draft.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { app, session } from 'electron';
import { chromium } from 'playwright-core';
import { createAppWindow } from '../electron/window-branding.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { showHumanVerification } from '../electron/human-verification.js';
import { SellerPublisher, fillCategoryAttributes, requireCategoryAttributes, mainImageFormState, distinctAlibabaImageUrls } from '../server/publisher.js';
import { readPostingAttributeSchema, sourceAttributeForField, sourceSpecificationForField } from '../server/category-attributes.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { inspectVerificationDocument } from '../server/human-verification.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_CDP_PORT);
fs.mkdirSync(root, { recursive: true });
const cases = JSON.parse(fs.readFileSync(process.env.QA_CASES_FILE, 'utf8').replace(/^\uFEFF/, ''));
const reportFile = path.join(root, 'report.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : { root, cases: [], captures: [], publications: [] };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const cookies = readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json'));
const cookieFile = path.join(root, 'alibaba-cookies.json');
writePrivateSession(cookieFile, cookies);
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
process.env.DATA_DIR = root; process.env.PORT = '0';
const partition = `cross-category-qa-${Date.now()}`;
const browserSession = session.fromPartition(partition);
for (const cookie of cookies) {
  const domain = cookie.domain.replace(/^\./, '');
  if (/(^|\.)(alibaba\.com|alicdn\.com)$/.test(domain)) await browserSession.cookies.set({ ...cookie, url: `https://${domain}${cookie.path || '/'}` }).catch(() => {});
}
app.on('window-all-closed', () => {});
globalThis.__KUA_YIPU_SELLER_BRIDGE = { humanVerification: (url, options) => showHumanVerification({
  url, partition, ...options,
  saveSession: async ({ webContents, readStorage }) => {
    writePrivateSession(cookieFile, await webContents.session.cookies.get({}));
    writePrivateSession(path.join(root, 'alibaba-storage.json'), { [new URL(webContents.getURL()).origin]: await readStorage() });
  },
  onCreated: ({ window }) => window.on('show', () => console.log('验证码窗口已显示，请用户完成验证')),
}) };
const openSource = SellerPublisher.prototype.sourceBrowser;
SellerPublisher.prototype.sourceBrowser = async function (...args) {
  console.log('QA：正在连接采集浏览器');
  const context = await openSource.apply(this, args);
  console.log('QA：采集浏览器连接完成');
  if (!context.qaObserved) {
    context.qaObserved = true;
    for (const method of ['cookies', 'addCookies', 'newPage']) {
      const original = context[method];
      context[method] = async (...values) => {
        console.log(`QA：采集会话 ${method} 开始`);
        try {
          const result = await original.apply(context, values);
          if (method === 'newPage') {
            const close = result.close;
            result.close = async (...options) => {
              console.log('QA：关闭采集页面开始');
              try { return await close.apply(result, options); }
              finally { console.log('QA：关闭采集页面结束'); }
            };
          }
          return result;
        } finally { console.log(`QA：采集会话 ${method} 结束`); }
      };
    }
  }
  return context;
};
const readSource = SellerPublisher.prototype.readSourceProduct;
const completeSourceVerification = SellerPublisher.prototype.completeSourceVerification;
SellerPublisher.prototype.completeSourceVerification = async function (...args) {
  let reading = false;
  const timer = setInterval(async () => {
    if (reading) return;
    reading = true;
    try {
      const states = [];
      for (const page of this.sourceContext?.pages() || []) {
        if (page.isClosed()) continue;
        states.push({ title: await page.title(), ...await page.evaluate(inspectVerificationDocument) });
      }
      fs.writeFileSync(path.join(root, 'source-verification-state.json'), JSON.stringify({ at: new Date().toISOString(), states }, null, 2));
    } catch {} finally { reading = false; }
  }, 2000);
  try { return await completeSourceVerification.apply(this, args); }
  finally { clearInterval(timer); }
};
SellerPublisher.prototype.readSourceProduct = async function (page, base, ...args) {
  console.log(JSON.stringify({ sourceStart: base.sourceId, url: base.sourceUrl }));
  let observing = false;
  const observer = setInterval(async () => {
    console.log(JSON.stringify({ sourcePending: base.sourceId, url: page.url(), closed: page.isClosed() }));
    if (observing || page.isClosed()) return;
    observing = true;
    try {
      const state = await page.locator('body').innerText({ timeout: 5000 });
      console.log(JSON.stringify({ sourceDocument: base.sourceId, text: state.slice(0, 800) }));
    } catch (error) { console.log(JSON.stringify({ sourceDocumentError: base.sourceId, message: error.message.slice(0, 500) })); }
    finally { observing = false; }
  }, 15000);
  let value;
  try { value = await readSource.call(this, page, base, ...args); }
  catch (error) {
    console.log(JSON.stringify({ sourceError: base.sourceId, url: page.url(), code: error.code, message: error.message }));
    throw error;
  }
  finally { clearInterval(observer); }
  const evidence = await page.evaluate(() => ({
    title: document.querySelector('h1')?.innerText,
    tables: [...document.querySelectorAll('table')].map(node => node.innerText).filter(Boolean),
    attributeSections: [...document.querySelectorAll('[data-module-name*="attribute" i], [data-testid*="attribute" i]')].filter(node => !node.parentElement?.closest('[data-module-name*="attribute" i], [data-testid*="attribute" i]')).map(node => node.innerText),
    media: [...document.querySelectorAll('video, video source')].map(node => ({ url: node.currentSrc || node.src, poster: node.poster })),
  }));
  fs.writeFileSync(path.join(root, `${value.sourceId}-source.json`), JSON.stringify({ product: value, evidence }, null, 2));
  await page.screenshot({ path: path.join(root, `${value.sourceId}-source.png`) }).catch(() => {});
  report.captures.push({ sourceId: value.sourceId, attributes: value.attributes?.length, mainImages: value.mainImages?.length,
    detailImages: value.detailImages?.length, videos: value.videos?.length, categoryId: value.categoryId, warning: value.collectWarning }); save();
  return value;
};
const publish = SellerPublisher.prototype.publishProduct;
SellerPublisher.prototype.publishProduct = async function (product, address, mode, ...rest) {
  const seller = await this.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await seller.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, seller.url()));
  if (mode === 'submit') {
    assert.ok(report.publications.some(row => row.sourceId === product.sourceId && row.mode === 'draft' && row.result?.status === 'drafted'), 'Draft must succeed before publishing');
    assert.ok(!report.publications.some(row => row.sourceId === product.sourceId && row.mode === 'submit'
      && !row.reconciledNoSubmission), 'Reconcile an earlier submission before trying again');
  }
  const row = { sourceId: product.sourceId, categoryId: product.categoryId, mode, startedAt: new Date().toISOString() };
  report.publications.push(row); save();
  const capture = async () => {
    row.fields = await this.page?.evaluate(readPostingAttributeSchema).catch(() => []) || [];
    row.fields = row.fields.map(field => ({ ...field, source: sourceAttributeForField(product, field) || null,
      specification: sourceSpecificationForField(product, field) || null }));
    row.images = await this.page?.locator('#struct-scImages').evaluate(node => ({ text: node.innerText, images: [...node.querySelectorAll('img')].map(img => img.src) })).catch(() => null);
    row.mainImageState = this.page ? await mainImageFormState(this.page).catch(() => null) : null;
    row.specificationHtml = await this.page?.locator('#struct-specification').evaluate(node => node.outerHTML).catch(() => null);
    row.validationLocations = await this.page?.locator('.next-form-item-help, .next-feedback-content, .next-message-content, [class*="error"]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && /必填|图片|image|required/i.test(node.innerText || '')).map(node => ({ text: node.innerText, section: node.closest('.com-struct[id]')?.id, html: node.outerHTML.slice(0, 3000) }))).catch(() => []);
    row.video = await this.page?.locator('[id*="video" i]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, text: node.innerText?.slice(0, 1500) }))).catch(() => []);
    save();
  };
  const reconcile = this.reconcileMainImages;
  this.reconcileMainImages = async (...args) => {
    const result = await reconcile.apply(this, args);
    await capture();
    if (process.env.QA_STRICT_ATTRIBUTES === '1') await requireCategoryAttributes(this.page, product);
    return result;
  };
  try { row.result = await publish.call(this, product, address, mode, ...rest); return row.result; }
  catch (error) {
    row.error = { message: error.message, code: error.code, requiredFields: error.requiredFields, diagnostics: error.diagnostics };
    // The site exposes the category form but refuses this account's category.
    // Exercise accessible controls only; never bypass the publishing restriction.
    if (error.code === 'PUBLISH_CATEGORY_NOT_AUTHORIZED' && process.env.QA_UNSAVED_FIELDS === '1') {
      row.unsavedAttributeCheck = { submitted: false, saved: false };
      let observing = false;
      const observer = setInterval(async () => {
        if (observing) return;
        observing = true;
        try {
          const fields = await this.page.evaluate(readPostingAttributeSchema);
          row.unsavedAttributeCheck.lastObservedAt = new Date().toISOString();
          row.unsavedAttributeCheck.lastFields = fields;
          console.log(JSON.stringify({ specificationProgress: product.sourceId, fields: fields.filter(field => field.saleSpecification) }));
          save();
        } catch {} finally { observing = false; }
      }, 15000);
      try {
        const progress = message => { console.log(message); rest[2]?.(`验证未提交表单：${message}`); };
        if (process.env.QA_UNSAVED_MEDIA === '1') {
          await this.fillLegacyDescription(this.page, product, progress);
          row.unsavedAttributeCheck.detailImageUrls = [];
          for (const frame of this.page.frames()) {
            const body = frame.locator('body.mce-content-body, body[contenteditable="true"]');
            if (await body.isVisible().catch(() => false)) {
              row.unsavedAttributeCheck.detailImageUrls.push(...await body.locator('img[src]').evaluateAll(nodes => nodes.map(node => node.src)));
            }
          }
          assert.equal(row.unsavedAttributeCheck.detailImageUrls.length, distinctAlibabaImageUrls(product.detailImages || []).length);
        }
        await fillCategoryAttributes(this.page, product, progress);
        row.unsavedAttributeCheck.mapping = await this.fillProductFields(this.page, product, progress);
        if (process.env.QA_UNSAVED_MEDIA === '1') {
          await this.uploadMainImages(this.page, product, progress);
          row.unsavedAttributeCheck.mainImages = await mainImageFormState(this.page);
          assert.equal(row.unsavedAttributeCheck.mainImages.occupied, distinctAlibabaImageUrls(product.mainImages || []).length);
          try { await this.uploadMainVideo(this.page, product); row.unsavedAttributeCheck.mainVideoUploaded = true; }
          catch (videoError) { row.unsavedAttributeCheck.videoWarning = videoError.message; }
          await this.fillPriceFields(this.page, product, { onProgress: progress });
        }
        await fillCategoryAttributes(this.page, product, progress);
        await requireCategoryAttributes(this.page, product);
        const schema = await this.page.evaluate(readPostingAttributeSchema);
        const empty = schema.filter(field => field.required && !field.disabled && !field.hasValue);
        assert.deepEqual(empty.map(field => field.label), [], 'Required attributes and sales specifications must all contain committed values');
        row.unsavedAttributeCheck.ok = true;
      } catch (checkError) {
        row.unsavedAttributeCheck.error = { message: checkError.message, requiredFields: checkError.requiredFields, unmatchedSourceFields: checkError.unmatchedSourceFields };
      } finally { clearInterval(observer); }
    }
    await capture(); throw error;
  }
  finally {
    this.reconcileMainImages = reconcile;
    await this.page?.screenshot({ path: path.join(root, `${product.sourceId}-${mode}.png`) }).catch(() => {});
    row.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ publication: row.sourceId, mode, result: row.result, error: row.error }));
  }
};
const server = await import('../server/index.js');
const listener = await server.serverReady;
const base = `http://127.0.0.1:${listener.address().port}`;
const request = async (url, body) => {
  const response = await fetch(base + url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); assert.ok(response.ok, value.error); return value;
};
const native = createAppWindow({ width: 1440, height: 1000, title: '抄得快 · 跨品类实际操作验证', webPreferences: { contextIsolation: true, nodeIntegration: false } });
await native.loadURL(base + '/');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.QA_CDP_PORT}`);
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === base + '/');
assert.ok(page); page.setDefaultTimeout(60000);
let lastMessage = '';
async function finishJob(id, minutes = 20) {
  const deadline = Date.now() + minutes * 60000;
  while (Date.now() < deadline) {
    const state = await request('/api/state'); const job = state.jobs.find(job => job.id === id);
    if (lastMessage !== job.message) { lastMessage = job.message; console.log(job.message); }
    if (['completed', 'failed', 'paused', 'cancelled'].includes(job.status)) return { state, job };
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error(`Job ${id} exceeded verification time`);
}
try {
  const announcement = page.getByRole('dialog', { name: '公告', exact: true });
  await announcement.waitFor({ timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 20 && await announcement.isVisible(); i++) { await announcement.getByRole('button', { name: '我已阅读', exact: true }).click(); await announcement.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {}); }
  for (const sample of cases.filter(sample => !process.env.QA_CASE_FILTER || process.env.QA_CASE_FILTER.split(',').includes(sample.kind))) {
    let item = report.cases.find(item => item.url === sample.url);
    if (!item) { item = { ...sample }; report.cases.push(item); save(); }
    try {
      let state = await request('/api/state');
      let folder = state.collectionFolders.find(folder => folder.name === `跨品类验收-${sample.kind}`);
      if (!folder) {
        await page.getByTitle('新建采集分组', { exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '新建采集分组' });
        await dialog.getByLabel('分组名称').fill(`跨品类验收-${sample.kind}`); await dialog.getByRole('button', { name: '保存', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
        state = await request('/api/state'); folder = state.collectionFolders.find(folder => folder.name === `跨品类验收-${sample.kind}`);
      }
      assert.ok(folder); item.folderId = folder.id;
      await page.getByLabel('采集分组', { exact: true }).selectOption(folder.id);
      await page.waitForFunction(id => document.querySelector('[aria-label="采集分组"]')?.value === id && !document.querySelector('.app-shell')?.inert, folder.id);
      const existing = state.products.find(product => product.collectionFolderId === folder.id);
      if (!existing) {
        const paused = state.jobs.find(job => job.type === 'collect' && job.status === 'paused'
          && job.metadata?.collectionFolderId === folder.id && job.metadata?.links?.some(link => link.url === sample.url));
        let job;
        if (paused) {
          console.log(`QA：继续已暂停的原采集任务 ${paused.id}`);
          job = await request(`/api/jobs/${paused.id}/resume`, {});
        } else {
          await page.locator('.sidebar nav button').filter({ hasText: '单个商品采集' }).click();
          await page.getByLabel('采集链接', { exact: true }).fill(sample.url);
          const [created] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/api/collect/links')),
            page.getByRole('button', { name: '开始采集', exact: true }).click(),
          ]);
          job = await created.json(); assert.equal(created.status(), 202, job.error);
        }
        const done = await finishJob(job.id); item.collection = done.job; save();
        assert.equal(done.job.status, 'completed', done.job.message); state = done.state;
      }
      let product = state.products.find(product => product.collectionFolderId === folder.id);
      assert.ok(product); item.sourceId = product.sourceId; item.id = product.id;
      item.collected = { title: product.title, categoryId: product.categoryId, mainImages: product.mainImages?.length, detailImages: product.detailImages?.length, attributes: product.attributes?.length, videos: product.videos?.length, skuCount: product.skus?.length, quality: product.quality };
      save();
      await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
      const productRow = page.locator('.product-table tbody tr').filter({ hasText: product.sourceId });
      await productRow.waitFor();
      if (process.env.QA_CATEGORY_PICK_SOURCE === product.sourceId && !item.categoryPickRoundtrip) {
        const snapshot = JSON.stringify(product.source?.snapshot);
        const before = product.categoryId;
        const expected = process.env.QA_CATEGORY_PICK_EXPECTED;
        assert.match(expected || '', /^[1-9]\d{0,11}$/);
        await productRow.getByTitle('编辑完整资料').click();
        const editor = page.getByRole('dialog', { name: '编辑产品', exact: true });
        await editor.getByRole('button', { name: '重选类目', exact: true }).click();
        const picker = editor.getByRole('region', { name: '选择国际站产品类目', exact: true });
        await picker.getByRole('tab', { name: '搜索类目', exact: true }).click();
        await picker.getByLabel('搜索类目名称或 ID', { exact: true }).fill(expected);
        await picker.getByRole('option').filter({ hasText: new RegExp(`ID ${expected}$`) }).click();
        await picker.getByRole('button', { name: '确认选择', exact: true }).click();
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        state = await request('/api/state'); product = state.products.find(row => row.id === product.id);
        assert.equal(product.categoryId, expected);
        assert.equal(JSON.stringify(product.source?.snapshot), snapshot);
        await productRow.getByTitle('编辑完整资料').click();
        assert.ok((await editor.locator('.pe-category-path').allTextContents()).some(text => text.includes(expected)));
        await editor.getByRole('button', { name: '返回', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        item.categoryPickRoundtrip = { before, after: expected, path: product.categoryPath, reopened: true, sourceSnapshotUnchanged: true }; save();
      }
      if (process.env.QA_CATEGORY_REFERENCE_SOURCE === product.sourceId && !item.categoryReferenceRoundtrip) {
        const snapshot = JSON.stringify(product.source?.snapshot);
        const before = product.categoryId;
        await productRow.getByTitle('编辑完整资料').click();
        const editor = page.getByRole('dialog', { name: '编辑产品', exact: true });
        await editor.getByRole('button', { name: '重选类目', exact: true }).click();
        const picker = editor.getByRole('region', { name: '选择国际站产品类目', exact: true });
        await picker.getByRole('tab', { name: '读取同类商品', exact: true }).click();
        await picker.getByLabel('同类国际站商品链接', { exact: true }).fill(product.sourceUrl);
        const [response] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/categories/from-product'), { timeout: 240000 }),
          picker.getByRole('button', { name: '读取商品类目', exact: true }).click(),
        ]);
        const option = await response.json(); assert.ok(response.ok(), option.error);
        assert.equal(option.id, process.env.QA_CATEGORY_REFERENCE_EXPECTED);
        await picker.getByRole('button', { name: '确认选择', exact: true }).click();
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        state = await request('/api/state'); product = state.products.find(row => row.id === product.id);
        assert.equal(product.categoryId, option.id);
        assert.equal(JSON.stringify(product.source?.snapshot), snapshot);
        await productRow.getByTitle('编辑完整资料').click();
        assert.ok((await editor.locator('.pe-category-path').allTextContents()).some(text => text.includes(option.id)));
        await editor.getByRole('button', { name: '返回', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        item.categoryReferenceRoundtrip = { before, after: option.id, path: option.path, source: product.sourceUrl, reopened: true, sourceSnapshotUnchanged: true }; save();
      }
      if (process.env.QA_EDIT_ROUNDTRIP === '1' && (!item.manualEditRoundtrip || process.env.QA_REPEAT_EDIT === '1') && process.env.QA_SUBMIT !== '1') {
        const original = String(product.priceTiers?.[0]?.price ?? '');
        assert.ok(Number(original) > 0, 'This edit roundtrip requires an existing source price tier');
        const changed = (Number(original) + 0.01).toFixed(2);
        assert.ok(product.source?.snapshot, 'Captured source snapshot is required');
        const snapshot = JSON.stringify(product.source.snapshot);
        for (const value of [changed, original]) {
          await productRow.getByTitle('编辑完整资料').click();
          const editor = page.getByRole('dialog', { name: '编辑产品', exact: true });
          await editor.getByRole('tab', { name: '交易信息', exact: true }).click();
          await editor.getByLabel('阶梯 1 价格', { exact: true }).fill(value);
          await editor.getByRole('button', { name: '保存', exact: true }).click();
          await editor.waitFor({ state: 'hidden' });
          await productRow.getByTitle('编辑完整资料').click();
          await editor.getByRole('tab', { name: '交易信息', exact: true }).click();
          assert.equal(Number(await editor.getByLabel('阶梯 1 价格', { exact: true }).inputValue()), Number(value));
          await editor.getByRole('button', { name: '返回', exact: true }).click();
          await editor.waitFor({ state: 'hidden' });
        }
        state = await request('/api/state'); product = state.products.find(row => row.id === product.id);
        assert.equal(JSON.stringify(product.source?.snapshot), snapshot, 'Manual editing cannot rewrite source provenance');
        item.manualEditRoundtrip = { original, changed, restored: true, reopened: true }; save();
      }
      if (process.env.QA_EXTRAS_SOURCE === product.sourceId && !item.manualExtras && process.env.QA_SUBMIT !== '1') {
        await productRow.getByTitle('编辑完整资料').click();
        const editor = page.getByRole('dialog', { name: '编辑产品', exact: true });
        await editor.getByRole('tab', { name: '商品服务与证书', exact: true }).click();
        const name = product.attributes.find(row => /^(?:chipset|芯片组)$/i.test(row.name))?.name;
        assert.ok(name, 'This scenario requires an observed source chipset property');
        await editor.getByRole('group', { name: '深度定制', exact: true }).getByLabel(name, { exact: true }).check();
        await editor.getByLabel(`${name}定制 1 值`, { exact: true }).fill('JL');
        await editor.getByLabel(`${name}定制 1 加价`, { exact: true }).fill('0.5');
        await editor.getByLabel(`${name}定制 1 起订量`, { exact: true }).fill('3000');
        await editor.getByRole('tab', { name: '国家/地区差异设置', exact: true }).click();
        await editor.getByLabel('基础价加减金额', { exact: true }).check();
        for (const [index, country, value] of [[1, 'United States', '1'], [2, 'Canada', '-1']]) {
          await editor.getByRole('button', { name: '选取国家/地区', exact: true }).click();
          await editor.getByLabel(`定价国家 ${index}`, { exact: true }).selectOption(country);
          await editor.getByLabel(`地区价格 ${index}`, { exact: true }).fill(value);
        }
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        state = await request('/api/state'); product = state.products.find(row => row.id === product.id);
        assert.equal(product.services.customizationDetails[`deepCustomization:${name}`].rows[0].value, 'JL');
        assert.equal(product.regionalPricing.rows.length, 2);
        item.manualExtras = { services: product.services, regionalPricing: product.regionalPricing, draftOnlyServices: true };
        save();
      }
      if (process.env.QA_SKU_PRICE_SOURCE === product.sourceId && process.env.QA_SUBMIT !== '1' && !item.manualSkuPrices) {
        assert.equal(product.skus.length, 3, 'This explicit price scenario expects three SKUs');
        await productRow.getByTitle('编辑完整资料').click();
        const editor = page.getByRole('dialog', { name: '编辑产品', exact: true });
        await editor.getByRole('tab', { name: '交易信息', exact: true }).click();
        await editor.getByLabel('根据规格设置价格', { exact: true }).check();
        await editor.getByRole('tab', { name: '产品规格', exact: true }).click();
        const prices = process.env.QA_SKU_PRICES ? process.env.QA_SKU_PRICES.split(',').map(Number) : [5.1, 5.2, 5.3];
        assert.ok(prices.length === product.skus.length && prices.every(value => Number.isFinite(value) && value > 0));
        for (let index = 0; index < prices.length; index++) await editor.getByLabel(`SKU ${index + 1} 价格`, { exact: true }).fill(String(prices[index]));
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        state = await request('/api/state'); product = state.products.find(row => row.id === product.id);
        assert.equal(product.priceMode, 'sku');
        assert.deepEqual(product.skus.map(sku => Number(sku.price)), prices);
        item.manualSkuPrices = product.skus.map(sku => ({ attributes: sku.attributes, price: sku.price }));
        item.priceScenario = 'Explicitly edited through the product editor to verify different SKU prices; not claimed as source-published SKU prices';
        save();
      }
      if (process.env.QA_SPEC_IMAGE_SOURCE === product.sourceId && !item.manualSpecificationEdit && process.env.QA_SUBMIT !== '1') {
        // Source photos show only White. Test an explicit, reversible merchant
        // edit without inventing a Black picture or altering the source capture.
        const before = structuredClone(product.variantGroups);
        const color = before.find(group => group.name === 'color');
        assert.deepEqual(color?.options, ['White', 'Black']);
        await productRow.getByTitle('编辑完整资料').click();
        const editor = page.getByRole('dialog', { name: '编辑产品', exact: true });
        await editor.getByRole('tab', { name: '产品规格', exact: true }).click();
        await editor.getByTitle('移除 color Black', { exact: true }).click();
        const white = editor.locator('.pe-spec-option').filter({ hasText: 'White' });
        await white.getByRole('button', { name: '选取图片', exact: true }).click();
        await editor.getByLabel('White 规格图片地址', { exact: true }).fill(product.mainImages[1]);
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        state = await request('/api/state'); product = state.products.find(row => row.id === product.id);
        const edited = product.variantGroups.find(group => group.name === 'color');
        assert.deepEqual(edited.options, ['White']);
        assert.equal(edited.optionImages.White, product.mainImages[1]);
        assert.ok(product.skus.every(sku => !Object.values(sku.attributes).includes('Black')));
        item.manualSpecificationEdit = { before, after: product.variantGroups, reason: 'Only White is shown in source photos; intentionally test a merchant-edited White-only listing. Original source has White and Black without image associations.' };
        save();
      }
      if (!await productRow.getByRole('checkbox').isChecked()) await productRow.getByRole('checkbox').click();
      await page.getByRole('button', { name: '选中商品上架 1', exact: true }).waitFor();
      await page.screenshot({ path: path.join(root, `${product.sourceId}-workbench.png`) });
      const modes = process.env.QA_EDIT_ONLY === '1' ? [] : process.env.QA_DRAFT_AND_SUBMIT === '1' ? ['draft', 'submit'] : process.env.QA_SUBMIT === '1' ? ['submit'] : ['draft'];
      for (const mode of modes) {
        if (!(mode === 'draft' && process.env.QA_REPEAT_DRAFT === '1')
          && report.publications.some(row => row.sourceId === product.sourceId && row.mode === mode && row.result)) continue;
        // A successful draft clears the workbench selection. Select the same
        // saved product again before the separately authorized submit action.
        await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
        await productRow.waitFor();
        if (!await productRow.getByRole('checkbox').isChecked()) await productRow.getByRole('checkbox').click();
        await page.locator('.sidebar nav button').filter({ hasText: '上架任务' }).click();
        await page.getByRole('button', { name: mode === 'draft' ? '保存草稿 逐条填充并保存' : '直接提交 填充后自动发布' }).click();
        const [started] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/publish') && response.ok()),
          (async () => {
            await page.getByRole('button', { name: '开始处理 1 件', exact: true }).click();
            if (mode === 'submit') await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
          })(),
        ]);
        const job = await started.json(); const done = await finishJob(job.id); item[mode] = done.job; save();
        const result = done.state.products.find(p => p.id === product.id);
        item[`${mode}Result`] = result.publishResult; save();
        assert.equal(result.status, mode === 'draft' ? 'drafted' : 'published', result.publishResult?.message);
      }
      if (process.env.QA_EDIT_ONLY !== '1') { item.ok = true; delete item.error; }
    } catch (error) { item.error = error.message; item.ok = false; console.log(JSON.stringify({ case: sample.kind, error: error.message })); }
    save();
  }
  report.ok = report.cases.length === cases.length && report.cases.every(item => item.ok);
  if (!report.ok) process.exitCode = 1;
} finally {
  save(); await browser.close(); if (!native.isDestroyed()) native.close(); await server.shutdownServer();
  fs.rmSync(cookieFile, { force: true }); fs.rmSync(path.join(root, 'alibaba-storage.json'), { force: true });
  console.log(JSON.stringify({ root, ok: report.ok, cases: report.cases.map(item => ({ kind: item.kind, ok: item.ok, error: item.error })) }));
}
