import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { syncProductModel, verifySourceIntegrity, recordProductMutation, sourceSnapshotFingerprint } from '../server/product-model.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('upgrades a legacy capture without adding fields to its hashed source or flagging working edits as tampering', () => {
  const snapshot = { sourceId: 'old', title: 'Original', attributes: [{ name: 'Age Range', value: '2 to 4 Years, 5 to 7 years' }], packaging: { weight: 2 } };
  const product = { schemaVersion: 4, title: 'Edited', source: { snapshot: structuredClone(snapshot), snapshotHash: hash(snapshot) } };
  syncProductModel(product);
  recordProductMutation(product, { origin: 'China', logisticsAttributes: ['Seller selected'], stockProvenance: { stock: 'manual' } });
  assert.equal(verifySourceIntegrity(product).valid, true);
  assert.deepEqual(product.source.snapshot, snapshot);
  assert.equal(product.source.snapshotHash, hash(snapshot));
  assert.equal(product.quality.issues.some((issue) => issue.code === 'source.snapshot.tampered'), false);
  product.source.snapshot.packaging.weight = 9;
  product.schemaVersion = 3;
  syncProductModel(product);
  assert.equal(verifySourceIntegrity(product).valid, false);
  assert.equal(product.source.snapshotHash, hash(snapshot));
});

test('retains compatibility with legacy normalized hashes and protects newly captured unknown fields', () => {
  const snapshot = { title: 'Original' };
  const legacy = { source: { snapshot, snapshotHash: sourceSnapshotFingerprint(snapshot) } };
  assert.equal(verifySourceIntegrity(legacy).valid, true);
  const product = syncProductModel({ title: 'New' }, { captureSource: true });
  assert.equal(product.source.snapshotHashVersion, 2);
  product.source.snapshot.extra = 'unexpected source mutation';
  assert.equal(verifySourceIntegrity(product).valid, false);
});
