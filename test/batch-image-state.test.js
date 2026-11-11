import test from 'node:test';
import assert from 'node:assert/strict';
import { imageUndoEntry, appendImageUndo, undoImageEntry, replaceImageTargets, UNDO_STEP_LIMIT } from '../src/batch-image-state.js';

const products = () => Array.from({ length: 2000 }, (_, i) => ({ id: String(i), revision: `revision-${i}`, sourceImages: { mainImages: [`source-${i}`] }, mainImages: [`main-${i}`], detailImages: Array.from({ length: 30 }, (_, n) => `detail-${i}-${n}`) }));

test('undo of one product retains only its changed image list across thousands of products', () => {
  const before = products(), after = before.map((p) => p.id === '1999' ? { ...p, detailImages: p.detailImages.slice(0, -1) } : p);
  const entry = imageUndoEntry(before, after);
  assert.equal(entry.patches.length, 1);
  assert.deepEqual(Object.keys(entry.patches[0]).sort(), ['detailImages', 'id']);
  assert.equal(entry.patches[0].detailImages, before[1999].detailImages);
  const restored = undoImageEntry(after, entry);
  assert.deepEqual(restored, before);
  assert.equal(restored[0], before[0]);
  assert.equal(restored[1999].sourceImages, before[1999].sourceImages);
  assert.equal(restored[1999].revision, 'revision-1999');
});

test('undo history obeys a memory budget and never crosses an uncached operation', () => {
  const small = { patches: [{ id: '1', mainImages: ['original'] }], bytes: 100 };
  let history = [];
  for (let i = 0; i < 100; i++) history = appendImageUndo(history, small);
  assert.equal(history.length, UNDO_STEP_LIMIT);
  history = appendImageUndo(history, small, 250);
  assert.equal(history.length, 2);
  assert.deepEqual(appendImageUndo(history, { patches: small.patches, bytes: 251 }, 250), []);
  assert.equal(appendImageUndo(history, { patches: [], bytes: 0 }), history);
});

test('mixed transformation results update the exact product and slot without cloning all lists', () => {
  const before = products();
  const after = replaceImageTargets(before, [
    { target: { id: '1999', key: 'detailImages', index: 29, url: 'detail-1999-29' }, result: { url: 'repaired' } },
    { target: { id: '1998', key: 'mainImages', index: 0, url: 'main-1998' }, error: 'unavailable' },
    { target: { id: '0', key: 'mainImages', index: 0, url: 'main-0' }, result: { url: 'main-0' } },
  ]);
  assert.equal(after[1999].detailImages[29], 'repaired');
  assert.equal(before[1999].detailImages[29], 'detail-1999-29');
  assert.equal(after[1999].mainImages, before[1999].mainImages);
  assert.equal(after[1998], before[1998]);
  assert.equal(after[0], before[0]);
});
