import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryChangePatch } from '../server/product-edit.js';

const product = () => ({ categoryId: '201774004', categoryReference: { categoryId: '201774004' },
  attributes: [{ id: '7', valueId: '8', propertyId: '7', name: 'Material', value: ['Cotton'] }],
  variantGroups: [{ attributeId: '9', optionIds: { Pink: '10' }, name: 'Color', options: ['Pink'], optionImages: { Pink: 'pink.jpg' } }],
  skus: [{ id: 'sku-1', attributes: { Color: 'Pink' }, code: 'KEEP', price: 5, stock: 0 }],
  images: ['pink.jpg'], price: 5, stock: 0, source: { snapshot: { categoryId: '201774004' } },
});

test('explicit category changes drop stale bindings without touching source, SKU or property text', () => {
  const original = product(), before = structuredClone(original);
  const patch = categoryChangePatch(original, { categoryId: '135', categoryPath: ['Agriculture', 'Other Agriculture Products'] });
  const next = { ...original, ...patch };
  assert.equal(next.categoryReference, null);
  assert.equal(next.targetCategoryId, null);
  assert.deepEqual(next.attributes, [{ name: 'Material', value: ['Cotton'] }]);
  assert.deepEqual(next.variantGroups, [{ name: 'Color', options: ['Pink'], optionImages: { Pink: 'pink.jpg' } }]);
  for (const key of ['skus', 'images', 'price', 'stock', 'source']) assert.deepEqual(next[key], before[key]);
  assert.deepEqual(original, before);
});

test('same leaf and ordinary edits retain bindings; category changes use edited attribute text', () => {
  const original = product();
  for (const patch of [{ title: 'Edited' }, { categoryId: original.categoryId }, { categoryPath: ['Translated'] }]) assert.deepEqual(categoryChangePatch(original, patch), patch);
  assert.deepEqual(categoryChangePatch(original, { categoryId: '135', attributes: [{ id: '7', name: 'Material', value: 'Wool' }] }).attributes, [{ name: 'Material', value: 'Wool' }]);
  assert.deepEqual(categoryChangePatch({}, { categoryId: '135' }).attributes, undefined);
});
