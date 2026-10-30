// One authorized publication, only after the identical edited sample passed
// the full draft flow. A receipt file prevents an accidental duplicate run.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SellerPublisher } from '../server/publisher.js';
import { buildAlibabaPublishUrl, productCategory } from '../server/category-routing.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR, priorRoot = process.env.QA_DRAFT_DIR, sourceId = process.env.QA_SOURCE_ID;
assert.ok(root && priorRoot && sourceId && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const reportFile = path.join(root, 'publication.json');
assert.equal(fs.existsSync(reportFile), false, 'Do not repeat an already attempted formal publication');
const draft = JSON.parse(fs.readFileSync(path.join(priorRoot, 'performance.json')));
assert.ok(draft.ok && draft.samples.some(row => row.sourceId === sourceId && row.attributesAccepted && row.result?.status === 'drafted' && !row.error));
const state = JSON.parse(fs.readFileSync(path.join(priorRoot, 'workspace/workspace.json')));
const product = state.products.find(row => row.sourceId === sourceId);
assert.ok(product);
fs.cpSync(path.join(priorRoot, 'workspace/media'), path.join(root, 'media'), { recursive: true, errorOnExist: true, force: false });
fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ products: [product] }));
const session = path.join(root, 'cookies.json');
writePrivateSession(session, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = session;
const publisher = new SellerPublisher(root);
const record = { sourceId, mode: 'submit', started: new Date().toISOString(), stages: [], videos: false };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(record, null, 2));
let confirmed = false;
try {
  save();
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const category = productCategory(product), began = performance.now();
  record.result = await publisher.publishProduct(product, buildAlibabaPublishUrl(category.id), 'submit', category.pathText,
    'watermark-release-qa', stage => { record.stages.push({ stage, ms: Math.round(performance.now() - began) }); save(); },
    { listingMode: 'auto', uploadProductVideos: false, allowPolicyWarningPublish: true });
  record.ms = Math.round(performance.now() - began);
  assert.equal(record.result.status, 'published');
  const id = new URL(record.result.url).searchParams.get('primaryId');
  assert.match(id, /^\d+$/);
  record.publishedId = id; confirmed = true;
  fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify([record], null, 2));
} catch (error) { record.error = { message: error.message, code: error.code, diagnostics: error.diagnostics }; process.exitCode = 1; }
finally { record.finished = new Date().toISOString(); save(); await publisher.shutdown(); fs.rmSync(session, { force: true }); }
if (confirmed) {
  process.env.QA_LEDGER_DIR = root;
  process.env.QA_WORKSPACE_FILE = path.join(root, 'workspace.json');
  try {
    await import('./published-readback-live-qa.mjs');
    const readback = JSON.parse(fs.readFileSync(path.join(root, `${sourceId}-published-readback.json`)));
    assert.ok(readback.ok && !readback.error, readback.error || 'Persisted readback did not complete');
    record.readbackPassed = true;
  }
  catch (error) { record.readbackError = error.message; process.exitCode = 1; }
  save();
}
console.log(JSON.stringify({ sourceId, publishedId: record.publishedId, ms: record.ms, readbackPassed: record.readbackPassed, error: record.error, readbackError: record.readbackError }));
