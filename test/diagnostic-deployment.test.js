import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute the exact Node contract used by the deployment shell in an isolated
// directory. These tests never invoke systemctl, curl or production paths.
const script = fs.readFileSync(new URL('../auth-server/deploy/update-diagnostic-schema.sh', import.meta.url), 'utf8');
const verifier = script.match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE\r?\n/)?.[1];
assert.ok(verifier, 'Deployment script must contain its executable module-pair verifier');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-deployment-'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  for (const name of ['diagnostic-schema.js', 'diagnostic-evidence.js']) {
    fs.copyFileSync(new URL('../auth-server/' + name, import.meta.url), path.join(directory, name));
  }
  return { directory, run: () => spawnSync(process.execPath, ['--input-type=module', '-', directory], {
    input: verifier, encoding: 'utf8', windowsHide: true, timeout: 10000,
  }), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('deployment isolation verifies paired imports, old reports, new evidence and credential rejection', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /legacy reports and redaction verified/);
  } finally { f.close(); }
});

test('deployment isolation rejects a mismatched evidence module before any service operation', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, 'diagnostic-evidence.js'), 'export const sanitizeDiagnosticFailure = input => input;');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /diagnosticText/);
  } finally { f.close(); }
});

test('deployment isolation rejects an old allowlist that silently discards new attempt fields', () => {
  const f = fixture();
  try {
    const file = path.join(f.directory, 'diagnostic-schema.js');
    const current = fs.readFileSync(file, 'utf8');
    // Simulate the old server behavior: otherwise valid reports/events but no
    // attempt identity. Syntax-only validation would incorrectly accept it.
    const stale = current.replace(/^\s*\.\.\.\(uuid\.test\(event\.attemptId[^\r\n]*\r?\n/m, '');
    assert.notEqual(stale, current);
    fs.writeFileSync(file, stale);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AssertionError/);
  } finally { f.close(); }
});

test('deployment isolation fails when evidence cleaning allows token fields to reach a report', () => {
  const f = fixture();
  try {
    const file = path.join(f.directory, 'diagnostic-evidence.js');
    const current = fs.readFileSync(file, 'utf8');
    const unredacted = current.replace('!SECRET_KEY.test(key) && ', '');
    assert.notEqual(unredacted, current);
    fs.writeFileSync(file, unredacted);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AssertionError/);
  } finally { f.close(); }
});
