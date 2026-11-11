// Diagnose a prior publication's video picker using the production recovery flow.
// Reads an exact saved receipt; never creates or republishes a listing.
// QA_READ_ONLY inspects the bank without confirming any selection. Optional
// traces and snapshots are private diagnostics and must stay outside Git.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { openBankAdvancedSearch } from '../server/posting-video-bank.js';

const root = process.env.QA_OUTPUT_DIR;
const userData = process.env.QA_DESKTOP_USER_DATA_DIR;
assert.ok(root && userData && process.env.QA_EXPECTED_ACCOUNT);
const state = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE || path.join(userData, '.data/workspace.json')));
const receipt = state.jobs.find(job => job.id === process.env.QA_JOB_ID)?.results?.[process.env.QA_LOCAL_PRODUCT_ID];
assert.equal(receipt?.status, 'published');
assert.equal(new URL(receipt.url).searchParams.get('primaryId'), receipt.videoAssociation.productId);
fs.mkdirSync(root, { recursive: true });
const session = path.join(root, 'alibaba-cookies.json');
writePrivateSession(session, readPrivateSession(path.join(userData, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = session;
const publisher = new SellerPublisher(root);
const report = { productId: receipt.videoAssociation.productId, documents: [] };
let diagnosticTimer;
let tracedContext;
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const context = page.context(), newPage = context.newPage.bind(context);
  if (process.env.QA_TRACE === '1') {
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracedContext = context;
  }
  context.newPage = async () => {
    const child = await newPage(), close = child.close.bind(child);
    child.close = async (...args) => {
      for (const frame of child.frames()) {
        if (!/^https:\/\/hz-productposting\.alibaba\.com\/product\/products_popup\.htm/.test(frame.url())) continue;
        try {
          report.documents.push(await frame.evaluate(productId => {
            const describe = node => ({ tag: node.tagName, id: node.id, className: node.className });
            return {
              productIdInput: document.querySelector('input#productId')?.value,
              videoFilter: document.querySelector('#isVideo')?.closest('.next-select-single')?.textContent,
              links: [...document.querySelectorAll('a[href*="/product-detail/"]')].slice(0, 30).map(node => {
                const url = new URL(node.href), ancestors = [];
                for (let parent = node.parentElement, i = 0; parent && i < 5; parent = parent.parentElement, i++) ancestors.push(describe(parent));
                return { path: url.pathname, exactProduct: url.pathname.endsWith(`_${productId}.html`), ancestors };
              }),
              imageWrappers: [...document.querySelectorAll('.popup-item-img-wrapper')].map(describe),
              checkboxValues: [...document.querySelectorAll('input[type="checkbox"]')].map(node => ({ value: node.value, checked: node.checked })),
              messages: [...document.querySelectorAll('.next-message-content,.next-table-empty')].map(node => node.textContent.slice(0, 500)),
            };
          }, report.productId));
        } catch (error) { report.documents.push({ captureError: error.message }); }
      }
      return close(...args);
    };
    return child;
  };
  if (process.env.QA_READ_ONLY === '1') {
    report.readOnly = true;
    report.linkedDocuments = [];
    for (const video of receipt.videoAssociation.items || [receipt.videoAssociation]) {
      assert.match(String(video.id), /^\d+$/);
      await page.goto(`https://hz-productposting.alibaba.com/product/videobank/linked_products.htm?videoId=${video.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('table').waitFor({ state: 'attached', timeout: 20000 });
      await page.locator('.next-loading.next-open').waitFor({ state: 'hidden', timeout: 20000 });
      await page.waitForTimeout(1500);
      report.linkedDocuments.push({ id: video.id, role: video.role, url: page.url(),
        text: (await page.locator('body').innerText()).slice(0, 12000),
        tables: await page.locator('table').count() });
      if (process.env.QA_INSPECT_ASSOCIATION === '1') {
        const bankUrl = new URL(video.bankUrl);
        assert.equal(bankUrl.origin, 'https://hz-productposting.alibaba.com');
        assert.equal(bankUrl.pathname, '/product/videobank/home.htm');
        await page.goto(bankUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.getByPlaceholder(/^(?:Video name|(?:请输入)?视频名称)\s*$/i).fill(video.name);
        await page.locator('button').filter({ hasText: /^(?:Search|搜索)$/i }).click({ timeout: 15000 });
        await page.locator('.next-loading.next-open').waitFor({ state: 'hidden', timeout: 20000 });
        const row = page.locator('.list-item-name').filter({ hasText: video.name }).locator('xpath=ancestor::tr[1]');
        await row.waitFor({ state: 'visible', timeout: 20000 });
        const rowText = await row.innerText();
        assert.match(rowText, new RegExp(`VID\\s*[:：]\\s*${video.id}(?:\\D|$)`));
        const action = video.role === 'detail' ? /^(?:Relate Product Details|关联产品详情|关联详情)$/i : /^(?:Relate Product|关联产品主图|关联产品|关联商品)$/i;
        await row.getByText(action).filter({ visible: true }).click({ timeout: 15000 });
        if (process.env.QA_INSPECT_SEARCH === '1') {
          const iframe = page.locator('.icbu-product-select iframe');
          await iframe.waitFor({ state: 'visible', timeout: 20000 });
          const frame = await iframe.elementHandle().then(node => node.contentFrame());
          assert.ok(frame);
          const ready = async () => await frame.locator('input#productId').isVisible()
            || await frame.locator(`a[href*="_${report.productId}.html"]`).isVisible();
          const started = Date.now();
          await openBankAdvancedSearch(page, frame.getByRole('button', { name: /^(?:Advanced Search|高级搜索)$/i }), ready);
          report.searchRecovery = { elapsedMs: Date.now() - started, ready: await ready(), confirmedSelection: false };
        }
        await page.waitForTimeout(2000);
        report.associationInspection = { id: video.id, rowText,
          text: (await page.locator('body').innerText()).slice(0, 12000),
          frames: page.frames().slice(1).map(frame => frame.url()) };
        const selectorFrame = page.frames().find(frame => /^https:\/\/hz-productposting\.alibaba\.com\/product\/products_popup\.htm/.test(frame.url()));
        if (selectorFrame) {
          await selectorFrame.locator('body').waitFor({ timeout: 20000 });
          await selectorFrame.waitForTimeout(3000);
          report.associationInspection.selector = await selectorFrame.evaluate(productId => ({
            productIdInputVisible: Boolean(document.querySelector('input#productId')?.getClientRects().length),
            exactLinks: [...document.querySelectorAll(`a[href*="_${productId}.html"]`)].map(node => ({
              path: new URL(node.href).pathname, visible: Boolean(node.getClientRects().length),
              cardClass: node.closest('.popup-item,td')?.className,
            })),
            checkedIds: [...document.querySelectorAll('input[type="checkbox"]:checked')].map(node => node.value),
          }), report.productId);
        }
        await page.screenshot({ path: path.join(root, 'association-inspection.png'), fullPage: true });
      }
    }
  } else {
    const capture = async () => {
      report.checkpoints ||= [];
      for (const child of context.pages()) {
        if (!/^https:\/\/hz-productposting\.alibaba\.com\/product\/(?:videobank\/|products_popup\.htm)/.test(child.url())) continue;
        const checkpoint = { url: child.url(), at: new Date().toISOString(), frames: [] };
        for (const frame of child.frames()) {
          if (!/^https:\/\/hz-productposting\.alibaba\.com\//.test(frame.url())) continue;
          checkpoint.frames.push({ url: frame.url(), text: (await frame.locator('body').innerText({ timeout: 1500 }).catch(() => '')).slice(0, 8000) });
        }
        report.checkpoints.push(checkpoint);
      }
      report.checkpoints = report.checkpoints.slice(-12);
      fs.writeFileSync(path.join(root, 'picker-checkpoints.json'), JSON.stringify(report.checkpoints, null, 2));
    };
    diagnosticTimer = setInterval(() => { void capture().catch(() => {}); }, 15000);
    report.result = await publisher.retryPublishedVideo(receipt.videoAssociation);
  }
} catch (error) {
  report.error = { message: error.message, code: error.code };
  report.result = error.videoAssociation;
  process.exitCode = 1;
} finally {
  clearInterval(diagnosticTimer);
  if (tracedContext) await tracedContext.tracing.stop({ path: path.join(root, 'association-trace.zip') }).catch(() => {});
  await publisher.shutdown();
  fs.rmSync(session, { force: true });
  fs.writeFileSync(path.join(root, 'picker-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile: path.join(root, 'picker-report.json'), error: report.error, associated: report.result?.associated }));
}
