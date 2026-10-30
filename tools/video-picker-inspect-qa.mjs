// Diagnose a prior publication's video picker using the production recovery flow.
// Reads an exact saved receipt; never creates or republishes a listing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR;
const userData = process.env.QA_DESKTOP_USER_DATA_DIR;
assert.ok(root && userData && process.env.QA_EXPECTED_ACCOUNT);
const state = JSON.parse(fs.readFileSync(path.join(userData, '.data/workspace.json')));
const receipt = state.jobs.find(job => job.id === process.env.QA_JOB_ID)?.results?.[process.env.QA_LOCAL_PRODUCT_ID];
assert.equal(receipt?.status, 'published');
assert.equal(new URL(receipt.url).searchParams.get('primaryId'), receipt.videoAssociation.productId);
fs.mkdirSync(root, { recursive: true });
const session = path.join(root, 'alibaba-cookies.json');
writePrivateSession(session, readPrivateSession(path.join(userData, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = session;
const publisher = new SellerPublisher(root);
const report = { productId: receipt.videoAssociation.productId, documents: [] };
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const context = page.context(), newPage = context.newPage.bind(context);
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
  report.result = await publisher.retryPublishedVideo(receipt.videoAssociation);
} catch (error) {
  report.error = { message: error.message, code: error.code };
  report.result = error.videoAssociation;
  process.exitCode = 1;
} finally {
  await publisher.shutdown();
  fs.rmSync(session, { force: true });
  fs.writeFileSync(path.join(root, 'picker-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile: path.join(root, 'picker-report.json'), error: report.error, associated: report.result?.associated }));
}
