import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const magic = Buffer.from('KYB1');
const readKey = (file) => {
  const key = Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).key, 'base64');
  if (key.length !== 32) throw new Error('Expected a 32-byte backup key');
  return key;
};
export function createBackupKey(file) {
  fs.writeFileSync(file, JSON.stringify({ format: 'KYB1', cipher: 'AES-256-GCM', key: crypto.randomBytes(32).toString('base64') }), { flag: 'wx', mode: 0o600 });
}
export async function transformBackup(mode, input, output, keyFile) {
  if (!['seal', 'open'].includes(mode)) throw new Error('Mode must be seal or open');
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new destination');
  const key = readKey(keyFile);
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  try {
    if (mode === 'seal') {
      const nonce = crypto.randomBytes(12);
      const header = Buffer.concat([magic, nonce]);
      fs.writeFileSync(temporary, header, { flag: 'wx', mode: 0o600 });
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(header);
      await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(temporary, { flags: 'a' }));
      fs.appendFileSync(temporary, cipher.getAuthTag());
    } else {
      const size = fs.statSync(input).size;
      if (size < 32) throw new Error('Invalid backup size');
      const descriptor = fs.openSync(input, 'r');
      const header = Buffer.alloc(16); const tag = Buffer.alloc(16);
      try { fs.readSync(descriptor, header, 0, 16, 0); fs.readSync(descriptor, tag, 0, 16, size - 16); }
      finally { fs.closeSync(descriptor); }
      if (!header.subarray(0, 4).equals(magic)) throw new Error('Unsupported backup format');
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(4));
      cipher.setAAD(header); cipher.setAuthTag(tag);
      await pipeline(fs.createReadStream(input, { start: 16, end: size - 17 }), cipher, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    }
    fs.renameSync(temporary, output);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output, keyFile] = process.argv.slice(2);
  if (mode === 'keygen' && input) createBackupKey(input);
  else if (['seal', 'open'].includes(mode) && input && output && keyFile) await transformBackup(mode, input, output, keyFile);
  else throw new Error('Usage: node tools/encrypted-backup.mjs keygen <key.json> | seal/open <input> <output> <key.json>');
  console.log('Backup operation completed');
}
