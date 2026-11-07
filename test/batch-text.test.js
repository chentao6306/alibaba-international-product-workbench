import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformTitle, removeKeywordText, batchTextOperations, batchTextPatch } from '../server/batch-text.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { JsonStore } from '../server/store.js';

test('title rules replace every literal occurrence in order before adding prefix and suffix', () => {
  assert.equal(transformTitle('HD H-D HD Shirt', { prefix: 'New ', suffix: ' Sale', replacements: [{ search: 'HD', replacement: 'Harley Davidson' }, { search: 'H-D', replacement: 'Harley Davidson' }] }), 'New Harley Davidson Harley Davidson Harley Davidson Shirt Sale');
  assert.equal(transformTitle('A+B [x] $& A+B', { replacements: [{ search: 'A+B', replacement: '$&' }, { search: '[x]', replacement: '$1' }] }), '$& $1 $& $&');
  assert.equal(transformTitle('HD hd Hd', { replacements: [{ search: 'hd', replacement: 'X' }], caseSensitive: false }), 'X X X');
  assert.equal(transformTitle('HD hd', { replacements: [{ search: 'hd', replacement: 'X' }] }), 'HD X');
  assert.equal(transformTitle('AB', { replacements: [{ search: 'A', replacement: 'B' }, { search: 'B', replacement: 'C' }] }), 'CC');
});

test('keyword deletion removes only specified text and preserves the rest of each phrase across categories', () => {
  const original = ['YINGTAI 2.4 Inch Flip Elderly Cell Phone', 'TaiKaw HD CarPlay TaiKaw', 'INCA Cotton Dress', '  untouched  phrase  ', 'YINGTAI'];
  assert.deepEqual(removeKeywordText(original, { remove: ['YINGTAI', 'TaiKaw', 'INCA'] }), ['2.4 Inch Flip Elderly Cell Phone', 'HD CarPlay', 'Cotton Dress', '  untouched  phrase  ']);
  assert.equal(original[0], 'YINGTAI 2.4 Inch Flip Elderly Cell Phone');
  assert.deepEqual(removeKeywordText(['Logo phone', 'logo dress'], { remove: ['Logo'] }), ['phone', 'logo dress']);
  assert.deepEqual(removeKeywordText(['Logo phone', 'logo dress'], { remove: ['Logo'], caseSensitive: false }), ['phone', 'dress']);
  assert.deepEqual(removeKeywordText(['[logo] phone + phone'], { remove: ['[logo]', '+'] }), ['phone phone']);
  assert.deepEqual(removeKeywordText(undefined, { remove: ['logo'] }), []);
});

test('blank rows are ignored, malformed rules and empty resulting titles are rejected', () => {
  assert.deepEqual(batchTextOperations({ titleReplacements: [{ search: '', replacement: '' }], keywordRemovals: [' ', ''] }), {});
  assert.equal(transformTitle('Phone', { replacements: [{ search: '', replacement: '' }] }), 'Phone');
  for (const operation of [null, [], { replacements: 'bad' }, { replacements: [{ search: '', replacement: 'X' }] }, { replacements: [{ search: 'Phone', replacement: '' }] }, { prefix: 3 }, { caseSensitive: 'false' }]) assert.throws(() => transformTitle('Phone', operation), { status: 400 });
  for (const operation of [null, [], { remove: 'logo' }, { remove: [null] }, { caseSensitive: 'false' }]) assert.throws(() => removeKeywordText(['logo'], operation), { status: 400 });
});

test('keyword deletion applies after explicitly supplied unified keywords and never edits the title', () => {
  const product = { title: 'LOGO Phone', keywords: ['original'] };
  assert.deepEqual(batchTextPatch(product, { keywords: ['LOGO Cotton Shirt'], keywordTransform: { remove: ['LOGO'] } }), { keywords: ['Cotton Shirt'] });
  assert.equal(product.title, 'LOGO Phone');
});

test('batch text API keeps product identity, source snapshots and combined operations and rolls back invalid batches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-text-'));
  process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
  const server = await import('../server/index.js'); const listener = await server.serverReady;
  const store = new JsonStore(path.join(root, 'workspace.json'));
  const call = async (ids, patch) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/products/batch-update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, patch }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const items = ['Phone', 'Cotton Dress', 'Water Pump'].map((title, i) => syncProductModel({ id: String(i), title: `LOGO ${title}`, keywords: [`LOGO ${title}`, 'LOGO'], price: 10, currencySymbol: '$', description: 'Original', categoryId: String(i + 100), textGeneration: { fields: { keywords: { source: 'generated', value: [`LOGO ${title}`, 'LOGO'] } } } }));
    store.update((state) => { state.products = items; });
    const sources = items.map((item) => structuredClone(item.source));
    const response = await call(['2', 'missing', '0'], { titleTransform: { prefix: 'New ', suffix: ' Sale', replacements: [{ search: 'LOGO ', replacement: '' }] }, keywordTransform: { remove: ['LOGO'] }, priceTransform: { percent: 10 }, descriptionPrefix: 'Additional' });
    assert.equal(response.status, 200); assert.equal(response.body.updated, 2);
    const actual = store.read((state) => state.products);
    assert.deepEqual(actual.map((p) => p.title), ['New Phone Sale', 'LOGO Cotton Dress', 'New Water Pump Sale']);
    assert.deepEqual(actual[0].keywords, ['Phone']); assert.deepEqual(actual[2].keywords, ['Water Pump']);
    assert.equal(actual[0].price, '11.00'); assert.equal(actual[0].description, 'Original\nAdditional');
    assert.equal(actual[0].textGeneration.fields.keywords.source, 'manual');
    assert.ok(actual.every((item) => verifySourceIntegrity(item).valid));
    assert.deepEqual(actual.map((item) => item.source), sources);
    const before = fs.readFileSync(path.join(root, 'workspace.json'), 'utf8');
    assert.equal((await call(['0', '1'], { titleTransform: { replacements: [{ search: 'LOGO Cotton Dress', replacement: '' }] } })).status, 400);
    assert.equal(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'), before);
    assert.equal((await call(['2', 'missing', '0'], { title: ['Pump only', 'Missing', 'Phone only'] })).status, 200);
    assert.deepEqual(store.read((state) => state.products.map((p) => p.title)), ['Phone only', 'LOGO Cotton Dress', 'Pump only']);
    store.update((state) => { state.jobs = [{ id: 'busy', type: 'publish', status: 'running', metadata: { productIds: ['0'] } }]; });
    assert.equal((await call(['0', '2'], { keywordTransform: { remove: ['Phone'] } })).status, 409);
    assert.deepEqual(store.read((state) => state.products[0].keywords), ['Phone']);
  } finally { await server.shutdownServer(); fs.rmSync(root, { recursive: true, force: true }); }
});
