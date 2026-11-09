import test from 'node:test';
import assert from 'node:assert/strict';
import { gotoWithRetry, requireNewProductPage, SellerPublisher } from '../server/publisher.js';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
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

test('retries interrupted new-form navigation only when explicitly requested and never retries controls', async () => {
  for (const message of [
    'page.goto: Navigation to "https://post.alibaba.com/product/publish.htm?catId=1" is interrupted by another navigation to "https://post.alibaba.com/product/publish.htm?itemId=123&pubAction=draft"',
    'page.goto: net::ERR_ABORTED at https://post.alibaba.com/product/publish.htm',
  ]) {
    const original = new Error(message), response = { status: 200 };
    const page = navigationPage([original, response]);
    assert.equal(await gotoWithRetry(page, target, { attempts: 2, retryInterrupted: true }), response);
    assert.equal(page.calls.length, 2);
    const unchanged = navigationPage([original, response]);
    await assert.rejects(gotoWithRetry(unchanged, target), value => value === original);
    assert.equal(unchanged.calls.length, 1);
    const repeated = navigationPage([original, original, response]);
    await assert.rejects(gotoWithRetry(repeated, target, { attempts: 2, retryInterrupted: true }), error => {
      assert.equal(error.code, 'PUBLISH_NAVIGATION_INTERRUPTED');
      assert.match(userFacingError(error), /跳转冲突.*尚未填写或提交/);
      assert.equal(publishEnvironmentBlockCode(error), error.code);
      assert.deepEqual(publishRepairPlan(error), []);
      return true;
    });
    assert.equal(repeated.calls.length, 2);
  }
});

test('rejects an existing product edit page as the baseline of a new listing regardless of category', () => {
  requireNewProductPage(target);
  for (const identity of ['itemId', 'productId', 'primaryId']) {
    const url = `${target}&${identity}=1234567890123&pubAction=draft`;
    assert.throws(() => requireNewProductPage(url), error => {
      assert.equal(error.code, 'PUBLISH_EXISTING_PRODUCT_PAGE');
      assert.equal(publishEnvironmentBlockCode(error), error.code);
      assert.deepEqual(publishRepairPlan(error), []);
      assert.match(userFacingError(error), /避免覆盖已有商品/);
      return true;
    });
  }
});

test('starts each product in its own document while keeping session and unrelated tabs intact', { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const context = await browser.newContext();
  try {
    const oldDraftPages = [];
    await context.route('https://post.alibaba.com/**', route => {
      if (route.request().url().includes('itemId=')) oldDraftPages.push(route.request().frame().page());
      return route.fulfill({ contentType: 'text/html', body: '<input name="productTitle">' });
    });
    const unrelated = await context.newPage(); await unrelated.goto(target);
    await context.addCookies([{ name: 'fixture_session', value: 'preserved', url: target }]);
    const previous = await context.newPage(); await previous.goto(target);
    await previous.evaluate(() => {
      localStorage.setItem('fixture_session', 'preserved');
      setTimeout(() => location.href = '/product/publish.htm?itemId=1234567890123&pubAction=draft', 1000);
    });
    const publisher = new SellerPublisher('.data/unused-navigation-fixture');
    publisher.context = context; publisher.page = previous; publisher.publishingPage = { page: previous };
    publisher.currentSellerPage = async () => previous;
    const next = await publisher.createProductPage(target);
    assert.notEqual(next, previous); assert.equal(previous.isClosed(), true); assert.equal(unrelated.isClosed(), false);
    await gotoWithRetry(next, target);
    await next.waitForTimeout(1100);
    requireNewProductPage(next.url());
    // A busy machine may let the prior page's timer fire before it closes.
    // Its redirect must never navigate the new product's document.
    assert.ok(oldDraftPages.every(page => page === previous));
    assert.equal(await next.locator('input').inputValue(), '');
    assert.equal(await next.evaluate(() => localStorage.getItem('fixture_session')), 'preserved');
    assert.equal((await context.cookies()).find(c => c.name === 'fixture_session').value, 'preserved');
    publisher.publishingPage = { page: next };
    const third = await publisher.createProductPage(target.replace('5904002', '201450201'));
    assert.equal(next.isClosed(), true); assert.equal(unrelated.isClosed(), false);
    assert.equal(context.pages().length, 2, 'Only the current automated page and unrelated tab remain');
    assert.equal(publisher.page, third);
  } finally { await browser.close(); }
});

test('completed product stop handlers detach so later cancellation cannot close an old or new page', () => {
  const publisher = new SellerPublisher('.data/unused-navigation-fixture');
  const controller = new AbortController(); let calls = 0;
  const stop = () => calls++;
  stop.dispose = () => controller.signal.removeEventListener('abort', stop);
  controller.signal.addEventListener('abort', stop);
  publisher.publishStops.set('batch', stop);
  publisher.clearPublishStop('batch');
  controller.abort();
  assert.equal(calls, 0); assert.equal(publisher.requestPublishStop('batch'), false);
});
