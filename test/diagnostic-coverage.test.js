import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { capturePublishFailure, createPublishDiagnosticStore } from '../server/publish-diagnostics.js';
import { diagnosticSummaryFromState, buildDiagnosticReport } from '../server/diagnostic-report.js';
import { diagnosticData, diagnosticText, sanitizeDiagnosticFailure } from '../auth-server/diagnostic-evidence.js';
import { sanitizeDiagnosticReport, diagnosticStage } from '../auth-server/diagnostic-schema.js';
import { createDiagnosticStore } from '../auth-server/diagnostics.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-coverage-'));
  const account = 'coverage-fixture';
  const directory = path.join(root, 'diagnostics', crypto.createHash('sha256').update(account).digest('hex').slice(0, 24));
  return { root, account, directory, store: createPublishDiagnosticStore(root, account),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('identical errors retain evidence from different target categories and execution modes', () => {
  const f = fixture();
  try {
    const cases = [
      ['201', 'draft', 'rules'], ['202', 'submit', 'rules'], ['202', 'draft', 'assisted'], ['202', 'draft', 'rules'],
      ...Array.from({ length: 4 }, () => ['203', 'draft', 'rules']),
    ];
    cases.forEach(([targetCategoryId, mode, processingMode], index) => {
      f.store.write({ product: { id: `item-${index}`, title: `Fixture ${index}`, categoryId: '999' }, targetCategoryId, mode, processingMode,
        stage: '填写类目属性：类型', error: { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' } });
      const file = fs.readdirSync(f.directory).map(name => path.join(f.directory, name)).find(file => JSON.parse(fs.readFileSync(file, 'utf8')).product.id === `item-${index}`);
      const time = new Date(Date.now() - 10000 + index * 1000);
      fs.utimesSync(file, time, time);
    });
    const result = f.store.read();
    assert.deepEqual(result.failures.map(item => item.product.id), ['item-7', 'item-3', 'item-2', 'item-1', 'item-0']);
    assert.equal(result.failureIndex.length, 8);
    assert.equal(result.failureIndex.filter(item => item.evidence === 'included').length, 5);
    assert.equal(result.failureIndex.filter(item => item.omissionReason === 'snapshot-limit').length, 3);
    assert.equal(result.failureIndex.find(item => item.product.id === 'item-0').targetCategoryId, '201');
    assert.equal(result.omittedFailures, 3);
  } finally { f.close(); }
});

test('a zero snapshot budget still identifies failures while unreadable captures remain explicit', () => {
  const f = fixture();
  try {
    f.store.write({ product: { id: 'phone-1', title: 'Phone sk-fixtureprivatekey0123456789', cookies: 'PRIVATE_COOKIE' },
      error: { message: 'Upload timeout\npassword=PRIVATE_PASSWORD', cookies: 'PRIVATE_COOKIE' }, mode: 'submit' });
    fs.writeFileSync(path.join(f.directory, crypto.randomUUID() + '.json'), '{');
    const result = f.store.read(0);
    assert.equal(result.failures.length, 0);
    assert.equal(result.failureIndex.length, 2);
    assert.equal(result.failureIndex.find(item => item.product.id === 'phone-1').omissionReason, 'report-budget');
    assert.equal(result.failureIndex.filter(item => item.omissionReason === 'unreadable').length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|fixtureprivatekey/);
    assert.equal(result.omittedFailures, 2);
  } finally { f.close(); }
});

test('historical failures have a bounded index and retain current and source truncation flags', () => {
  const f = fixture();
  try {
    const now = Date.now();
    const products = Array.from({ length: 72 }, (_, index) => ({ id: `item-${index}`, title: `Fixture ${index}`, categoryId: '201',
      sourceCategoryId: '101', status: 'publish_failed', updatedAt: new Date(now - index * 1000).toISOString(),
      ...(index === 0 ? { description: 'x'.repeat(300000), source: { snapshot: { description: 'y'.repeat(300000) } } } : {}),
      publishResult: { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN', message: 'Control did not accept the value', requiredFields: ['Type'], diagnostics: { publishStage: '填写类目属性' } },
      publishHistory: [{ mode: 'submit', categoryId: '202' }],
    }));
    const summary = diagnosticSummaryFromState({ products });
    const report = buildDiagnosticReport({ version: '1.4.102', dataDirectory: f.root, account: f.account, summary });
    assert.equal(report.failureIndex.length, 60);
    assert.equal(report.failureCoverage.omittedIndexEntries, 12);
    assert.equal(report.failures.length, 3);
    assert.equal(report.omittedFailures, 69);
    assert.equal(report.failureIndex[0].targetCategoryId, '202');
    assert.equal(report.failureIndex[0].sourceCategoryId, '101');
    assert.equal(report.failureIndex[0].mode, 'submit');
    assert.equal(report.failureIndex[0].evidence, 'historical');
    assert.equal(report.failureIndex[0].truncated, true);
    assert.equal(report.failureIndex[0].omissionReason, 'not-captured');
    assert.equal(report.failures[0].truncation.product, true);
    assert.equal(report.failures[0].truncation.source, true);
    assert.equal(report.failures[0].truncated, true);
    assert.deepEqual(sanitizeDiagnosticReport(report), report);
  } finally { f.close(); }
});

test('retention and clear markers explain missing captures without restoring cleared product identities', () => {
  const f = fixture();
  try {
    const expired = new Date(Date.now() - 8 * 86400000);
    f.store.write({ product: { id: 'expired', title: 'Expired fixture' }, stage: 'images', error: { code: 'PUBLISH_IMAGE_REJECTED' } });
    for (const name of fs.readdirSync(f.directory)) fs.utimesSync(path.join(f.directory, name), expired, expired);
    const summary = diagnosticSummaryFromState({ products: [{ id: 'expired', title: 'Expired fixture', status: 'publish_failed', updatedAt: expired.toISOString() }] });
    const report = buildDiagnosticReport({ dataDirectory: f.root, account: f.account, summary });
    assert.equal(report.failures.length, 0);
    assert.equal(report.failureIndex[0].omissionReason, 'retention-expired');
    assert.equal(report.failureCoverage.prunedDuringRead.retention, 1);
    assert.equal(report.failureCoverage.snapshotRetentionDays, 7);
    f.store.clear();
    const cleared = buildDiagnosticReport({ dataDirectory: f.root, account: f.account, summary });
    assert.equal(cleared.failureIndex.length, 0);
    assert.doesNotMatch(JSON.stringify(cleared), /Expired fixture/);
  } finally { f.close(); }
});

test('full captures stay indexed when newer state failures fill the summary limit', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 8; index++) f.store.write({ product: { id: `capture-${index}`, title: `Captured ${index}` }, targetCategoryId: `${200 + index}`, mode: 'draft',
      error: { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' } });
    const products = Array.from({ length: 60 }, (_, index) => ({ id: `state-${index}`, title: `Historical ${index}`, status: 'publish_failed',
      updatedAt: new Date(Date.now() + 1000 + index).toISOString(), publishResult: { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' } }));
    const report = buildDiagnosticReport({ dataDirectory: f.root, account: f.account, summary: diagnosticSummaryFromState({ products }) });
    assert.equal(report.failures.length, 5);
    assert.equal(report.failureIndex.length, 60);
    assert.equal(report.failureCoverage.omittedIndexEntries, 8);
    assert.equal(report.omittedFailures, 63);
    for (const failure of report.failures) assert.equal(report.failureIndex.find(item => item.id === failure.id)?.evidence, 'included');
  } finally { f.close(); }
});

test('attempt timelines survive capture and authenticated storage with strict bounded fields', async () => {
  const f = fixture();
  try {
    const attemptId = crypto.randomUUID();
    const timeline = { totalMs: 3500, entries: [
      { stage: 'images', startedMs: 0, durationMs: 1200, outcome: 'completed', cookie: 'PRIVATE_COOKIE' },
      { stage: 'verification', startedMs: 1200, durationMs: 1800, outcome: 'waiting', url: 'https://private.example/' },
      { stage: 'save-draft', startedMs: 3000, durationMs: 500, outcome: 'failed', password: 'PRIVATE_PASSWORD' },
    ], truncated: false };
    const captured = await capturePublishFailure({ product: { id: 'fixture-1', title: 'Fixture' }, error: new Error('Draft failed'),
      mode: 'draft', processingMode: 'assisted', targetCategoryId: '201', attemptId, timeline });
    f.store.write(captured);
    const report = buildDiagnosticReport({ dataDirectory: f.root, account: f.account });
    report.events = [{ at: new Date().toISOString(), event: 'publish-failed', stage: 'save-draft', mode: 'draft', processingMode: 'assisted', attemptId, stageMs: 500 },
      { at: new Date().toISOString(), event: 'publish-stage-completed', stage: 'images', mode: 'draft', processingMode: 'assisted', attemptId, stageMs: 1200 }];
    const remote = createDiagnosticStore(path.join(f.root, 'remote-fixture'));
    const receipt = remote.put(report, { account: 'qa', device: 'fixture' });
    const restored = remote.get(receipt.id).report;
    assert.equal(restored.failures[0].attemptId, attemptId);
    assert.equal(restored.failureIndex[0].attemptId, attemptId);
    assert.equal(restored.events[0].attemptId, attemptId);
    assert.equal(restored.events[0].stageMs, 500);
    assert.equal(restored.events[1].event, 'publish-stage-completed');
    assert.equal(restored.events[1].stageMs, 1200);
    assert.equal(restored.failureIndex[0].processingMode, 'assisted');
    assert.deepEqual(restored.failures[0].timeline.entries.map(item => item.stage), ['images', 'verification', 'save-draft']);
    assert.doesNotMatch(JSON.stringify(restored), /PRIVATE_|private\.example|cookie|password/);
    assert.equal(diagnosticStage('等待人工验证：产品图片'), 'verification');
    assert.equal(diagnosticStage('正在保存草稿'), 'save-draft');
    assert.equal(diagnosticStage('属性值校验'), 'attributes');
    const oversized = sanitizeDiagnosticFailure({ timeline: { totalMs: Infinity,
      entries: Array.from({ length: 121 }, () => ({ stage: 'PRIVATE_STAGE', durationMs: -1, outcome: 'PRIVATE_OUTCOME' })) } });
    assert.equal(oversized.timeline.entries.length, 120);
    assert.equal(oversized.timeline.totalMs, 0);
    assert.equal(oversized.timeline.truncated, true);
    assert.equal(oversized.truncation.timeline, true);
    assert.doesNotMatch(JSON.stringify(oversized), /PRIVATE_/);
    assert.deepEqual(sanitizeDiagnosticReport(restored), restored);
  } finally { f.close(); }
});

test('failure evidence redacts model credentials and tokens at truncation boundaries', () => {
  assert.doesNotMatch(diagnosticText('x'.repeat(15) + ' sk-privatecredential0123456789', 30), /sk-|private/);
  assert.doesNotMatch(diagnosticText('apiKey=PRIVATE_API_KEY'), /PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(diagnosticData({ apiKey: 'PRIVATE_API_KEY', privateKey: 'PRIVATE_KEY', token: 'PRIVATE_TOKEN',
    details: { bearer: 'Bearer PRIVATE_BEARER', message: 'token=PRIVATE_MESSAGE' }, price: 12 })), /PRIVATE_/);
});

test('gallery mapping repeats cannot crowd out FAQ evidence in the same leaf category', () => {
  const f = fixture();
  try {
    const stages = ['faq-source', 'gallery-schema', ...Array(6).fill('gallery-mapping')];
    stages.forEach((stage, index) => {
      f.store.write({ product: { id: `detail-${index}` }, targetCategoryId: '201', mode: 'submit', processingMode: 'rules',
        stage: '检查新版详情：商品卖点、公司介绍和 FAQ',
        error: { code: 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH', diagnostics: { stage } } });
      const file = fs.readdirSync(f.directory).map(name => path.join(f.directory, name))
        .find(file => JSON.parse(fs.readFileSync(file)).product.id === `detail-${index}`);
      const time = new Date(Date.now() - 10000 + index * 1000);
      fs.utimesSync(file, time, time);
    });
    const result = f.store.read();
    assert.equal(result.failures.length, 5);
    assert.deepEqual(new Set(result.failures.map(item => item.error.diagnostics.stage)), new Set(['faq-source', 'gallery-schema', 'gallery-mapping']));
    assert.equal(result.failureIndex.length, 8);
  } finally { f.close(); }
});

test('new failures across five categories reserve evidence for an older distinct FAQ cause', () => {
  const f = fixture();
  try {
    const cases = [
      ['201', 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH', 'faq-source', '检查新版详情'],
      ['202', 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH', 'gallery-mapping', '检查新版详情'],
      ['203', 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH', 'gallery-mapping', '检查新版详情'],
      ['204', 'PUBLISH_PAGE_INCOMPLETE', '', '准备上传详情图片'],
      ['205', 'PUBLISH_PAGE_INCOMPLETE', '', '准备上传详情图片'],
      ['206', 'PUBLISH_PAGE_INCOMPLETE', '', '准备上传详情图片'],
    ];
    cases.forEach(([targetCategoryId, code, stage, progress], index) => {
      f.store.write({ product: { id: `cross-${index}` }, targetCategoryId, mode: 'draft', processingMode: 'rules', stage: progress,
        error: { code, diagnostics: { stage } } });
      const file = fs.readdirSync(f.directory).map(name => path.join(f.directory, name))
        .find(file => JSON.parse(fs.readFileSync(file)).product.id === `cross-${index}`);
      const time = new Date(Date.now() - 10000 + index * 1000); fs.utimesSync(file, time, time);
    });
    const result = f.store.read();
    assert.equal(result.failures.length, 5);
    assert.ok(result.failures.some(item => item.product.id === 'cross-0'));
    assert.equal(result.failures[0].product.id, 'cross-5');
    assert.equal(result.failureIndex.length, 6);
  } finally { f.close(); }
});
