import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { cleanupWorkspace } from '../server/storage-cleanup.js';
import { applyPublishedProductReference } from '../server/product-model.js';
import { licenseState, clientAllowed, pagination, announcementInput } from '../auth-server/policy.js';
import { AnnouncementInbox } from '../server/announcements.js';

test('cross-category missing-field references fill partial packaging without replacing identity or variants', () => {
  const target = { categoryId: 'phone', title: 'My phone', price: 12, currencySymbol: '$', packaging: { length: 20, weight: 0 }, origin: '', attributes: [{ name: 'Color', value: 'Red' }], skus: [{ id: 'one', price: 12 }], mainImages: ['mine.jpg'] };
  const reference = { categoryId: 'headphones', title: 'Reference', price: 99, origin: 'China', packaging: { length: 30, width: 15, height: 8, weight: 1 }, attributes: [{ name: 'Color', value: 'Black' }], skus: [{ id: 'ref', price: 99 }] };
  const before = structuredClone(target);
  const patch = applyPublishedProductReference(target, reference, { preserveCategory: true, onlyMissing: true });
  assert.deepEqual(patch.packaging, { length: 20, width: 15, height: 8, weight: 1 });
  assert.equal(patch.origin, 'China'); assert.equal(patch.attributes[0].value, 'Red');
  for (const field of ['categoryId', 'title', 'price', 'skus', 'mainImages']) assert.equal(patch[field], undefined);
  assert.deepEqual(target, before);
});

test('cleanup requires explicit scopes and confirmation, blocks unfinished work and preserves credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    fs.mkdirSync(path.join(root, 'publish-images')); fs.writeFileSync(path.join(root, 'publish-images', 'cache.jpg'), 'image');
    fs.writeFileSync(path.join(root, 'cookies.json'), 'session');
    store.update((s) => { s.products = [{ id: 'p', mainImages: ['/media/image.jpg'] }]; });
    assert.throws(() => cleanupWorkspace(store, root, { scopes: ['images'] }), /确认/);
    assert.throws(() => cleanupWorkspace(store, root, { confirm: true, scopes: ['../'] }), /确认/);
    assert.throws(() => cleanupWorkspace(store, root, { confirm: true, scopes: ['media'] }), /引用/);
    store.update((s) => { s.jobs = [{ status: 'paused' }]; });
    assert.throws(() => cleanupWorkspace(store, root, { confirm: true, scopes: ['images'] }), /任务/);
    store.update((s) => { s.jobs = []; });
    cleanupWorkspace(store, root, { confirm: true, scopes: ['images'] });
    assert.equal(store.read().products.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(root, 'publish-images')), []);
    cleanupWorkspace(store, root, { confirm: true, scopes: ['products', 'media'] });
    assert.equal(store.read().products.length, 0);
    assert.equal(fs.readFileSync(path.join(root, 'cookies.json'), 'utf8'), 'session');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cleanup refuses directory links pointing outside its storage root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-outside-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, path.join(root, 'publish-images'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanupWorkspace(store, root, { confirm: true, scopes: ['images'] }), /目录异常/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('multi-device authorization still enforces expiration and suspension', () => {
  const license = { status: 'active', expires_at: '2030-01-01', allow_multi_device: true, active_device_id: 'A' };
  assert.equal(clientAllowed(license, 'B'), true);
  assert.equal(clientAllowed({ ...license, allow_multi_device: false }, 'B'), false);
  assert.equal(clientAllowed({ ...license, allow_multi_device: false }, 'A'), true);
  assert.equal(clientAllowed({ ...license, status: 'paused' }, 'A'), false);
  assert.equal(licenseState({ ...license, expires_at: '2020-01-01' }), 'expired');
  assert.equal(clientAllowed({ ...license, expires_at: '2020-01-01' }, 'A'), false);
  assert.deepEqual(pagination({ page: -10, pageSize: 500000 }), { page: 1, pageSize: 20, offset: 0 });
  assert.throws(() => announcementInput({ title: 'Title', content: 'Text', kind: 'code' }));
});

test('announcement read receipts persist per account and apply only to the displayed revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'announcement-test-'));
  try {
    const file = path.join(root, 'reads.json');
    const a = new AnnouncementInbox(file, 'http://localhost', 'account-a');
    const b = new AnnouncementInbox(file, 'http://localhost', 'account-b');
    a.items = [{ id: '1', revision: 2 }]; b.items = a.items;
    assert.throws(() => a.markRead('1', 1), /公告已更新/);
    a.markRead('1', 2);
    assert.deepEqual(a.readState(), { 'account-a': { 1: 2 } });
    b.markRead('1', 2);
    assert.deepEqual(b.readState(), { 'account-a': { 1: 2 }, 'account-b': { 1: 2 } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
