// Validate the exact delivery bootstrap and embedded payload without installing
// over the user's application, changing registry entries or touching user data.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const release = path.resolve(process.argv[2]);
const version = JSON.parse(fs.readFileSync('package.json')).version;
const setup = path.join(release, `chaodekuai-${version}-setup.exe`);
const application = path.join(release, 'win-unpacked');
const output = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'installer-payload-qa-'));
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, CHAODEKUAI_SETUP_QUIET: '1', CHAODEKUAI_SETUP_LOG: path.join(output, 'bootstrap.log') };
const verified = spawnSync(setup, ['/verify', application, output], { env, windowsHide: true, timeout: 120000 });
assert.equal(verified.status, 0, verified.error?.message);
assert.equal(fs.readFileSync(path.join(output, 'verified-install.txt'), 'utf8').replace(/^\uFEFF/, ''), application);
const empty = path.join(output, 'incomplete-program'); fs.mkdirSync(empty, { recursive: true });
const rejected = spawnSync(setup, ['/verify', empty, empty], { env, windowsHide: true, timeout: 30000 });
assert.equal(rejected.error, undefined);
assert.notEqual(rejected.status, 0, 'An incomplete program must be rejected');
assert.equal(fs.existsSync(path.join(empty, 'verified-install.txt')), false);
const inspect = path.join(output, 'embedded-installer-hash.ps1');
fs.writeFileSync(inspect, `
$assembly=[Reflection.Assembly]::LoadFile($args[0])
$stream=$assembly.GetManifestResourceStream('installer.exe')
$hash=[Security.Cryptography.SHA256]::Create()
try { [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
finally { $hash.Dispose(); $stream.Dispose() }
`);
const embedded = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', inspect, setup], {
  env, windowsHide: true, timeout: 30000, encoding: 'utf8',
});
assert.equal(embedded.status, 0, embedded.stderr);
const expected = createHash('sha256').update(fs.readFileSync(path.join(release, `chaodekuai-${version}-inner.exe`))).digest('hex');
assert.equal(embedded.stdout.trim(), expected);
const result = { version, ok: true, completePayloadAccepted: true, incompletePayloadRejected: true, embeddedInstallerSha256: expected };
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
