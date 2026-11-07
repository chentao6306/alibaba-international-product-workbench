// Replay local evidence only. Do not print source contents or credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { preparePublishProduct } from '../server/publisher.js';
import { currentDescriptionStructure, descriptionSourceHash } from '../server/description-structure.js';
import { compileNativeDescription } from '../server/native-description-fields.js';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = input.report || input;
const failures = (report.failures || []).filter(f => f.error?.diagnostics?.stage === 'faq-source'
  || /原 FAQ 的问题或答案不完整/.test(f.error?.message || ''));
assert.ok(failures.length, 'Report must include an incomplete FAQ failure');
const results = [];
for (const failure of failures) {
  assert.ok(failure.source?.structuredDescription);
  const product = { ...structuredClone(failure.product), source: {
    // The report contains a projection of the source snapshot, not its stored
    // integrity metadata. Rebuild that metadata only for this offline fixture.
    snapshot: structuredClone(failure.source), snapshotHashVersion: 2,
    snapshotHash: descriptionSourceHash(JSON.stringify(failure.source)),
  } };
  const before = structuredClone(product);
  const prepared = preparePublishProduct(product);
  const structure = currentDescriptionStructure(prepared);
  const gallery = root => structure.modules.filter(m => m.type === 'gallery' && (m.scope === 'company' ? 'companyImage' : 'detailImage') === root)
    .map((m, i) => ({ value: String(i + 1), enName: m.title || (root === 'companyImage' ? 'Extended company profile' : 'Other product images') }));
  // These limits are fixture values. Production still reads live schemas.
  const plan = compileNativeDescription(structure, {
    textDesc: { maxLength: 2000 }, companyDesc: { maxLength: 2000 },
    companyFaqDesc: { maxItem: 10, questionLength: 150, answerLength: 1000 },
    detailImage: { maxImageItem: 30, dataSource: gallery('detailImage') },
    companyImage: { maxImageItem: 30, dataSource: gallery('companyImage') },
  });
  const original = failure.source.structuredDescription.modules.find(m => m.type === 'faq').items;
  assert.deepEqual(plan.companyFaqDesc, original.map(item => ({ question: item.question, answers: item.answer })));
  assert.equal(plan.companyDesc, failure.product.structuredDescription.modules.find(m => m.type === 'company')?.text || '');
  assert.deepEqual(product, before);
  results.push({ faqCount: plan.companyFaqDesc.length, recoveredRows: structure.repairs.flatMap(r => r.rows),
    imageCount: plan.galleries.reduce((sum, g) => sum + g.images.length, 0),
    editedCompanyPreserved: true, inputUnchanged: true });
}
console.log(JSON.stringify({ ok: true, clientVersion: report.appVersion, cases: results,
  scope: 'offline diagnostic fixture with reconstructed snapshot integrity metadata; not a live platform publication' }));
