import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReferencePatch, previewProductReference, applyReferencePreview, failedPublishProducts, referenceCandidates } from '../server/reference-workflow.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { postingPageProblem } from '../server/posting-readiness.js';

function fixture() {
  const target = syncProductModel({ id: 'target', status: 'publish_failed', title: 'Early learning book', price: 12, stock: 0,
    categoryId: '201776003', categoryPath: ['Toys', 'Books'], attributes: [{ name: 'Type', value: 'Audio Books' }],
    variantGroups: [{ name: '颜色', options: ['Yellow'] }], skus: [{ attributes: { 颜色: 'Yellow' }, stock: 0, code: 'BOOK', enabled: false }],
    publishResult: { status: 'failed', message: '属性[Type] 必须填写', requiredFields: ['Type'] },
  }, { captureSource: true });
  const reference = { id: 'ref', status: 'published', title: 'Drone part', categoryId: '201346401', categoryPath: ['Drones Accessories'],
    attributes: [{ name: 'Type', value: 'FPV VTX' }, { name: 'Logo printing', value: 'No' }], model: '5.8G 3W',
    variantGroups: [{ name: 'Color', options: ['Yellow'] }], skus: [{ attributes: { Color: 'Yellow' }, stock: 99, code: 'REF', price: 90 }], packaging: { weight: 5 } };
  return { products: [target, reference], jobs: [] };
}

test('previews category and model changes, preserves source and target commercial data, and freezes reference', () => {
  const state = fixture(), source = structuredClone(state.products[0].source);
  const request = { ids: ['target', 'ref'], referenceId: 'ref' };
  const preview = previewProductReference(state, request);
  assert.equal(preview.items[0].categoryChanged, true);
  assert.ok(preview.items[0].changes.some((item) => item.field === 'model' && item.after === '5.8G 3W'));
  assert.ok(preview.items[1].skipped);
  assert.equal(state.products[0].categoryId, '201776003', 'Preview does not mutate');
  assert.equal(applyReferencePreview(state, { ...request, previewToken: preview.token }).changed.length, 1);
  const target = state.products[0];
  assert.equal(target.title, 'Early learning book'); assert.equal(target.price, 12);
  assert.deepEqual(target.skus.map(({ stock, code, enabled, price }) => ({ stock, code, enabled, price })), [{ stock: 0, code: 'BOOK', enabled: false, price: 12 }]);
  assert.equal(target.packaging, undefined);
  assert.equal(target.referenceRecovery.failure.requiredFields[0], 'Type');
  assert.equal(target.publishResult, undefined); assert.equal(target.status, 'ready');
  assert.deepEqual(target.source, source); assert.equal(verifySourceIntegrity(target).valid, true);
  state.products[1].attributes[0].value = 'Changed later';
  assert.equal(target.categoryReference.template.attributes[0].value, 'FPV VTX');
  assert.deepEqual(failedPublishProducts(state.products).map((item) => item.id), ['target']);
});

test('rejects stale previews, active jobs, missing products and cross-category partial references', () => {
  const state = fixture(), request = { ids: ['target'], referenceId: 'ref' };
  const preview = previewProductReference(state, request);
  state.products[0].price = 15;
  assert.throws(() => applyReferencePreview(state, { ...request, previewToken: preview.token }), { status: 409 });
  assert.throws(() => previewProductReference(state, { ...request, ids: ['missing'] }), { status: 409 });
  assert.throws(() => previewProductReference(state, { ...request, options: { scope: 'attributes' } }), /相同类目/);
  state.jobs = [{ type: 'publish', status: 'running', metadata: { productIds: ['target'] } }];
  assert.throws(() => previewProductReference(state, request), { status: 409 });
});

test('limits attribute and specification references to the selected sections and repairs false values', () => {
  const state = fixture(), [target, reference] = state.products;
  target.categoryId = reference.categoryId; reference.attributes[1].value = false;
  const attrs = buildReferencePatch(target, reference, { scope: 'attributes' });
  assert.equal(attrs.variantGroups, undefined); assert.equal(attrs.categoryId, undefined);
  assert.equal(attrs.attributes.find((item) => item.name === 'Logo printing').value, false);
  const specs = buildReferencePatch(target, reference, { scope: 'specifications' });
  assert.equal(specs.attributes, undefined); assert.equal(specs.origin, undefined); assert.equal(specs.categoryId, undefined);
  target.publishResult.requiredFields = ['Logo印刷'];
  const repair = buildReferencePatch(target, reference, { scope: 'failed-fields' });
  assert.equal(repair.attributes.find((item) => item.name === 'Logo印刷').value, false);
  assert.equal(repair.attributes[0].value, 'Audio Books'); assert.equal(repair.variantGroups, undefined);
});

test('uses successful snapshots and distinguishes saved seller templates from successful listings', () => {
  const state = fixture();
  state.products[1].publishHistory = [{ result: { status: 'published' }, categoryId: '201346401', data: { attributes: [{ name: 'Type', value: 'Accepted' }] } }];
  state.referenceTemplates = [{ id: 'seller-1', title: 'Seller form', referenceTemplate: { id: 'seller-1', categoryId: '201776003' } }];
  const candidates = referenceCandidates(state);
  assert.equal(candidates[0].template.attributes[0].value, 'Accepted');
  assert.equal(candidates[1].source, 'seller');
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm', '当前商品类目不在线上经营类目范围内，无法发品').code, 'PUBLISH_CATEGORY_NOT_AUTHORIZED');
});

test('repairs a rejected single specification consistently while refusing to collapse multiple SKUs', () => {
  const [target, reference] = fixture().products;
  target.categoryId = reference.categoryId;
  target.variantGroups = [{ name: 'Type', options: ['Old'], optionIds: { Old: '1' } }];
  target.skus = [{ attributes: { Type: 'Old' }, price: 12, stock: 3, code: 'BOOK' }];
  const patch = buildReferencePatch(target, reference, { scope: 'failed-fields' });
  assert.deepEqual(patch.variantGroups[0].options, ['FPV VTX']);
  assert.deepEqual(patch.skus[0], { attributes: { Type: 'FPV VTX' }, price: 12, stock: 3, code: 'BOOK' });
  target.variantGroups[0].options.push('Another');
  assert.deepEqual(buildReferencePatch(target, reference, { scope: 'failed-fields' }), {});
});
