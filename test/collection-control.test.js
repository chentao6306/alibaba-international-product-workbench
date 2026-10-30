import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { runCollectionControl, trackCollectionPage, recoverCollectionGroups } from '../server/collection-control.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('a stalled collection can pause without waiting for the renderer and rejects late writes and pages', async () => {
  const entered = deferred(), release = deferred(), late = deferred();
  let stop = false, writes = 0, closes = 0;
  const page = { close: async () => { closes++; await new Promise(() => {}); } };
  const pending = runCollectionControl({ shouldStop: () => stop, onCheckpoint: () => { writes++; } }, async (options, guard) => {
    trackCollectionPage(page);
    guard(() => writes++)(); options.onCheckpoint(); entered.resolve();
    await release.promise;
    assert.throws(() => guard(() => writes++)(), { code: 'COLLECT_PAUSED' });
    assert.throws(() => options.onCheckpoint(), { code: 'COLLECT_PAUSED' });
    assert.throws(() => trackCollectionPage({ close: async () => { closes++; } }), { code: 'COLLECT_PAUSED' });
    late.resolve();
  }, { pollMs: 5 });
  await entered.promise; stop = true;
  await assert.rejects(pending, { code: 'COLLECT_PAUSED' });
  assert.equal(writes, 2); assert.equal(closes, 1);
  release.resolve(); await late.promise; await sleep(0);
  assert.equal(writes, 2); assert.equal(closes, 2);
});

test('lack of progress pauses the collection, while actual checkpoint and verification feedback keep it alive', async () => {
  await assert.rejects(runCollectionControl({}, () => new Promise(() => {}), { timeoutMs: 30, pollMs: 5 }), { code: 'COLLECT_STALLED' });
  let waits = 0;
  const result = await runCollectionControl({ onWaiting: () => waits++, onCheckpoint: () => {} }, async options => {
    for (let i = 0; i < 5; i++) { await sleep(20); options.onWaiting('等待人工验证'); options.onCheckpoint({ page: i }); }
    return 'verified';
  }, { timeoutMs: 100, pollMs: 5 });
  assert.equal(result, 'verified'); assert.equal(waits, 5);
});

test('a graceful pause accepts the current product while a later manual pause still interrupts its stalled page', async () => {
  let stop = false, interrupt = false, writes = 0, closes = 0;
  const entered = deferred(), release = deferred();
  const pending = runCollectionControl({ shouldStop: () => stop, shouldInterrupt: () => interrupt }, async (options, guard) => {
    trackCollectionPage({ close: async () => { closes++; } }); entered.resolve();
    await release.promise;
    guard(() => writes++)();
    assert.equal(options.shouldStop(), true);
    await new Promise(() => {});
  }, { pollMs: 5 });
  await entered.promise; stop = true;
  await sleep(30); release.resolve(); await sleep(10);
  assert.equal(writes, 1); assert.equal(closes, 0);
  interrupt = true;
  await assert.rejects(pending, { code: 'COLLECT_PAUSED' });
  assert.equal(closes, 1);
  stop = false;
  const stalled = runCollectionControl({ shouldStop: () => stop, shouldInterrupt: () => false },
    () => { stop = true; return new Promise(() => {}); }, { pollMs: 5, timeoutMs: 30 });
  await assert.rejects(stalled, { code: 'COLLECT_STALLED' });
});

test('a paused collection closes only its own pages, leaving another run and seller page intact', async () => {
  const entered = deferred(), release = deferred();
  let stop = false; const closed = [];
  const seller = { close: async () => closed.push('seller') };
  trackCollectionPage(seller);
  const first = runCollectionControl({ shouldStop: () => stop }, async () => {
    trackCollectionPage({ close: async () => closed.push('first') }); entered.resolve(); await new Promise(() => {});
  }, { pollMs: 5 });
  const second = runCollectionControl({}, async () => {
    trackCollectionPage({ close: async () => closed.push('second') }); await release.promise; return 'completed';
  });
  await entered.promise; stop = true;
  await assert.rejects(first, { code: 'COLLECT_PAUSED' });
  release.resolve(); assert.equal(await second, 'completed'); assert.deepEqual(closed, ['first']);
});

test('startup unlocks orphaned collecting groups while preserving counts, products and valid task ownership', () => {
  const state = { groups: [
    { id: 'orphan', status: 'collecting', activeJobId: 'missing', collectedCount: 17 },
    { id: 'paused', status: 'collecting', activeJobId: 'old', collectedCount: 1 },
    { id: 'active', status: 'collecting', activeJobId: 'stale', collectedCount: 3 },
    { id: 'done', status: 'done', collectedCount: 20 },
  ], products: [{ id: 'keep', title: 'Original' }], jobs: [
    { id: 'old', type: 'collect', status: 'paused', metadata: { groupId: 'paused' } },
    { id: 'new', type: 'collect', status: 'running', metadata: { groupId: 'active' } },
  ] };
  recoverCollectionGroups(state);
  assert.deepEqual(state.groups.map(group => [group.status, group.activeJobId, group.collectedCount]), [
    ['ready', '', 17], ['ready', '', 1], ['collecting', 'new', 3], ['done', undefined, 20],
  ]);
  assert.deepEqual(state.products, [{ id: 'keep', title: 'Original' }]);
});

test('pausing an actual stalled Chromium evaluation closes its collection tab and keeps a seller tab usable', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const seller = await browser.newPage(); await seller.setContent('<h1>Seller still working</h1>');
    let stop = false, page;
    const entered = deferred();
    const pending = runCollectionControl({ shouldStop: () => stop }, async () => {
      page = trackCollectionPage(await browser.newPage());
      await page.setContent('<h1>Reading product 18</h1>'); entered.resolve();
      await page.evaluate(() => new Promise(() => {}));
    }, { pollMs: 10 });
    await entered.promise; stop = true;
    await assert.rejects(pending, { code: 'COLLECT_PAUSED' });
    for (let i = 0; i < 100 && !page.isClosed(); i++) await sleep(10);
    assert.ok(page.isClosed()); assert.equal(await seller.locator('h1').innerText(), 'Seller still working');
  } finally { await browser.close(); }
});
