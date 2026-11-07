import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readPrivateSession } from '../../server/private-session-storage.js';

assert.ok(process.env.QA_DESKTOP_USER_DATA_DIR);
const cookies = readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json'));
const accounts = [...new Set(cookies.filter(cookie => cookie.name === 'xman_us_t' && /(^|\.)alibaba\.com$/i.test(cookie.domain))
  .map(cookie => new URLSearchParams(cookie.value)).filter(value => value.get('sign') === 'y').map(value => value.get('x_lid')))].filter(Boolean);
assert.equal(accounts.length, 1, 'Exactly one signed-in seller identity is required');
if (process.env.QA_OUTPUT_DIR) {
  fs.mkdirSync(process.env.QA_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.QA_OUTPUT_DIR, 'account.json'), JSON.stringify({ account: accounts[0] }));
}
console.log(JSON.stringify({ account: accounts[0] }));
