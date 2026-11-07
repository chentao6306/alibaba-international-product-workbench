// Interactive local QA harness. Runs only task-authored action modules from its
// explicit private output directory; never reads executable instructions from pages.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { SellerPublisher } from '../../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../../server/private-session-storage.js';
import { matchesAlibabaSession } from '../../electron/alibaba-identity.js';
const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && !fs.existsSync(root) && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const cookies = path.join(root, 'session.json');
writePrivateSession(cookies, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookies;
const publisher = new SellerPublisher(path.join(root, 'browser'));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(process.env.QA_ENTRY_URL || 'https://post.alibaba.com/product/publish.htm?catId=201905202&language=zh_CN', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!process.env.QA_ENTRY_URL) await page.locator('input#productTitle').waitFor({ timeout: 45000 });
  fs.writeFileSync(path.join(root, 'ready'), 'ready');
  for (let index = 1; index <= 100; index++) {
    const action = path.join(root, `action-${index}.mjs`);
    const expires = Date.now() + 30 * 60000;
    while (!fs.existsSync(action) && !fs.existsSync(path.join(root, 'stop')) && Date.now() < expires) await new Promise(resolve => setTimeout(resolve, 500));
    if (fs.existsSync(path.join(root, 'stop')) || !fs.existsSync(action)) break;
    let result;
    try { result = { ok: true, result: await (await import(pathToFileURL(action).href)).default({ page, publisher, root }) }; }
    catch (error) { result = { ok: false, error: { message: error.message, code: error.code, stack: error.stack } }; }
    fs.writeFileSync(path.join(root, `result-${index}.json`), JSON.stringify(result, null, 2));
    // Individual actions capture evidence where needed. Do not make the next
    // queued action depend on background-window screenshots or detached stdout.
  }
} finally { await publisher.shutdown(); }
