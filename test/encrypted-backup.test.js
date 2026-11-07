import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBackupKey, transformBackup } from '../tools/encrypted-backup.mjs';

test('encrypted backups restore exactly and reject corruption or a wrong key without publishing plaintext', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  const at = (name) => path.join(root, name);
  try {
    const source = crypto.randomBytes(1024 * 1024 + 123);
    fs.writeFileSync(at('source'), source);
    createBackupKey(at('key.json')); createBackupKey(at('other.json'));
    await transformBackup('seal', at('source'), at('sealed'), at('key.json'));
    await transformBackup('open', at('sealed'), at('restored'), at('key.json'));
    assert.deepEqual(fs.readFileSync(at('restored')), source);
    await assert.rejects(transformBackup('open', at('sealed'), at('wrong'), at('other.json')));
    assert.equal(fs.existsSync(at('wrong')), false);
    const corrupt = fs.readFileSync(at('sealed')); corrupt[20] ^= 1; fs.writeFileSync(at('corrupt'), corrupt);
    await assert.rejects(transformBackup('open', at('corrupt'), at('invalid'), at('key.json')));
    assert.equal(fs.existsSync(at('invalid')), false);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
    await assert.rejects(transformBackup('open', at('sealed'), at('restored'), at('key.json')), /already exists/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
