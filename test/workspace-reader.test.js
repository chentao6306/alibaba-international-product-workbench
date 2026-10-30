import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWorkspace } from '../server/workspace-reader.js';
import { JsonStore } from '../server/store.js';

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-reader-'));
  try { return fn(path.join(root, 'workspace.json')); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('workspace reads preserve Unicode, nested values and escaped delimiters across every byte boundary', () => fixture(file => {
  const original = { version: 6, products: [{ id: '商品😀', text: '中文🎁 with "quoted", braces [}] and slash \\ \n',
    source: { snapshot: { attributes: [['款式', '男装'], ['Chapter', null]], flags: [true, false], value: -1.23e-10 } } },
    [], {}, null, 0, true, ''], jobs: [], settings: { keep: 'unchanged', escape: '\\"' } };
  const json = JSON.stringify(original, null, 2);
  for (const prefix of ['', '\uFEFF']) {
    fs.writeFileSync(file, prefix + json);
    for (const chunkBytes of [1, 2, 3, 7, 31, 1024]) assert.deepEqual(readWorkspace(file, { chunkBytes }), original);
  }
  fs.writeFileSync(file, '{"same":1,"same":2,"__proto__":{"polluted":true},"escaped":"\\uD83D\\uDE00\\t\\r\\n"}');
  const actual = readWorkspace(file, { chunkBytes: 1 });
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.equal(actual.polluted, undefined);
}));

test('invalid or truncated workspaces never overwrite the durable file or replace the last complete cache', () => fixture(file => {
  const store = new JsonStore(file);
  store.update(state => { state.products = [{ id: 'saved' }]; });
  const previous = store.cachedState;
  for (const source of ['', '{', '{"products":[', '{"products":[{"id":"unfinished', '{"products":[1,]}',
    '{"x":true false}', '{"x":01}', '{"x":undefined}', '{"x":{]}', '{"x":"bad\\x"}', '{"x":1,}', '{}garbage', '[]']) {
    fs.writeFileSync(file, source);
    assert.throws(() => store.read(), { code: 'WORKSPACE_READ_INVALID' });
    assert.equal(store.cachedState, previous);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['workspace.json']);
  }
  fs.writeFileSync(file, JSON.stringify(previous));
  assert.equal(store.read(state => state.products[0].id), 'saved');
}));

test('cold workspace reads use bounded buffers and retain snapshots, history, jobs and settings after saving and reopening', t => fixture(file => {
  const store = new JsonStore(file);
  store.update(state => {
    state.products = Array.from({ length: 80 }, (_, index) => ({ id: String(index), title: `Item ${index}`, description: 'x'.repeat(50000),
      source: { snapshot: { title: '原商品', packaging: { weight: '0.3' } } }, auditTrail: [{ before: { title: 'old' }, after: { title: 'new' } }] }));
    state.jobs = [{ id: 'task', status: 'paused', progress: 18 }];
    state.settings.uploadProductVideos = false;
  });
  const expected = store.read();
  const read = fs.readSync;
  let largest = 0, calls = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, ...args) => { calls++; largest = Math.max(largest, buffer.length); return read(fd, buffer, ...args); });
  const all = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    assert.notEqual(target, file, 'A workspace must not be read into one string');
    return all(target, ...args);
  });
  const reopened = new JsonStore(file);
  assert.deepEqual(reopened.read(), expected);
  assert.ok(calls > 3); assert.ok(largest <= 1024 * 1024);
  reopened.updateProducts(['12'], products => { products[0].price = 19; });
  expected.products[12].price = 19;
  assert.deepEqual(new JsonStore(file).read(), expected);
  const other = new JsonStore(file);
  other.update(state => { state.settings.uploadProductVideos = true; });
  assert.equal(reopened.read(state => state.settings.uploadProductVideos), true);
  t.mock.restoreAll();
}));
