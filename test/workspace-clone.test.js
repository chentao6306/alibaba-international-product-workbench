import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneWorkspaceValue } from '../server/workspace-clone.js';
import { JsonStore } from '../server/store.js';

test('workspace copies detach nested edits and preserve JSON keys, sparse arrays and shared containers', () => {
  const original = JSON.parse('{"__proto__":{"safe":true},"title":"中文 😀","values":[null,false,0,""],"nested":{"values":[1,2]}}');
  original.other = original.nested;
  original.sparse = new Array(3); original.sparse[2] = 'last';
  const copy = cloneWorkspaceValue(original);
  assert.deepEqual(copy, structuredClone(original));
  assert.equal(copy.nested, copy.other);
  assert.notEqual(copy.nested, original.nested);
  copy.nested.values.push(3); copy.__proto__.safe = false;
  assert.deepEqual(original.nested.values, [1, 2]);
  assert.equal(original.__proto__.safe, true);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.throws(() => cloneWorkspaceValue({ callback() {} }), { name: 'DataCloneError' });
  assert.deepEqual(cloneWorkspaceValue({ date: new Date(0), bytes: new Uint8Array([1, 2]) }),
    structuredClone({ date: new Date(0), bytes: new Uint8Array([1, 2]) }));
});

test('retained transaction references and failed edits cannot mutate saved workspace containers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-copy-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    const original = { id: '1', title: 'before', source: { snapshot: { attributes: [{ name: 'Type', value: 'A' }] } } };
    let retained;
    store.update(state => { state.products.push(original); retained = state; });
    original.source.snapshot.attributes[0].value = 'external';
    retained.products[0].title = 'external';
    const read = store.read(); read.products[0].source.snapshot.attributes.push({ name: 'Injected' });
    assert.throws(() => store.update(state => { state.products[0].title = 'failed'; throw new Error('Abort'); }), /Abort/);
    assert.equal(store.read(state => state.products[0].title), 'before');
    assert.deepEqual(store.read(state => state.products[0].source.snapshot.attributes), [{ name: 'Type', value: 'A' }]);
    const output = store.updateProducts(['1'], products => {
      retained = products[0]; products[0].title = 'saved'; return products[0];
    });
    output.source.snapshot.attributes[0].value = 'changed'; retained.title = 'external';
    assert.equal(store.read(state => state.products[0].title), 'saved');
    assert.deepEqual(new JsonStore(store.filePath).read(), store.read());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
