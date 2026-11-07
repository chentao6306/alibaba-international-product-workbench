// Read a locally saved customer report; emit counts only, never source content.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { preparePublishProduct } from '../server/publisher.js';
import { currentDescriptionStructure } from '../server/description-structure.js';
import { compileNativeDescription, requireNativeDescriptionFields } from '../server/native-description-fields.js';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = input.report || input;
const matches = (report.failures || []).filter(f => /无法唯一匹配图集“”/.test(f.error?.message || ''));
assert.ok(matches.length, 'Report must contain the unnamed gallery failure');
const results = [];
for (const failure of matches) {
  const original = structuredClone(failure.product);
  const prepared = preparePublishProduct(failure.product);
  const structure = currentDescriptionStructure(prepared);
  const names = ['Scene image', 'Detail shot', 'Other product images', 'Company overview', 'Competitive advantages',
    'Factory profile', 'Customization capabilities', 'Production workflow', 'Trade show participation',
    'Packaging & shipping specifications', 'Extended company profile'];
  const fields = (failure.page?.fields || []).filter(f => f.type === 'checkbox' && f.id === f.value && /^\d{3}$/.test(f.id));
  assert.equal(fields.length, names.length, 'Unrecognized captured gallery controls');
  let position = -1;
  for (const name of names) {
    const next = failure.page.text.indexOf(name, position + 1);
    assert.ok(next > position, 'Captured gallery labels must match control order');
    position = next;
  }
  const options = fields.map((f, i) => ({ value: f.value, enName: names[i], disabled: f.disabled }));
  // Text limits here are a test fixture, not a claim that the log captured
  // Json component props. Actual publishing still reads the live schema.
  const schemas = { textDesc: { maxLength: 2000 }, companyDesc: { maxLength: 2000 },
    companyFaqDesc: { maxItem: 10, questionLength: 150, answerLength: 1000 },
    detailImage: { maxImageItem: 30, dataSource: options.slice(0, 3) },
    companyImage: { maxImageItem: 30, dataSource: options.slice(3) } };
  const plan = compileNativeDescription(structure, schemas);
  assert.deepEqual(plan.galleries.flatMap(g => g.images.map(i => i.url)), prepared.detailImages);
  const stored = { textDesc: plan.textDesc, companyDesc: plan.companyDesc, companyFaqDesc: plan.companyFaqDesc,
    detailImage: [], companyImage: [] };
  for (const group of plan.galleries) {
    group.urls = group.images.map(i => i.url);
    stored[group.rootId].push({ value: group.value, enName: group.name, imageList: group.urls.map(imgURL => ({ imgURL })) });
  }
  requireNativeDescriptionFields(plan, stored);
  assert.equal(plan.galleries.at(-1).name, 'Extended company profile');
  assert.deepEqual(failure.product, original);
  assert.equal(plan.companyDesc, structure.modules.find(m => m.type === 'company').text);
  results.push({ images: prepared.detailImages.length, galleries: plan.galleries.length, faq: plan.companyFaqDesc.length,
    productImages: stored.detailImage.flatMap(g => g.imageList).length,
    companyImages: stored.companyImage.flatMap(g => g.imageList).length,
    editedCompanyTextPreserved: true, originalUnchanged: true });
}
console.log(JSON.stringify({ ok: true, clientVersion: report.appVersion, cases: results,
  scope: 'offline compile and readback contract using captured option order; no live publication' }));
