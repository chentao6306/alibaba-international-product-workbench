import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublishDelayRange, publishDelayFromRequest, randomPublishDelayMs, waitForPublishDelay } from '../server/publish-delay.js';

test('normalizes user-selected publishing delay and keeps the upper bound safe', () => {
  assert.deepEqual(normalizePublishDelayRange(-2, 8), { minSeconds: 0, maxSeconds: 8 });
  assert.deepEqual(normalizePublishDelayRange(12, 4), { minSeconds: 12, maxSeconds: 12 });
  assert.deepEqual(normalizePublishDelayRange(500, 900), { minSeconds: 300, maxSeconds: 300 });
  assert.equal(randomPublishDelayMs({ minSeconds: 0, maxSeconds: 0 }), 0);
  assert.equal(randomPublishDelayMs({ minSeconds: 2, maxSeconds: 6 }, () => 0), 2000);
  assert.equal(randomPublishDelayMs({ minSeconds: 2, maxSeconds: 6 }, () => 0.5), 4000);
  assert.equal(randomPublishDelayMs({ minSeconds: 2, maxSeconds: 6 }, () => 1), 6000);
});

test('rejects invalid request ranges instead of silently changing user choices', () => {
  for (const values of [[-1, 5], [4, 2], [0, 301], ['abc', 10], ['', 2], [false, 10]]) {
    assert.throws(() => publishDelayFromRequest({ publishDelayMinSeconds: values[0], publishDelayMaxSeconds: values[1] }), { status: 400 });
  }
  assert.deepEqual(publishDelayFromRequest({}, { minSeconds: 2, maxSeconds: 4 }), { minSeconds: 2, maxSeconds: 4 });
  assert.deepEqual(publishDelayFromRequest({ publishDelayMinSeconds: '0', publishDelayMaxSeconds: '0' }), { minSeconds: 0, maxSeconds: 0 });
});

test('reports countdown and interrupts long delays promptly without completing the wait', async () => {
  let time = 0;
  const counts = [];
  const options = { now: () => time, sleep: async (ms) => { time += ms; }, onWaiting: (seconds) => counts.push(seconds), shouldStop: () => false };
  assert.equal(await waitForPublishDelay({ minSeconds: 2, maxSeconds: 2 }, options), true);
  assert.deepEqual(counts, [2, 1]);
  time = 0; counts.length = 0;
  assert.equal(await waitForPublishDelay({ minSeconds: 300, maxSeconds: 300 }, { ...options, shouldStop: () => time >= 250 }), false);
  assert.equal(time, 250);
  time = 0;
  assert.equal(await waitForPublishDelay({}, options), true);
  assert.equal(time, 0);
});
