import test from 'node:test';
import assert from 'node:assert/strict';
import { previewProductReference, applyReferencePreview } from '../server/reference-workflow.js';
import { sourceDetailHasBrokenImages } from '../server/publisher.js';

function fixture(count) {
  const reference = { id: 'reference', title: 'Accepted reference', status: 'published', categoryId: '201346401',
    attributes: [{ name: 'Material', value: 'ABS' }], origin: 'China' };
  return { jobs: [], products: [reference, ...Array.from({ length: count }, (_, index) => ({
    id: `target-${index}`, title: `Unchanged title ${index}`, status: 'publish_failed', categoryId: '201346401',
    price: index + 1, stock: 12, attributes: [{ name: 'Material', value: 'Aluminum' }],
    source: { snapshot: { title: `Original ${index}` } },
  }))] };
}
const requestFor = state => ({ ids: state.products.slice(1).map(product => product.id), referenceId: 'reference', options: { scope: 'attributes' } });

test('previews 1886 reference targets in bounded pages and binds edits outside the visible page', () => {
  const state = fixture(1886), request = requestFor(state);
  const first = previewProductReference(state, request);
  assert.equal(first.items.length, 30);
  assert.equal(first.total, 1886);
  assert.equal(first.totalChanged, 1886);
  const last = previewProductReference(state, { ...request, page: 63 });
  assert.equal(last.items.length, 26);
  assert.equal(last.items.at(-1).id, 'target-1885');
  assert.equal(last.token, first.token);
  state.products.at(-1).title = 'Edited on another page';
  assert.throws(() => applyReferencePreview(state, { ...request, previewToken: first.token }), { status: 409 });
  assert.equal(state.products[1].attributes[0].value, 'Aluminum');
  const fresh = previewProductReference(state, request);
  const saved = applyReferencePreview(state, { ...request, previewToken: fresh.token, page: 1, pageSize: 1 });
  assert.equal(saved.changed.length, 1886, 'Saving applies all reviewed IDs, not only the preview page');
  for (const product of state.products.slice(1)) {
    assert.equal(product.attributes.find(item => item.name === 'Material').value, 'ABS');
    assert.equal(product.stock, 12);
    assert.ok(product.price > 0);
    assert.match(product.source.snapshot.title, /^Original /);
  }
});

test('reference review hashes over 512 MB of source history without creating one giant string', () => {
  const state = fixture(1886), request = requestFor(state);
  // Shared immutable strings simulate actual content volume without requiring
  // the test to retain hundreds of megabytes of duplicated fixture storage.
  const capture = 'x'.repeat(160 * 1024);
  for (const product of state.products.slice(1)) product.source.snapshot.html = capture;
  const previousSerializedContentBytes = 2 * capture.length * request.ids.length;
  assert.ok(previousSerializedContentBytes > 512 * 1024 * 1024);
  const preview = previewProductReference(state, request);
  assert.equal(preview.totalChanged, 1886);
  assert.match(preview.token, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 1024 * 1024);
  assert.equal(state.products.at(-1).source.snapshot.html, capture);
});

test('legacy reference edits retain the original values and store only changed fields in edit history', () => {
  const state = fixture(1), request = requestFor(state), product = state.products[1];
  delete product.source;
  product.descriptionHtml = '<p>Existing unmodified long description</p>';
  const preview = previewProductReference(state, request);
  assert.equal(product.source, undefined, 'A read-only preview must not migrate or edit the product');
  applyReferencePreview(state, { ...request, previewToken: preview.token });
  assert.equal(product.source.snapshot.attributes[0].value, 'Aluminum');
  assert.equal(product.attributes[0].value, 'ABS');
  assert.equal(product.source.snapshot.descriptionHtml, product.descriptionHtml);
  assert.equal(product.auditTrail[0].format, 'changed-fields');
  assert.equal(product.auditTrail[0].before.attributes[0].value, 'Aluminum');
  assert.equal(product.auditTrail[0].after.attributes[0].value, 'ABS');
  assert.equal(product.auditTrail[0].before.descriptionHtml, undefined);
  assert.equal(product.auditTrail[0].after.descriptionHtml, undefined);
});

test('warranty prose cannot mark detail images broken while real empty placeholders still fail', () => {
  assert.equal(sourceDetailHasBrokenImages('<p>365 days guarantee. Already used or broken, no guarantee.</p><img src="https://example.test/photo.jpg">'), false);
  assert.equal(sourceDetailHasBrokenImages('<p>图片失效请联系我们，image not found support.</p>'), false);
  assert.equal(sourceDetailHasBrokenImages('<img src="https://example.test/broken-case.jpg" alt="broken">'), false);
  assert.equal(sourceDetailHasBrokenImages('<img src="about:blank" data-src="https://example.test/photo.jpg">'), false);
  assert.equal(sourceDetailHasBrokenImages('<img src="about:blank">'), true);
  assert.equal(sourceDetailHasBrokenImages('<img>'), true);
});
