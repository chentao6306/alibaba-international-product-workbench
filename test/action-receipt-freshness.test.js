import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { waitForActionResult } from '../server/publisher.js';

// Some cases exercise three separate bounded saves in one browser fixture.
const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try { await run(await browser.newPage()); } finally { await browser.close(); }
});

browserTest('does not accept an unchanged success message from the preceding draft save', async page => {
  await page.setContent('<div role="alert">保存成功</div><button onclick="window.saves++">保存</button><script>window.saves=0</script>');
  await assert.rejects(waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 600, busyGraceMs: 0 }),
    { code: 'PUBLISH_SUBMIT_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.saves), 1);
});

browserTest('accepts identical success text only when this save replaces or redisplays its receipt', async page => {
  for (const behavior of ['replace', 'rewrite', 'redisplay']) {
    await page.setContent('<div role="alert">保存成功</div><button>保存</button>');
    await page.evaluate(behavior => {
      window.saves = 0;
      document.querySelector('button').onclick = () => {
        window.saves++;
        const alert = document.querySelector('[role=alert]');
        if (behavior === 'replace') alert.outerHTML = '<div role="alert">保存成功</div>';
        if (behavior === 'rewrite') alert.textContent = '保存成功';
        if (behavior === 'redisplay') { alert.hidden = true; setTimeout(() => { alert.hidden = false; }, 100); }
      };
    }, behavior);
    const result = await waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 1200, busyGraceMs: 0 });
    assert.equal(result.verifiedBy, 'feedback', behavior);
    assert.equal(await page.evaluate(() => window.saves), 1);
    assert.equal(await page.evaluate(() => Boolean(window.__postingReceipt)), false);
  }
});

browserTest('unrelated form mutations do not refresh an old save receipt', async page => {
  await page.setContent('<div role="alert">保存成功</div><div id="other"></div><button onclick="window.saves++;document.querySelector(\'#other\').textContent=\'updated\'">保存</button><script>window.saves=0</script>');
  await assert.rejects(waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 600, busyGraceMs: 0 }),
    { code: 'PUBLISH_SUBMIT_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.saves), 1);
});

browserTest('changes to the age of an old success message do not acknowledge a new save', async page => {
  for (const nested of [true, false]) {
    await page.setContent(nested
      ? '<div role="alert">Saved successfully <span>10 seconds ago</span></div><button>Save</button>'
      : '<div role="alert">Saved successfully 10 seconds ago</div><button>Save</button>');
    await page.evaluate(nested => {
      window.saves = 0;
      document.querySelector('button').onclick = () => {
        window.saves++;
        const alert = document.querySelector('[role=alert]');
        if (nested) alert.querySelector('span').textContent = '11 seconds ago';
        else alert.textContent = 'Saved successfully 11 seconds ago';
      };
    }, nested);
    await assert.rejects(waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 600, busyGraceMs: 0 }),
      { code: 'PUBLISH_SUBMIT_RESULT_UNKNOWN' });
    assert.equal(await page.evaluate(() => window.saves), 1);
  }
});

browserTest('accepts a reused text node that changes from saved to saving and back to saved', async page => {
  for (const deferred of [true, false]) {
    await page.setContent('<div role="alert">Saved successfully</div><button>Save</button>');
    await page.evaluate(deferred => {
      window.saves = 0;
      window.receiptText = document.querySelector('[role=alert]').firstChild;
      document.querySelector('button').onclick = () => {
        window.saves++;
        window.receiptText.data = 'Saving...';
        const saved = () => { window.receiptText.data = 'Saved successfully'; };
        if (deferred) setTimeout(saved, 100);
        else saved();
      };
    }, deferred);
    const result = await waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 1200, busyGraceMs: 0 });
    assert.equal(result.verifiedBy, 'feedback');
    assert.equal(await page.evaluate(() => window.saves), 1);
    assert.equal(await page.evaluate(() => window.receiptText === document.querySelector('[role=alert]').firstChild), true);
  }
});

browserTest('two consecutive saves require separate receipts and never send a second click for an uncertain save', async page => {
  await page.setContent('<button>保存</button>');
  await page.evaluate(() => {
    window.saves = 0;
    document.querySelector('button').onclick = () => {
      if (++window.saves === 1) document.body.insertAdjacentHTML('beforeend', '<div role="alert">保存成功</div>');
    };
  });
  assert.equal((await waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 1200 })).verifiedBy, 'feedback');
  await assert.rejects(waitForActionResult(page, page.locator('button'), 'draft', page.url(), { timeoutMs: 600, busyGraceMs: 0 }),
    { code: 'PUBLISH_SUBMIT_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.saves), 2);
});

browserTest('an old success URL is not a new publication receipt', async page => {
  await page.route('https://post.alibaba.com/**', route => route.fulfill({ contentType: 'text/html', body: '<button onclick="window.saves=(window.saves||0)+1">提交</button>' }));
  await page.goto('https://post.alibaba.com/product/success.htm?primaryId=1234567890123');
  await assert.rejects(waitForActionResult(page, page.locator('button'), 'submit', page.url(), { timeoutMs: 600, busyGraceMs: 0 }),
    { code: 'PUBLISH_SUBMIT_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.saves), 1);
});

browserTest('a fragment change on an old success page is not a new publication receipt', async page => {
  await page.route('https://post.alibaba.com/**', route => route.fulfill({ contentType: 'text/html',
    body: '<div role="alert">Submitted successfully</div><button onclick="window.saves=(window.saves||0)+1;location.hash=\'changed\'">Submit</button>' }));
  await page.goto('https://post.alibaba.com/product/success.htm?primaryId=1234567890123');
  await assert.rejects(waitForActionResult(page, page.locator('button'), 'submit', page.url(), { timeoutMs: 600, busyGraceMs: 0 }),
    { code: 'PUBLISH_SUBMIT_RESULT_UNKNOWN' });
  assert.equal(await page.evaluate(() => window.saves), 1);
  assert.equal(new URL(page.url()).hash, '#changed');
});

browserTest('accepts a new document with a visible saved receipt after a same-URL reload', async page => {
  let documentLoads = 0, saves = 0;
  await page.exposeFunction('recordSave', () => { saves++; });
  await page.route('https://post.alibaba.com/**', route => route.fulfill({ contentType: 'text/html',
    body: ++documentLoads === 1
      ? '<button onclick="window.recordSave().then(() => location.reload())">Save</button>'
      : '<div role="alert">Saved successfully</div><button>Save</button>' }));
  await page.goto('https://post.alibaba.com/product/publish.htm');
  const originalUrl = page.url();
  const result = await waitForActionResult(page, page.locator('button'), 'draft', originalUrl, { timeoutMs: 1200, busyGraceMs: 0 });
  assert.equal(result.verifiedBy, 'feedback');
  assert.equal(page.url(), originalUrl);
  assert.equal(documentLoads, 2);
  assert.equal(saves, 1);
});
