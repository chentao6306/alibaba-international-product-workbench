// Local-only development console for inspecting a persistent isolated QA browser.
// Run through live-desktop-qa.cjs; commands are read solely from the developer PTY.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../../server/publisher.js';
import { matchesAlibabaSession } from '../../electron/alibaba-identity.js';

assert.ok(process.env.QA_OUTPUT_DIR && process.env.QA_EXPECTED_ACCOUNT);
const publisher = new SellerPublisher(process.env.QA_OUTPUT_DIR);
const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
globalThis.qa = { publisher, page };
const root = process.env.QA_OUTPUT_DIR;
fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ ready: true }));
try {
  for (let index = 1; ; index++) {
    const command = path.join(root, `command-${index}.js`);
    while (!fs.existsSync(command)) await new Promise(resolve => setTimeout(resolve, 200));
    const line = fs.readFileSync(command, 'utf8').replace(/^\uFEFF/, '');
    if (line.trim() === '.exit') break;
    fs.writeFileSync(path.join(root, 'running.json'), JSON.stringify({ index, startedAt: new Date().toISOString() }));
    let result;
    try { result = { value: await eval(`(async () => { ${line} })()`) }; }
    catch (error) { result = { error: { message: error.message, code: error.code } }; }
    fs.writeFileSync(path.join(root, `result-${index}.json`), JSON.stringify(result, null, 2));
  }
} finally { await publisher.shutdown(); }
