import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPublishedProductReference } from '../server/product-model.js';
import { createPublishedReferenceTemplate, createRequiredFieldRepair } from '../server/publish-reference.js';

test('explicit reference fills missing freight and logistics fields without overwriting existing shipping choices', () => {
  const reference = { id: 'ref', categoryId: '123', packaging: { weight: 2, length: 20, width: 10, height: 5 }, logisticsAttributes: ['普货'], freightTemplate: 'Standard', attributes: [] };
  const target = { packaging: { weight: 1 }, title: 'Target', price: 12 };
  const patch = applyPublishedProductReference(target, reference, { fullTemplate: true });
  assert.deepEqual(patch.logisticsAttributes, ['普货']);
  assert.equal(patch.freightTemplate, 'Standard');
  assert.deepEqual(patch.packaging, { weight: 1, length: 20, width: 10, height: 5 });
  const existing = applyPublishedProductReference({ ...target, logisticsAttributes: ['磁性物质'], freightTemplate: 'Mine' }, reference, { fullTemplate: true });
  assert.equal(existing.logisticsAttributes, undefined);
  assert.equal(existing.freightTemplate, undefined);
  assert.equal(patch.title, undefined); assert.equal(patch.price, undefined);
});

test('reference uses accepted logistics from the successful attempt instead of stale local values', () => {
  const candidate = { id: 'ref', categoryId: '123', logisticsAttributes: ['普货'], packaging: { weight: 999 } };
  const snapshot = { data: { packaging: { weight: 888 } }, result: { status: 'published', acceptedLogistics: {
    packaging: { weight: 0.3, length: 10, width: 5, height: 2 }, logisticsAttributes: ['磁性物质'], freightTemplate: 'Accepted',
  } } };
  const template = createPublishedReferenceTemplate(candidate, snapshot);
  assert.deepEqual(template.packaging, snapshot.result.acceptedLogistics.packaging);
  assert.deepEqual(template.logisticsAttributes, ['磁性物质']);
  assert.equal(template.freightTemplate, 'Accepted');
  assert.equal(candidate.packaging.weight, 999);
});

test('reference attribute repair discards stale value IDs for rejected options', () => {
  const target = { attributes: [{ id: '123', name: 'Type', value: 'Old', valueIds: { Old: 'bad' }, valueId: 'bad' }] };
  const repair = createRequiredFieldRepair(target, { requiredAttributes: [{ name: '类型', value: 'Accepted' }] }, ['类型']);
  assert.equal(repair.patch.attributes[0].value, 'Accepted');
  assert.deepEqual(repair.patch.attributes[0].valueIds, {});
  assert.equal(repair.patch.attributes[0].valueId, undefined);
  assert.equal(target.attributes[0].valueIds.Old, 'bad');
});
