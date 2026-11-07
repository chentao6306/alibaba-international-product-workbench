import test from 'node:test';
import assert from 'node:assert/strict';
import { gotoWithRetry } from '../server/publisher.js';
import { userFacingError } from '../server/browser-error.js';
import { publishEnvironmentBlockCode, publishRepairPlan } from '../server/publish-recovery.js';

const target = 'https://post.alibaba.com/product/publish.htm?from=common&catId=5904002';
const timeout = () => new Error('page.goto: Timeout 60000ms exceeded.\nCall log: waiting until "domcontentloaded"');

function navigationPage(outcomes) {
  const calls = [];
  const waits = [];
  return {
    calls, waits,
    isClosed: () => false,
    async goto(url, options) {
      calls.push({ url, options });
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async waitForTimeout(ms) { waits.push(ms); },
  };
}

test('retries an initial publishing navigation timeout once before continuing with the response', async () => {
  const response = { status: 200 };
  const page = navigationPage([timeout(), response]);
  const progress = [];
  assert.equal(await gotoWithRetry(page, target, {
    attempts: 2, retryTimeout: true, onRetry: (event) => progress.push(event),
  }), response);
  assert.equal(page.calls.length, 2);
  assert.ok(page.calls.every((call) => call.url === target && call.options.waitUntil === 'domcontentloaded'));
  assert.deepEqual(page.waits, [2000]);
  assert.deepEqual(progress, [{ attempt: 2, attempts: 2, timeout: true }]);
});

test('bounds repeated publishing navigation timeouts and reports that no product was submitted', async () => {
  const page = navigationPage([timeout(), timeout(), { status: 200 }]);
  await assert.rejects(gotoWithRetry(page, target, { attempts: 2, retryTimeout: true }), (error) => {
    assert.equal(error.code, 'PUBLISH_NAVIGATION_TIMEOUT');
    assert.equal(publishEnvironmentBlockCode(error), 'PUBLISH_NAVIGATION_TIMEOUT');
    assert.equal(error.diagnostics.attempts, 2);
    assert.equal(error.diagnostics.targetUrl, target);
    assert.match(error.cause.message, /page\.goto/);
    assert.match(userFacingError(error), /发布页加载超时.*尚未填写或提交/);
    assert.doesNotMatch(userFacingError(error), /page\.goto|Call log/);
    assert.deepEqual(publishRepairPlan(error), []);
    return true;
  });
  assert.equal(page.calls.length, 2);
});

test('does not extend other navigation callers timeout policy implicitly', async () => {
  const original = timeout();
  const page = navigationPage([original, { status: 200 }]);
  await assert.rejects(gotoWithRetry(page, target, { attempts: 2 }), (error) => error === original);
  assert.equal(page.calls.length, 1);
  assert.deepEqual(page.waits, []);
});

test('does not treat control timeouts or closed pages as retryable navigation', async () => {
  for (const original of [new Error('locator.click: Timeout 5000ms exceeded'), new Error('page.goto: Target page, context or browser has been closed')]) {
    const page = navigationPage([original, { status: 200 }]);
    await assert.rejects(gotoWithRetry(page, target, { attempts: 2, retryTimeout: true }), (error) => error === original);
    assert.equal(page.calls.length, 1);
  }
  const page = navigationPage([timeout()]);
  page.isClosed = () => true;
  await assert.rejects(gotoWithRetry(page, target, { attempts: 2, retryTimeout: true }), /page\.goto/);
  assert.equal(page.calls.length, 1);
});

test('stops navigation retries when the user pauses during the retry delay', async () => {
  const controller = new AbortController();
  const page = navigationPage([timeout(), { status: 200 }]);
  page.waitForTimeout = async () => controller.abort();
  await assert.rejects(gotoWithRetry(page, target, { attempts: 2, retryTimeout: true, signal: controller.signal }), { code: 'PUBLISH_PAUSED' });
  assert.equal(page.calls.length, 1);
});

test('preserves existing recovery for transient connection resets', async () => {
  const response = { status: 200 };
  const page = navigationPage([new Error('page.goto: net::ERR_CONNECTION_RESET'), response]);
  assert.equal(await gotoWithRetry(page, target, { attempts: 2 }), response);
  assert.equal(page.calls.length, 2);
});
