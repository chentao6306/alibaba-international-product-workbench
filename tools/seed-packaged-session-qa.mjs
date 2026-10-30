// Import the app's encrypted cookie export into an isolated QA profile. Avoid
// copying the live Chromium SQLite database while the user's app has it open.
import { app, session, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { readPrivateSession } from '../server/private-session-storage.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const profile = path.resolve(process.env.QA_SEED_PROFILE);
const account = process.env.QA_EXPECTED_ACCOUNT;
assert.ok(profile.startsWith(path.resolve(os.tmpdir()) + path.sep));
assert.ok(/^packaged-(?:watermark-soak|startup)-/.test(path.basename(path.dirname(profile))));
assert.equal(path.basename(profile), 'profile');
assert.ok(account && process.env.QA_DESKTOP_USER_DATA_DIR);
assert.ok(fs.existsSync(path.join(profile, 'Local State')));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 30000);
async function seedSession() {
  await app.whenReady();
  const cookies = readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json'), {
    decrypt: buffer => safeStorage.decryptString(buffer),
  });
  assert.ok(matchesAlibabaSession(cookies, account, 'https://i.alibaba.com/'));
  const target = session.fromPartition(`persist:kua-yipu-${account}`);
  let imported = 0;
  // Restore non-HttpOnly cookies before overlapping HttpOnly parent-domain
  // cookies; Chromium rejects the reverse order as script-cookie shadowing.
  for (const cookie of [...cookies].sort((a, b) => Number(Boolean(a.httpOnly)) - Number(Boolean(b.httpOnly)))) {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!/(^|\.)alibaba\.com$/i.test(domain)) continue;
    const expires = cookie.expirationDate ?? cookie.expires;
    if (expires > 0 && expires < Date.now() / 1000) continue;
    const options = { url: `https://${domain}${cookie.path || '/'}`,
      name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly) };
    if (!cookie.hostOnly) options.domain = cookie.domain;
    if (expires > 0) options.expirationDate = expires;
    const sameSite = String(cookie.sameSite || '').toLowerCase();
    if (['lax', 'strict', 'unspecified', 'no_restriction'].includes(sameSite)) options.sameSite = sameSite;
    else if (sameSite === 'none') options.sameSite = 'no_restriction';
    await target.cookies.set(options); imported++;
  }
  await target.cookies.flushStore();
  assert.ok(matchesAlibabaSession(await target.cookies.get({}), account, 'https://i.alibaba.com/'));
  console.log(JSON.stringify({ ok: true, imported }));
  clearTimeout(deadline); app.exit(0);
}
seedSession().catch(error => {
  console.error(error.message); clearTimeout(deadline); app.exit(1);
});
