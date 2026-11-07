import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { createBackgroundTasks } from '../server/background-tasks.js';

test('a full disk preserves the last saved snapshot, cleans partial files, and permits a later successful save', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-full-'));
  try {
    const file = path.join(root, 'workspace.json'), store = new JsonStore(file);
    store.update(state => { state.products = [{ id: 'saved' }]; });
    const original = fs.readFileSync(file);
    const write = fs.writeFileSync;
    const failing = t.mock.method(fs, 'writeFileSync', (target, ...args) => {
      if (String(target).startsWith(file + '.')) {
        write(target, 'partial'); throw Object.assign(new Error('No space'), { code: 'ENOSPC' });
      }
      return write(target, ...args);
    });
    assert.throws(() => store.update(state => state.products.push({ id: 'not-saved' })), error => error.code === 'ENOSPC' && error.storageFailure && /磁盘/.test(error.message));
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(fs.readdirSync(root), ['workspace.json']);
    assert.equal(store.read(state => state.products.length), 1);
    failing.mock.restore();
    store.update(state => state.products.push({ id: 'saved-after-recovery' }));
    assert.equal(new JsonStore(file).read(state => state.products.length), 2);
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('low disk space is rejected before a workspace write begins', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-low-'));
  try {
    const store = new JsonStore(path.join(root, 'workspace.json'));
    t.mock.method(fs, 'statfsSync', () => ({ bavail: 1, bsize: 4096 }));
    assert.throws(() => store.update(state => state.settings.priceMarkup = 5), { code: 'ENOSPC', status: 507 });
    assert.equal(store.read(state => state.settings.priceMarkup), 0);
    assert.deepEqual(fs.readdirSync(root), ['workspace.json']);
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failing job and its failing error write do not escape or start queued work', async () => {
  const stopped = [], ran = [];
  const tasks = createBackgroundTasks({ onStop: id => stopped.push(id) });
  await tasks.run('first', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  await tasks.run('second', async () => ran.push('second'));
  assert.deepEqual(stopped, ['first']); assert.deepEqual(ran, []);
  const jobs = [{ id: 'first', status: 'running', progress: 2 }, { id: 'second', status: 'queued' }, { id: 'done', status: 'completed' }];
  const state = tasks.state({ jobs });
  assert.deepEqual(state.jobs.map(job => job.status), ['paused', 'paused', 'completed']);
  assert.equal(jobs[0].status, 'running', 'runtime status does not masquerade as a durable write');
  assert.equal(state.jobs[0].progress, 2);
  assert.match(state.service.message, /核对.*发布结果/);
  let passed = false, code;
  tasks.middleware({ method: 'GET' }, {}, () => { passed = true; });
  assert.equal(passed, true);
  tasks.middleware({ method: 'POST' }, { status: value => { code = value; return { json() {} }; } }, () => assert.fail('must block mutations'));
  assert.equal(code, 507);
});
