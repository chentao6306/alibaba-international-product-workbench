import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, enterPostingForm, recoverPostingClick, dismissPostingOverlays } from '../../server/publisher.js';
import { ensureSimplifiedChinese } from '../../server/posting-language.js';
import { waitForPostingTitle } from '../../server/posting-readiness.js';
import { configurePostingInteractions } from '../../server/posting-interaction.js';
import { waitForHumanVerification } from '../../server/browser-runtime.js';
import { buildAlibabaPublishUrl } from '../../server/category-routing.js';
import { matchesAlibabaSession } from '../../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_DESKTOP_USER_DATA_DIR);
fs.mkdirSync(root, { recursive: true });
const sessionFile = path.join(root, 'session.json');
writePrivateSession(sessionFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = sessionFile;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const report = { submitted: false, categoryId: process.env.QA_CATEGORY_ID || '1355', startedAt: new Date().toISOString(), stages: [] };
let page;
async function snapshot(name) {
  const body = await page.locator('body').innerText();
  const headers = await page.locator('header, #header, .ui-header, [role="banner"]').evaluateAll(nodes => nodes.map(node => node.outerHTML));
  fs.writeFileSync(path.join(root, name + '.txt'), body);
  fs.writeFileSync(path.join(root, name + '-header.json'), JSON.stringify(headers, null, 2));
  await page.screenshot({ path: path.join(root, name + '.png') });
  return { url: page.url(), headerCount: headers.length, bodyStart: body.slice(0, 3500) };
}
try {
  page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, 'https://www.alibaba.com/'));
  configurePostingInteractions(page, { recover: target => recoverPostingClick(page, target) });
  const url = buildAlibabaPublishUrl(report.categoryId) + (process.env.QA_INITIAL_LANGUAGE === 'omit' ? '' : '&language=en_US');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForHumanVerification(page);
  await enterPostingForm(page, url, report.categoryId);
  await waitForPostingTitle(page, { verify: () => waitForHumanVerification(page) });
  report.initial = await snapshot('initial');
  if (process.env.QA_SELECT_ENGLISH === '1') {
    await dismissPostingOverlays(page);
    const trigger = page.locator('.ui-header-lan-display').first();
    if (await trigger.count()) await trigger.hover();
    const english = page.locator('a[data-role="item"][rel="en_US"]');
    if (await english.isVisible()) await english.click();
    await page.waitForTimeout(3000);
    await waitForPostingTitle(page);
  }
  report.before = await snapshot('before');
  report.result = await ensureSimplifiedChinese(page, {
    verify: () => waitForHumanVerification(page), beforeSwitch: () => dismissPostingOverlays(page), reloadOnMismatch: true,
    onProgress: stage => { report.stages.push(stage); console.log(stage); },
  });
  report.after = await snapshot('after');
  report.ok = true;
} catch (error) {
  report.error = { code: error.code, message: error.message };
  if (page && !page.isClosed()) report.failure = await snapshot('failure').catch(() => null);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, 'language.json'), JSON.stringify(report, null, 2));
  await publisher.shutdown(); fs.rmSync(sessionFile, { force: true });
  console.log(JSON.stringify({ ok: report.ok, categoryId: report.categoryId, result: report.result, error: report.error }));
}
