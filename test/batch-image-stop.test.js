import test from 'node:test';
import assert from 'node:assert/strict';
import { processImageTargets } from '../src/batch-operations.js';

test('stopping thousands of image targets retains in-flight results and resumes only unstarted targets', async () => {
  const targets = Array.from({ length: 6000 }, (_, index) => ({ id: String(index), key: 'detailImages', index: 0, url: `image-${index}` }));
  let stop = false, active = 0, maximum = 0;
  const calls = [];
  const results = await processImageTargets(targets, async target => {
    active++; maximum = Math.max(maximum, active); calls.push(target.id);
    await new Promise(resolve => setTimeout(resolve, 5));
    stop = true; active--;
    return { url: `${target.url}-edited`, changed: true };
  }, () => {}, { shouldCancel: () => stop });
  assert.equal(maximum, 2);
  assert.deepEqual(calls, ['0', '1']);
  assert.equal(results.filter(item => item.result).length, 2);
  assert.equal(results.filter(item => item.cancelled).length, 5998);
  assert.deepEqual(results.map(item => item.target), targets);
  const pending = results.filter(item => item.cancelled).map(item => item.target);
  const resumed = await processImageTargets(pending, async target => ({ url: target.url + '-edited' }));
  assert.equal(resumed.length, 5998);
  assert.ok(resumed.every(item => item.result && !item.error));
  assert.equal(targets[0].url, 'image-0');
});

test('already stopped image tasks make no requests and report every target as resumable', async () => {
  const targets = [{ id: 'a', url: 'shared' }, { id: 'b', url: 'shared' }];
  const results = await processImageTargets(targets, () => assert.fail('must not start'), () => {}, { shouldCancel: () => true });
  assert.equal(results.length, 2);
  assert.ok(results.every(item => item.cancelled && !item.result));
});
