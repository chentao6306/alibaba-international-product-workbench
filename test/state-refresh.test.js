import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateRefresher } from '../src/state-refresh.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('a post-save refresh rereads after an older poll and concurrent polls never overlap', async () => {
  let calls = 0;
  const before = deferred(), after = deferred();
  const refresh = createStateRefresher(() => { calls++; return calls === 1 ? before.promise : after.promise; });
  const poll = refresh({ fresh: false });
  assert.equal(refresh({ fresh: false }), poll);
  const saved = refresh();
  assert.notEqual(saved, poll);
  assert.equal(refresh(), saved, 'multiple writes before the follow-up starts share one fresh read');
  before.resolve('old-folder');
  assert.equal(await poll, 'old-folder');
  after.resolve('new-folder');
  assert.equal(await saved, 'new-folder');
  assert.equal(calls, 2);
});

test('writes completed during a follow-up read get another fresh state and failed polls do not block recovery', async () => {
  const reads = [deferred(), deferred(), deferred()]; let calls = 0;
  const refresh = createStateRefresher(() => reads[calls++].promise);
  const poll = refresh({ fresh: false }); const saved = refresh();
  reads[0].reject(Error('temporary outage'));
  await assert.rejects(poll, /temporary outage/);
  await new Promise(resolve => setImmediate(resolve));
  const secondSave = refresh();
  reads[1].resolve('first-write');
  assert.equal(await saved, 'first-write');
  reads[2].resolve('second-write');
  assert.equal(await secondSave, 'second-write');
  assert.equal(calls, 3);
});
