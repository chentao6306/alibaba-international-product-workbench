import test from 'node:test';
import assert from 'node:assert/strict';
import { changeEditorCategory, createEditorForm, editorPayload, editAttribute, editorAttributeRows, rebuildEditorSkus, updateDeliveryCell, labelOf } from '../src/product-editor-model.js';

test('shows collected values in Chinese requirement rows without creating empty translated duplicates', () => {
  const form = createEditorForm({ attributes: [{ name: 'Estimated Battery Life', value: '3-5 hours' }, { name: 'Novel Widget Feature', value: 'Original' }] });
  const rows = editorAttributeRows(form, [{ id: '400013808', label: '预计电池续航时间', required: true }, { id: '900', label: '新类目属性', labels: ['新类目属性', 'Novel Widget Feature'], required: true }]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.descriptor?.id === '400013808').item.value, '3-5 hours');
  assert.equal(rows.find(row => row.descriptor?.id === '900').item.value, 'Original');
  assert.equal(labelOf('noise cancelling'), '降噪');
  assert.equal(labelOf('touch screen'), '触摸屏');
  assert.equal(form.attributes[0].name, 'Estimated Battery Life');
});
import { previewProductReference, applyReferencePreview } from '../server/reference-workflow.js';
import { productEditPatch } from '../server/product-edit.js';

const product = () => ({ id: 'target', status: 'publish_failed', title: 'Propeller', sourcePlatform: 'alibaba.com', categoryId: '201346401',
  price: 3.5, stock: 0, moq: 2, attributes: [{ id: '2', name: 'Brand Name', value: 'GWRC', valueId: 'old-brand' }, { name: 'Material', value: ['Plastic'] }],
  priceTiers: [{ minQuantity: 2, price: 3.5 }, { minQuantity: 500, price: 2.9 }],
  deliveryTime: [['Quantity', '1 - 500', '501 - 2000', '> 2000'], ['Lead time', '7', '15', 'To be negotiated']],
  videos: [{ role: 'main', url: 'https://example.com/main.mp4', poster: 'main.jpg' }, { role: 'detail', url: 'https://example.com/detail.mp4' }],
  packaging: { weight: '0.010', length: 7, width: 7, height: 3.5, unknownSourceField: 'keep' }, services: { customizations: [{ name: 'Packaging', minimum: 500 }] },
  structuredDescription: { html: '<p>Original</p>', modules: [{ type: 'custom', data: 'preserve' }] },
  variantGroups: [{ name: 'Color', options: ['Black'], optionImages: { Black: 'black.jpg' } }],
  skus: [{ attributes: { Color: 'Black' }, code: 'KEEP', stock: 0, price: 2.9, enabled: false, image: 'black.jpg' }],
  publishResult: { status: 'failed', requiredFields: ['Brand Name'], message: 'Brand missing' } });

test('schema attributes keep row identity and order while optional and required values are first entered', () => {
  let form = createEditorForm(product());
  const before = structuredClone(form);
  const fields = [{ id: 'application', label: '应用领域', required: true }, { id: 'notes', label: '使用说明', required: false }];
  const rows = editorAttributeRows(form, fields);
  assert.deepEqual(form, before, 'displaying missing fields does not modify the saved payload');
  const notes = rows.find((row) => row.descriptor?.id === 'notes');
  form = editAttribute(form, notes.index, { ...notes.item, value: 'Indoor use only' });
  assert.deepEqual(editorAttributeRows(form, fields).map((row) => row.key), rows.map((row) => row.key));
  const application = editorAttributeRows(form, fields).find((row) => row.descriptor?.id === 'application');
  form = editAttribute(form, application.index, { ...application.item, value: 'Christmas decorations' });
  assert.deepEqual(editorAttributeRows(form, fields).map((row) => row.key), rows.map((row) => row.key));
  assert.equal(editorPayload(form).attributes.find((item) => item.id === 'application').value, 'Christmas decorations');
  assert.equal(editorPayload(form).attributes.find((item) => item.id === 'notes').value, 'Indoor use only');
});

test('schema rows use property IDs before translated names without merging distinct same-name properties', () => {
  const form = { attributes: [{ id: 'a', name: 'Function', value: 'one' }, { id: 'b', name: 'Function', value: 'two' }, { name: 'Brand Name', value: 'Own' }] };
  const fields = [{ id: 'b', label: '功能', options: ['two', 'three'] }, { id: 'a', label: '功能' }, { id: 'brand', label: '品牌名称' }];
  const rows = editorAttributeRows(form, fields);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.descriptor.id === 'a').item.value, 'one');
  assert.equal(rows.find((row) => row.descriptor.id === 'b').item.value, 'two');
  assert.equal(rows.find((row) => row.descriptor.id === 'brand').item.value, 'Own');
});

test('editing a title preserves collected multi-values, prices, delivery ranges, structured data and video roles', () => {
  const original = product(), source = structuredClone(original);
  const form = createEditorForm(original); form.title = 'Edited propeller';
  const patch = editorPayload(form);
  for (const field of ['attributes', 'priceTiers', 'deliveryTime', 'packaging', 'services', 'videos', 'structuredDescription', 'skus']) assert.deepEqual(patch[field], original[field], field);
  assert.equal(patch.stock, 0); assert.equal(patch.videoUrl, original.videos[0].url);
  assert.deepEqual(original, source);
  assert.equal(productEditPatch({ source: { secret: 1 }, status: 'published', title: 'Allowed' }).status, undefined);
});

test('editing an attribute clears stale value IDs and synchronizes brand without losing Other text', () => {
  let form = createEditorForm(product());
  form = editAttribute(form, 0, { ...form.attributes[0], value: 'Other' });
  assert.equal(form.brand, 'Other'); assert.equal(form.brandName, 'Other');
  assert.equal(form.attributes[0].id, '2'); assert.equal(form.attributes[0].valueId, undefined);
  form = editAttribute(form, 0, { ...form.attributes[0], value: 'PUSD' });
  assert.equal(editorPayload(form).attributes[0].value, 'PUSD');
  const delivery = updateDeliveryCell(form.deliveryTime, 1, 1, '20');
  assert.deepEqual(delivery[0], form.deliveryTime[0]); assert.equal(delivery[1][1], '7'); assert.equal(delivery[1][2], '20'); assert.equal(delivery[1][3], 'To be negotiated');
});

test('changing specification combinations retains only matching SKU commercial values and correctly binds model images', () => {
  const form = createEditorForm(product());
  let next = rebuildEditorSkus(form, [{ ...form.variantGroups[0], options: ['Black', 'White'] }]);
  assert.equal(next.skus[0].code, 'KEEP'); assert.equal(next.skus[0].stock, 0); assert.equal(next.skus[0].enabled, false); assert.equal(next.skus[0].price, 2.9);
  assert.equal(next.skus[1].code, ''); assert.equal(next.skus[1].stock, 0); assert.equal(next.skus[1].price, 3.5);
  next = rebuildEditorSkus(form, [{ name: 'Compatible Model', options: ['Other'] }, { name: 'Model Number', options: ['5.8G 3W'], optionImages: { '5.8G 3W': 'vtx.jpg' } }]);
  assert.deepEqual(next.colorImages, {}); assert.deepEqual(next.modelImages, { '5.8G 3W': 'vtx.jpg' }); assert.equal(next.skus[0].image, 'vtx.jpg');
  assert.throws(() => rebuildEditorSkus(form, [{ name: 'Color', options: ['Black'] }, { name: '颜色', options: ['Red'] }]), /重复/);
  const removedImage = rebuildEditorSkus(form, [{ ...form.variantGroups[0], optionImages: { Black: '' } }]);
  assert.equal(removedImage.skus[0].image, '');
  const removed = rebuildEditorSkus({ ...form, color: 'Black', variantGroups: [], attributes: [{ name: 'Color', value: 'Black' }] }, []);
  assert.equal(removed.color, ''); assert.deepEqual(removed.attributes, []);
});

test('changing the leaf drops old property IDs and retains source text for remapping', () => {
  const form = createEditorForm({ ...product(), moq: '2 pieces' });
  const next = changeEditorCategory(form, { id: '201896803', path: 'Electronics >> Smartphones' });
  assert.equal(next.attributes[0].id, undefined); assert.equal(next.attributes[0].valueId, undefined);
  assert.equal(next.attributes[0].value, 'GWRC'); assert.equal(editorPayload(form).moq, 2);
});

test('reference preview uses unsaved edits without mutation and invalidates when saved data changes', () => {
  const state = { products: [product(), { ...product(), id: 'ref', status: 'published', brand: 'PUSD', attributes: [{ name: 'Brand Name', value: 'PUSD' }] }], jobs: [] };
  const editorDraft = editorPayload(createEditorForm(state.products[0])); editorDraft.title = 'Unsaved title'; editorDraft.price = 11;
  const request = { ids: ['target'], referenceId: 'ref', editorDraft };
  const preview = previewProductReference(state, request);
  assert.equal(state.products[0].title, 'Propeller'); assert.equal(preview.items[0].title, 'Unsaved title'); assert.equal(preview.items[0].patch.skus[0].price, 2.9);
  applyReferencePreview(state, { ...request, previewToken: preview.token });
  assert.equal(state.products[0].title, 'Unsaved title'); assert.equal(state.products[0].price, 11); assert.equal(state.products[0].brand, 'PUSD');
  assert.equal(state.products[0].referenceRecovery.failure.message, 'Brand missing');
  const second = previewProductReference(state, request); state.products[0].subtitle = 'Concurrent edit';
  assert.throws(() => applyReferencePreview(state, { ...request, previewToken: second.token }), /重新预览/);
});
