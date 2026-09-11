import fs from 'node:fs';
import path from 'node:path';

const HEADER = Buffer.from('KYPS1\n');

export function readPrivateSession(file, encryption = globalThis.__KUA_YIPU_SECURE_STORAGE) {
  const content = fs.readFileSync(file);
  if (!content.subarray(0, HEADER.length).equals(HEADER)) return JSON.parse(content.toString('utf8'));
  if (!encryption) throw new Error('请使用桌面客户端读取登录会话');
  return JSON.parse(encryption.decrypt(content.subarray(HEADER.length)));
}

export function writePrivateSession(file, value, encryption = globalThis.__KUA_YIPU_SECURE_STORAGE) {
  if (!encryption) throw new Error('当前环境不支持安全保存登录会话');
  const content = Buffer.concat([HEADER, encryption.encrypt(JSON.stringify(value))]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
